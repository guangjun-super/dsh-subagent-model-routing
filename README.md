# dsh-subagent-model-routing

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Difficulty-aware model & reasoning-effort routing for [DeepSeek Harness](https://www.deepseek.com/harness/) subagents.**

A Cordis plugin that automatically picks a preset **provider / model / reasoning effort** for every subagent you spawn, based on how hard the task looks. A small "rename this variable" task gets a cheap, low-effort route; a "refactor the auth module and audit security" task gets the strong model with maximum reasoning.

It applies to **every agent preset** — `standard`, `code`, `cordis`, `minimal`, and any custom preset — because it mounts on the **host plane**, not inside a single preset.

[中文文档 →](./README-zh.md)

## Features

- **Three difficulty tiers** — `easy` / `medium` / `hard`, each with its own `{ provider?, model?, reasoningEffort? }` preset.
- **Automatic difficulty scoring** — heuristic signal words (Chinese & English) plus task length.
- **Reasoning-effort aware** — `off` / `low` / `high` / `max`, with graceful fallback when a model doesn't support the requested effort.
- **Standalone settings panel** — a dedicated *Settings → subagent routing* page (中文：*设置 → 子代理路由*), where you edit tiers and thresholds; saves to `settings.yaml` and hot-applies (no restart).
- **Optional diagnostic log** — one JSON line per classification, for when you can't see the console.

## How it works

When an in-process subagent is created — via `subagent`, `subagent_fork`, a `workflow` worker, or a `ralph` child — the plugin scores its first task message, lands it in a tier, and swaps that subagent's model route to the tier preset. The `{{model}}` variable in the persona is kept in sync, and the choice survives continuable-subagent cold restarts.

Out-of-process providers (`acp`, `codex`, `claude-code`, `dsh-sdk`) never create an agent in this process, so they are skipped automatically.

## Install

```sh
dsh plugin --profile web add dsh-subagent-model-routing
```

Then start the web UI:

```sh
dsh web
```

## Configure

All settings are optional and fall back to defaults. The patch `config` is the **baseline layer**; whatever you save in the settings panel is layered on top and hot-applies.

| Key | Description | Default |
|---|---|---|
| `tiers.easy` / `tiers.medium` / `tiers.hard` | Per-tier preset `{ provider?, model?, reasoningEffort? }`. Omitted fields inherit the subagent's parent route; omitting `reasoningEffort` clears the inherited effort (adapter default). | `easy: { reasoningEffort: low }`, `medium: { reasoningEffort: high }`, `hard: { reasoningEffort: max }` |
| `hardThreshold` | Score ≥ this → `hard` | `3` |
| `easyThreshold` | Score ≤ this → `easy` | `-1` |
| `reclassify` | `first`: classify only the first task message (follow-ups reuse the tier); `every`: re-classify on every message | `first` |
| `logFile` | Optional path for one-JSON-line-per-event diagnostics | *(none)* |

### Example: switch models per tier

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

### Difficulty scoring (heuristic)

The first task message's text blocks are scored:

- **Hard signal words +1** — e.g. `refactor` / `migrate` / `debug` / `race condition` / `security` / `from scratch` / `audit` / `distributed` … (and 重构 / 迁移 / 并发 / 安全 / 审计 / 分布式 …).
- **Easy signal words −1** — e.g. `rename` / `translate` / `summarize` / `typo` / `comment` … (and 重命名 / 翻译 / 总结 / 拼写 …).
- **Length** — ≤ 120 chars −1; ≥ 800 chars +1; ≥ 2000 chars +2.

Then `score ≥ hardThreshold → hard`, `score ≤ easyThreshold → easy`, otherwise `medium`. `classify()` is exported so you can unit-test or tune it directly.

## Use

1. Install and start `dsh web`.
2. (Optional) Open **Settings → subagent routing** (设置 → 子代理路由) and set each tier's Provider / Model / Reasoning effort. Provider & model are dropdowns sourced from the same model catalog as the chat model picker; leaving a field blank ("inherit") falls back to the parent route.
3. Spawn subagents as usual — routing is automatic.

## Limitations

- **In-process subagents only.** `acp`, `codex`, `claude-code`, and `dsh-sdk` subagents are created outside this process and are skipped.
- **Heuristic, not guaranteed.** Long-tail tasks can be misclassified; tune the thresholds or use `reclassify: every`.
- **Host-half edits need a restart** (Node ESM cache); **client-half edits need a page refresh**.

## Development

```sh
git clone git@github.com:guangjun-super/dsh-subagent-model-routing.git
cd dsh-subagent-model-routing
npm test          # 16 tests: pure logic + cordis wiring simulation
```

The wiring tests drive a real `cordis` `Context` to simulate scope events. They load it from a local `deepseek-harness` checkout; if that path doesn't match your machine, set the `DSH_CORDIS_CONTEXT` env var to a reachable `file://` URL, or the wiring block is skipped and only the pure-logic tests (`classify` / `textOf` / `normalizeConfig`) run.

## License

[MIT](./LICENSE)
