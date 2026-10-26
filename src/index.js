/**
 * Group-aware fail-fast tool batches for the DeepSeek Harness.
 *
 * The agent loop partitions the tool calls of one model response into ordering
 * groups: concurrency-safe calls form a group that may overlap up to the
 * configured `maxParallelToolCalls`; every other call is an exclusive
 * single-call group. Groups run strictly one after another — a group is fully
 * drained and its results are committed in model order before the next group
 * starts. This plugin relies on that barrier instead of forcing global serial
 * dispatch:
 *
 * - inside a group, calls keep overlapping as the loop permits (parallel reads
 *   stay parallel);
 * - once a call failure has committed, every call that has not started yet is
 *   denied before dispatch and settled as an error result telling the model it
 *   was not executed — in practice this cancels all remaining groups, and is
 *   conservative for a same-group tail that had not started when the failure
 *   became known;
 * - calls that already started in the failing group finish normally: they are
 *   declared concurrency-safe by their tool, so their results are still
 *   meaningful, and the loop commits everything in model order anyway.
 *
 * The model's emission order is treated as the dependency topology: when a
 * model writes `[write, bash]`, it almost always orders the calls by dependency
 * already. Groups preserve that order, so "skip everything that has not started
 * after the first failure" is a safe approximation that never has to understand
 * tool semantics. Continuing after a known failure is pure waste — the inputs
 * are stale and the effects can be destructive — while the turn itself is not
 * wasted: the model gets "call N failed, the rest were not executed" and repairs
 * on the next turn.
 *
 * Implementation: durable `session/event`s track the ordered call ids of the
 * step in flight, `tools/result` pins the first failed index, and
 * `tools/pre-execute` denies calls after that point. A denied call never
 * reaches its body; the loop still records the normal `tool/call` +
 * `tool/result` pair the model expects.
 *
 * Only model-direct calls participate. PTC sub-dispatches carry `exec.parent`
 * and keep their own program-level error handling; calls without a live agent
 * session (programmatic callers) are left untouched.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fail-fast'

/** Stable durable failure identity for a call skipped by fail-fast. */
const SKIP_CODE = 'SKIPPED_AFTER_FAILURE'
const SKIP_ERROR_NAME = 'FailFastSkippedError'

/**
 * Model-facing reason for a skipped call. The registry wraps a pre-execute
 * denial as `Error: <reason>`, so this text starts with "Not executed:".
 * @param failedName - name of the first tool call that failed in the batch.
 * @returns the reason string carried by the synthesized error result.
 */
function skipReason(failedName) {
  const preceding = failedName === '' ? 'preceding' : `preceding \`${failedName}\``
  return `Not executed: the ${preceding} call failed, so fail-fast skipped this call and every call that had not started yet in the batch. Fix the failure first, then re-issue the remaining calls in dependency order.`
}

/**
 * Bookkeeping for the tool batch of one step.
 * @param turn - turn number of the step.
 * @param step - step number inside the turn.
 */
function createBatch(turn, step) {
  return {
    turn,
    step,
    /** Call id -> emission index inside the assistant message. */
    index: new Map(),
    nextIndex: 0,
    /** Emission index of the first failed call, or -1 while the batch is healthy. */
    failedAt: -1,
    failedName: '',
  }
}

/**
 * Register one call id at the next emission position.
 * @param batch - batch to extend.
 * @param callId - durable call id from `tool/call`.
 */
function addCall(batch, callId) {
  if (batch.index.has(callId)) return
  batch.index.set(callId, batch.nextIndex)
  batch.nextIndex += 1
}

/**
 * Resolve the batch a model-direct execution belongs to.
 * @param batches - per-session batch map.
 * @param exec - tool execution seen by a tools event.
 * @returns the batch, or undefined for nested/subagent-external executions.
 */
function batchOf(batches, exec) {
  if (exec.parent !== undefined) return undefined
  const session = exec.agent?.session
  if (session === undefined) return undefined
  return batches.get(session.id)
}

/**
 * Install the fail-fast batch tracker.
 * @param ctx - owning Cordis context.
 */
export function apply(ctx) {
  /** Session id -> batch of the step currently in flight. */
  const batches = new Map()

  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'step/start': {
        const { turn, step } = event.data
        batches.set(session.id, createBatch(turn, step))
        break
      }
      case 'tool/call': {
        // `tool/call` is appended when the loop starts a call, in model
        // emission order; that order is the dependency topology we track.
        const { turn, step, callId } = event.data
        let batch = batches.get(session.id)
        if (batch === undefined || batch.turn !== turn || batch.step !== step) {
          // Defensive fallback: a step that opened before this plugin saw its
          // `step/start` still gets a batch, seeded with the first observed call.
          batch = createBatch(turn, step)
          batches.set(session.id, batch)
        }
        addCall(batch, callId)
        break
      }
      default:
        break
    }
  })

  ctx.on('session/disposed', (session) => {
    batches.delete(session.id)
  })

  // `tools/result` observes the frozen, final outcome of every call that ran:
  // failures include tool errors, policy denials, timeouts, and post-execute
  // blocks alike. Results commit in model order within a group and groups are
  // barriers, so the first observed failure is the batch's failure point.
  ctx.on('tools/result', (exec, result) => {
    if (!result.isError) return
    const batch = batchOf(batches, exec)
    if (batch === undefined || batch.failedAt !== -1) return
    const index = batch.index.get(exec.callId)
    if (index === undefined) return
    batch.failedAt = index
    batch.failedName = exec.name
  })

  // Prepend so a skipped call is denied before any other policy listener can
  // ask the user for approval or prepare the call: nothing about a call that
  // follows a known failure is worth prompting for, and its body must not run.
  ctx.on('tools/pre-execute', (exec, next) => {
    const batch = batchOf(batches, exec)
    if (batch === undefined || batch.failedAt === -1) return next()
    const index = batch.index.get(exec.callId)
    if (index === undefined || index <= batch.failedAt) return next()
    const reason = skipReason(batch.failedName)
    return {
      kind: 'deny',
      reason,
      info: { name: SKIP_ERROR_NAME, code: SKIP_CODE },
    }
  }, { prepend: true })
}
