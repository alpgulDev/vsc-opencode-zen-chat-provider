export const VSCODE_USAGE_MIME_TYPE = 'usage';

export type ZenUsage = {
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly totalTokens: number;
	readonly cachedTokens: number;
	readonly cacheWriteTokens: number;
	readonly reasoningTokens: number;
};

export type CopilotUsagePayload = {
	readonly prompt_tokens: number;
	readonly completion_tokens: number;
	readonly total_tokens: number;
	readonly prompt_tokens_details?: {
		cached_tokens: number;
		cache_creation_input_tokens?: number;
	};
	readonly completion_tokens_details?: {
		reasoning_tokens: number;
	};
};

function record(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function nonNegative(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined;
	}
	return Math.max(0, Math.trunc(value));
}

function firstNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		const candidate = nonNegative(value);
		if (candidate !== undefined) {
			return candidate;
		}
	}
	return undefined;
}

export function normalizeUsage(usage: unknown): ZenUsage | undefined {
	const root = record(usage);
	if (!root) {
		return undefined;
	}

	const raw = record(root.raw);
	const inputDetails = record(root.inputTokenDetails);
	const outputDetails = record(root.outputTokenDetails);
	const rawInputDetails = record(raw?.prompt_tokens_details) ?? record(raw?.input_tokens_details);
	const rawOutputDetails = record(raw?.completion_tokens_details) ?? record(raw?.output_tokens_details);

	const promptTokens = firstNumber(root.inputTokens, raw?.prompt_tokens, raw?.input_tokens);
	const completionTokens = firstNumber(root.outputTokens, raw?.completion_tokens, raw?.output_tokens);
	const inferredTotal = promptTokens !== undefined && completionTokens !== undefined
		? promptTokens + completionTokens
		: undefined;
	const totalTokens = firstNumber(root.totalTokens, raw?.total_tokens, inferredTotal);
	if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
		return undefined;
	}

	return {
		promptTokens: promptTokens ?? 0,
		completionTokens: completionTokens ?? 0,
		totalTokens: totalTokens ?? 0,
		cachedTokens: firstNumber(
			inputDetails?.cacheReadTokens,
			root.cachedInputTokens,
			rawInputDetails?.cached_tokens,
			raw?.cache_read_input_tokens,
			raw?.cache_read_tokens,
			raw?.cached_tokens
		) ?? 0,
		cacheWriteTokens: firstNumber(
			inputDetails?.cacheWriteTokens,
			rawInputDetails?.cache_creation_input_tokens,
			raw?.cache_creation_input_tokens,
			raw?.cache_write_tokens
		) ?? 0,
		reasoningTokens: firstNumber(
			outputDetails?.reasoningTokens,
			root.reasoningTokens,
			rawOutputDetails?.reasoning_tokens
		) ?? 0,
	};
}

export function toCopilotUsage(usage: ZenUsage): CopilotUsagePayload {
	const promptTokensDetails: { cached_tokens: number; cache_creation_input_tokens?: number } = {
		cached_tokens: usage.cachedTokens,
	};
	if (usage.cacheWriteTokens > 0) {
		promptTokensDetails.cache_creation_input_tokens = usage.cacheWriteTokens;
	}

	return {
		prompt_tokens: usage.promptTokens,
		completion_tokens: usage.completionTokens,
		total_tokens: usage.totalTokens,
		prompt_tokens_details: promptTokensDetails,
		...(usage.reasoningTokens > 0 ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}),
	};
}
