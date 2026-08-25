# dsh-clear-tool-results

A DeepSeek Harness (DSH) **host-plane** plugin: at the end of each turn it keeps only the **last `tool/result` per tool** from the just-finished turn and clears every `tool/result` from **older turns** out of the model's context. It provides a chat command to toggle the behavior:

```
/clear-tool-results on|off|status
```

GitHub: <https://github.com/stultuss/dsh-clear-tool-results>

npm: <https://www.npmjs.com/package/dsh-clear-tool-results>

## Why

DSH session logs are append-only; the model-visible history is derived from `session.surface`. Large tool outputs stay in every subsequent turn's request, wasting context window.

This plugin runs after each `turn/end`:

1. Within the turn that just ended, only the last complete result of each tool name is kept; the other results are replaced with:

```text
[middle tool results cleared]
```

2. All results from older turns (including the kept result from the previous turn) are replaced with:

```text
[previous-turn tool results cleared]
```

The original tool results remain in the session log (persistence, replay, and the chat transcript are unaffected) — they are simply no longer sent to the model.

<img width="1124" height="563" alt="image" src="https://github.com/user-attachments/assets/d0b6fc5b-dacc-47e0-a240-ce86d41d541f" />
<img width="1136" height="559" alt="image" src="https://github.com/user-attachments/assets/44b9ff52-e1c3-4298-80ea-24894d686e88" />

## Features

- Host-plane plugin: applies to **all sessions / all agent presets**;
- Chat command toggle — enable/disable without editing files;
- State persisted in `$DSH_HOME/clear-tool-results.json` (enabled by default);
- Each turn is grouped by tool name (resolved via the `tool/call` events' `callId` ↔ `name` mapping), keeping only the last complete result per tool; the middle results are replaced with a placeholder too;
- Tool results kept from the previous turn and earlier are cleared at the end of the current turn;
- Only Node built-in modules are used — no third-party runtime dependencies;
- Plays well with DSH's built-in compaction (`/compact`, `dsh-compaction-basic`, `dsh-compaction-tool-result-pruner`).

## Install

### 1. Install the npm package

**From npm (recommended):**

```sh
dsh plugin --profile web add dsh-clear-tool-results
```

Equivalent to running in the profile directory:

```sh
cd ~/.dsh/profiles/web
pnpm add dsh-clear-tool-results
```

**Or from GitHub:**

```sh
dsh plugin --profile web add github:stultuss/dsh-clear-tool-results
```

**Or from a local tarball:** put `dsh-clear-tool-results-0.1.0.tgz` somewhere convenient, then:

```sh
dsh plugin --profile web add ./dsh-clear-tool-results-0.1.0.tgz
```

### 2. Register it in the profile's `cordis.patch.yml`

Add the following to `~/.dsh/profiles/web/cordis.patch.yml` (or your profile's):

```yaml
- insert:
    - id: clear-tool-results-host
      name: 'dsh-clear-tool-results'
```

DSH hot-reloads the config after saving (no service restart needed). If the command menu in the web input box does not refresh, reload the page.

## Usage

Type in the chat input box:

| Command | Effect |
| --- | --- |
| `/clear-tool-results on` | Enable: keep only the last result of each tool per turn, and clear tool results from older turns |
| `/clear-tool-results off` | Disable: keep all tool results |
| `/clear-tool-results status` | Show the current toggle state |

State file:

```json
// $DSH_HOME/clear-tool-results.json
{
  "enabled": true
}
```

A missing file is treated as enabled.

## How it works

1. The plugin listens for `turn/end` in `session/event`;
2. It collects all append-origin `tool/result` nodes of the turn that just ended;
3. Tool names are resolved from the matching `tool/call` events (`message.source.callId` → `callId`/`name`), falling back to `toolName` / `name` / `tool` / `meta.*` fields on the result itself;
4. Results are grouped by tool name; within each group only the last node in surface order is kept, and the rest are replaced with `[middle tool results cleared]`;
5. All append-origin `tool/result` nodes from older turns are replaced with `[previous-turn tool results cleared]`;
6. Replacement is done via `session.append('tool/result', ..., { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs: [seq] })`, which modifies only `message.content` (keeping the `tool-result` wrapper shape, as DSH surface rules require) and preserves `turn`, `step`, `callId`, error fields, and `meta`;
7. The original events remain in the append-only log and can be replayed.

## Verify

- Create a new session;
- Turn 1: `Please call bash to run: echo secret-12345, then reply only "done"`;
- Turn 2: `What was that secret earlier?`

With clearing enabled, the model cannot see `secret-12345` — it only sees `[previous-turn tool results cleared]`.

## Uninstall

1. Remove the registration line from `cordis.patch.yml`;
2. Remove the dependency:

```sh
dsh plugin --profile web remove dsh-clear-tool-results
```

3. (Optional) Delete `$DSH_HOME/clear-tool-results.json`.

## License

MIT
