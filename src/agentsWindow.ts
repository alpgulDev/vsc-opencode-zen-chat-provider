import * as vscode from 'vscode';

const SUPPORT_AGENTS_WINDOW_SETTING = 'supportAgentsWindow';
const AGENT_HOST_BYOK_SETTING = 'byokModels.enabled';
const AGENTS_PICKER_SETTING = 'agentsPickerInAttachContextMenu';
const BYOK_BRIDGE_MINOR_VERSION = 129;

const STATE_KEYS = {
	support: 'opencodeZen.supportAgentsWindow.v1',
	byok: 'opencodeZen.agentsByokBridge.v1',
	picker: 'opencodeZen.agentsPickerInAttachContextMenu.v1',
} as const;

export function isAgentsWindowEnabled(): boolean {
	return vscode.workspace.getConfiguration('opencodeZen').get<boolean>('agentsWindow', true);
}

export function isAutoEnableEnabled(): boolean {
	return vscode.workspace.getConfiguration('opencodeZen').get<boolean>('autoEnableAgentsWindow', true);
}

function hasModernAgentHost(): boolean {
	const [major = 1, minor = 0] = vscode.version.split('.').map(Number);
	return major > 1 || (major === 1 && minor >= BYOK_BRIDGE_MINOR_VERSION);
}

export async function ensureAgentsWindowSupport(context: vscode.ExtensionContext): Promise<void> {
	if (!isAgentsWindowEnabled() || !isAutoEnableEnabled()) {
		return;
	}

	let changed = false;

	const extensions = vscode.workspace.getConfiguration('extensions');
	const support = extensions.get<Record<string, boolean>>(SUPPORT_AGENTS_WINDOW_SETTING, {});
	if (support[context.extension.id] !== true) {
		await extensions.update(
			SUPPORT_AGENTS_WINDOW_SETTING,
			{ ...support, [context.extension.id]: true },
			vscode.ConfigurationTarget.Global
		);
		await context.globalState.update(STATE_KEYS.support, true);
		changed = true;
	}

	if (hasModernAgentHost()) {
		const agentHost = vscode.workspace.getConfiguration('chat.agentHost');
		if (agentHost.get<boolean>(AGENT_HOST_BYOK_SETTING) !== true) {
			await agentHost.update(AGENT_HOST_BYOK_SETTING, true, vscode.ConfigurationTarget.Global);
			await context.globalState.update(STATE_KEYS.byok, true);
			changed = true;
		}
	}

	const sessions = vscode.workspace.getConfiguration('sessions.chat.experimental');
	if (sessions.get<boolean>(AGENTS_PICKER_SETTING) === true) {
		await sessions.update(AGENTS_PICKER_SETTING, false, vscode.ConfigurationTarget.Global);
		await context.globalState.update(STATE_KEYS.picker, true);
		changed = true;
	}

	if (changed) {
		const reload = await vscode.window.showInformationMessage(
			'OpenCode Zen enabled VS Code Agents window support. Reload the window to apply it.',
			'Reload Now'
		);
		if (reload === 'Reload Now') {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	}
}

export async function revertAgentsWindowSupport(
	context: vscode.ExtensionContext,
	force = false
): Promise<void> {
	const extensions = vscode.workspace.getConfiguration('extensions');
	if (force || context.globalState.get<boolean>(STATE_KEYS.support)) {
		const support = extensions.get<Record<string, boolean>>(SUPPORT_AGENTS_WINDOW_SETTING, {});
		if (support[context.extension.id]) {
			const next = { ...support };
			delete next[context.extension.id];
			await extensions.update(
				SUPPORT_AGENTS_WINDOW_SETTING,
				Object.keys(next).length > 0 ? next : undefined,
				vscode.ConfigurationTarget.Global
			);
		}
		await context.globalState.update(STATE_KEYS.support, undefined);
	}

	if (force || context.globalState.get<boolean>(STATE_KEYS.byok)) {
		await vscode.workspace
			.getConfiguration('chat.agentHost')
			.update(AGENT_HOST_BYOK_SETTING, false, vscode.ConfigurationTarget.Global);
		await context.globalState.update(STATE_KEYS.byok, undefined);
	}

	if (force || context.globalState.get<boolean>(STATE_KEYS.picker)) {
		await vscode.workspace
			.getConfiguration('sessions.chat.experimental')
			.update(AGENTS_PICKER_SETTING, undefined, vscode.ConfigurationTarget.Global);
		await context.globalState.update(STATE_KEYS.picker, undefined);
	}
}
