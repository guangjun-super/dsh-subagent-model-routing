# dsh-subagent-model-routing

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**按任务难度为 [DeepSeek Harness](https://www.deepseek.com/harness/) 子代理自动路由模型与思考深度的插件。**

一个 Cordis 插件：每当你派生子代理时，它根据任务「看起来有多难」，自动为该子代理选择预设的 **Provider / 模型 / 思考深度（reasoning effort）**。像「把这个变量重命名一下」这种小任务走便宜的低深度档；「重构认证模块并做安全审计」这种大任务则走强模型 + 最大思考深度。

它对**所有 agent preset（模式）生效**——`standard`、`code`、`cordis`、`minimal` 以及任何自定义 preset——因为它挂在 **host 平面**，而不是某个 preset 内部。

[English →](./README.md)

## 特性

- **三档难度**——`easy` / `medium` / `hard`，每档各自配置 `{ provider?, model?, reasoningEffort? }`。
- **自动难度打分**——中英文信号词 + 任务长度的启发式规则。
- **思考深度感知**——`off` / `low` / `high` / `max`，模型不支持所选档位时优雅退回适配器默认。
- **独立配置面板**——在 *设置 → 子代理路由*（English: *Settings → subagent routing*）里编辑档位与阈值；保存写入 `settings.yaml` 并**热生效**（无需重启）。
- **可选诊断日志**——每次分级追加一行 JSON，看不到控制台时用来排查。

## 工作原理

当进程内子代理被创建——通过 `subagent`、`subagent_fork`、`workflow` worker 或 `ralph` 子代理——插件对其首条任务消息打分，落入某一档，然后把该子代理的模型路由替换为档位预设。persona 中的 `{{model}}` 变量同步修正，且分级结果会按会话保留，可续跑子代理冷恢复后仍沿用。

进程外 provider（`acp` / `codex` / `claude-code` / `dsh-sdk`）不在本进程内创建 agent，会被自动跳过。

## 安装

### 方式 A —— 从 npm（发布后）

```sh
dsh plugin --profile web add dsh-subagent-model-routing
```

### 方式 B —— 从 GitHub

```sh
dsh plugin --profile web add github:guangjun-super/dsh-subagent-model-routing
```

### 方式 C —— 从本地克隆

```sh
git clone git@github.com:guangjun-super/dsh-subagent-model-routing.git
dsh plugin --profile web add ./dsh-subagent-model-routing
```

然后启动 Web UI：

```sh
dsh web
```

> `dsh plugin add` 会把包安装进 profile 并追加到 `dsh.profile.bundles`。包内置的 `cordis.patch.yml`（即 `dsh.bundle.patch` 层）负责挂载 Host 半；`dsh.client` 声明负责在浏览器里加载设置面板。

### 手动安装（不用 `dsh plugin`）

1. 把包放到 profile 的 Node 解析路径里，例如 `~/.dsh/profiles/node_modules/dsh-subagent-model-routing/`。
2. 在 profile 的 `cordis.patch.yml`（例如 `~/.dsh/profiles/web/cordis.patch.yml`）里加上：

   ```yaml
   - insert:
       - id: dsh-subagent-model-routing
         name: dsh-subagent-model-routing
   ```

3. 重启 `dsh web`。

## 配置

所有配置均可省略、回落默认值。patch 里的 `config` 是**基准层**；设置面板里保存的值叠加在它之上并热生效。

| 键 | 说明 | 默认 |
|---|---|---|
| `tiers.easy` / `tiers.medium` / `tiers.hard` | 每档预设 `{ provider?, model?, reasoningEffort? }`。省略的字段沿用子代理继承的父级路由；省略 `reasoningEffort` 则清除继承深度（回到适配器默认）。 | `easy: { reasoningEffort: low }`、`medium: { reasoningEffort: high }`、`hard: { reasoningEffort: max }` |
| `hardThreshold` | 分数 ≥ 此值判为 `hard` | `3` |
| `easyThreshold` | 分数 ≤ 此值判为 `easy` | `-1` |
| `reclassify` | `first`：仅按首条任务消息分级（后续消息沿用）；`every`：每条消息重新分级 | `first` |
| `logFile` | 可选；每次事件追加一行 JSON 的诊断文件路径 | *(无)* |

### 按难度切换模型的示例

```yaml
- insert:
    - id: dsh-subagent-model-routing
      name: dsh-subagent-model-routing
      config:
        tiers:
          easy:   { provider: deepseek-official, model: deepseek-v4-flash, reasoningEffort: low }
          medium: { provider: deepseek-official, model: deepseek-v4-flash, reasoningEffort: high }
          hard:   { provider: deepseek-official, model: deepseek-v4-pro,   reasoningEffort: max }
        hardThreshold: 3
        easyThreshold: -1
        reclassify: first
```

### 难度打分（启发式）

对任务文本（子代理首条消息的全部文本块）逐项计分：

- **复杂信号词 +1**——如 `refactor` / `migrate` / `debug` / `race condition` / `security` / `from scratch` / `audit` / `distributed` …（以及 重构 / 迁移 / 并发 / 安全 / 审计 / 分布式 …）。
- **简单信号词 −1**——如 `rename` / `translate` / `summarize` / `typo` / `comment` …（以及 重命名 / 翻译 / 总结 / 拼写 …）。
- **长度**——≤120 字 −1；≥800 字 +1；≥2000 字 +2。

然后 `分数 ≥ hardThreshold → hard`，`分数 ≤ easyThreshold → easy`，否则 `medium`。`classify()` 已导出，可直接单测调参。

## 使用

1. 安装并启动 `dsh web`。
2. （可选）打开 **设置 → 子代理路由**（Settings → subagent routing），为每档设置 Provider / 模型 / 思考深度。Provider 与模型是与对话选模型同源的下拉框；某字段留空（「继承」）即回落父级路由。
3. 照常派生子代理——路由全自动。

## 已知限制

- **仅覆盖进程内子代理。**`acp`、`codex`、`claude-code`、`dsh-sdk` 的子代理在本进程外创建，会被跳过。
- **启发式、非保证。**长尾任务可能误判；可调阈值，或改用 `reclassify: every`。
- **改 Host 半需重启**（Node ESM 缓存）；**改客户端半只需刷新页面**。

## 开发

```sh
git clone git@github.com:guangjun-super/dsh-subagent-model-routing.git
cd dsh-subagent-model-routing
npm test          # 16 个用例：纯逻辑 + cordis 接线模拟
```

接线测试会用真实的 `cordis` `Context` 模拟 scope 事件分发。它从本地 `deepseek-harness` checkout 加载；如果该路径与你的机器不符，可通过 `DSH_CORDIS_CONTEXT` 环境变量指向一个可达的 `file://` URL；加载失败时接线块会跳过，只跑纯逻辑用例（`classify` / `textOf` / `normalizeConfig`）。

## 许可

[MIT](./LICENSE)
