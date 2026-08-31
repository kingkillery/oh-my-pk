export class ContentHashFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContentHashFormatError";
	}
}

export class ContentHashMismatchError extends Error {
	readonly expected: string;
	readonly actual: string;

	constructor(expected: string, actual: string) {
		super("content SHA-256 does not match the expected digest");
		this.name = "ContentHashMismatchError";
		this.expected = expected;
		this.actual = actual;
	}
}

export class ContentIntegrityError extends Error {
	readonly sha256: string;

	constructor(sha256: string) {
		super("stored content does not match its content-addressed path");
		this.name = "ContentIntegrityError";
		this.sha256 = sha256;
	}
}
