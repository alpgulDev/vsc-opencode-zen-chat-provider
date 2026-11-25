import * as vscode from 'vscode';
import { ensureAgentsWindowSupport, isAgentsWindowEnabled, isAutoEnableEnabled, revertAgentsWindowSupport } from './agentsWindow';
import { ZenTransportManager } from './zenTransport';
import { getOutputChannel } from './output';
import { AGENT_VENDOR_ID, OpenCodeZenChatProvider, VENDOR_ID } from './provider';

let activeTransport: ZenTransportManager | undefined;

export function activate(context: vscode.ExtensionContext) {
	const output = getOutputChannel();
	const transport = new ZenTransportManager(context);
	activeTransport = transport;
	const provider = new OpenCodeZenChatProvider(context, transport);
	const agentProvider = new OpenCodeZenChatProvider(context, transport, true);

	const addModels = async (): Promise<void> => {
		await vscode.commands.executeCommand('workbench.action.chat.manage');
		const byokEnabled = vscode.workspace.getConfiguration().get<boolean>('chat.agentHost.byokModels.enabled');
		if (byokEnabled !== true) {
			const enable = await vscode.window.showWarningMessage(
				'OpenCode Zen models require BYOK models in the Agents window.',
				'Enable'
			);
			if (enable) {
				await vscode.workspace.getConfiguration().update(
					'chat.agentHost.byokModels.enabled',
					true,
					vscode.ConfigurationTarget.Global
				);
			}
		}
	};

	context.subscriptions.push(
		output,
		transport,
		vscode.commands.registerCommand('opencodeZen.addModels', addModels),
		vscode.commands.registerCommand('opencodeZen.refreshModels', async () => {
			await provider.refreshModels(true);
			vscode.window.showInformationMessage('OpenCode Zen model list refreshed.');
		}),
		vscode.commands.registerCommand('opencodeZen.revertAgentsWindowSupport', async () => {
			await revertAgentsWindowSupport(context, true);
			vscode.window.showInformationMessage(
				'OpenCode Zen reverted the Agents window settings. Reload the window for the change to take effect.'
			);
		}),
		vscode.commands.registerCommand('opencodeZen.restartTransport', async () => {
			const endpoint = await transport.restart();
			if (endpoint) {
				vscode.window.showInformationMessage(`Bun-compatible transport restarted at ${endpoint.baseURL}.`);
			} else {
				vscode.window.showInformationMessage('Bun-compatible transport is disabled.');
			}
		})
	);

	void transport.getEndpoint().catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		output.error(`Bun-compatible transport startup failed: ${message}`);
	});

	try {
		if (!vscode.lm?.registerLanguageModelChatProvider) {
			output.error('VS Code Language Model API unavailable. Update VS Code to 1.104+.');
			vscode.window.showWarningMessage('OpenCode Zen requires VS Code 1.104+ to provide models.');
			return;
		}
		context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider));
		if (isAgentsWindowEnabled()) {
			context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(AGENT_VENDOR_ID, agentProvider));
		}

		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('opencodeZen.agentsWindow') ||
					event.affectsConfiguration('opencodeZen.autoEnableAgentsWindow')
				) {
					if (isAgentsWindowEnabled() && isAutoEnableEnabled()) {
						void ensureAgentsWindowSupport(context);
					} else {
						void revertAgentsWindowSupport(context);
					}
				}
			})
		);

		if (isAgentsWindowEnabled() && isAutoEnableEnabled()) {
			void ensureAgentsWindowSupport(context);
		}
		void warmModelPickerMetadata();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		output.error(`OpenCode Zen activation failed: ${message}`);
		vscode.window.showWarningMessage('OpenCode Zen failed to activate. Check the OpenCode Zen output channel for details.');
		console.error(err);
	}
}

async function warmModelPickerMetadata(): Promise<void> {
	if (!vscode.lm?.selectChatModels) {
		return;
	}
	const vendors = [VENDOR_ID];
	if (isAgentsWindowEnabled()) {
		vendors.push(AGENT_VENDOR_ID);
	}
	await Promise.allSettled(vendors.map((vendor) => vscode.lm.selectChatModels({ vendor })));
}

export async function deactivate(): Promise<void> {
	await activeTransport?.stop();
	activeTransport = undefined;
}
