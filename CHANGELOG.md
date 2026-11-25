# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## UNRELEASED [x.x.x] - xxxx-xx-xx

### Changed

- Register OpenCode Zen models in both the normal Chat picker and the Agents window / Copilot harness: base `opencode` BYOK models plus an `opencode-agent` variant with `targetChatSessionType: copilotcli`.
- Declare `capabilities.agentsWindow.supported: true` so the `opencode` vendor is registered in the Agents window **+ Add Models** list.
- Auto-enable `extensions.supportAgentsWindow`, `chat.agentHost.byokModels.enabled` (VS Code 1.129+), and keep the Agents picker visible; added `OpenCode Zen: Revert Agents Window Support` to undo only the changes this extension made.
- Reworked the Add Models group settings: `authMethod` selects `oauth`, `apiKey` or `signOut`, so VS Code no longer forces an API key. OAuth sign-in and sign-out now run from the group flow; the standalone `OpenCode Zen: Sign In` / `Sign Out` commands were removed.
- Added optional secret `apiKey` and `lane` (`auto`, `zen`, `go`) group settings.
- Removed the standalone self-test commands and self-test request loop.

### Fixed

- Treat an Add Models group with no explicit `authMethod` as OAuth. VS Code does not inject JSON schema defaults into provider group configuration, so leaving the default OAuth choice selected previously produced no sign-in.
- Stop VS Code's Add Models form from prompting for `apiKey` even when OAuth is selected. The property is no longer promptable; API keys are collected through a password-masked extension prompt that rejects empty input.
- Start a fresh device sign-in when an OAuth group is selected, instead of silently reusing a stored credential. Repeat resolutions reuse the in-flight/finished sign-in.
- Hide ungrouped models for both Chat and Agents vendors while a BYOK group is configured, so anonymous models do not appear before the group's OAuth/API key setup completes.
- Use the provider `managementCommand` hook so **Add Models** runs an extension-owned auth/lane wizard before any models are registered. OAuth failure or timeout now shows an error with Retry instead of silently exposing models.
- Fix Add Models doing nothing when a legacy provider group was still present: the wizard now runs before legacy-group hiding, and completed wizard setup takes precedence over legacy groups.

## [0.1.3] - 2026-01-27

### Fixed

- Filter out deprecated models flagged by models.dev status.
- Update GLM 4.7 Handling to reduce error rate for unwanted fields

## [0.1.2] - 2026-01-19

### Added

- Fix Packaging. The VIX didn't package dependencies.

## [0.1.1] - 2026-01-17

### Added

- Added Prompt Caching for all Models

## [0.1.0] - 2026-01-17

### Added

- Initial release of OpenCode Zen VS Code Chat Provider extension
- Integration with OpenCode Zen models via Language Model Chat Provider API
- API key management via VS Code SecretStorage
- Model registry with dynamic model fetching from models.dev
- Streaming support for chat completions
- Tool calling capabilities with JSON Schema support
- Self-test command for validating streaming and tool functionality
- Output channel for debugging and logging
