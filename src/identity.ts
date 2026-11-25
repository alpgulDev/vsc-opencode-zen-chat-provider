import { randomBytes } from 'crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RANDOM_LENGTH = 14;

let lastTimestamp = 0;
let counter = 0;

export function create(descending: boolean, timestamp = Date.now()): string {
	if (timestamp !== lastTimestamp) {
		lastTimestamp = timestamp;
		counter = 0;
	}
	counter++;

	const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
	const value = descending ? ~current : current;
	const time = Array.from({ length: 6 }, (_, index) =>
		Number((value >> BigInt(40 - 8 * index)) & 0xffn)
			.toString(16)
			.padStart(2, '0')
	).join('');

	const bytes = randomBytes(RANDOM_LENGTH);
	return time + Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

export function ascending(): string {
	return create(false);
}

export function descending(): string {
	return create(true);
}

export function sessionId(): string {
	return `ses_${descending()}`;
}

export function messageId(): string {
	return `msg_${ascending()}`;
}

export function isCanonicalSessionId(value: string): boolean {
	return /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(value);
}
