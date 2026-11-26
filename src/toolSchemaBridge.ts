import { foldToolName, officialToolCandidates } from './toolRenames';

export interface ToolSchemaTarget {
	readonly name: string;
	readonly inputSchema?: unknown;
}

export interface ToolInvocation {
	readonly name: string;
	readonly input: Record<string, unknown>;
}

type SchemaRecord = Record<string, unknown>;

const PATH_ALIASES = ['filePath', 'file_path', 'fileName', 'file_name', 'uri', 'target_file'] as const;

const ARGUMENT_ALIASES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
	read: { path: PATH_ALIASES },
	edit: {
		path: PATH_ALIASES,
		oldString: ['old_str', 'oldText', 'old_text'],
		newString: ['new_str', 'newText', 'new_text'],
	},
	write: { path: PATH_ALIASES, content: ['file_text', 'text', 'contents'] },
	execute: { code: ['command', 'cmd', 'script'] },
	shell: { workdir: ['cwd', 'workingDirectory', 'working_directory'] },
	glob: { pattern: ['query'], path: ['cwd', 'workingDirectory'] },
	grep: { pattern: ['query'], include: ['glob', 'filePattern', 'file_pattern'] },
	webfetch: { url: ['uri'] },
	websearch: { query: ['q', 'searchQuery'] },
	skill: { id: ['skill', 'name', 'skillName'] },
	subagent: { agent: ['agentType', 'subagentType'] },
	question: {},
};

function buildReverseAliases(): Record<string, Record<string, string>> {
	const reverse: Record<string, Record<string, string>> = {};
	for (const [tool, aliases] of Object.entries(ARGUMENT_ALIASES)) {
		const entries: Record<string, string> = {};
		for (const [canonical, candidates] of Object.entries(aliases)) {
			for (const candidate of candidates) {
				entries[candidate] = canonical;
			}
		}
		reverse[tool] = entries;
	}
	return reverse;
}

const REVERSE_ARGUMENT_ALIASES = buildReverseAliases();

function asRecord(value: unknown): SchemaRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as SchemaRecord : {};
}

function schemaProperties(schema: unknown): SchemaRecord {
	const record = asRecord(schema);
	const properties = record.properties;
	return properties && typeof properties === 'object' && !Array.isArray(properties)
		? properties as SchemaRecord
		: {};
}

function allowsAdditional(schema: unknown): boolean {
	const record = asRecord(schema);
	return record.additionalProperties !== false;
}

function truncate(value: string, length: number): string {
	return value.length <= length ? value : value.slice(0, length);
}

function parseSchema(value: unknown): unknown {
	if (typeof value !== 'string') {
		return value;
	}
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}

export function normalizeLegacyQuestionArgs(input: unknown): Record<string, unknown> {
	const record = asRecord(input);
	if (Array.isArray(record.questions)) {
		return record;
	}

	const message = typeof record.message === 'string' ? record.message : 'Choose an option';
	if (!('requestedSchema' in record)) {
		return { questions: [{ question: message, header: truncate(message, 30), options: [] }] };
	}

	const properties = schemaProperties(parseSchema(record.requestedSchema));
	if (Object.keys(properties).length === 0) {
		return { questions: [{ question: message, header: truncate(message, 30), options: [] }] };
	}
	const questions: Array<Record<string, unknown>> = [];
	for (const [key, raw] of Object.entries(properties)) {
		const property = asRecord(raw);
		const values = Array.isArray(property.enum) ? property.enum : [];
		const names = Array.isArray(property.enumNames) ? property.enumNames : [];
		const options = values.map((value, index) => {
			const candidate = names[index];
			const label = typeof candidate === 'string' ? candidate : String(value);
			return { label, description: label === String(value) ? '' : String(value) };
		});
		questions.push({
			question: typeof property.description === 'string' ? property.description : message,
			header: truncate(typeof property.title === 'string' ? property.title : key, 30),
			options,
		});
	}

	return { questions };
}

export function normalizeRequestedSchemaType(input: unknown): Record<string, unknown> {
	const record = asRecord(input);
	if (typeof record.requestedSchema !== 'string') {
		return record;
	}
	return { ...record, requestedSchema: parseSchema(record.requestedSchema) ?? { type: 'object', properties: {} } };
}

export function normalizeV2QuestionToV1(input: unknown): Record<string, unknown> {
	const record = normalizeRequestedSchemaType(input);
	if (!Array.isArray(record.questions)) {
		return record;
	}
	const first = asRecord(record.questions[0]);
	const message = typeof first.question === 'string' ? first.question : 'Choose an option';
	const properties: Record<string, unknown> = {};
	for (const raw of record.questions) {
		const question = asRecord(raw);
		const values: string[] = [];
		const names: string[] = [];
		for (const optionRaw of Array.isArray(question.options) ? question.options : []) {
			const option = asRecord(optionRaw);
			const label = typeof option.label === 'string' ? option.label : '';
			const value = typeof option.description === 'string' && option.description !== '' ? option.description : label;
			values.push(value);
			names.push(label);
		}
		const key = foldToolName(typeof question.header === 'string' ? question.header : '') || 'answer';
		properties[key] = {
			type: 'string',
			title: typeof question.header === 'string' ? question.header : 'Answer',
			description: typeof question.question === 'string' ? question.question : message,
			enum: values,
			enumNames: names,
		};
	}
	return { message, requestedSchema: { type: 'object', properties } };
}

function questionArgsForTarget(input: unknown, targetSchema: unknown): Record<string, unknown> {
	const properties = schemaProperties(targetSchema);
	if ('questions' in properties) {
		return normalizeLegacyQuestionArgs(input);
	}
	if ('requestedSchema' in properties) {
		return normalizeV2QuestionToV1(input);
	}
	return asRecord(input);
}

function webSearchArgsForTarget(input: unknown, targetSchema: unknown): Record<string, unknown> {
	const properties = schemaProperties(targetSchema);
	if ('query' in properties || !('url' in properties)) {
		return asRecord(input);
	}
	const query = asRecord(input).query;
	if (typeof query !== 'string') {
		return asRecord(input);
	}
	return { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}` };
}

type PatchOperation = {
	readonly kind: 'add' | 'update' | 'delete';
	readonly path: string;
	readonly fileText: string;
	readonly oldText: string;
	readonly newText: string;
};

function parsePatch(input: unknown): PatchOperation | undefined {
	const raw = asRecord(input).patchText;
	if (typeof raw !== 'string') {
		return undefined;
	}
	const lines = raw.split(/\r?\n/);
	let kind: PatchOperation['kind'] | undefined;
	let path = '';
	let start = -1;
	for (let index = 0; index < lines.length; index++) {
		const match = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/.exec(lines[index]);
		if (match !== null) {
			kind = match[1].toLowerCase() as PatchOperation['kind'];
			path = match[2].trim();
			start = index + 1;
			break;
		}
	}
	if (kind === undefined || path === '' || start < 0) {
		return undefined;
	}
	const fileText: string[] = [];
	const oldText: string[] = [];
	const newText: string[] = [];
	for (let index = start; index < lines.length; index++) {
		const line = lines[index];
		if (line.startsWith('*** ')) {
			break;
		}
		if (kind === 'add' && line.startsWith('+')) {
			fileText.push(line.slice(1));
		} else if (kind === 'update' && line.startsWith('-') && !line.startsWith('---')) {
			oldText.push(line.slice(1));
		} else if (kind === 'update' && line.startsWith('+') && !line.startsWith('+++')) {
			newText.push(line.slice(1));
		}
	}
	return {
		kind,
		path,
		fileText: fileText.join('\n'),
		oldText: oldText.join('\n'),
		newText: newText.join('\n'),
	};
}

function preferredPatchCandidates(input: unknown): readonly string[] {
	switch (parsePatch(input)?.kind) {
		case 'add':
			return ['create', 'edit', 'bash'];
		case 'delete':
			return ['bash', 'edit', 'create'];
		case 'update':
			return ['edit', 'create', 'bash'];
		default:
			return ['edit', 'create', 'bash'];
	}
}

function patchArgsForTarget(input: unknown, targetSchema: unknown): Record<string, unknown> {
	const operation = parsePatch(input);
	if (operation === undefined) {
		return asRecord(input);
	}
	const properties = schemaProperties(targetSchema);
	if (operation.kind === 'add') {
		if ('file_text' in properties) {
			return { path: operation.path, file_text: operation.fileText };
		}
		if ('old_str' in properties && 'new_str' in properties) {
			return { path: operation.path, old_str: '', new_str: operation.fileText };
		}
	}
	if (operation.kind === 'delete' && 'command' in properties) {
		return { command: `rm -- ${JSON.stringify(operation.path)}` };
	}
	if (operation.kind === 'update' && 'old_str' in properties && 'new_str' in properties) {
		return { path: operation.path, old_str: operation.oldText, new_str: operation.newText };
	}
	return asRecord(input);
}

function resolveArgumentKey(
	key: string,
	aliases: Readonly<Record<string, string | readonly string[]>>,
	targetProperties: SchemaRecord
): string | undefined {
	if (key in targetProperties) {
		return key;
	}
	const foldedKey = foldToolName(key);
	for (const targetKey of Object.keys(targetProperties)) {
		if (foldToolName(targetKey) === foldedKey) {
			return targetKey;
		}
	}
	const raw = aliases[key];
	const candidates = typeof raw === 'string' ? [raw] : raw ?? [];
	for (const alias of candidates) {
		if (alias in targetProperties) {
			return alias;
		}
		const foldedAlias = foldToolName(alias);
		for (const targetKey of Object.keys(targetProperties)) {
			if (foldToolName(targetKey) === foldedAlias) {
				return targetKey;
			}
		}
	}
	return undefined;
}

function mapArguments(
	input: unknown,
	targetSchema: unknown,
	aliases: Readonly<Record<string, string | readonly string[]>>
): Record<string, unknown> {
	const targetProperties = schemaProperties(targetSchema);
	const mapped: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(asRecord(input))) {
		const targetKey = resolveArgumentKey(key, aliases, targetProperties);
		if (targetKey === undefined) {
			if (allowsAdditional(targetSchema)) {
				mapped[key] = value;
			}
			continue;
		}
		mapped[targetKey] = value;
	}
	return mapped;
}

export function canonicalizeToolResult(output: unknown): unknown {
	if (!output || typeof output !== 'object') {
		return { type: 'text', value: String(output ?? '') };
	}
	const record = asRecord(output);
	if (record.type === 'text') {
		return { type: 'text', value: String(record.value ?? '') };
	}
	if (record.type === 'json') {
		return { type: 'text', value: JSON.stringify(record.value, null, 2) };
	}
	if (record.type === 'content' && Array.isArray(record.value)) {
		const parts = record.value.filter((part) => {
			const item = asRecord(part);
			return item.type === 'image-data' || item.type === 'file-data';
		});
		if (parts.length > 0) {
			return { type: 'content', value: parts };
		}
		const text = record.value
			.map((part) => {
				const item = asRecord(part);
				return typeof item.text === 'string' ? item.text : '';
			})
			.filter((part) => part.length > 0)
			.join('\n');
		return { type: 'text', value: text };
	}
	return { type: 'text', value: JSON.stringify(record) };
}

export class ToolSchemaBridge {
	private readonly names = new Map<string, string>();
	private readonly targetsByName: ReadonlyMap<string, ToolSchemaTarget>;

	constructor(
		private readonly canonicalSchemas: Readonly<Record<string, unknown>>,
		targets: readonly ToolSchemaTarget[]
	) {
		for (const name of Object.keys(canonicalSchemas)) {
			this.names.set(foldToolName(name), name);
		}
		for (const name of Object.keys(canonicalSchemas)) {
			for (const candidate of officialToolCandidates(name)) {
				const key = foldToolName(candidate);
				if (!this.names.has(key)) {
					this.names.set(key, name);
				}
			}
		}
		this.targetsByName = new Map(targets.map((target) => [foldToolName(target.name), target]));
	}

	private canonicalCandidates(name: string): readonly string[] {
		const key = foldToolName(name);
		for (const canonical of Object.keys(this.canonicalSchemas)) {
			if (foldToolName(canonical) === key) {
				return [canonical];
			}
		}
		const candidates: string[] = [];
		for (const canonical of Object.keys(this.canonicalSchemas)) {
			if (officialToolCandidates(canonical).some((candidate) => foldToolName(candidate) === key)) {
				candidates.push(canonical);
			}
		}
		return candidates;
	}

	private resolveCanonicalName(name: string, input: unknown): string {
		const candidates = this.canonicalCandidates(name);
		if (candidates.length <= 1) {
			return candidates[0] ?? this.names.get(foldToolName(name)) ?? name;
		}
		const keys = Object.keys(asRecord(input));
		for (const canonical of candidates) {
			const properties = schemaProperties(this.canonicalSchemas[canonical]);
			for (const key of keys) {
				if (key in properties) {
					return canonical;
				}
				if (Object.keys(properties).some((property) => foldToolName(property) === foldToolName(key))) {
					return canonical;
				}
			}
		}
		return candidates[0];
	}

	canonicalize(name: string, input: unknown): ToolInvocation {
		const canonicalName = this.names.get(foldToolName(name)) ?? name;
		const args = canonicalName === 'question' ? normalizeRequestedSchemaType(input) : asRecord(input);
		return { name: canonicalName, input: args };
	}

	findTarget(canonicalName: string, boundClient?: string, input?: unknown): ToolSchemaTarget | undefined {
		const candidates: string[] = [];
		if (canonicalName === 'patch') {
			candidates.push(...preferredPatchCandidates(input));
		} else if (boundClient !== undefined) {
			candidates.push(boundClient);
		}
		candidates.push(...officialToolCandidates(canonicalName));
		for (const candidate of candidates) {
			const target = this.targetsByName.get(foldToolName(candidate));
			if (target !== undefined) {
				return target;
			}
		}
		return undefined;
	}

	toTarget(canonicalName: string, input: unknown, target: ToolSchemaTarget): ToolInvocation {
		let args = input;
		if (canonicalName === 'question') {
			args = questionArgsForTarget(input, target.inputSchema);
		} else if (canonicalName === 'websearch') {
			args = webSearchArgsForTarget(input, target.inputSchema);
		} else if (canonicalName === 'patch') {
			args = patchArgsForTarget(input, target.inputSchema);
		}
		return {
			name: target.name,
			input: mapArguments(args, target.inputSchema, ARGUMENT_ALIASES[canonicalName] ?? {}),
		};
	}

	toCanonical(targetName: string, input: unknown): ToolInvocation {
		const canonicalName = this.resolveCanonicalName(targetName, input);
		const args = canonicalName === 'question' ? normalizeLegacyQuestionArgs(input) : input;
		return {
			name: canonicalName,
			input: mapArguments(args, this.canonicalSchemas[canonicalName], REVERSE_ARGUMENT_ALIASES[canonicalName] ?? {}),
		};
	}
}
