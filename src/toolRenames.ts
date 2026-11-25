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
		const bound = this.official.get(wire);
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
		case 'shell':
			return ['Bash'];
		case 'edit':
			return ['Edit'];
		case 'glob':
			return ['Glob'];
		case 'grep':
			return ['Grep'];
		case 'question':
			return ['AskUserQuestion'];
		case 'read':
			return ['Read'];
		case 'skill':
			return ['Skill'];
		case 'subagent':
		case 'task':
			return ['Agent', 'Task', 'Subagent'];
		case 'todowrite':
			return ['TodoWrite'];
		case 'webfetch':
			return ['WebFetch'];
		case 'websearch':
			return ['WebSearch'];
		case 'write':
			return ['Write'];
		case 'patch':
			return ['Patch'];
		default:
			return [];
	}
}
