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

/** The manifest references bytes that have not been published to the configured CAS. */
export class ArtifactContentMissingError extends Error {
	readonly artifactId: string;
	readonly contentSha256: string;

	constructor(artifactId: string, contentSha256: string) {
		super(`artifact ${artifactId} references content that is not present in the content-addressed store`);
		this.name = "ArtifactContentMissingError";
		this.artifactId = artifactId;
		this.contentSha256 = contentSha256;
	}
}

/** The CAS bytes exist but do not match the size declared by the immutable manifest. */
export class ArtifactContentSizeMismatchError extends Error {
	readonly artifactId: string;
	readonly expectedSizeBytes: number;
	readonly actualSizeBytes: number;

	constructor(artifactId: string, expectedSizeBytes: number, actualSizeBytes: number) {
		super(`artifact ${artifactId} content size does not match the manifest`);
		this.name = "ArtifactContentSizeMismatchError";
		this.artifactId = artifactId;
		this.expectedSizeBytes = expectedSizeBytes;
		this.actualSizeBytes = actualSizeBytes;
	}
}

/** An artifact ID already belongs to a different immutable manifest. */
export class ArtifactManifestConflictError extends Error {
	readonly artifactId: string;
	readonly existingManifestDigest: string;
	readonly receivedManifestDigest: string;

	constructor(artifactId: string, existingManifestDigest: string, receivedManifestDigest: string) {
		super(`artifact ${artifactId} is already registered with a different manifest digest`);
		this.name = "ArtifactManifestConflictError";
		this.artifactId = artifactId;
		this.existingManifestDigest = existingManifestDigest;
		this.receivedManifestDigest = receivedManifestDigest;
	}
}
