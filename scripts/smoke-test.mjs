/**
 * dsh-llm-retry-watchdog 冒烟测试：用桩 cordis ctx 驱动 lib/index.js，
 * 验证瞬时错误的升级退避调度器核心行为。
 * 运行：node scripts/smoke-test.mjs
 */
import { apply } from '../lib/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeCtx(config, agentGetter) {
  const handlers = {}
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    agents: { get: agentGetter ?? (() => undefined) },
    on: (event, handler) => {
      handlers[event] = handler
    },
    effect: (setup) => {
      setup()
      return () => {}
    },
    inject: (_deps, fn) => fn({}), // settings/webServer 服务缺失 → 插件走旁路分支
  }
  apply(ctx, config)
  return { ctx, handlers }
}

function makeSession(id) {
  return { id, log: [] }
}

function makeAgent(sessionId) {
  return {
    session: { id: sessionId },
    inbox: { nextTurn: [], nextStep: [] },
    followups: [],
    followup(msg) {
      this.followups.push(msg)
    },
    whenIdle: async () => {},
  }
}

const turnEndError = (turn, code) => ({
  type: 'turn/end',
  data: { turn, reason: { kind: 'error', error: { code } } },
})
const turnEndOk = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'complete' } } })

const BASE_CFG = {
  autoContinue: true,
  continueOnError: true,
  maxContinuations: 8,
  errorRetryScheduleMs: [1000, 2000, 4000],
  errorRetryMaxAttempts: 3,
  maxProviderRetryAfterMs: 60000,
}

let failed = 0
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failed += 1
}

// ── T1: 首次错误 → 延迟 50ms 后投递一次（非即时） ──
{
  const agent = makeAgent('s1')
  const { handlers } = makeCtx({ ...BASE_CFG }, () => agent)
  
  const session = makeSession('s1')
  handlers['session/event'](session, turnEndError(1, 'TIMEOUT'))
  check('T1a 首次错误后未即时投递（等待退避）', agent.followups.length === 0)
  await sleep(400)
  check('T1b 退避未到点仍不投递（1000ms 档）', agent.followups.length === 0)
  await sleep(1400)
  check('T1c 退避 1000ms 到点后投递 1 次', agent.followups.length === 1)
}

// ── T2: 连续错误 → 第二轮用 100ms 档；第 3 次到硬上限停手 ──
{
  const agent = makeAgent('s2')
  const ctxStub = makeCtx({ ...BASE_CFG }, () => agent)
  const handlers = ctxStub.handlers
  
  const session = makeSession('s2')
  handlers['session/event'](session, turnEndError(1, 'TIMEOUT'))
  await sleep(1800)
  handlers['session/event'](session, turnEndError(2, 'TIMEOUT'))
  await sleep(800)
  check('T2a 第二轮 2000ms 档未到，仍 1 次', agent.followups.length === 1)
  await sleep(1800)
  check('T2b 第二轮 2000ms 档到点投递', agent.followups.length === 2)
  handlers['session/event'](session, turnEndError(3, 'SERVER'))
  await sleep(4600)
  check('T2c 第三轮 4000ms 档到点投递', agent.followups.length === 3)
  // 第 4 次错误：attempt 已达硬上限 3 → 不再投递
  handlers['session/event'](session, turnEndError(4, 'SERVER'))
  await sleep(1000)
  check('T2d 硬上限触顶后不再投递', agent.followups.length === 3)
}

// ── T3: 错误链中人工发言 → 定时器销毁、不再投递 ──
{
  const agent = makeAgent('s3')
  const { handlers } = makeCtx({ ...BASE_CFG }, () => agent)
  
  const session = makeSession('s3')
  handlers['session/event'](session, turnEndError(1, 'TIMEOUT'))
  handlers['session/event'](
    session,
    { type: 'user/message', data: { source: { kind: 'user' } } },
  )
  await sleep(1800)
  check('T3 人工发言撤销待发重试', agent.followups.length === 0)
}

// ── T4: 错误后成功回合 → 链清零，后续错误从 50ms 档重新开始 ──
{
  const agent = makeAgent('s4')
  const { handlers } = makeCtx({ ...BASE_CFG }, () => agent)
  
  const session = makeSession('s4')
  handlers['session/event'](session, turnEndError(1, 'TIMEOUT'))
  await sleep(1800) // 第 1 次投递（attempt=1）
  handlers['session/event'](session, turnEndOk(2)) // 成功回合 → 清零
  handlers['session/event'](session, turnEndError(3, 'TIMEOUT')) // 新链
  await sleep(400)
  check('T4a 成功后新错误链从首档开始（1000ms 未到）', agent.followups.length === 1)
  await sleep(1800)
  check('T4b 新链首档到点投递（attempt 计数已重置）', agent.followups.length === 2)
}

// ── T5: 截断（max-tokens）仍走即时链式，不受错误调度影响 ──
{
  const agent = makeAgent('s5')
  const { handlers } = makeCtx({ ...BASE_CFG }, () => agent)
  
  const session = makeSession('s5')
  session.log.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } })
  handlers['session/event'](session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'max-tokens' } },
  })
  await sleep(30)
  check('T5 截断即时续写不受退避影响', agent.followups.length === 1)
}

// ── T6: inbox 忙 → 让位不投递 ──
{
  const agent = makeAgent('s6')
  agent.inbox.nextTurn = [{ fake: true }] // inboxBusy 检查 nextTurn/nextStep 队列
  const { handlers } = makeCtx({ ...BASE_CFG }, () => agent)
  
  const session = makeSession('s6')
  handlers['session/event'](session, turnEndError(1, 'TIMEOUT'))
  await sleep(1800)
  check('T6 inbox 忙时让位（0 投递）', agent.followups.length === 0)
}

// ── T7: 确定性错误（QUOTA）不触发看门狗 ──
{
  const agent = makeAgent('s7')
  const { handlers } = makeCtx({ ...BASE_CFG }, () => agent)
  
  const session = makeSession('s7')
  handlers['session/event'](session, turnEndError(1, 'QUOTA_EXCEEDED'))
  await sleep(1800)
  check('T7 确定性错误不投递', agent.followups.length === 0)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
