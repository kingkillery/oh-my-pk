export type MeshCliJsonPrimitive = string | number | boolean | null;

export interface MeshCliJsonObject {
	readonly [key: string]: MeshCliJson;
}

export type MeshCliJson = MeshCliJsonPrimitive | readonly MeshCliJson[] | MeshCliJsonObject;

export type MeshCliCommand = "submit" | "status" | "follow" | "cancel" | "artifacts" | "trace";
export type MeshCliEnvelopeCommand = MeshCliCommand | "help" | "unknown";
export type MeshCliEnvelopeType = "result" | "event" | "complete" | "error";

export interface MeshCliError {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
	readonly unavailable?: boolean;
}

/**
 * The only wire format emitted by this package. It is deliberately JSON-safe
 * and JSONL-friendly so callers can pipe a follow stream without parsing
 * human prose or provider-specific errors.
 */
export interface MeshCliEnvelope {
	readonly schemaVersion: "ompk.mesh-cli/v1";
	readonly ok: boolean;
	readonly command: MeshCliEnvelopeCommand;
	readonly requestId: string;
	readonly sequence: number;
	readonly type: MeshCliEnvelopeType;
	readonly data?: MeshCliJson;
	readonly error?: MeshCliError;
}

export interface MeshCliRequestBase {
	readonly requestId: string;
}

export interface MeshCliSubmitRequest extends MeshCliRequestBase {
	/** Caller-owned key; the CLI never replaces or generates an effect key. */
	readonly idempotencyKey: string;
	/** Service-specific task submission body, retained without interpretation. */
	readonly payload: MeshCliJsonObject;
}

export interface MeshCliStatusRequest extends MeshCliRequestBase {
	readonly taskId?: string;
	readonly cursor?: string;
}

export interface MeshCliFollowRequest extends MeshCliRequestBase {
	readonly taskId: string;
	readonly cursor?: string;
	readonly limit?: number;
}

export interface MeshCliCancelRequest extends MeshCliRequestBase {
	readonly taskId: string;
	/** Caller-owned key; cancellation remains safely retryable. */
	readonly idempotencyKey: string;
	readonly reason?: string;
}

export interface MeshCliArtifactsRequest extends MeshCliRequestBase {
	readonly taskId: string;
	readonly cursor?: string;
}

export interface MeshCliTraceRequest extends MeshCliRequestBase {
	readonly taskId: string;
	readonly cursor?: string;
}

export interface MeshCliUnavailableResult {
	readonly status: "unavailable" | "unsupported";
	readonly code?: string;
	readonly reason?: string;
	readonly retryable?: boolean;
}

/**
 * Adapters may return domain records that are not immediately JSON-safe (for
 * example Date or bigint values). The CLI boundary normalizes them before
 * output; adapters never get to write directly to stdout.
 */
export type MeshCliApiResult = unknown;
export type MeshCliFollowResult = MeshCliApiResult | AsyncIterable<MeshCliApiResult>;

/**
 * Transport-free application boundary. The CLI never creates a backend,
 * contacts Nostr, opens Docker, or obtains secrets. An OMPK bridge injects an
 * adapter that owns those capabilities and the authoritative state.
 */
export interface MeshCliApi {
	readonly submit?: (request: MeshCliSubmitRequest) => Promise<MeshCliApiResult>;
	readonly status?: (request: MeshCliStatusRequest) => Promise<MeshCliApiResult>;
	readonly follow?: (request: MeshCliFollowRequest) => Promise<MeshCliFollowResult>;
	readonly cancel?: (request: MeshCliCancelRequest) => Promise<MeshCliApiResult>;
	readonly artifacts?: (request: MeshCliArtifactsRequest) => Promise<MeshCliApiResult>;
	readonly trace?: (request: MeshCliTraceRequest) => Promise<MeshCliApiResult>;
}

export interface MeshCliWriter {
	write(line: string): void | Promise<void>;
}
