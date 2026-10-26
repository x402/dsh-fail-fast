// Smoke test for the fail-fast batch logic with a mock Cordis context.
import { apply, name } from '../src/index.js'

const listeners = new Map()
const disposers = []
const ctx = {
  on(event, listener) {
    if (!listeners.has(event)) listeners.set(event, [])
    listeners.get(event).push(listener)
    return () => {}
  },
}
apply(ctx)

let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log(`ok   ${label}`) }
  else { failures += 1; console.log(`FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`) }
}

const emitSession = (session, event) => {
  for (const listener of listeners.get('session/event') ?? []) listener(session, event)
}
const preExecute = (exec) => {
  let nextCalled = false
  const decision = listeners.get('tools/pre-execute')[0](exec, () => { nextCalled = true; return { kind: 'allow' } })
  return { decision, nextCalled }
}
const emitResult = (exec, result) => {
  for (const listener of listeners.get('tools/result') ?? []) listener(exec, result)
}

const session = { id: 's-1' }
const agent = { session }
const call = (id) => ({ callId: id, name: `tool-${id}`, agent })
const nested = (id) => ({ callId: `${id}:ptc:0`, name: 'read', agent, parent: Symbol('outer') })
const errorResult = { isError: true, error: { message: 'ENOENT' }, content: [] }
const okResult = { isError: false, value: null, content: [] }

// Step 1: batch of three calls, first one fails.
emitSession(session, { type: 'step/start', data: { turn: 1, step: 1 } })
emitSession(session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'a', name: 'tool-a', arguments: '{}' } })
emitSession(session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'b', name: 'tool-b', arguments: '{}' } })
emitSession(session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name: 'tool-c', arguments: '{}' } })

const a = preExecute(call('a'))
check('first call is allowed', a.nextCalled && a.decision.kind === 'allow', a.decision)
emitResult(call('a'), errorResult)

const b = preExecute(call('b'))
check('call after failure is denied', b.nextCalled === false && b.decision?.kind === 'deny', b.decision)
check('skip reason names the failed call', /Not executed/.test(b.decision?.reason ?? '') && /tool-a/.test(b.decision?.reason ?? ''), b.decision?.reason)
check('skip carries durable error identity', b.decision?.info?.code === 'SKIPPED_AFTER_FAILURE', b.decision?.info)
emitResult(call('b'), errorResult)

const c = preExecute(call('c'))
check('every later call is denied too', c.nextCalled === false && c.decision?.kind === 'deny', c.decision)

// Nested PTC sub-dispatch and calls without an agent stay untouched.
const n = preExecute(nested('a'))
check('nested PTC sub-dispatch is untouched', n.nextCalled === true, n.decision)
const orphan = preExecute({ callId: 'z', name: 'tool-z' })
check('agent-less call is untouched', orphan.nextCalled === true, orphan.decision)

// A new step opens a fresh batch: the previous failure must not leak.
emitSession(session, { type: 'step/start', data: { turn: 1, step: 2 } })
emitSession(session, { type: 'tool/call', data: { turn: 1, step: 2, callId: 'd', name: 'tool-d', arguments: '{}' } })
const d = preExecute(call('d'))
check('new step resets the failure latch', d.nextCalled === true && d.decision.kind === 'allow', d.decision)
emitResult(call('d'), okResult)

// A successful first call keeps the rest of the batch running.
emitSession(session, { type: 'step/start', data: { turn: 1, step: 3 } })
emitSession(session, { type: 'tool/call', data: { turn: 1, step: 3, callId: 'e', name: 'tool-e', arguments: '{}' } })
emitSession(session, { type: 'tool/call', data: { turn: 1, step: 3, callId: 'f', name: 'tool-f', arguments: '{}' } })
const e = preExecute(call('e'))
emitResult(call('e'), okResult)
const f = preExecute(call('f'))
check('successful first call does not skip the rest', e.nextCalled === true && f.nextCalled === true, { e: e.decision, f: f.decision })

// A later failure skips only the calls after it.
emitSession(session, { type: 'step/start', data: { turn: 1, step: 4 } })
emitSession(session, { type: 'tool/call', data: { turn: 1, step: 4, callId: 'g', name: 'tool-g', arguments: '{}' } })
emitSession(session, { type: 'tool/call', data: { turn: 1, step: 4, callId: 'h', name: 'tool-h', arguments: '{}' } })
emitSession(session, { type: 'tool/call', data: { turn: 1, step: 4, callId: 'i', name: 'tool-i', arguments: '{}' } })
const g = preExecute(call('g'))
emitResult(call('g'), okResult)
const h = preExecute(call('h'))
emitResult(call('h'), errorResult)
const i = preExecute(call('i'))
check('only calls after a later failure are skipped', g.nextCalled === true && h.nextCalled === true && i.nextCalled === false && i.decision.kind === 'deny', { g: g.decision.kind, h: h.decision.kind, i: i.decision.kind })

console.log(failures === 0 ? '\nall smoke checks passed' : `\n${failures} smoke check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
