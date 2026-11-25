import { jsonSchema } from 'ai';
import * as vscode from 'vscode';
import { buildCliHeaders, buildToolRenames, clientToolWireName, projectForWorkdir, projectId, type CliRequestContext } from './cliShaping';
import { GatewayRouteResolver, providerBaseUrl, sdkPackageForProtocol, type ResolvedGatewayRoute } from './gatewayRoutes';
import type { ZenTransportManager } from './zenTransport';
import { isCanonicalSessionId, messageId, sessionId } from './identity';
import {
	clearByokApiKey,
	clearCredential,
	getGatewayCredential,
	getInferenceAuth,
	getOAuthInferenceAuth,
	signIn,
	storeByokApiKey,
	type InferenceAuth,
} from './oauth';
import { ModelRegistry } from './modelRegistry';
import { OPENAI_COMPAT_PROVIDER_NAME, streamZen } from './zenClient';
import { getOutputChannel } from './output';
import { toCopilotUsage, VSCODE_USAGE_MIME_TYPE, type ZenUsage } from './usage';

export const VENDOR_ID = 'opencode';
export const AGENT_VENDOR_ID = 'opencode-agent';

const AGENT_MODEL_SUFFIX = '::agent-host';
const AGENT_SESSION_TYPE = 'copilotcli';

const BYOK_GROUP_STATE_PREFIX = 'opencodeZen.byokGroup.v1.';
const OAUTH_PROMPTED_STATE_KEY = 'opencodeZen.oauthGroupPrompted.v1';

type AuthMethod = 'oauth' | 'apiKey' | 'signOut';

type GroupedModelOptions = vscode.PrepareLanguageModelChatModelOptions & {
	readonly configuration?: { readonly authMethod?: AuthMethod; readonly apiKey?: string; readonly lane?: string };
};

type ResponseOptionsWithConfig = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

function configuredValue(configuration: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = configuration?.[key];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function configuredApiKey(configuration: Record<string, unknown> | undefined): string | undefined {
	return configuredValue(configuration, 'apiKey');
}

function configuredAuthMethod(configuration: Record<string, unknown> | undefined): AuthMethod {
	const value = configuredValue(configuration, 'authMethod');
	return value === 'apiKey' || value === 'signOut' ? value : 'oauth';
}

export function modelsForLane(
	models: readonly vscode.LanguageModelChatInformation[],
	lane: string
): vscode.LanguageModelChatInformation[] {
	if (lane === 'zen') {
		return models.filter((model) => !model.id.endsWith('-go'));
	}
	if (lane === 'go') {
		return models.filter((model) => model.id.endsWith('-go'));
	}
	return [...models];
}

export function rawModelId(modelId: string): string {
	return modelId.endsWith(AGENT_MODEL_SUFFIX) ? modelId.slice(0, -AGENT_MODEL_SUFFIX.length) : modelId;
}

export class OpenCodeZenChatProvider implements vscode.LanguageModelChatProvider {
	private readonly registry: ModelRegistry;
	private readonly routeResolver: GatewayRouteResolver;
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	private readonly apiKeysByModelId = new Map<string, string>();
	private readonly byokGroupStateKey: string;
	private oauthPromptInFlight: Promise<void> | undefined;
	private lastGroupAuthMethod: AuthMethod | undefined;
	readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly transport?: ZenTransportManager,
		private readonly agentVariant = false
	) {
		this.byokGroupStateKey = `${BYOK_GROUP_STATE_PREFIX}${this.agentVariant ? AGENT_VENDOR_ID : VENDOR_ID}`;
		this.registry = new ModelRegistry(context);
		this.registry.onDidChange(() => this.onDidChangeEmitter.fire());
		this.routeResolver = new GatewayRouteResolver(
			context.workspaceState,
			() => getGatewayCredential(context.secrets)
		);
	}

	async refreshModels(force = false): Promise<void> {
		if (force) {
			this.registry.invalidate();
		}

		// Best-effort refresh, but don't crash activation.
		try {
			const auth = await getInferenceAuth(this.context.secrets);
			await this.registry.getModels({ force: true, anonymous: auth.apiKey === 'public' });
			this.onDidChangeEmitter.fire();
		} catch (err) {
			getOutputChannel().error(`Model refresh failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		await this.refreshRoutes(force);
	}

	private async refreshRoutes(force: boolean): Promise<void> {
		try {
			const routes = await this.routeResolver.refresh(force);
			if (routes) {
				getOutputChannel().info(
					`OpenCode Console routes refreshed (${Object.keys(routes.go).length} go, ${Object.keys(routes.zen).length} zen).`
				);
			}
		} catch (err) {
			getOutputChannel().warn(`Route discovery failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async resolveRoute(modelId: string): Promise<ResolvedGatewayRoute | undefined> {
		try {
			return await this.routeResolver.resolve(modelId);
		} catch (err) {
			getOutputChannel().warn(`Route lookup failed: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	private hasByokGroupConfigured(): boolean {
		return this.context.globalState.get<boolean>(this.byokGroupStateKey, false);
	}

	private async markByokGroupConfigured(): Promise<void> {
		await this.context.globalState.update(this.byokGroupStateKey, true);
	}

	private async ensureGroupAuth(
		authMethod: AuthMethod,
		apiKey: string | undefined,
		token: vscode.CancellationToken
	): Promise<InferenceAuth | undefined> {
		if (authMethod === 'signOut') {
			if (this.lastGroupAuthMethod !== 'signOut') {
				await clearCredential(this.context.secrets);
				await this.context.globalState.update(OAUTH_PROMPTED_STATE_KEY, false);
				getOutputChannel().info('OpenCode Zen signed out from the Add Models group.');
				this.lastGroupAuthMethod = 'signOut';
			}
			this.onDidChangeEmitter.fire();
			return undefined;
		}

		this.lastGroupAuthMethod = authMethod;

		if (authMethod === 'apiKey') {
			if (!apiKey) {
				getOutputChannel().warn('OpenCode Zen API key group needs an apiKey. Edit the group and add one.');
				return undefined;
			}
			await this.context.globalState.update(OAUTH_PROMPTED_STATE_KEY, false);
			await storeByokApiKey(this.context.secrets, apiKey);
			return { apiKey };
		}

		await clearByokApiKey(this.context.secrets);
		const existing = await getOAuthInferenceAuth(this.context.secrets);
		if (existing) {
			return existing;
		}
		if (this.context.globalState.get<boolean>(OAUTH_PROMPTED_STATE_KEY, false)) {
			return undefined;
		}
		if (!this.oauthPromptInFlight) {
			await this.context.globalState.update(OAUTH_PROMPTED_STATE_KEY, true);
			const controller = new AbortController();
			const subscription = token.onCancellationRequested(() => controller.abort());
			this.oauthPromptInFlight = (async () => {
				try {
					await signIn(this.context.secrets, controller.signal);
					getOutputChannel().info('OpenCode Zen OAuth sign-in completed from the Add Models group.');
					this.onDidChangeEmitter.fire();
				} catch (err) {
					if (!controller.signal.aborted) {
						const message = err instanceof Error ? err.message : String(err);
						getOutputChannel().error(`OpenCode Zen OAuth sign-in failed: ${message}`);
					}
				}
			})().finally(() => {
				subscription.dispose();
				this.oauthPromptInFlight = undefined;
			});
		}
		await this.oauthPromptInFlight;
		return getOAuthInferenceAuth(this.context.secrets);
	}

	private rememberApiKey(modelId: string, apiKey: string): void {
		this.apiKeysByModelId.set(modelId, apiKey);
		const rawId = rawModelId(modelId);
		if (rawId !== modelId) {
			this.apiKeysByModelId.set(rawId, apiKey);
		}
	}

	private async resolveRequestAuth(
		options: ResponseOptionsWithConfig,
		modelId: string
	): Promise<InferenceAuth> {
		const configured = configuredApiKey(options.modelConfiguration) ?? configuredApiKey(options.configuration);
		if (configured) {
			return { apiKey: configured };
		}
		const remembered = this.apiKeysByModelId.get(modelId) ?? this.apiKeysByModelId.get(rawModelId(modelId));
		if (remembered) {
			return { apiKey: remembered };
		}
		return getInferenceAuth(this.context.secrets);
	}

	async provideLanguageModelChatInformation(
		options: GroupedModelOptions,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		try {
			const configuration = options.configuration;
			let auth: InferenceAuth | undefined;

			if (configuration !== undefined) {
				if (configuration.authMethod === undefined && configuration.apiKey === undefined && configuration.lane === undefined) {
					return [];
				}
				await this.markByokGroupConfigured();
				auth = await this.ensureGroupAuth(
					configuredAuthMethod(configuration),
					configuredApiKey(configuration),
					token
				);
				if (!auth) {
					return [];
				}
			} else {
				if (!this.agentVariant && this.hasByokGroupConfigured()) {
					return [];
				}
				auth = await getInferenceAuth(this.context.secrets);
			}

			const models = await this.registry.getModels({ anonymous: auth.apiKey === 'public' });
			await this.refreshRoutes(false);

			if (this.agentVariant) {
				return models.map((model) => {
					const id = `${model.id}${AGENT_MODEL_SUFFIX}`;
					this.rememberApiKey(id, auth.apiKey);
					return {
						...model,
						id,
						name: `${model.name} (Agents)`,
						isBYOK: true,
						isUserSelectable: true,
						targetChatSessionType: AGENT_SESSION_TYPE,
					};
				});
			}

			const visible = configuration ? modelsForLane(models, configuration.lane ?? 'auto') : models;
			return visible.map((model) => {
				this.rememberApiKey(model.id, auth.apiKey);
				return { ...model, isBYOK: true, isUserSelectable: true };
			});
		} catch (err) {
			// If model metadata fetch fails, surface no models rather than throwing.
			getOutputChannel().error(`Model discovery failed: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: ResponseOptionsWithConfig,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const transportEndpoint = await this.transport?.getEndpoint();
		const auth = await this.resolveRequestAuth(options, model.id);

		const abortController = new AbortController();
		token.onCancellationRequested(() => abortController.abort());
		const requestDiagnostics = startRequestDiagnostics(model, options, messages);

		const rawId = rawModelId(model.id);
		const toolMode = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
		const route = await this.resolveRoute(rawId);
		const metadata = await this.registry.getModelProviderInfo(rawId);
		const providerInfo = route
			? {
				npm: sdkPackageForProtocol(route.route.protocol),
				api: providerBaseUrl(route.route),
				headers: metadata?.headers,
				options: metadata?.options,
				originalModelId: route.route.model_id,
			}
			: metadata;
		const isGoLane = route?.plan === 'go' || (!route && rawId.endsWith('-go'));
		const requestToolMode = isGoLane && toolMode === 'required' ? 'auto' : toolMode;
		const requestModelId = providerInfo?.originalModelId ?? rawId;
		const requestMeta = await getOrCreateRequestMetadata(this.context, options);
		const toolNameMap = buildToolNameMap(options.tools, providerInfo?.npm);
		const declaredToolNames = [...toolNameMap.toProvider.values()];
		const renames = buildToolRenames(declaredToolNames);
		const toolAliases = new Map(
			declaredToolNames.map((name) => [name, renames.wire(name) ?? clientToolWireName(name)])
		);
		for (const [vscodeName, providerName] of toolNameMap.toProvider) {
			toolNameMap.toVsCode.set(providerName, vscodeName);
		}
		const resolveToolName = (wire: string): string => {
			const declared = renames.resolve(wire);
			return toolNameMap.toVsCode.get(declared) ?? declared;
		};
		const tools = options.tools ? toolsToAiSdkTools(options.tools, toolNameMap.toProvider) : undefined;
		const coreMessages = messagesToAiSdkMessages(messages, toolNameMap.toProvider);
		const promptCaching = getPromptCachingConfig();
		const promptCacheKey =
			promptCaching.enabled && promptCaching.cacheKeyScope !== 'none'
				? requestMeta.sessionId
				: undefined;
		const cacheRetention = promptCaching.enabled ? promptCaching.retention : undefined;
		const anthropicCacheControl =
			promptCaching.enabled && providerInfo?.npm === '@ai-sdk/anthropic'
				? buildAnthropicCacheControl(promptCaching.anthropicTtl)
				: undefined;
		let cachedMessages = coreMessages;
		if (promptCaching.enabled && anthropicCacheControl) {
			cachedMessages = applyAnthropicCacheControl(coreMessages, anthropicCacheControl);
		} else if (promptCaching.enabled && providerInfo?.npm === '@ai-sdk/openai-compatible') {
			if (isGlm47ModelId(rawId)) {
				cachedMessages = removeOpenAICompatibleCacheControl(coreMessages);
			} else {
				cachedMessages = applyOpenAICompatibleCacheControl(coreMessages);
			}
		} else if (providerInfo?.npm === '@ai-sdk/openai-compatible') {
			cachedMessages = removeOpenAICompatibleCacheControl(coreMessages);
		}

		const { debugFlag, modelOptions } = splitDebugOptions(options.modelOptions);
		const baseProviderOptions = buildProviderOptions(
			modelOptions,
			providerInfo?.npm,
			promptCacheKey,
			cacheRetention,
			rawId,
			providerInfo?.options
		);
		const providerOptions = baseProviderOptions;
		const cliContext: CliRequestContext = {
			sessionId: requestMeta.sessionId,
			projectId: projectId(projectForWorkdir(requestMeta.workdir)),
			modelId: requestModelId,
			workdir: requestMeta.workdir,
			modelHeaders: providerInfo?.headers,
			toolAliases,
			shapeBody: providerInfo?.npm === '@ai-sdk/openai-compatible',
		};
		const requestHeaders = buildCliHeaders(cliContext);

		if (debugFlag) {
			logDebugRequest(model, requestModelId, requestToolMode, options, coreMessages, tools, providerInfo, providerOptions);
		}

		let textChars = 0;
		let toolCalls = 0;
		let usage: ZenUsage | undefined;

		try {
			await streamZen(
				{
					apiKey: auth.apiKey,
					modelId: requestModelId,
					messages: cachedMessages,
					tools,
					toolMode: requestToolMode,
					abortSignal: abortController.signal,
					providerOptions,
					providerNpm: providerInfo?.npm,
					baseURL: providerInfo?.api,
					headers: requestHeaders,
					resolveToolName,
					debugLogging: debugFlag,
					cliContext,
					baseFetch: transportEndpoint?.fetch,
				},
				{
					onTextDelta: (delta) => {
						if (delta) {
							textChars += delta.length;
							progress.report(new vscode.LanguageModelTextPart(delta));
						}
					},
					onToolCall: ({ toolCallId, toolName, input }) => {
						toolCalls++;
						const argumentKeys = input && typeof input === 'object' ? Object.keys(input).join(', ') : '';
						getOutputChannel().info(
							`Tool call ${requestDiagnostics.id}: ${toolName} [${argumentKeys || 'no args'}]`
						);
						progress.report(new vscode.LanguageModelToolCallPart(toolCallId, toolName, input));
					},
					onUsage: (snapshot) => {
						usage = snapshot;
						// Copilot reads token counts from this internal usage data part.
						progress.report(new vscode.LanguageModelDataPart(
							new TextEncoder().encode(JSON.stringify(toCopilotUsage(snapshot))),
							VSCODE_USAGE_MIME_TYPE
						));
					},
				}
			);
			finishRequestDiagnostics(requestDiagnostics, textChars, toolCalls, usage);
		} catch (err) {
			failRequestDiagnostics(requestDiagnostics, err);
			if (debugFlag) {
				logDebugError(model, requestModelId, requestToolMode, options, coreMessages, tools, providerInfo, err);
			}
			throw err;
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		void _model;
		void _token;
		// VS Code uses this for planning/truncation. We provide a rough estimate.
		const serialized = typeof text === 'string' ? text : JSON.stringify(text.content);
		return Math.max(1, Math.ceil(serialized.length / 4));
	}
}

type RequestDiagnostics = {
	readonly id: string;
	readonly startedAt: number;
};

function startRequestDiagnostics(
	model: vscode.LanguageModelChatInformation,
	options: vscode.ProvideLanguageModelChatResponseOptions,
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): RequestDiagnostics {
	const diagnostics = { id: messageId(), startedAt: Date.now() };
	const initiator = requestInitiator(options);
	const toolMode = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
	getOutputChannel().info(
		`Request ${diagnostics.id} started: ${model.name} (${model.id}); initiator=${initiator ?? 'unknown'}; ` +
		`messages=${messages.length} [${summarizeMessageRoles(messages)}]; tools=${options.tools?.length ?? 0} ` +
		`[${summarizeToolNames(options.tools)}]; mode=${toolMode}.`
	);
	return diagnostics;
}

function finishRequestDiagnostics(
	diagnostics: RequestDiagnostics,
	textChars: number,
	toolCalls: number,
	usage?: ZenUsage
): void {
	const tokenInfo = usage
		? `; tokens=${usage.promptTokens}/${usage.completionTokens}/${usage.totalTokens}, cached=${usage.cachedTokens}`
		: '';
	getOutputChannel().info(
		`Request ${diagnostics.id} completed in ${Date.now() - diagnostics.startedAt}ms: ` +
		`textChars=${textChars}, toolCalls=${toolCalls}${tokenInfo}.`
	);
}

function failRequestDiagnostics(diagnostics: RequestDiagnostics, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	getOutputChannel().error(
		`Request ${diagnostics.id} failed in ${Date.now() - diagnostics.startedAt}ms: ${message}`
	);
}

function requestInitiator(options: vscode.ProvideLanguageModelChatResponseOptions): string | undefined {
	const record = options as unknown as Record<string, unknown>;
	const value = record.requestInitiator;
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function summarizeMessageRoles(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
	let system = 0;
	let user = 0;
	let assistant = 0;
	for (const message of messages) {
		if (message.role === vscode.LanguageModelChatMessageRole.User) {
			user++;
		} else if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			assistant++;
		} else {
			system++;
		}
	}
	return `system=${system}, user=${user}, assistant=${assistant}`;
}

function summarizeToolNames(tools: readonly vscode.LanguageModelChatTool[] | undefined): string {
	if (!tools || tools.length === 0) {
		return 'none';
	}
	const names = tools.map((tool) => tool.name);
	const shown = names.slice(0, 12).join(', ');
	return names.length > 12 ? `${shown}, +${names.length - 12}` : shown;
}

function messagesToAiSdkMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	toolNameMap: ReadonlyMap<string, string>
): any[] {
	// We use `any` to avoid hard-coupling to ai-sdk's evolving CoreMessage shape.
	// But we must still satisfy AI SDK runtime validation.
	const toolNameByCallId = new Map<string, string>();
	for (const message of messages) {
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				toolNameByCallId.set(part.callId, mapToolName(part.name, toolNameMap));
			}
		}
	}

	const out: any[] = [];

	for (const message of messages) {
		const mapped = mapVsCodeMessageToAiSdkMessages(message, toolNameByCallId, toolNameMap);
		out.push(...mapped);
	}

	return out;
}

function mapVsCodeMessageToAiSdkMessages(
	message: vscode.LanguageModelChatRequestMessage,
	toolNameByCallId: ReadonlyMap<string, string>,
	toolNameMap: ReadonlyMap<string, string>
): any[] {
	const isUser = message.role === vscode.LanguageModelChatMessageRole.User;

	const textImageFileParts: any[] = [];
	const toolResultParts: any[] = [];
	const assistantParts: any[] = [];

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			const textPart = { type: 'text', text: part.value };
			if (isUser) {
				textImageFileParts.push(textPart);
			} else {
				assistantParts.push(textPart);
			}
			continue;
		}

		if (part instanceof vscode.LanguageModelToolCallPart) {
			// Assistant-only in VS Code input, but we handle defensively.
			assistantParts.push({
				type: 'tool-call',
				toolCallId: part.callId,
				toolName: mapToolName(part.name, toolNameMap),
				input: part.input,
			});
			continue;
		}

		if (part instanceof vscode.LanguageModelToolResultPart) {
			const toolName = toolNameByCallId.get(part.callId) ?? mapToolName('unknown', toolNameMap);
			toolResultParts.push({
				type: 'tool-result',
				toolCallId: part.callId,
				toolName,
				output: languageModelToolResultContentToOutput(part.content),
			});
			continue;
		}

		if (part instanceof vscode.LanguageModelDataPart) {
			const converted = dataPartToAiSdkPart(part);
			if (!converted) {
				continue;
			}

			if (isUser) {
				textImageFileParts.push(converted);
			} else {
				assistantParts.push(converted);
			}
			continue;
		}

		// Unknown VS Code part; drop to keep AI SDK validation happy.
	}

	const out: any[] = [];

	if (isUser) {
		if (textImageFileParts.length > 0) {
			out.push({ role: 'user', content: simplifyTextOnlyContent(textImageFileParts) });
		}
		if (toolResultParts.length > 0) {
			out.push({ role: 'tool', content: toolResultParts });
		}
	} else {
		out.push({ role: 'assistant', content: simplifyTextOnlyContent(assistantParts) });
	}

	return out;
}

function simplifyTextOnlyContent(parts: any[]): any {
	if (parts.length === 0) {
		return '';
	}
	if (parts.every((p) => p?.type === 'text' && typeof p.text === 'string')) {
		// Use string to satisfy the strictest schema path.
		return parts.map((p) => p.text).join('');
	}
	return parts;
}

function dataPartToAiSdkPart(part: vscode.LanguageModelDataPart): any | undefined {
	// VS Code may include internal metadata such as cache_control in Agent/Plan mode.
	if (part.mimeType === 'cache_control') {
		return undefined;
	}

	if (part.mimeType.startsWith('text/')) {
		return { type: 'text', text: new TextDecoder('utf-8').decode(part.data) };
	}

	if (part.mimeType.startsWith('image/')) {
		// AI SDK accepts Buffer/Uint8Array.
		return { type: 'image', image: Buffer.from(part.data), mimeType: part.mimeType };
	}

	// Fallback: represent as a file.
	return { type: 'file', data: Buffer.from(part.data), mimeType: part.mimeType };
}

function languageModelToolResultContentToOutput(
	content: Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart | vscode.LanguageModelDataPart | unknown>
): { type: 'text'; value: string } | { type: 'json'; value: unknown } | { type: 'content'; value: Array<any> } {
	const parts: Array<any> = [];
	const textChunks: string[] = [];

	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			textChunks.push(part.value);
			parts.push({ type: 'text', text: part.value });
			continue;
		}
		if (part instanceof vscode.LanguageModelPromptTsxPart) {
			const text = String(part.value);
			textChunks.push(text);
			parts.push({ type: 'text', text });
			continue;
		}
		if (part instanceof vscode.LanguageModelDataPart) {
			if (part.mimeType === 'cache_control') {
				continue;
			}
			if (part.mimeType.startsWith('text/')) {
				const text = new TextDecoder('utf-8').decode(part.data);
				textChunks.push(text);
				parts.push({ type: 'text', text });
				continue;
			}
			const base64 = Buffer.from(part.data).toString('base64');
			if (part.mimeType.startsWith('image/')) {
				parts.push({ type: 'image-data', data: base64, mediaType: part.mimeType });
				continue;
			}
			parts.push({ type: 'file-data', data: base64, mediaType: part.mimeType });
			continue;
		}

		if (part !== undefined) {
			parts.push({ type: 'custom', value: part });
		}
	}

	if (parts.length === 0) {
		return { type: 'text', value: '' };
	}

	if (parts.every((p) => p.type === 'text')) {
		return { type: 'text', value: textChunks.join('') };
	}

	return { type: 'content', value: parts };
}

function toolsToAiSdkTools(
	tools: readonly vscode.LanguageModelChatTool[],
	toolNameMap: ReadonlyMap<string, string>
): Record<string, any> {
	const mapped: Record<string, any> = {};
	for (const tool of tools) {
		// AI SDK expects either a Zod schema or a JSON Schema wrapped with jsonSchema().
		// VS Code provides plain JSON Schema objects, so we wrap them.
		const schema = normalizeToolSchema(tool.inputSchema);
		const name = mapToolName(tool.name, toolNameMap);
		mapped[name] = {
			description: tool.description,
			inputSchema: jsonSchema(schema as any),
			// No `execute`: VS Code invokes tools and sends results back on next turn.
		};
	}
	return mapped;
}

function normalizeToolSchema(schema: unknown): unknown {
	const fallback = { type: 'object', properties: {}, additionalProperties: true };
	if (!schema || typeof schema !== 'object') {
		return fallback;
	}

	const record = schema as Record<string, unknown>;
	if (record.type === 'object') {
		const hasProperties = typeof record.properties === 'object' && record.properties !== null;
		return {
			...record,
			properties: hasProperties ? record.properties : {},
			additionalProperties:
				record.additionalProperties === undefined ? true : record.additionalProperties,
		};
	}

	return record;
}

function buildToolNameMap(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
	providerNpm: string | undefined
): { toProvider: Map<string, string>; toVsCode: Map<string, string> } {
	const toProvider = new Map<string, string>();
	const toVsCode = new Map<string, string>();

	if (!tools || tools.length === 0) {
		return { toProvider, toVsCode };
	}

	const needsSanitize = providerNpm === '@ai-sdk/anthropic' || providerNpm === '@ai-sdk/openai' || providerNpm === '@ai-sdk/openai-compatible';
	const used = new Set<string>();

	for (const tool of tools) {
		const baseName = needsSanitize ? sanitizeToolName(tool.name) : tool.name;
		let name = baseName;
		let suffix = 1;
		while (used.has(name)) {
			name = `${baseName}_${suffix++}`.slice(0, 128);
		}
		used.add(name);
		toProvider.set(tool.name, name);
		toVsCode.set(name, tool.name);
	}

	return { toProvider, toVsCode };
}

function sanitizeToolName(name: string): string {
	const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_');
	const trimmed = cleaned.length > 0 ? cleaned.slice(0, 128) : 'tool';
	return trimmed;
}

function mapToolName(name: string, toolNameMap: ReadonlyMap<string, string>): string {
	return toolNameMap.get(name) ?? name;
}

type PromptCachingConfig = {
	enabled: boolean;
	retention: 'in_memory' | '24h';
	cacheKeyScope: 'workspace' | 'global' | 'none';
	anthropicTtl: '5m' | '1h' | 'none';
};

type RequestMetadata = {
	workdir: string;
	sessionId: string;
	requestId: string;
};

function getPromptCachingConfig(): PromptCachingConfig {
	const config = vscode.workspace.getConfiguration('opencodeZen');
	return {
		enabled: config.get<boolean>('promptCaching.enabled', true),
		retention: config.get<'in_memory' | '24h'>('promptCaching.retention', 'in_memory'),
		cacheKeyScope: config.get<'workspace' | 'global' | 'none'>('promptCaching.cacheKeyScope', 'workspace'),
		anthropicTtl: config.get<'5m' | '1h' | 'none'>('promptCaching.anthropicTtl', '5m'),
	};
}

async function getOrCreateRequestMetadata(
	context: vscode.ExtensionContext,
	options: vscode.ProvideLanguageModelChatResponseOptions
): Promise<RequestMetadata> {
	const sessionStorageKey = 'opencodeZen.cliSessionId';
	const stored = context.workspaceState.get<string>(sessionStorageKey);
	const stableSessionId = stored && isCanonicalSessionId(stored) ? stored : sessionId();
	if (stableSessionId !== stored) {
		await context.workspaceState.update(sessionStorageKey, stableSessionId);
	}

	const workdir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
	const requestId = messageId();

	const overriddenSessionId = tryGetModelOptionString(options.modelOptions, 'sessionID')
		?? tryGetModelOptionString(options.modelOptions, 'sessionId');

	return {
		workdir,
		sessionId: overriddenSessionId && isCanonicalSessionId(overriddenSessionId) ? overriddenSessionId : stableSessionId,
		requestId,
	};
}

function tryGetModelOptionString(
	modelOptions: vscode.ProvideLanguageModelChatResponseOptions['modelOptions'] | undefined,
	key: string
): string | undefined {
	if (!modelOptions || typeof modelOptions !== 'object') {
		return undefined;
	}
	const value = (modelOptions as Record<string, unknown>)[key];
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function buildAnthropicCacheControl(ttl: '5m' | '1h' | 'none'): { type: 'ephemeral'; ttl?: '5m' | '1h' } {
	if (ttl === 'none') {
		return { type: 'ephemeral' };
	}
	return { type: 'ephemeral', ttl };
}

function applyAnthropicCacheControl(messages: any[], cacheControl: { type: 'ephemeral'; ttl?: '5m' | '1h' }): any[] {
	if (!Array.isArray(messages) || messages.length === 0) {
		return messages;
	}

	return applyCacheControlToMessages(messages, (message) => {
		const existing = (message.providerOptions as Record<string, any> | undefined)?.anthropic;
		if (existing?.cacheControl || existing?.cache_control) {
			return message;
		}
		return {
			...message,
			providerOptions: mergeProviderOptions(message.providerOptions, { anthropic: { cacheControl } }),
		};
	});
}

function applyOpenAICompatibleCacheControl(messages: any[]): any[] {
	if (!Array.isArray(messages) || messages.length === 0) {
		return messages;
	}

	return applyCacheControlToMessages(messages, (message) => {
		const existing = (message.providerOptions as Record<string, any> | undefined)?.openaiCompatible;
		if (existing?.cache_control) {
			return message;
		}
		return {
			...message,
			providerOptions: mergeProviderOptions(message.providerOptions, {
				openaiCompatible: { cache_control: { type: 'ephemeral' } },
			}),
		};
	});
}

function removeOpenAICompatibleCacheControl(messages: any[]): any[] {
	if (!Array.isArray(messages) || messages.length === 0) {
		return messages;
	}

	let changed = false;
	const stripped = messages.map((message) => {
		if (!message || typeof message !== 'object') {
			return message;
		}
		const providerOptions = (message.providerOptions as Record<string, any> | undefined)?.openaiCompatible;
		if (!providerOptions || providerOptions.cache_control === undefined) {
			return message;
		}
		changed = true;
		const merged = mergeProviderOptions(message.providerOptions, {
			openaiCompatible: { cache_control: undefined },
		});
		return {
			...message,
			providerOptions: merged,
		};
	});

	return changed ? stripped : messages;
}

function isGlm47ModelId(modelId: string): boolean {
	const normalized = modelId.trim().toLowerCase();
	return normalized === 'glm-4.7' || normalized.endsWith('/glm-4.7');
}

function applyCacheControlToMessages(messages: any[], updater: (message: any) => any): any[] {
	const systemIndices: number[] = [];
	const nonSystemIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const role = messages[i]?.role;
		if (role === 'system') {
			systemIndices.push(i);
		} else {
			nonSystemIndices.push(i);
		}
	}

	const selected = new Set<number>();
	for (const index of systemIndices.slice(0, 2)) {
		selected.add(index);
	}
	for (const index of nonSystemIndices.slice(-2)) {
		selected.add(index);
	}

	if (selected.size === 0) {
		return messages;
	}

	return messages.map((message, index) => {
		if (!selected.has(index) || !message || typeof message !== 'object') {
			return message;
		}
		return updater(message);
	});
}

function buildProviderOptions(
	modelOptions: Record<string, unknown> | undefined,
	providerNpm: string | undefined,
	cacheKey: string | undefined,
	retention: 'in_memory' | '24h' | undefined,
	modelId: string,
	modelDefaults: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
	const merged = modelOptions ? { ...modelOptions } : {};
	const normalizedModelId = modelId.toLowerCase();
	const result: Record<string, unknown> = modelDefaults ? { ...modelDefaults } : {};

	if (providerNpm === '@ai-sdk/openai') {
		result.store = false;
	}

	if (providerNpm === '@ai-sdk/google') {
		result.thinkingConfig = {
			includeThoughts: true,
			...(normalizedModelId.includes('gemini-3') ? { thinkingLevel: 'high' } : {}),
		};
	}

	if (providerNpm === '@ai-sdk/anthropic' && isKimiK25(normalizedModelId)) {
		result.thinking = {
			type: 'enabled',
			budgetTokens: 16_000,
		};
	}

	if (normalizedModelId.includes('gpt-5') && !normalizedModelId.includes('gpt-5-chat')) {
		if (!normalizedModelId.includes('gpt-5-pro')) {
			result.reasoningEffort = 'medium';
			result.reasoningSummary = 'auto';
		}
		if (normalizedModelId.includes('gpt-5.') && !normalizedModelId.includes('codex') && !normalizedModelId.includes('-chat')) {
			result.textVerbosity = 'low';
		}
		result.include = ['reasoning.encrypted_content'];
	}

	const setCacheKey = (merged.setCacheKey as boolean | undefined) ?? true;
	delete merged.setCacheKey;

	if (cacheKey && setCacheKey) {
		if (providerNpm === '@ai-sdk/openai') {
			result.promptCacheKey = cacheKey;
			result.prompt_cache_key = cacheKey;
			if (retention && retention !== 'in_memory') {
				result.promptCacheRetention = retention;
				result.prompt_cache_retention = retention;
			}
		} else if (providerNpm === '@ai-sdk/openai-compatible') {
			result.prompt_cache_key = cacheKey;
			result.promptCacheKey = cacheKey;
			if (retention && retention !== 'in_memory') {
				result.prompt_cache_retention = retention;
				result.promptCacheRetention = retention;
			}
		}
	}

	const providerKey = providerOptionsKey(providerNpm);
	if (providerNpm === '@ai-sdk/openai-compatible') {
		const namedCurrent = (merged[OPENAI_COMPAT_PROVIDER_NAME] as Record<string, unknown> | undefined) ?? {};
		merged[OPENAI_COMPAT_PROVIDER_NAME] = { ...namedCurrent, ...result };

		const genericCurrent = (merged.openaiCompatible as Record<string, unknown> | undefined) ?? {};
		merged.openaiCompatible = { ...genericCurrent, ...result };
	} else if (providerKey) {
		const current = (merged[providerKey] as Record<string, unknown> | undefined) ?? {};
		merged[providerKey] = { ...current, ...result };
	}

	return Object.keys(merged).length > 0 ? merged : undefined;
}

function providerOptionsKey(providerNpm: string | undefined): string | undefined {
	if (providerNpm === '@ai-sdk/openai') {
		return 'openai';
	}
	if (providerNpm === '@ai-sdk/anthropic') {
		return 'anthropic';
	}
	if (providerNpm === '@ai-sdk/google') {
		return 'google';
	}
	if (providerNpm === '@ai-sdk/openai-compatible') {
		return OPENAI_COMPAT_PROVIDER_NAME;
	}
	return undefined;
}

function isKimiK25(modelId: string): boolean {
	return modelId.includes('k2p5') || modelId.includes('kimi-k2.5') || modelId.includes('kimi-k2p5');
}

function mergeProviderOptions(
	base: Record<string, unknown> | undefined,
	addition: Record<string, unknown>
): Record<string, unknown> {
	if (!base || typeof base !== 'object') {
		return { ...addition };
	}

	const merged = { ...base } as Record<string, unknown>;
	for (const [key, value] of Object.entries(addition)) {
		const existing = merged[key];
		if (existing && typeof existing === 'object' && value && typeof value === 'object') {
			merged[key] = { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) };
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

function splitDebugOptions(
	modelOptions: vscode.ProvideLanguageModelChatResponseOptions['modelOptions'] | undefined
): { debugFlag: boolean; modelOptions?: Record<string, unknown> } {
	if (!modelOptions || typeof modelOptions !== 'object') {
		return { debugFlag: false, modelOptions: modelOptions as Record<string, unknown> | undefined };
	}

	const copy = { ...(modelOptions as Record<string, unknown>) };
	const debugFlag = Boolean(copy.__opencodeDebugSelfTest);
	delete copy.__opencodeDebugSelfTest;

	return { debugFlag, modelOptions: Object.keys(copy).length > 0 ? copy : undefined };
}

function logDebugRequest(
	model: vscode.LanguageModelChatInformation,
	requestModelId: string,
	requestToolMode: 'required' | 'auto',
	options: vscode.ProvideLanguageModelChatResponseOptions,
	coreMessages: any[],
	tools: Record<string, any> | undefined,
	providerInfo: { npm: string; api: string } | undefined,
	providerOptions: Record<string, unknown> | undefined,
): void {
	const output = getOutputChannel();
	output.info('Debug: provider request payload');
	output.info(`Model: ${model.name} (${model.id})`);
	output.info(`Request Model ID: ${requestModelId}`);
	output.info(`Request Tool mode: ${requestToolMode}`);
	output.info(`Tools enabled: ${tools ? Object.keys(tools).length : 0}`);
	output.append(`\n${safeJson({
		modelId: requestModelId,
		messages: coreMessages,
		tools,
		toolMode: requestToolMode,
		providerOptions: providerOptions ?? options.modelOptions ?? undefined,
		provider: providerInfo,
	})}\n`);
}

function logDebugError(
	model: vscode.LanguageModelChatInformation,
	requestModelId: string,
	requestToolMode: 'required' | 'auto',
	options: vscode.ProvideLanguageModelChatResponseOptions,
	coreMessages: any[],
	tools: Record<string, any> | undefined,
	providerInfo: { npm: string; api: string } | undefined,
	err: unknown
): void {
	const output = getOutputChannel();
	output.error('Debug: provider error');
	output.info(`Model: ${model.name} (${model.id})`);
	output.info(`Request Model ID: ${requestModelId}`);
	output.info(`Request Tool mode: ${requestToolMode}`);
	output.append(`\n${safeJson({
		modelId: requestModelId,
		messages: coreMessages,
		tools,
		toolMode: requestToolMode,
		modelOptions: options.modelOptions ?? undefined,
		provider: providerInfo,
		error: serializeError(err),
	})}\n`);
}

function serializeError(err: unknown): unknown {
	const seen = new Set<unknown>();

	const toPlain = (value: unknown, depth: number): unknown => {
		if (value === null || value === undefined) {
			return value;
		}
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			return value;
		}
		if (value instanceof Uint8Array) {
			return Buffer.from(value).toString('utf-8');
		}
		if (typeof value !== 'object') {
			return String(value);
		}
		if (seen.has(value)) {
			return '[Circular]';
		}
		seen.add(value);
		if (depth <= 0) {
			return '[MaxDepth]';
		}

		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.getOwnPropertyNames(record)) {
			out[key] = toPlain(record[key], depth - 1);
		}
		if ('cause' in record) {
			out.cause = toPlain(record.cause, depth - 1);
		}
		return out;
	};

	return toPlain(err, 4);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
