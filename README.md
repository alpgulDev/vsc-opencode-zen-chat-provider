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
3. Run **OpenCode Zen: Add Models**, add an **OpenCode Zen** group, then pick the authentication method in the group settings.

## Commands

Open the command palette (`Ctrl/Cmd+Shift+P`):

- `OpenCode Zen: Add Models` (`opencodeZen.addModels`)
  - Opens the Language Models editor. Select **Add Models → OpenCode Zen** and choose a group name.
  - In the group settings, choose `authMethod`:
    - `oauth` (default, also used when the group has no explicit auth choice) starts OpenCode Console device sign-in; no API key is required.
    - `apiKey` uses the `apiKey` you enter in the group (stored by VS Code as a secret).
    - `signOut` clears the stored OAuth credential and API key.
  - The optional `lane` setting (`auto`, `zen`, `go`) filters which models the group exposes.
  - The command offers to enable `chat.agentHost.byokModels.enabled` if it is off.
- `OpenCode Zen: Refresh Model List` (`opencodeZen.refreshModels`)
  - Refetches models from `https://models.dev/api.json` (filtered to provider `opencode`) and refreshes the registered vendors.
- `OpenCode Zen: Revert Agents Window Support` (`opencodeZen.revertAgentsWindowSupport`)
  - Restores the VS Code settings the extension auto-enabled for the Agents window.
- `OpenCode Zen: Restart Bun-Compatible Transport` (`opencodeZen.restartTransport`)
  - Restarts the extension-owned transport helper.

Sign-in, sign-out and self-test commands were removed; authentication is managed entirely from the Add Models group.

## Notes

- Models are registered as BYOK models for the main Chat picker and through an `opencode-agent` variant (`targetChatSessionType: copilotcli`) for the Agents window / Copilot harness.
- The manifest declares `capabilities.agentsWindow.supported: true`, so VS Code loads the extension in the Agents window process and its `opencode` vendor appears in **+ Add Models** there.
- On activation the extension also enables `extensions.supportAgentsWindow.<extension-id>`, `chat.agentHost.byokModels.enabled` (VS Code 1.129+), and pins `sessions.chat.experimental.agentsPickerInAttachContextMenu` off. The revert command restores only the settings this extension changed.
- Tool calling is supported by streaming `LanguageModelToolCallPart` from the provider.
- Tool execution is handled by the caller (VS Code) by sending back `LanguageModelToolResultPart` on the next request.
- With `authMethod: oauth`, device credentials are stored in **SecretStorage**. With no signed-in credential and no group, requests fall back to `Bearer public` (matching the OpenCode CLI anonymous lane).
- Requests are shaped like OpenCode CLI traffic: canonical `ses_`/`msg_` IDs, CLI headers, official 2.x system prompt and tool manifest, and opaque aliases for VS Code tools.
- Run `npm run test:parity` for offline parity checks (no requests to `opencode.ai`).
