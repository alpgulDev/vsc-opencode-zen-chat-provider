export const CLIENT_TOOL_PREFIX = 'mcp_';
export const TOOL_WIRE_NAME_LIMIT = 64;
const TOOL_NAME_SEPARATORS = new Set(['_', '.', '-', ' ', '\t', '\r', '\n']);

export function foldToolName(name: string): string {
	let folded = '';
	for (const character of name.toLowerCase()) {
		if (!TOOL_NAME_SEPARATORS.has(character)) {
			folded += character;
		}
	}
	return folded;
}

export class ToolRenames {
	private readonly toWire = new Map<string, string>();
	private readonly toClient = new Map<string, string>();
	private readonly official = new Map<string, string>();
	private readonly byCase = new Map<string, string>();
	private readonly byShape = new Map<string, string>();

	get size(): number {
		return this.toWire.size;
	}

	wire(client: string): string | undefined {
		if (client === '') {
			return undefined;
		}
		return this.toWire.get(client);
	}

	client(wire: string): string | undefined {
		if (wire === '') {
			return undefined;
		}
		return this.toClient.get(wire);
	}

	officialClient(name: string): string | undefined {
		if (name === '') {
			return undefined;
		}
		return this.official.get(name);
	}

	bindOfficial(name: string, client: string): void {
		if (name === '' || client === '') {
			return;
		}
		if (!this.official.has(name)) {
			this.official.set(name, client);
		}
	}

	add(client: string, wire: string): void {
		if (client === '' || wire === '' || client === wire) {
			return;
		}
		const existing = this.toWire.get(client);
		if (existing !== undefined) {
			if (existing !== wire) {
				return;
			}
		} else {
			if (this.toClient.has(wire)) {
				return;
			}
			this.toWire.set(client, wire);
			this.toClient.set(wire, client);
		}
		this.bindFolded(this.byCase, client.toLowerCase(), client);
		this.bindFolded(this.byShape, foldToolName(client), client);
	}

	private bindFolded(folded: Map<string, string>, key: string, client: string): void {
		if (key === '') {
			return;
		}
		const existing = folded.get(key);
		if (existing !== undefined) {
			if (existing !== client) {
				folded.set(key, '');
			}
			return;
		}
		folded.set(key, client);
	}

	hasPrefix(prefix: string): boolean {
		if (prefix === '') {
			return false;
		}
		for (const wire of this.toClient.keys()) {
			if (wire.startsWith(prefix)) {
				return true;
			}
		}
		return false;
	}

	hasLongerPrefix(prefix: string): boolean {
		if (prefix === '') {
			return false;
		}
		for (const wire of this.toClient.keys()) {
			if (wire.length > prefix.length && wire.startsWith(prefix)) {
				return true;
			}
		}
		return false;
	}

	resolve(wire: string): string {
		if (wire === '') {
			return wire;
		}
		const exact = this.toClient.get(wire);
		if (exact !== undefined) {
			return exact;
		}
		const bound = this.official.get(wire) ?? this.official.get(wire.toLowerCase());
		if (bound !== undefined) {
			return bound;
		}
		let client = wire;
		if (wire.startsWith(CLIENT_TOOL_PREFIX) && wire.length > CLIENT_TOOL_PREFIX.length) {
			client = wire.slice(CLIENT_TOOL_PREFIX.length);
		}
		const declared = this.toWire.get(client);
		if (declared !== undefined) {
			return client;
		}
		const byCase = this.byCase.get(client.toLowerCase());
		if (byCase !== undefined) {
			return byCase === '' ? client : byCase;
		}
		const byShape = this.byShape.get(foldToolName(client));
		if (byShape !== undefined && byShape !== '') {
			return byShape;
		}
		return client;
	}

	restore(wire: string): string {
		return this.resolve(wire);
	}
}

export function officialToolCandidates(name: string): readonly string[] {
	switch (name.toLowerCase()) {
		case 'bash':
		case 'execute':
		case 'shell':
			return ['Bash', 'bash', 'run_in_terminal', 'execute_command'];
		case 'edit':
			return [
				'Edit', 'replace_string_in_file', 'multi_replace_string_in_file',
				'insert_edit_into_file', 'edit_file', 'str_replace_editor',
			];
		case 'glob':
			return ['Glob', 'list_dir', 'file_search'];
		case 'grep':
			return ['Grep', 'grep_search', 'find_text_in_files', 'codebase_search'];
		case 'question':
			return ['ask_user', 'AskUserQuestion', 'request_user_input'];
		case 'read':
			return ['Read', 'view', 'read_file', 'view_file'];
		case 'skill':
			return ['Skill'];
		case 'subagent':
		case 'task':
			return ['Agent', 'Task', 'Subagent', 'runSubagent'];
		case 'todowrite':
			return ['TodoWrite', 'manage_todo_list'];
		case 'webfetch':
			return ['WebFetch', 'web_fetch', 'fetch_webpage'];
		case 'websearch':
			return ['WebSearch', 'web_search', 'search_web', 'web_fetch'];
		case 'write':
			return ['Write', 'create', 'create_file', 'write_file'];
		case 'patch':
			return ['Patch', 'apply_patch', 'apply_patch_tool', 'edit', 'create', 'bash'];
		default:
			return [];
	}
}
