import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, type ModelMessage } from 'ai';
import { createCliFetch, type CliRequestContext } from './cliShaping';
import { getOutputChannel } from './output';
import { normalizeUsage, type ZenUsage } from './usage';

export const ZEN_BASE_URL = 'https://opencode.ai/inference/openai/v1';
export const ZEN_GO_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';

export const QUOTA_ERROR_MARKERS = [
	'insufficient_quota', 'quota_exceeded', 'quota exceeded', 'quota exhausted',
	'rate_limit', 'rate limit', 'rate-limit', 'usage_limit', 'usage limit',
	'freeusagelimiterror', 'insufficient balance', 'credit balance is too low',
	'额度不足', '配额已用尽',
] as const;

export function isQuotaError(status: number | undefined, body: string): boolean {
	if (status === 429) {
		return true;
	}
	const lowered = body.toLowerCase();
	return QUOTA_ERROR_MARKERS.some((marker) => lowered.includes(marker));
}

export type ToolMode = 'auto' | 'required';

export type StreamCallbacks = {
	onTextDelta: (delta: string) => void;
	onToolCall: (args: { toolCallId: string; toolName: string; input: object }) => void;
	onUsage?: (usage: ZenUsage) => void;
};

type ApiErrorDetails = {
	statusCode?: number;
	statusText?: string;
	responseBody?: string;
	requestId?: string;
	url?: string;
	requestBody?: unknown;
	originalMessage?: string;
	retryAfterMs?: number;
	quota?: boolean;
};

function wrapApiError(err: unknown, extra?: Partial<ApiErrorDetails>): Error {
	const details = { ...extractErrorDetails(err), ...(extra ?? {}) };
	const baseMessage = err instanceof Error ? err.message : String(err);

	if (details.statusCode === 401 || baseMessage.includes('Unauthorized') || baseMessage.includes('401') || baseMessage.includes('Invalid credential')) {
		const wrapped = new Error(
			'Unauthorized: Run "OpenCode Zen: Sign In" to connect your OpenCode Console account.',
			{ cause: err instanceof Error ? err : undefined }
		);
		return Object.assign(wrapped, details);
	}
	if (baseMessage.includes('404') || baseMessage.includes('Not Found')) {
		const wrapped = new Error('Model not found. The requested model may not be available.', {
			cause: err instanceof Error ? err : undefined,
		});
		return Object.assign(wrapped, details);
	}
	if (isQuotaError(details.statusCode, `${details.responseBody ?? ''} ${details.originalMessage ?? ''} ${baseMessage}`)) {
		const retry = details.retryAfterMs !== undefined
			? ` Retry after ${Math.ceil(details.retryAfterMs / 1000)}s.`
			: '';
		const wrapped = new Error(
			`OpenCode usage limit reached. Run "OpenCode Zen: Sign In" with a subscribed account or wait for the reset.${retry} (${baseMessage})`,
			{ cause: err instanceof Error ? err : undefined }
		);
		return Object.assign(wrapped, details, { quota: true });
	}

	const wrapped = new Error(baseMessage, { cause: err instanceof Error ? err : undefined });
	return Object.assign(wrapped, details);
}

function headerValue(candidate: Record<string, unknown>, name: string): string | undefined {
	const headers = candidate.headers;
	if (!headers) {
		return undefined;
	}
	const getter = (headers as { get?: (key: string) => string | null }).get;
	if (typeof getter === 'function') {
		return getter.call(headers, name) ?? undefined;
	}
	const target = name.toLowerCase();
	if (Array.isArray(headers)) {
		for (const entry of headers) {
			if (Array.isArray(entry) && String(entry[0]).toLowerCase() === target) {
				return String(entry[1]);
			}
		}
		return undefined;
	}
	if (typeof headers === 'object') {
		for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
			if (key.toLowerCase() === target && typeof value === 'string') {
				return value;
			}
		}
	}
	return undefined;
}

function parseRetryAfter(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const seconds = Number(value.trim());
	if (Number.isFinite(seconds) && seconds >= 0) {
		return seconds * 1000;
	}
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

function extractErrorDetails(err: unknown): ApiErrorDetails {
	const record = (value: unknown): Record<string, unknown> | undefined => {
		if (value && typeof value === 'object') {
			return value as Record<string, unknown>;
		}
		return undefined;
	};

	const candidates = [record(err), record((err as { cause?: unknown })?.cause)].filter(Boolean) as Record<string, unknown>[];
	const details: ApiErrorDetails = {};

	for (const candidate of candidates) {
		if (details.statusCode === undefined) {
			const status = candidate.statusCode ?? candidate.status;
			if (typeof status === 'number') {
				details.statusCode = status;
			}
		}
		if (details.statusText === undefined && typeof candidate.statusText === 'string') {
			details.statusText = candidate.statusText;
		}
		if (details.url === undefined && typeof candidate.url === 'string') {
			details.url = candidate.url;
		}
		if (details.requestId === undefined && typeof candidate.requestId === 'string') {
			details.requestId = candidate.requestId;
		}
		if (details.responseBody === undefined && candidate.responseBody !== undefined) {
			details.responseBody = normalizeToString(candidate.responseBody);
		}
		if (details.requestBody === undefined && candidate.requestBody !== undefined) {
			details.requestBody = candidate.requestBody;
		}
		if (details.originalMessage === undefined && typeof candidate.message === 'string') {
			details.originalMessage = candidate.message;
		}
		if (details.retryAfterMs === undefined) {
			const retryAfter = parseRetryAfter(headerValue(candidate, 'retry-after'));
			if (retryAfter !== undefined) {
				details.retryAfterMs = retryAfter;
			}
		}
	}

	return details;
}

function normalizeToString(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value instanceof Uint8Array) {
		return Buffer.from(value).toString('utf-8');
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export const OPENAI_COMPAT_PROVIDER_NAME = 'opencode';

export async function streamZen(
	options: {
		apiKey: string;
		modelId: string;
		messages: ModelMessage[];
		tools?: Record<string, any>;
		toolMode: ToolMode;
		abortSignal: AbortSignal;
		headers?: Record<string, string>;
		providerOptions?: Record<string, any>;
		debugLogging?: boolean;
		providerNpm?: string;
		baseURL?: string;
		toolNameMap?: ReadonlyMap<string, string>;
		resolveToolName?: (name: string) => string;
		cliContext?: CliRequestContext;
		baseFetch?: typeof fetch;
	},
	callbacks: StreamCallbacks
): Promise<void> {
	if (!options.apiKey || options.apiKey.trim() === '') {
		throw new Error('OpenCode inference credentials are empty. Run "OpenCode Zen: Sign In".');
	}

	const baseURL = options.baseURL ?? ZEN_BASE_URL;
	const providerNpm = options.providerNpm ?? '@ai-sdk/openai-compatible';
	const cliFetch = options.cliContext
		? createCliFetch(options.cliContext, options.baseFetch ?? fetch)
		: options.baseFetch;
	const fetchImpl = options.debugLogging
		? createDebugFetch(cliFetch ?? fetch)
		: cliFetch;
	const provider = createProvider(
		providerNpm,
		options.apiKey,
		baseURL,
		fetchImpl
	);
	const endpointPath = getEndpointPath(providerNpm);

	const result = streamText({
		model: provider(options.modelId),
		messages: options.messages,
		headers: options.headers,
		tools: options.tools,
		toolChoice: options.tools ? options.toolMode : undefined,
		abortSignal: options.abortSignal,
		providerOptions: options.providerOptions,
	});

	const requestBody: Record<string, unknown> = {
		model: options.modelId,
		messages: options.messages,
		tools: options.tools,
		tool_choice: options.tools ? options.toolMode : undefined,
		provider_options: options.providerOptions ?? undefined,
	};

	let emitted = false;
	let sawAnyChunk = false;

	try {
		for await (const part of result.fullStream) {
			sawAnyChunk = true;

			if (part.type === 'text-delta') {
				emitted = emitted || part.text.length > 0;
				callbacks.onTextDelta(part.text);
				continue;
			}

			// VS Code has no reasoning response part. Drop reasoning deltas instead of
			// leaking the model's internal monologue into the chat response.
			if (part.type === 'reasoning-delta') {
				continue;
			}

			if (part.type === 'tool-call') {
				emitted = true;
				callbacks.onToolCall({
					toolCallId: part.toolCallId,
					toolName: options.resolveToolName?.(part.toolName)
						?? options.toolNameMap?.get(part.toolName)
						?? part.toolName,
					input: (part.input ?? {}) as object,
				});
				continue;
			}

			if (part.type === 'error') {
				throw wrapApiError(part.error, {
					requestBody,
					url: `${baseURL}${endpointPath}`,
				});
			}

			// Ignore finish/metadata parts.
		}
	} catch (err) {
		throw wrapApiError(err, {
			requestBody,
			url: `${baseURL}${endpointPath}`,
		});
	}

	// VS Code shows "Sorry, no response was returned" if we emit nothing.
	if (!emitted) {
		callbacks.onTextDelta(sawAnyChunk ? '\n' : 'No response returned by model.');
	}

	const usage = normalizeUsage(await result.usage);
	if (usage) {
		callbacks.onUsage?.(usage);
		const output = getOutputChannel();
		output.info(
			`Usage: prompt=${usage.promptTokens}, completion=${usage.completionTokens}, ` +
			`total=${usage.totalTokens}, cached=${usage.cachedTokens}`
		);
		if (usage.cacheWriteTokens > 0) {
			output.info(`Prompt cache: write=${usage.cacheWriteTokens}`);
		}
	}
}

function createProvider(
	providerNpm: string,
	apiKey: string,
	baseURL: string,
	fetchImpl?: typeof fetch
): (modelId: string) => any {
	switch (providerNpm) {
		case '@ai-sdk/anthropic':
			return createAnthropic({ apiKey, baseURL, fetch: fetchImpl }) as any;
		case '@ai-sdk/openai':
			return createOpenAI({ apiKey, baseURL, fetch: fetchImpl }) as any;
		case '@ai-sdk/google':
			return createGoogleGenerativeAI({ apiKey, baseURL, fetch: fetchImpl }) as any;
		case '@ai-sdk/openai-compatible':
		default:
			return createOpenAICompatible({
				name: OPENAI_COMPAT_PROVIDER_NAME,
				apiKey,
				baseURL,
				fetch: fetchImpl,
				includeUsage: true,
				transformRequestBody: (args) => applyOpenAICompatibleCaching(args),
			});
	}
}

function applyOpenAICompatibleCaching(args: Record<string, any>): Record<string, any> {
	const modelId = typeof args.model === 'string' ? args.model.toLowerCase() : '';
	const providerOptions = extractCompatibleProviderOptions(args);
	const isGlm47 = modelId === 'glm-4.7' || modelId.endsWith('/glm-4.7');
	if (isGlm47) {
		const hasCacheKey =
			args.prompt_cache_key !== undefined || providerOptions?.prompt_cache_key !== undefined;
		const hasRetention =
			args.prompt_cache_retention !== undefined || providerOptions?.prompt_cache_retention !== undefined;
		if (!hasCacheKey && !hasRetention) {
			return args;
		}
		const sanitizedProviderOptions =
			providerOptions && typeof providerOptions === 'object'
				? {
						...providerOptions,
						prompt_cache_key: undefined,
						prompt_cache_retention: undefined,
					}
				: providerOptions;
		return {
			...args,
			prompt_cache_key: undefined,
			prompt_cache_retention: undefined,
			provider_options:
				sanitizedProviderOptions && args.provider_options && typeof args.provider_options === 'object'
					? {
							...(args.provider_options as Record<string, any>),
							[OPENAI_COMPAT_PROVIDER_NAME]: sanitizedProviderOptions,
						}
					: args.provider_options,
		};
	}
	const cacheKey = args.prompt_cache_key ?? providerOptions?.prompt_cache_key;
	const retention = args.prompt_cache_retention ?? providerOptions?.prompt_cache_retention;

	if (!cacheKey && !retention) {
		return args;
	}

	return {
		...args,
		prompt_cache_key: cacheKey ?? args.prompt_cache_key,
		prompt_cache_retention: retention ?? args.prompt_cache_retention,
	};
}

function extractCompatibleProviderOptions(args: Record<string, any>): Record<string, any> | undefined {
	const snake = args?.provider_options;
	const camel = args?.providerOptions;

	const candidates = [
		snake?.[OPENAI_COMPAT_PROVIDER_NAME],
		snake?.openaiCompatible,
		snake?.opencode,
		snake?.['opencode-zen'],
		camel?.[OPENAI_COMPAT_PROVIDER_NAME],
		camel?.openaiCompatible,
		camel?.opencode,
		camel?.['opencode-zen'],
	];

	for (const candidate of candidates) {
		if (candidate && typeof candidate === 'object') {
			return candidate as Record<string, any>;
		}
	}

	return undefined;
}

function getEndpointPath(providerNpm: string): string {
	if (providerNpm === '@ai-sdk/anthropic') {
		return '/messages';
	}
	if (providerNpm === '@ai-sdk/openai') {
		return '/responses';
	}
	if (providerNpm === '@ai-sdk/google') {
		return '/v1beta/models';
	}
	return '/chat/completions';
}

function createDebugFetch(baseFetch: typeof fetch = fetch): typeof fetch {
	const output = getOutputChannel();

	return async (input, init) => {
		const requestInfo = await serializeRequest(input, init);
		output.info('Debug: HTTP request');
		output.append(`\n${requestInfo}\n`);

		const response = await baseFetch(input, init);
		const responseInfo = await serializeResponse(response);

		if (!response.ok) {
			output.error('Debug: HTTP response (non-OK)');
			output.append(`\n${responseInfo}\n`);
		} else {
			output.info('Debug: HTTP response');
			output.append(`\n${responseInfo}\n`);
		}

		return response;
	};
}

async function serializeRequest(
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1]
): Promise<string> {
	const request = new Request(input, init);
	const headers = redactHeaders(request.headers);
	let body: string | undefined;
	try {
		body = await request.clone().text();
	} catch {
		body = undefined;
	}

	return safeJson({
		method: request.method,
		url: request.url,
		headers,
		body: body && body.length > 0 ? body : undefined,
	});
}

async function serializeResponse(response: Response): Promise<string> {
	let bodyText: string | undefined;
	try {
		bodyText = await response.clone().text();
	} catch {
		bodyText = undefined;
	}

	return safeJson({
		status: response.status,
		statusText: response.statusText,
		url: response.url,
		headers: redactHeaders(response.headers),
		body: bodyText && bodyText.length > 0 ? bodyText : undefined,
	});
}

function redactHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		const lower = key.toLowerCase();
		if (lower === 'authorization' || lower === 'x-api-key') {
			out[key] = '[REDACTED]';
			continue;
		}
		out[key] = value;
	}
	return out;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
