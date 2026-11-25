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
3. In the Extension Development Host, run **OpenCode Zen: Add Models** and add an **OpenCode Zen** group. Models are only exposed through groups added this way.

## Commands

Open the command palette (`Ctrl/Cmd+Shift+P`):

- `OpenCode Zen: Sign In` (`opencodeZen.signIn`)
  - Device OAuth with OpenCode Console; access/refresh tokens are stored in **SecretStorage** (not in settings).
- `OpenCode Zen: Sign Out` (`opencodeZen.signOut`)
- `OpenCode Zen: Add Models` (`opencodeZen.addModels`)
  - Opens the Language Models editor. Select **Add Models → OpenCode Zen** and choose a group name.
  - The optional `lane` setting (`auto`, `zen`, `go`) filters which models the group exposes.
  - To use the group in the Agents window / Copilot harness, keep `chat.agentHost.byokModels.enabled` enabled; the command offers to enable it if it is off.
- `OpenCode Zen: Refresh Model List` (`opencodeZen.refreshModels`)
  - Refetches models from `https://models.dev/api.json` (filtered to provider `opencode`) and refreshes all configured groups.
- `OpenCode Zen: Self Test` (`opencodeZen.selfTest`)
  - Prompts for a model, then runs a small tool-calling roundtrip.
  - Output is written to the **OpenCode Zen** Output Channel.

## Notes

- Models are registered only through **Add Models** groups so they are treated as BYOK models by VS Code and appear in the Agents window / Copilot harness as well as the main Chat picker.
- Tool calling is supported by streaming `LanguageModelToolCallPart` from the provider.
- Tool execution is handled by the caller (VS Code) by sending back `LanguageModelToolResultPart` on the next request.
- Without sign-in, requests use `Bearer public` (matching the OpenCode CLI anonymous lane).
- Requests are shaped like OpenCode CLI traffic: canonical `ses_`/`msg_` IDs, CLI headers, official 2.x system prompt and tool manifest, and opaque aliases for VS Code tools.
- Run `npm run test:parity` for offline parity checks (no requests to `opencode.ai`).
