/**
 * dsh-subagent-model-routing 的测试：
 * 1. classify / textOf / normalizeConfig 的纯逻辑单测（无外部依赖）。
 * 2. 用真实 cordis 模拟 scope 事件分发，验证监听器接线：
 *    - 子代理创建后，其 agent/request 的默认路由被替换为按难度选择的
 *      provider/model/reasoningEffort；
 *    - system-prompt/assemble 的 variables 注入 {{model}}；
 *    - reclassify: 'first' 时后续消息不重分级、'every' 时重分级；
 *    - agent/disposed 后监听器拆除（恢复透传）；
 *    - 非子代理（普通 agent）不受影响。
 *
 * 运行：node --test test/host.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply as pluginApply,
  classify,
  textOf,
  normalizeConfig,
} from '../index.js'

// 接线测试需要真实的 cordis Context 来模拟 scope 事件分发。从本地
// deepseek-harness checkout（或任意可达路径）通过 DSH_CORDIS_CONTEXT 环境变量
// 加载；加载失败时跳过接线块，只跑纯逻辑用例（classify / textOf / normalizeConfig）。
let Context
let hasContext = true
try {
  const mod = await import(
    process.env.DSH_CORDIS_CONTEXT
      ?? 'file:///Users/chengj/Developer/repo/deepseek-harness/vendor/cordis/lib/index.js'
  )
  Context = mod.Context
} catch {
  hasContext = false
}

const plugin = { name: 'dsh-subagent-model-routing', apply: pluginApply }

// ── 纯逻辑 ────────────────────────────────────────────────────────────────

test('classify: 短小简单任务判为 easy', () => {
  assert.equal(classify('把这个变量重命名一下').tier, 'easy')
  assert.equal(classify('list the files in this directory').tier, 'easy')
  assert.equal(classify('读一下这个文件并简单总结').tier, 'easy')
})

test('classify: 复杂重构/安全/并发任务判为 hard', () => {
  assert.equal(classify(
    '重构整个认证模块：迁移到新的密钥架构，做一次安全审计并排查并发死锁问题',
  ).tier, 'hard')
  assert.equal(classify(
    'Debug a flaky race condition in the scheduler, redesign the locking, '
    + 'and verify the fix with adversarial edge cases across the distributed pipeline',
  ).tier, 'hard')
})

test('classify: 中等任务判为 medium', () => {
  assert.equal(classify('给模块补充单元测试并修复几处边界情况').tier, 'medium')
  assert.equal(classify('为登录页增加表单校验，覆盖重复提交与边界情况').tier, 'medium')
})

test('classify: 长文任务加分', () => {
  const longTask = '请浏览这份文档并给出你的评论。'.repeat(200) // 约 3000 字，无任何关键词
  assert.equal(classify(longTask).tier, 'medium') // 0 + 2(长度) = 2
  assert.equal(classify('看看这个').tier, 'easy')
})

test('classify: 阈值可配置', () => {
  const text = '实现一个简单的命令行工具并做格式化输出'
  // 默认：实现+1、简单-1、格式化-1 = -1 → easy
  assert.equal(classify(text).tier, 'easy')
  // 提高 easyThreshold：-1 <= -5 不成立 → medium
  assert.equal(classify(text, { easyThreshold: -5, hardThreshold: 3 }).tier, 'medium')
})

test('textOf: 拼接文本块', () => {
  assert.equal(textOf({
    content: [
      { type: 'text', text: '第一段' },
      { type: 'tool-call', name: 'x' },
      { type: 'text', text: '第二段' },
    ],
  }), '第一段\n第二段')
  assert.equal(textOf({ content: [] }), '')
  assert.equal(textOf(undefined), '')
})

test('normalizeConfig: 非法字段回退默认并告警', () => {
  const warnings = []
  const logger = { warn: message => warnings.push(message) }
  const config = normalizeConfig({
    tiers: {
      easy: { reasoningEffort: 'ultra' },
      weird: { reasoningEffort: 'low' },
      hard: { provider: 42 },
    },
    hardThreshold: 1,
    easyThreshold: 2,
    reclassify: 'sometimes',
  }, logger)
  assert.deepEqual(config.tiers.easy, {})
  assert.equal(config.tiers.weird, undefined)
  assert.deepEqual(config.tiers.hard, {})
  assert.deepEqual(config.tiers.medium, { reasoningEffort: 'high' })
  assert.equal(config.hardThreshold, 3)
  assert.equal(config.easyThreshold, -1)
  assert.equal(config.reclassify, 'first')
  assert.ok(warnings.length >= 4, `应产生至少 4 条告警，实际 ${warnings.length}`)
})

// ── cordis 接线模拟 ────────────────────────────────────────────────────────

/** 与 dsh-scope 相同的两级作用域模拟。 */
const kScope = Symbol('test.scope')
const scopeParents = new Map()

function carrierOf(key) {
  return {
    [Context.filter](ctx) {
      const tag = ctx[kScope]
      if (tag === undefined) return true
      for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) {
        if (cursor === tag) return true
      }
      return false
    },
  }
}

function makeScope(root, key, parentKey) {
  if (parentKey !== undefined) scopeParents.set(key, parentKey)
  return {
    ctx: root.extend({ [kScope]: key }),
    carrier: carrierOf(key),
  }
}

function makeAgent(scope, { id = 'child-1', subagent = true } = {}) {
  const options = subagent
    ? { provider: 'parent-provider', model: 'parent-model', subagentDepth: 1 }
    : { provider: 'parent-provider', model: 'parent-model' }
  return {
    ctx: scope.ctx,
    options,
    session: {
      id,
      header: { meta: subagent ? { origin: 'subagent' } : {} },
    },
  }
}

function taskMessage(text) {
  return { content: [{ type: 'text', text }], role: 'user' }
}

async function boot(config = {}) {
  const root = new Context()
  await root.plugin(plugin, config)
  return root
}

/** 对某个 scope 触发一次请求 waterfall，返回最终 call config。 */
async function requestConfig(root, scope, seed) {
  return root.waterfall(scope.carrier, 'agent/request', { turn: 1, step: 1 }, () => seed)
}

/** 先跑一次 system-prompt/assemble（真实循环中组装先于请求，选择快照在组装时落定）。 */
async function assemble(root, scope) {
  return root.waterfall(
    scope.carrier,
    'system-prompt/assemble',
    {},
    {},
    () => ({ variables: { cwd: '/x' } }),
  )
}

test('接线：子代理的请求路由被替换为所选档位', { skip: !hasContext }, async () => {
  const root = await boot()
  const standing = {}
  const child = makeScope(root, {}, standing)
  const agent = makeAgent(child)

  root.emit(child.carrier, 'agent/created', { agent })
  root.emit(child.carrier, 'agent/inbox/inserted', {
    agent,
    message: taskMessage('重构整个认证模块并做安全审计（hard）'),
  })
  await assemble(root, child)

  const config = await requestConfig(root, child, {
    provider: 'parent-provider',
    model: 'parent-model',
    maxTokens: 4096,
  })
  assert.deepEqual(config, {
    provider: 'parent-provider',
    model: 'parent-model',
    maxTokens: 4096,
    reasoningEffort: 'max', // hard 档默认 max
  })
})

test('接线：tier 指定的 provider/model 生效，并清除继承的思考深度', { skip: !hasContext }, async () => {
  const root = await boot({
    tiers: {
      easy: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
    },
  })
  const child = makeScope(root, {}, {})
  const agent = makeAgent(child)

  root.emit(child.carrier, 'agent/created', { agent })
  root.emit(child.carrier, 'agent/inbox/inserted', {
    agent,
    message: taskMessage('把变量重命名一下（easy）'),
  })
  await assemble(root, child)

  const config = await requestConfig(root, child, {
    provider: 'parent-provider',
    model: 'parent-model',
    reasoningEffort: 'max', // 继承来的深度应被 tier 的 low 替换
  })
  assert.deepEqual(config, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'low',
  })
})

test('接线：system-prompt/assemble 注入 {{model}} 变量', { skip: !hasContext }, async () => {
  const root = await boot()
  const child = makeScope(root, {}, {})
  const agent = makeAgent(child)

  root.emit(child.carrier, 'agent/created', { agent })
  root.emit(child.carrier, 'agent/inbox/inserted', {
    agent,
    message: taskMessage('重写网络协议层（hard）'),
  })

  const assembled = await root.waterfall(
    child.carrier,
    'system-prompt/assemble',
    {},
    {},
    () => ({ variables: { cwd: '/x' }, text: 'persona {{model}}' }),
  )
  assert.deepEqual(assembled, {
    variables: { cwd: '/x', provider: 'parent-provider', model: 'parent-model' },
    text: 'persona {{model}}',
  })
})

test('接线：reclassify=first 时后续消息沿用首次档位', { skip: !hasContext }, async () => {
  const root = await boot()
  const child = makeScope(root, {}, {})
  const agent = makeAgent(child)

  root.emit(child.carrier, 'agent/created', { agent })
  root.emit(child.carrier, 'agent/inbox/inserted', {
    agent,
    message: taskMessage('重构整个认证模块并做安全审计（hard）'),
  })
  root.emit(child.carrier, 'agent/inbox/inserted', {
    agent,
    message: taskMessage('continue（这条很短，若重分级会变 easy）'),
  })
  await assemble(root, child)

  const config = await requestConfig(root, child, {
    provider: 'parent-provider',
    model: 'parent-model',
  })
  assert.equal(config.reasoningEffort, 'max')
})

test('接线：reclassify=every 时后续消息重新分级', { skip: !hasContext }, async () => {
  const root = await boot({ reclassify: 'every' })
  const child = makeScope(root, {}, {})
  const agent = makeAgent(child)

  root.emit(child.carrier, 'agent/created', { agent })
  root.emit(child.carrier, 'agent/inbox/inserted', {
    agent,
    message: taskMessage('重构整个认证模块并做安全审计（hard）'),
  })
  root.emit(child.carrier, 'agent/inbox/inserted', {
    agent,
    message: taskMessage('把日志里的拼写改一下（easy）'),
  })
  await assemble(root, child)

  const config = await requestConfig(root, child, {
    provider: 'parent-provider',
    model: 'parent-model',
  })
  assert.equal(config.reasoningEffort, 'low')
})

test('接线：agent/disposed 后监听器拆除，请求恢复透传', { skip: !hasContext }, async () => {
  const root = await boot()
  const child = makeScope(root, {}, {})
  const agent = makeAgent(child)

  root.emit(child.carrier, 'agent/created', { agent })
  root.emit(child.carrier, 'agent/inbox/inserted', {
    agent,
    message: taskMessage('实现一个分布式调度器（hard）'),
  })
  root.emit(child.carrier, 'agent/disposed', { agent })

  const config = await requestConfig(root, child, {
    provider: 'parent-provider',
    model: 'parent-model',
  })
  assert.deepEqual(config, { provider: 'parent-provider', model: 'parent-model' })
})

test('接线：普通（非子）代理不受影响', { skip: !hasContext }, async () => {
  const root = await boot()
  const scope = makeScope(root, {}, {})
  const agent = makeAgent(scope, { id: 'parent-1', subagent: false })

  root.emit(scope.carrier, 'agent/created', { agent })
  root.emit(scope.carrier, 'agent/inbox/inserted', {
    agent,
    message: taskMessage('重构整个认证模块（hard，但这是父代理）'),
  })

  const config = await requestConfig(root, scope, {
    provider: 'parent-provider',
    model: 'parent-model',
  })
  assert.deepEqual(config, { provider: 'parent-provider', model: 'parent-model' })
})

test('接线：路由缺失时不伪造 provider/model（透传）', { skip: !hasContext }, async () => {
  const root = await boot()
  const child = makeScope(root, {}, {})
  const agent = {
    ctx: child.ctx,
    options: { subagentDepth: 1 }, // 无 provider/model
    session: { id: 'routeless-child', header: { meta: { origin: 'subagent' } } },
  }

  root.emit(child.carrier, 'agent/created', { agent })
  root.emit(child.carrier, 'agent/inbox/inserted', {
    agent,
    message: taskMessage('重构整个认证模块并做安全审计（hard）'),
  })

  const config = await requestConfig(root, child, { provider: 'x', model: 'y' })
  assert.deepEqual(config, { provider: 'x', model: 'y' })
})

test('接线：模型不支持所选思考深度时优雅退回适配器默认', { skip: !hasContext }, async () => {
  const root = await boot({
    tiers: { easy: { reasoningEffort: 'off' } },
  })
  root.provide('llm', {
    resolveCallConfig: async (config) => {
      if (config.reasoningEffort === 'off') {
        const error = new Error('unsupported')
        error.code = 'UNSUPPORTED_REASONING_EFFORT'
        throw error
      }
      return config
    },
  })
  const child = makeScope(root, {}, {})
  const agent = makeAgent(child)

  root.emit(child.carrier, 'agent/created', { agent })
  root.emit(child.carrier, 'agent/inbox/inserted', {
    agent,
    message: taskMessage('把变量重命名一下（easy → 档位 off）'),
  })
  await assemble(root, child)

  const config = await requestConfig(root, child, {
    provider: 'parent-provider',
    model: 'parent-model',
  })
  // off 被 llm 拒绝 → 从请求配置中移除，退回适配器默认，而不是响亮失败。
  assert.deepEqual(config, { provider: 'parent-provider', model: 'parent-model' })
})
