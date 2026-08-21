/**
 * dsh-subagent-model-routing 的浏览器半 —— 设置页「插件配置」标签页的卡片 bundle。
 *
 * 惰性 CJS factory 格式（与仓库 tsdown clientBundle 预设产物一致）：执行脚本
 * 只注册 factory，模块副作用全部在物化时运行。运行时只依赖平台种子模块
 * （react/jsx-runtime 与 react），无任何跨插件值导入，满足 bundle 纯净度门禁。
 * 卡片自持全部表单逻辑（暂存、revision 设栅、覆盖标记）。
 *
 * Provider / 模型 / 思考深度都是下拉选择：Provider 与模型选项来自 Host 的
 * `llm.models` 模型目录（与对话里的模型选择同一数据源），思考深度选项在选定
 * 具体模型时收敛为该模型实际提供的档位。留空（"继承"）语义不变。
 */

window.__ModuleLoader__.load({
	id: 'dsh-subagent-model-routing',
	factory: (require) => {
		const { jsx, jsxs } = require('react/jsx-runtime')
		const React = require('react')

		const name = 'ui-dsh-subagent-model-routing'
		const inject = ['slots', 'locale', 'settingsScope', 'connection', 'remote']
		const NS = 'settings.subagentModelRouting'
		const NAMESPACE = 'dsh-subagent-model-routing'

		const TIERS = ['easy', 'medium', 'hard']
		const EFFORTS = ['off', 'low', 'high', 'max']

		// ── 文案（zh / en）────────────────────────────────────────────────────
		const zh = {
			title: '子代理路由',
			description: '按子代理任务难度自动选择预设的模型与思考深度。留空（继承）沿用子代理继承的父级路由；清除某个字段即恢复继承。',
			tier: { easy: '简单任务', medium: '中等任务', hard: '困难任务' },
			provider: 'Provider',
			model: '模型',
			effort: '思考深度',
			inheritProvider: '继承（沿用父级路由）',
			inheritModel: '继承（沿用父级路由）',
			inheritEffort: '默认（适配器默认）',
			catalogLoading: '正在加载模型目录…',
			catalogFailed: '模型目录加载失败，仍可保留当前值：{message}',
			hardThreshold: 'hard 分数线（分数 ≥ 此值判为困难）',
			easyThreshold: 'easy 分数线（分数 ≤ 此值判为简单）',
			reclassify: '后续消息重分级',
			reclassifyFirst: '仅创建时分级（first）',
			reclassifyEvery: '每条消息重分级（every）',
			save: '保存',
			discard: '放弃修改',
			overridden: '已覆盖',
			invalidNumber: '不是有效数字',
			saveFailed: '保存未生效（Host 拒绝了写入，或与其它写入冲突），请重试。',
			unavailable: 'Host 未挂载 dsh-subagent-model-routing 插件。',
		}
		const en = {
			title: 'subagent routing',
			description: 'Route subagents to preset models and reasoning efforts by task difficulty. Blank (inherit) fields follow the parent route; clearing a field restores inheritance.',
			tier: { easy: 'Easy tasks', medium: 'Medium tasks', hard: 'Hard tasks' },
			provider: 'Provider',
			model: 'Model',
			effort: 'Reasoning effort',
			inheritProvider: 'Inherit (parent route)',
			inheritModel: 'Inherit (parent route)',
			inheritEffort: 'Default (adapter default)',
			catalogLoading: 'Loading the model catalog…',
			catalogFailed: 'The model catalog failed to load; current values stay selectable: {message}',
			hardThreshold: 'Hard threshold (score ≥ this is hard)',
			easyThreshold: 'Easy threshold (score ≤ this is easy)',
			reclassify: 'Reclassify follow-ups',
			reclassifyFirst: 'Only at creation (first)',
			reclassifyEvery: 'On every message (every)',
			save: 'Save',
			discard: 'Discard',
			overridden: 'Overridden',
			invalidNumber: 'Not a valid number',
			saveFailed: 'The save did not land (the Host rejected the write, or it raced another write). Try again.',
			unavailable: 'The dsh-subagent-model-routing plugin is not mounted on the Host.',
		}

		// ── 极简可观察 store（HostObservable：getSnapshot + subscribe）────────
		function createStore(initial) {
			let state = initial
			const listeners = new Set()
			return {
				getSnapshot: () => state,
				subscribe: (fn) => {
					listeners.add(fn)
					return () => { listeners.delete(fn) }
				},
				set: (next) => {
					state = next
					for (const fn of [...listeners]) fn()
				},
			}
		}

		/** 由 snapshot 的 user 层判断字段是否被覆盖（按「出现」而非按值）。 */
		function userHas(user, field) {
			return typeof user === 'object' && user !== null && Object.prototype.hasOwnProperty.call(user, field)
		}

		/** JSON 形状值的深比较（键序无关），用于写后读回校验。 */
		function deepEqual(a, b) {
			if (Object.is(a, b)) return true
			if (typeof a !== typeof b) return false
			if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
				if (Array.isArray(a) !== Array.isArray(b)) return false
				if (Array.isArray(a)) {
					if (a.length !== b.length) return false
					for (let i = 0; i < a.length; i++) {
						if (!deepEqual(a[i], b[i])) return false
					}
					return true
				}
				const keysA = Object.keys(a)
				const keysB = Object.keys(b)
				if (keysA.length !== keysB.length) return false
				for (const key of keysA) {
					if (!Object.prototype.hasOwnProperty.call(b, key)) return false
					if (!deepEqual(a[key], b[key])) return false
				}
				return true
			}
			return false
		}

		/**
		 * 卡片控制器：把设置 scope 投射成卡片快照，自持暂存/保存，并维护
		 * `llm.models` 模型目录（Provider / 模型下拉的数据源）。
		 */
		class CardController {
			constructor(scope, api) {
				this.scope = scope
				this.api = api
				this.staged = new Map() // field -> { kind: 'set'|'clear', value? }
				this.saving = false
				this.failed = false
				this.catalog = { status: 'loading', error: null, groups: [], failures: [] }
				this.catalogGeneration = 0
				this.store = createStore(this.project())
				this.scope.subscribe(() => { this.publish() })
				void this.loadCatalog()
			}

			publish() {
				this.store.set(this.project())
			}

			snapshot() {
				return this.scope.getSnapshot()
			}

			/** 当前有效的 tiers 对象（暂存优先，其次 scope 解析值）。 */
			effectiveTiers() {
				const staged = this.staged.get('tiers')
				if (staged !== undefined) return staged.kind === 'set' ? staged.value : {}
				const value = this.snapshot().value
				return typeof value?.tiers === 'object' && value?.tiers !== null ? value.tiers : {}
			}

			draftOf(field) {
				const staged = this.staged.get(field)
				if (staged !== undefined) return staged
				const value = this.snapshot().value
				return value?.[field] === undefined ? { kind: 'clear' } : { kind: 'set', value: value[field] }
			}

			tierText(tier, field) {
				const value = this.effectiveTiers()[tier]?.[field]
				return value === undefined ? '' : String(value)
			}

			tierOverridden(tier, field) {
				const user = this.snapshot().user
				if (!userHas(user, 'tiers')) return false
				const userTier = user?.tiers?.[tier]
				return typeof userTier === 'object' && userTier !== null
					&& Object.prototype.hasOwnProperty.call(userTier, field)
			}

			numberValid(text) {
				const trimmed = String(text).trim()
				return trimmed === '' || Number.isFinite(Number(trimmed))
			}

			async loadCatalog() {
				const generation = ++this.catalogGeneration
				this.catalog = { ...this.catalog, status: 'loading', error: null }
				this.publish()
				try {
					const response = await this.api.llm.models({})
					if (!response.result.ok) throw new Error(response.result.error.message)
					if (generation !== this.catalogGeneration) return
					this.catalog = {
						status: 'ready',
						error: null,
						groups: response.result.value.groups ?? [],
						failures: response.result.value.failures ?? [],
					}
				} catch (error) {
					if (generation !== this.catalogGeneration) return
					this.catalog = {
						status: 'error',
						error: error instanceof Error ? error.message : String(error),
						groups: [],
						failures: [],
					}
				}
				this.publish()
			}

			/** Provider 下拉选项：目录组 + 目录失败的 provider（禁用）+ 当前草稿值兜底。 */
			providerOptions(draft) {
				const options = []
				for (const group of this.catalog.groups) {
					options.push({ value: group.id, label: `${group.name} (${group.id})`, disabled: false })
				}
				for (const failure of this.catalog.failures) {
					options.push({ value: failure.id, label: `${failure.name} (${failure.id}) — 加载失败`, disabled: true })
				}
				if (draft !== '' && !options.some(option => option.value === draft)) {
					options.push({ value: draft, label: draft, disabled: false })
				}
				return options
			}

			/** 模型下拉选项：所选 provider 组的模型 + 当前草稿值兜底。 */
			modelOptions(draftProvider, draft) {
				const group = this.catalog.groups.find(entry => entry.id === draftProvider)
				if (group === undefined) {
					return draft === '' ? [] : [{ value: draft, label: draft, disabled: false }]
				}
				const options = group.models.map(model => ({
					value: model.id,
					label: model.name !== undefined && model.name !== model.id ? `${model.name} (${model.id})` : model.id,
					disabled: false,
				}))
				if (draft !== '' && !options.some(option => option.value === draft)) {
					options.push({ value: draft, label: draft, disabled: false })
				}
				return options
			}

			/** 思考深度选项：具体模型已知时收敛为其提供的档位，否则给标准四档。 */
			effortOptions(draftProvider, draftModel) {
				const group = this.catalog.groups.find(entry => entry.id === draftProvider)
				const model = group?.models.find(entry => entry.id === draftModel)
				const offered = model?.reasoning?.efforts?.map(entry => entry.id)
				return offered !== undefined && offered.length > 0 ? offered : EFFORTS
			}

			project() {
				const snap = this.snapshot()
				const ready = snap.status === 'ready'
				const hardText = this.draftOf('hardThreshold').value
				const easyText = this.draftOf('easyThreshold').value
				const invalid = !this.numberValid(hardText) || !this.numberValid(easyText)
				const tiers = {}
				for (const tier of TIERS) {
					const provider = this.tierText(tier, 'provider')
					const model = this.tierText(tier, 'model')
					tiers[tier] = {
						provider,
						model,
						effort: this.tierText(tier, 'reasoningEffort'),
						providerOverridden: this.tierOverridden(tier, 'provider'),
						modelOverridden: this.tierOverridden(tier, 'model'),
						effortOverridden: this.tierOverridden(tier, 'reasoningEffort'),
						providerOptions: this.providerOptions(provider),
						modelOptions: this.modelOptions(provider, model),
						effortOptions: this.effortOptions(provider, model),
					}
				}
				return {
					available: ready,
					writable: ready && snap.writable,
					dirty: this.staged.size > 0,
					saving: this.saving,
					failed: this.failed,
					invalid,
					catalog: this.catalog,
					tiers,
					hardThreshold: hardText === undefined ? '' : String(hardText),
					hardOverridden: userHas(this.snapshot().user, 'hardThreshold'),
					easyThreshold: easyText === undefined ? '' : String(easyText),
					easyOverridden: userHas(this.snapshot().user, 'easyThreshold'),
					reclassify: this.draftOf('reclassify').value ?? 'first',
					reclassifyOverridden: userHas(this.snapshot().user, 'reclassify'),
				}
			}

			/** 暂存一个档位字段；空字符串 = 从 tiers 对象里删除该字段（继承父级路由）。 */
			editTierField(tier, field, value) {
				const base = this.effectiveTiers()
				const nextTiers = { ...base }
				const nextTier = { ...(typeof base[tier] === 'object' && base[tier] !== null ? base[tier] : {}) }
				const trimmed = String(value).trim()
				if (trimmed === '') delete nextTier[field]
				else nextTier[field] = trimmed
				for (const key of Object.keys(nextTier)) {
					if (nextTier[key] === undefined) delete nextTier[key]
				}
				nextTiers[tier] = nextTier
				for (const t of TIERS) {
					if (nextTiers[t] !== undefined && Object.keys(nextTiers[t]).length === 0) delete nextTiers[t]
				}
				this.stage('tiers', nextTiers)
			}

			editThreshold(field, text) {
				const trimmed = String(text).trim()
				if (trimmed === '') this.staged.set(field, { kind: 'clear' })
				else this.staged.set(field, { kind: 'set', value: Number(trimmed) })
				this.failed = false
				this.publish()
			}

			editReclassify(value) {
				this.stage('reclassify', value)
			}

			resetField(field) {
				this.staged.set(field, { kind: 'clear' })
				this.failed = false
				this.publish()
			}

			discard() {
				if (this.staged.size === 0 && !this.failed) return
				this.staged.clear()
				this.failed = false
				this.publish()
			}

			stage(field, value) {
				this.staged.set(field, { kind: 'set', value })
				this.failed = false
				this.publish()
			}

			async save() {
				if (this.staged.size === 0 || this.saving || this.project().invalid) return
				this.saving = true
				this.failed = false
				this.publish()
				let landed = true
				try {
					for (const [field, edit] of this.staged) {
						if (edit.kind === 'clear') {
							await this.scope.unset(field)
						} else {
							await this.scope.set(field, edit.value)
						}
					}
					// Host 是唯一权威：写后回读 user 层确认落盘（深比较：对象
					// 经线序列化后必然是新引用，引用相等会把成功误判为失败）。
					const user = this.snapshot().user ?? {}
					for (const [field, edit] of this.staged) {
						if (edit.kind === 'clear') {
							if (userHas(user, field)) landed = false
						} else if (!deepEqual(user?.[field], edit.value)) {
							landed = false
						}
					}
				} catch (error) {
					landed = false
					console.error('[dsh-subagent-model-routing] save failed:', error)
				}
				this.saving = false
				this.failed = !landed
				if (landed) this.staged.clear()
				this.publish()
			}

			inject() {
				return {
					hooks: { subagentModelRouting: this.store },
					editTierField: (tier, field, text) => { this.editTierField(tier, field, text) },
					editThreshold: (field, text) => { this.editThreshold(field, text) },
					editReclassify: (value) => { this.editReclassify(value) },
					resetField: (field) => { this.resetField(field) },
					save: () => { void this.save() },
					discard: () => { this.discard() },
				}
			}
		}

		// ── 渲染 ─────────────────────────────────────────────────────────────
		const styles = {
			card: { padding: '16px 0', display: 'flex', flexDirection: 'column', gap: '12px' },
			title: { color: 'var(--dsw-alias-label-primary, #222)', fontSize: 15, fontWeight: 600, lineHeight: '22px' },
			description: { color: 'var(--dsw-alias-label-secondary, #666)', fontSize: 13, lineHeight: '20px' },
			notice: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)' },
			tierBlock: { border: '1px solid var(--dsw-alias-border-l2, #e3e3e3)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 },
			tierTitle: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #222)' },
			row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
			label: { width: 72, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)', flexShrink: 0 },
			input: {
				flex: 1, minWidth: 140, fontSize: 13, lineHeight: '20px', padding: '4px 8px',
				border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)', borderRadius: 6,
				background: 'var(--dsw-alias-bg-input, #fff)', color: 'var(--dsw-alias-label-primary, #222)',
			},
			actions: { display: 'flex', gap: 8, alignItems: 'center' },
			primary: {
				fontSize: 13, padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
				border: '1px solid var(--dsw-alias-accent, #4D6BFE)', color: '#fff',
				background: 'var(--dsw-alias-accent, #4D6BFE)',
			},
			ghost: {
				fontSize: 13, padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
				border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)',
				background: 'transparent', color: 'var(--dsw-alias-label-primary, #222)',
			},
			reset: {
				fontSize: 12, border: 'none', background: 'transparent', cursor: 'pointer',
				color: 'var(--dsw-alias-label-secondary, #666)', padding: '2px 4px',
			},
			error: { fontSize: 12, color: 'var(--dsw-alias-danger, #d33)' },
			fieldError: { fontSize: 11, color: 'var(--dsw-alias-danger, #d33)' },
		}

		function SubagentModelRoutingCard(props) {
			const { t } = props
			const state = props.useSubagentModelRouting(s => s)
			if (!state.available) {
				return jsx('div', { style: styles.card, children: t('unavailable') })
			}
			const disabled = !state.writable || state.saving
			const rows = []
			for (const tier of TIERS) {
				const draft = state.tiers[tier]
				const selectRow = (label, value, options, overridden, onEdit, onReset, inheritLabel) => jsxs('div', { style: styles.row, children: [
					jsx('div', { style: styles.label, children: label }),
					jsx('select', {
						style: styles.input,
						value,
						disabled,
						onChange: (event) => { onEdit(event.target.value) },
						children: [
							jsx('option', { value: '', children: inheritLabel }),
							...options.map(option => jsx('option', {
								key: option.value,
								value: option.value,
								disabled: option.disabled === true,
								children: option.label,
							})),
						],
					}),
					overridden
						? jsx('button', { type: 'button', style: styles.reset, onClick: onReset, children: `${t('overridden')} ×` })
						: null,
				] })
				const effortChoices = draft.effortOptions.map(value => ({ value, label: value, disabled: false }))
				if (draft.effort !== '' && !effortChoices.some(option => option.value === draft.effort)) {
					effortChoices.push({ value: draft.effort, label: draft.effort, disabled: false })
				}
				rows.push(jsxs('div', { key: tier, style: styles.tierBlock, children: [
					jsx('div', { style: styles.tierTitle, children: t(`tier.${tier}`) }),
					selectRow(
						t('provider'), draft.provider, draft.providerOptions, draft.providerOverridden,
						(value) => { props.editTierField(tier, 'provider', value) },
						() => { props.editTierField(tier, 'provider', '') },
						t('inheritProvider'),
					),
					draft.provider === '' && draft.model === ''
						? null
						: selectRow(
							t('model'), draft.model, draft.modelOptions, draft.modelOverridden,
							(value) => { props.editTierField(tier, 'model', value) },
							() => { props.editTierField(tier, 'model', '') },
							t('inheritModel'),
						),
					selectRow(
						t('effort'), draft.effort, effortChoices, draft.effortOverridden,
						(value) => { props.editTierField(tier, 'reasoningEffort', value) },
						() => { props.editTierField(tier, 'reasoningEffort', '') },
						t('inheritEffort'),
					),
				] }))
			}
			const numberRow = (label, draft, overridden, onEdit, onReset) => jsxs('div', { style: styles.row, children: [
				jsx('div', { style: { ...styles.label, width: 'auto' }, children: label }),
				jsx('input', {
					style: { ...styles.input, maxWidth: 120 },
					value: draft,
					disabled,
					onChange: (event) => { onEdit(event.target.value) },
				}),
				!isFiniteText(draft)
					? jsx('div', { style: styles.fieldError, children: t('invalidNumber') })
					: null,
				overridden
					? jsx('button', { type: 'button', style: styles.reset, onClick: onReset, children: `${t('overridden')} ×` })
					: null,
			] })
			const saveDisabled = !state.dirty || state.invalid || state.saving
			const catalogNotice = state.catalog.status === 'loading'
				? t('catalogLoading')
				: state.catalog.status === 'error'
					? t('catalogFailed', { message: state.catalog.error })
					: null
			return jsxs('div', { style: styles.card, children: [
				jsx('div', { style: styles.title, children: t('title') }),
				jsx('div', { style: styles.description, children: t('description') }),
				catalogNotice !== null ? jsx('div', { style: styles.notice, children: catalogNotice }) : null,
				...rows,
				numberRow(
					t('hardThreshold'), state.hardThreshold, state.hardOverridden,
					(text) => { props.editThreshold('hardThreshold', text) },
					() => { props.resetField('hardThreshold') },
				),
				numberRow(
					t('easyThreshold'), state.easyThreshold, state.easyOverridden,
					(text) => { props.editThreshold('easyThreshold', text) },
					() => { props.resetField('easyThreshold') },
				),
				jsxs('div', { style: styles.row, children: [
					jsx('div', { style: { ...styles.label, width: 'auto' }, children: t('reclassify') }),
					jsx('select', {
						style: { ...styles.input, maxWidth: 220 },
						value: state.reclassify,
						disabled,
						onChange: (event) => { props.editReclassify(event.target.value) },
						children: [
							jsx('option', { value: 'first', children: t('reclassifyFirst') }),
							jsx('option', { value: 'every', children: t('reclassifyEvery') }),
						],
					}),
					state.reclassifyOverridden
						? jsx('button', { type: 'button', style: styles.reset, onClick: () => { props.resetField('reclassify') }, children: `${t('overridden')} ×` })
						: null,
				] }),
				jsxs('div', { style: styles.actions, children: [
					jsx('button', { type: 'button', style: styles.primary, disabled: saveDisabled, onClick: props.save, children: state.saving ? '…' : t('save') }),
					jsx('button', { type: 'button', style: styles.ghost, disabled: !state.dirty, onClick: props.discard, children: t('discard') }),
					state.failed ? jsx('div', { style: styles.error, children: t('saveFailed') }) : null,
				] }),
			] })
		}

		function isFiniteText(text) {
			const trimmed = String(text).trim()
			return trimmed === '' || Number.isFinite(Number(trimmed))
		}

		function apply(ctx) {
			ctx.effect(
				() => ctx.locale.register(NS, { zh, en }),
				'ui-dsh-subagent-model-routing: dictionaries',
			)
			const t = ctx.locale.bind(NS)
			const { api } = ctx.get('connection')
			const card = new CardController(
				ctx.settingsScope.bind({ namespace: NAMESPACE }),
				api,
			)
			// 模型目录与设置文档都可能让目录过期：订阅两条 Host 转发事件刷新。
			ctx.effect(
				() => ctx.remote.$on('llm/adapters-updated', () => { void card.loadCatalog() }),
				'ui-dsh-subagent-model-routing: catalog invalidation (adapters)',
			)
			ctx.effect(
				() => ctx.remote.$on('settings/document-updated', () => { void card.loadCatalog() }),
				'ui-dsh-subagent-model-routing: catalog invalidation (settings)',
			)
			ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'dsh-subagent-model-routing',
				order: 100,
				label: () => t('title'),
				locale: NS,
				inject: () => card.inject(),
			}, SubagentModelRoutingCard))
		}

		// 注意：不能带 default 导出——cordis Loader 的 unwrapExports 会优先取
		// .default（裸函数），把 inject/name 整个命名空间丢弃，apply 内访问
		// ctx.locale 等注入服务时会报 "cannot get property ... without inject"。
		return { name, inject, apply }
	},
})
