/**
 * dsh-subagent-model-routing — 按任务难度为子代理（subagent）自动选择模型与思考深度
 *
 * 这是一个自包含的 Cordis 插件（纯 ESM，无任何依赖导入，可被任意 dsh
 * profile 直接加载）。它挂在 HOST 平面的根组合上，因此对所有 agent preset
 * （包括标准模式）生效：子代理由 spawn / fork / workflow / ralph 等在进程内
 * 创建时，都会经过相同的 agent 事件流。
 *
 * 工作原理
 * --------
 * 1. `agent/created`：进程内的每个子代理发布时（其 options.subagentDepth 已
 *    被 resolveChildAgentOptions 打上深度标记），为它安装一份"模型选择引用"：
 *    在子代理自己的作用域上注册 `system-prompt/assemble` 与 `agent/request`
 *    两个 waterfall 监听器（与 dsh 内置 installModelSelection 语义一致）。
 * 2. `agent/inbox/inserted`：子代理收到任务消息（首次递送即创建时的任务）时，
 *    用启发式规则对任务文本打分分级（easy / medium / hard），并从配置的
 *    tiers 预设中解析出 { provider, model, reasoningEffort }，写入该子代理的
 *    选择引用。
 * 3. 子代理的每一步模型请求都会经过 `agent/request`：监听器把上一步拿到的
 *    默认路由（继承自父代理）替换为所选 tier 的 provider/model/thinking
 *    深度；`system-prompt/assemble` 同时修正 persona 中的 {{model}} 变量。
 * 4. `agent/disposed`：拆除该子代理身上的监听器；分级结果按 session id 记住，
 *    因此可续跑子代理（continuable）冷恢复后仍沿用创建时的档位。
 *
 * 覆盖范围：所有进程内子代理（spawn、fork、workflow worker、ralph 子代理）。
 * 进程外 provider（acp / codex / claude-code / dsh-sdk）的子代理不在本进程
 * 内创建 agent，本插件不会（也无法）介入，会自动跳过。
 *
 * 设置集成：在 dsh 环境中会注册 `dsh-subagent-model-routing` 设置命名空间，浏览器半
 * （dsh-subagent-model-routing-client.js）在设置页提供「子代理路由 / subagent
 * routing」独立配置面板，保存后写入 settings.yaml 并热生效（下个 subagent
 * 即用新档位）。cordis.patch.yml 里的 config 仍是基准层：面板里清除某个字段时
 * 回落到它。
 *
 * 配置（全部可选，缺省用默认值）：
 *   tiers:           { easy, medium, hard } → { provider?, model?, reasoningEffort? }
 *                    缺省字段沿用子代理继承的父级路由；reasoningEffort 省略时
 *                    清除继承的深度、回到该模型适配器的默认行为。
 *   hardThreshold:   分数 >= 此值判为 hard（默认 3）
 *   easyThreshold:   分数 <= 此值判为 easy（默认 -1）
 *   reclassify:      'first'（默认，仅首次递送分级）| 'every'（每条后续消息重分级）
 *   logFile:         可选；每次分级与插件装载/卸载时向该文件追加一行 JSON，
 *                    便于在看不到应用控制台时排查（写入失败仅告警、不影响功能）。
 */

export const name = 'dsh-subagent-model-routing'

import { appendFileSync } from 'node:fs'

// 设置集成（可选）：在 dsh 环境中解析 @deepseek-ai/dsh-settings 与 schemastery，
// 注册 `dsh-subagent-model-routing` 设置命名空间 —— 设置页的「子代理路由」面板会通过它
// 编辑三档预设并写入 settings.yaml（热生效）。导入失败（例如本插件在独立脚本
// 里单测）时静默降级为纯 patch 配置，功能不受影响。
let settingsApi
let schemastery
try {
  settingsApi = await import('@deepseek-ai/dsh-settings')
} catch {
  settingsApi = undefined
}
try {
  const mod = await import('@deepseek-ai/schemastery')
  schemastery = mod.default ?? mod
} catch {
  schemastery = undefined
}

/** 设置命名空间：面板与 Host 半侧配对的键。 */
const SETTINGS_NS = settingsApi === undefined ? 'dsh-subagent-model-routing' : settingsApi.settingsNamespace('dsh-subagent-model-routing')

const TIER_NAMES = ['easy', 'medium', 'hard']
const EFFORTS = ['off', 'low', 'high', 'max']

const DEFAULTS = {
  tiers: {
    easy: { reasoningEffort: 'low' },
    medium: { reasoningEffort: 'high' },
    hard: { reasoningEffort: 'max' },
  },
  hardThreshold: 3,
  easyThreshold: -1,
  reclassify: 'first',
}

/** 指向"任务复杂"的信号词（英文，匹配小写化后的文本子串）。 */
const HARD_HINTS = [
  'refactor', 'redesign', 'rewrite', 'migrat', 'rearchitect', 'architectur',
  'debug', 'troubleshoot', 'race condition', 'deadlock', 'concurren', 'thread-saf',
  'memory leak', 'performance', 'optimiz', 'bottleneck',
  'security', 'vulnerab', 'exploit', 'inject', 'authenticat', 'encrypt', 'cryptograph',
  'from scratch', 'implement', 'design', 'develop',
  'analyz', 'analys', 'investigat', 'audit', 'review', 'verify', 'validat',
  'production', 'robust', 'comprehensive', 'thorough', 'careful',
  'multi-file', 'multi-step', 'cross-module', 'distributed',
  'reverse engineer', 'crash', 'flaky', 'heisen',
  'complex', 'challenging', 'difficult',
  'workflow', 'orchestrat', 'pipeline', 'at scale',
  'adversarial', 'edge case', 'corner case', 'deep dive', 'research',
  'algorithm', 'compiler', 'kernel', 'scheduler',
]

/** 指向"任务简单"的信号词。 */
const EASY_HINTS = [
  'rename', 'read ', 'list ', 'format', 'spelling', 'typo', 'comment',
  'print ', 'one-line', 'single line', 'simple', 'trivial', 'quick',
  'small', 'minor', 'cosmetic', 'translate', 'summariz', 'explain',
  'what does', 'look up', 'lookup', 'grep', 'cat ',
]

/** 中文：复杂信号。 */
const HARD_HINTS_ZH = [
  '重构', '重写', '迁移', '移植', '架构', '调试', '排障', '排查',
  '并发', '死锁', '竞态', '内存泄漏', '泄漏', '性能', '优化', '瓶颈',
  '安全', '漏洞', '注入', '鉴权', '加密', '认证', '从零', '实现', '设计', '开发',
  '分析', '调查', '审查', '审计', '验证', '生产', '健壮', '全面', '彻底', '仔细',
  '多文件', '多模块', '多步骤', '跨模块', '分布式', '逆向', '崩溃',
  '复杂', '困难', '棘手', '挑战', '流程', '编排', '规模', '对抗',
  '边界情况', '边缘情况', '深入', '研究', '算法', '编译', '内核', '调度',
]

/** 中文：简单信号。 */
const EASY_HINTS_ZH = [
  '重命名', '列出', '格式化', '拼写', '错别字', '注释', '打印', '一行',
  '简单', '琐碎', '快速', '翻译', '总结', '解释', '查找', '查看',
  '读一下', '看看', '找一下',
]

/**
 * 对任务文本做启发式打分。
 * @param {string} text - 任务文本（子代理首次递送消息的全部文本块拼接）。
 * @param {{ hardThreshold?: number, easyThreshold?: number }} [options]
 * @returns {{ tier: 'easy'|'medium'|'hard', score: number }}
 */
export function classify(text, options = {}) {
  const hardThreshold = options.hardThreshold ?? DEFAULTS.hardThreshold
  const easyThreshold = options.easyThreshold ?? DEFAULTS.easyThreshold
  const lower = String(text ?? '').toLowerCase()
  let score = 0
  for (const hint of HARD_HINTS) if (lower.includes(hint)) score += 1
  for (const hint of EASY_HINTS) if (lower.includes(hint)) score -= 1
  for (const hint of HARD_HINTS_ZH) if (lower.includes(hint)) score += 1
  for (const hint of EASY_HINTS_ZH) if (lower.includes(hint)) score -= 1
  const length = lower.length
  if (length >= 2000) score += 2
  else if (length >= 800) score += 1
  else if (length <= 120) score -= 1
  const tier = score >= hardThreshold ? 'hard' : score <= easyThreshold ? 'easy' : 'medium'
  return { tier, score }
}

/**
 * 提取消息中的纯文本（用于分级）。
 * @param {{ content?: Array<{ type?: string, text?: unknown }> }} message
 * @returns {string}
 */
export function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/** 判断一个 agent 是否为进程内子代理。 */
function isSubagent(agent) {
  if (agent?.options?.subagentDepth !== undefined) return true
  const meta = agent?.session?.header?.meta
  return typeof meta === 'object' && meta !== null && meta.origin === 'subagent'
}

/**
 * 把用户配置合并为最终配置；非法字段回退默认值并告警（用户 patch 挂在
 * 整个应用的根组合上，宁可软失败也不要让应用启动失败）。
 * @param {unknown} raw - 插件配置。
 * @param {{ warn(message: string): void }} logger
 * @returns {object} 规范化后的配置。
 */
export function normalizeConfig(raw, logger) {
  const config = { ...DEFAULTS, ...(typeof raw === 'object' && raw !== null ? raw : {}) }
  config.tiers = { ...DEFAULTS.tiers, ...(typeof raw?.tiers === 'object' && raw?.tiers !== null ? raw.tiers : {}) }
  for (const key of Object.keys(config.tiers)) {
    if (!TIER_NAMES.includes(key)) {
      logger.warn(`[dsh-subagent-model-routing] 未知难度档位 "${key}"（应为 easy/medium/hard），已忽略`)
      delete config.tiers[key]
      continue
    }
    const tier = config.tiers[key]
    if (typeof tier !== 'object' || tier === null) {
      logger.warn(`[dsh-subagent-model-routing] tiers.${key} 不是对象，已回退默认值`)
      config.tiers[key] = { ...DEFAULTS.tiers[key] }
      continue
    }
    for (const [field, value] of Object.entries(tier)) {
      if (field === 'reasoningEffort') {
        if (value !== undefined && !EFFORTS.includes(value)) {
          logger.warn(`[dsh-subagent-model-routing] tiers.${key}.reasoningEffort 应为 ${EFFORTS.join('/')}，收到 "${value}"，已忽略该字段`)
          delete tier[field]
        }
      } else if (field === 'provider' || field === 'model') {
        if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
          logger.warn(`[dsh-subagent-model-routing] tiers.${key}.${field} 应为非空字符串，已忽略该字段`)
          delete tier[field]
        }
      } else {
        logger.warn(`[dsh-subagent-model-routing] tiers.${key} 出现未知字段 "${field}"，已忽略`)
        delete tier[field]
      }
    }
  }
  for (const field of ['hardThreshold', 'easyThreshold']) {
    if (!Number.isFinite(config[field])) {
      logger.warn(`[dsh-subagent-model-routing] ${field} 应为数字，收到 ${JSON.stringify(config[field])}，已回退默认值 ${DEFAULTS[field]}`)
      config[field] = DEFAULTS[field]
    }
  }
  if (config.hardThreshold <= config.easyThreshold) {
    logger.warn(`[dsh-subagent-model-routing] hardThreshold(${config.hardThreshold}) 必须大于 easyThreshold(${config.easyThreshold})，已回退默认值`)
    config.hardThreshold = DEFAULTS.hardThreshold
    config.easyThreshold = DEFAULTS.easyThreshold
  }
  if (config.reclassify !== 'first' && config.reclassify !== 'every') {
    logger.warn(`[dsh-subagent-model-routing] reclassify 应为 first/every，收到 "${config.reclassify}"，已回退 "first"`)
    config.reclassify = 'first'
  }
  if (config.logFile !== undefined && (typeof config.logFile !== 'string' || config.logFile === '')) {
    logger.warn(`[dsh-subagent-model-routing] logFile 应为非空字符串，收到 ${JSON.stringify(config.logFile)}，已忽略`)
    delete config.logFile
  }
  return config
}

/**
 * 向可选 logFile 追加一行诊断 JSON（尽力而为，绝不抛出）。
 * @param {string | undefined} logFile
 * @param {object} record
 */
function trace(logFile, record) {
  if (typeof logFile !== 'string' || logFile === '') return
  try {
    appendFileSync(logFile, JSON.stringify({ time: Date.now(), ...record }) + '\n')
  } catch {
    // 诊断通道不可用时静默：功能本身不受影响。
  }
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 */
export function apply(ctx, config) {
  // 组合层（cordis.patch.yml）的配置是「基准层」；设置文档里的用户层叠在它
  // 之上（installSettingsSection 负责解析合并）。决策时实时读取 effective()，
  // 所以设置页保存后下一个子代理立即用新档位，无需重启或改 patch。
  const entry = normalizeConfig(config, ctx.logger)
  let source = () => entry
  const effective = () => normalizeConfig({ ...source(), logFile: entry.logFile }, ctx.logger)

  if (settingsApi !== undefined && schemastery !== undefined) {
    const TierSchema = schemastery.object({
      provider: schemastery.string(),
      model: schemastery.string(),
      reasoningEffort: schemastery.union(['off', 'low', 'high', 'max']),
    })
    const SettingsSchema = schemastery.object({
      tiers: schemastery.object({
        easy: TierSchema,
        medium: TierSchema,
        hard: TierSchema,
      }),
      hardThreshold: schemastery.number(),
      easyThreshold: schemastery.number(),
      reclassify: schemastery.union(['first', 'every']),
    })
    settingsApi.installSettingsSection(ctx, SETTINGS_NS, SettingsSchema, entry, {
      setSource: (current) => { source = current },
      // 决策都在事件发生时用 effective() 现场读取，无需在变更时重建任何东西。
      onChange: () => {},
      validate: (value) => {
        if (typeof value.hardThreshold === 'number' && typeof value.easyThreshold === 'number'
          && value.hardThreshold <= value.easyThreshold) {
          throw new Error('hardThreshold 必须大于 easyThreshold')
        }
      },
    })
  }

  trace(entry.logFile, {
    event: 'mounted',
    tiers: entry.tiers,
    hardThreshold: entry.hardThreshold,
    easyThreshold: entry.easyThreshold,
    reclassify: entry.reclassify,
  })

  /** sessionId(String) → 创建时确定的分级与选择；跨 agent 生命周期保留（冷恢复沿用）。 */
  const tiersBySession = new Map()
  /** sessionId(String) → 当前活着的安装 { ref, dispose }。 */
  const live = new Map()

  /** 由档位 + 子代理自身路由解析出 ModelSelection；解析不出则返回 undefined。 */
  function selectionFor(tierName, agent) {
    const preset = effective().tiers[tierName] ?? {}
    const provider = preset.provider ?? agent?.options?.provider
    const model = preset.model ?? agent?.options?.model
    if (typeof provider !== 'string' || typeof model !== 'string' || provider === '' || model === '') {
      return undefined
    }
    return {
      provider,
      model,
      ...(preset.reasoningEffort === undefined ? {} : { reasoningEffort: preset.reasoningEffort }),
    }
  }

  /** 为某个子代理安装选择引用（幂等），语义与 dsh 内置 installModelSelection 一致。 */
  function install(agent) {
    const key = String(agent.session.id)
    const existing = live.get(key)
    if (existing !== undefined) return existing
    const ref = { current: undefined, assembled: undefined }
    const disposeAssembly = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const selected = ref.current
      const assembled = await next()
      ref.assembled = selected
      if (selected === undefined) return assembled
      return {
        ...assembled,
        variables: {
          ...(assembled?.variables ?? {}),
          provider: selected.provider,
          model: selected.model,
        },
      }
    })
    const disposeRequest = agent.ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      const selected = ref.assembled
      if (selected === undefined) return resolved
      // 思考深度是软旋钮：所选档位的 reasoningEffort 若不被目标模型支持
      // （例如 kimi k3 不提供 off），退回适配器默认并告警，而不是让整个
      // 子代理请求响亮失败。provider/model 的笔误仍保持响亮失败。
      let effort = selected.reasoningEffort
      if (effort !== undefined) {
        const llm = ctx.get('llm')
        if (llm !== undefined && typeof llm.resolveCallConfig === 'function') {
          try {
            await llm.resolveCallConfig({
              provider: selected.provider,
              model: selected.model,
              reasoningEffort: effort,
            })
          } catch (error) {
            if (error !== null && typeof error === 'object' && error.code === 'UNSUPPORTED_REASONING_EFFORT') {
              ctx.logger.warn(
                `[dsh-subagent-model-routing] ${selected.provider}/${selected.model} 不支持思考深度 ${effort}，`
                + '本次退回该模型的适配器默认值（可在设置页更换档位的思考深度）',
              )
              effort = undefined
            }
          }
        }
      }
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
      return {
        ...withoutInheritedEffort,
        provider: selected.provider,
        model: selected.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      }
    })
    const entry = {
      ref,
      dispose: () => {
        disposeAssembly()
        disposeRequest()
        if (live.get(key) === entry) live.delete(key)
      },
    }
    live.set(key, entry)
    return entry
  }

  /** 事件处理器不允许抛错（agent/created 的同步抛错会否决发布），统一收敛。 */
  function guarded(label, handler) {
    return (...args) => {
      try {
        return handler(...args)
      } catch (error) {
        ctx.logger.warn(`[dsh-subagent-model-routing] ${label} 处理失败: ${String(error)}`)
        return undefined
      }
    }
  }

  ctx.on('agent/created', guarded('agent/created', ({ agent }) => {
    if (!isSubagent(agent)) return
    const entry = install(agent)
    const remembered = tiersBySession.get(String(agent.session.id))
    if (remembered !== undefined) entry.ref.current = remembered.selection
  }))

  ctx.on('agent/inbox/inserted', guarded('agent/inbox/inserted', ({ agent, message }) => {
    if (!isSubagent(agent)) return
    const key = String(agent.session.id)
    const entry = install(agent)
    const remembered = tiersBySession.get(key)
    if (effective().reclassify !== 'every' && remembered !== undefined) {
      // 已分级（创建时或冷恢复后），沿用既有档位。
      entry.ref.current = remembered.selection
      return
    }
    const text = textOf(message)
    const decision = classify(text, effective())
    const selection = selectionFor(decision.tier, agent)
    tiersBySession.set(key, { tier: decision.tier, selection })
    entry.ref.current = selection
    if (selection === undefined) {
      ctx.logger.warn(
        `[dsh-subagent-model-routing] 子代理 ${key} 分级为 ${decision.tier}（分数 ${decision.score}），`
        + '但档位与父级路由都未提供 provider/model，本次不干预路由',
      )
      trace(effective().logFile, { event: 'classified', sessionId: key, tier: decision.tier, score: decision.score, selection: null })
      return
    }
    ctx.logger.info(
      `[dsh-subagent-model-routing] 子代理 ${key} 分级 ${decision.tier}（分数 ${decision.score}）→ `
      + `${selection.provider}/${selection.model}`
      + (selection.reasoningEffort === undefined ? '' : `，思考深度 ${selection.reasoningEffort}`)
      + `（任务前 80 字: ${text.slice(0, 80).replaceAll('\n', ' ')}）`,
    )
    trace(effective().logFile, { event: 'classified', sessionId: key, tier: decision.tier, score: decision.score, selection })
  }))

  ctx.on('agent/disposed', guarded('agent/disposed', ({ agent }) => {
    const entry = live.get(String(agent.session.id))
    if (entry !== undefined) entry.dispose()
  }))
}

// 不要加 export default：cordis Loader 的 unwrapExports 优先取 .default，
// 会丢弃 name/inject 等具名导出（见 deepseek-harness postmortem 0001）。
