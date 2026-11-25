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
3. In the Extension Development Host models appear in both the normal Chat picker and the Agents window / Copilot harness. Sign in with **OpenCode Zen: Sign In** for authenticated access (anonymous `Bearer public` fallback is used otherwise). Optionally run **OpenCode Zen: Add Models** to create a BYOK group.

## Commands

Open the command palette (`Ctrl/Cmd+Shift+P`):

- `OpenCode Zen: Sign In` (`opencodeZen.signIn`)
  - Device OAuth with OpenCode Console; access/refresh tokens are stored in **SecretStorage** (not in settings).
- `OpenCode Zen: Sign Out` (`opencodeZen.signOut`)
- `OpenCode Zen: Add Models` (`opencodeZen.addModels`)
  - Opens the Language Models editor. Select **Add Models → OpenCode Zen** and choose a group name.
  - The group's `apiKey` is stored by VS Code as a secret; it overrides the signed-in token when present.
  - The optional `lane` setting (`auto`, `zen`, `go`) filters which models the group exposes.
  - The command offers to enable `chat.agentHost.byokModels.enabled` if it is off.
- `OpenCode Zen: Refresh Model List` (`opencodeZen.refreshModels`)
  - Refetches models from `https://models.dev/api.json` (filtered to provider `opencode`) and refreshes the registered vendors.
- `OpenCode Zen: Revert Agents Window Support` (`opencodeZen.revertAgentsWindowSupport`)
  - Restores the VS Code settings the extension auto-enabled for the Agents window.
- `OpenCode Zen: Self Test` (`opencodeZen.selfTest`)
  - Prompts for a model, then runs a small tool-calling roundtrip.
  - Output is written to the **OpenCode Zen** Output Channel.

## Notes

- Models are registered as BYOK models for the main Chat picker and through an `opencode-agent` variant (`targetChatSessionType: copilotcli`) for the Agents window / Copilot harness.
- The manifest declares `capabilities.agentsWindow.supported: true`, so VS Code loads the extension in the Agents window process and its `opencode` vendor appears in **+ Add Models** there.
- On activation the extension also enables `extensions.supportAgentsWindow.<extension-id>`, `chat.agentHost.byokModels.enabled` (VS Code 1.129+), and pins `sessions.chat.experimental.agentsPickerInAttachContextMenu` off. The revert command restores only the settings this extension changed.
- Tool calling is supported by streaming `LanguageModelToolCallPart` from the provider.
- Tool execution is handled by the caller (VS Code) by sending back `LanguageModelToolResultPart` on the next request.
- Without sign-in, requests use `Bearer public` (matching the OpenCode CLI anonymous lane).
- Requests are shaped like OpenCode CLI traffic: canonical `ses_`/`msg_` IDs, CLI headers, official 2.x system prompt and tool manifest, and opaque aliases for VS Code tools.
- Run `npm run test:parity` for offline parity checks (no requests to `opencode.ai`).
