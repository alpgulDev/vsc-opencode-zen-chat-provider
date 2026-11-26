# OpenCode Zen – VS Code Chat Model Provider

> **Disclaimer:** This project is a community project and is not maintained by the OpenCode team (https://opencode.ai/) and has no ties to the OpenCode team.


This extension provides **OpenCode Zen** models to VS Code via the **Language Model Chat Provider** API (vendor id: `opencode`).

## Prerequisites

- VS Code `^1.104`
- Node.js (recent LTS recommended)
- An OpenCode Console account for signed-in access (device OAuth)

## Install

```bash
npm install
```

## Build

```bash
npm run compile
```

## Watch

```bash
npm run watch
```

## Create Extension Package
```bash
vsce package
```

## Run (Extension Development Host)

1. Open this folder in VS Code
2. Press `F5` (Run → Start Debugging)
3. In **+ Add Models**, choose **OpenCode Zen**. The extension asks for authentication and lane, then registers models only after setup succeeds.

## Commands

Open the command palette (`Ctrl/Cmd+Shift+P`):

- `OpenCode Zen: Add Models` (`opencodeZen.addModels`)
  - Opens the Language Models editor. **+ Add Models → OpenCode Zen** runs the extension-owned setup wizard.
  - Pick `OAuth`, `API Key`, `Anonymous`, or `Sign Out`, then pick `auto` / `zen` / `go`.
  - `OAuth` starts device sign-in and waits for completion (or a timeout/failure error with Retry).
  - `API Key` uses a password-masked prompt that rejects empty input and stores the key in **SecretStorage**.
  - Models are registered only after the chosen auth flow succeeds; on failure an error with **Retry** is shown and no models are exposed.
  - Groups created by earlier builds no longer block this wizard. Once the wizard completes, its saved auth/lane takes precedence over those legacy groups.
- `OpenCode Zen: Refresh Model List` (`opencodeZen.refreshModels`)
  - Refetches models from `https://models.dev/api.json` (filtered to provider `opencode`) and refreshes the registered vendors.
- `OpenCode Zen: Revert Agents Window Support` (`opencodeZen.revertAgentsWindowSupport`)
  - Restores the VS Code settings the extension auto-enabled for the Agents window.
- `OpenCode Zen: Restart Bun-Compatible Transport` (`opencodeZen.restartTransport`)
  - Restarts the extension-owned transport helper.

Standalone sign-in, sign-out and self-test commands were removed; authentication is managed entirely from the Add Models setup flow.

## Notes

- Models are registered as BYOK models for the main Chat picker and through an `opencode-agent` variant (`targetChatSessionType: copilotcli`) for the Agents window / Copilot harness.
- The manifest declares `capabilities.agentsWindow.supported: true`, so VS Code loads the extension in the Agents window process and its `opencode` vendor appears in **+ Add Models** there.
- On activation the extension also enables `extensions.supportAgentsWindow.<extension-id>`, `chat.agentHost.byokModels.enabled` (VS Code 1.129+), and pins `sessions.chat.experimental.agentsPickerInAttachContextMenu` off. The revert command restores only the settings this extension changed.
- Tool calling is supported by streaming `LanguageModelToolCallPart` from the provider.
- Tool execution is handled by the caller (VS Code) by sending back `LanguageModelToolResultPart` on the next request.
- OAuth credentials and API keys are stored in **SecretStorage**. `Anonymous` explicitly uses the public `Bearer public` lane.
- The provider contribution declares `managementCommand`, so VS Code's **Add Models** action resolves models with `silent: false` instead of immediately creating a group. The extension uses that signal to run auth and lane selection first; no models are exposed until it succeeds. On failure an error notification with **Retry** is shown.
- Existing VS Code provider groups created by earlier builds remain supported until the wizard is completed; after that, the wizard's saved auth/lane is authoritative and legacy groups are ignored to avoid duplicate or stale credentials.
- Model visibility follows the auth choice: `Anonymous` exposes only zero-cost models, while `OAuth` and `API Key` expose all active models. Every exposed model is selectable, so paid models cannot be chosen in anonymous mode and no manual opt-in is needed. Zero-cost models are labelled `Free` in their tooltip.
- Requests are shaped like OpenCode CLI traffic: canonical `ses_`/`msg_` IDs, CLI headers, official 2.x system prompt and tool manifest, and opaque aliases for VS Code tools.
- Run `npm run test:parity` for offline parity checks (no requests to `opencode.ai`).
