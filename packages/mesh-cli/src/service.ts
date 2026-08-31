import { isMeshCliJsonObject, redactMeshCliError, toMeshCliJson } from "./json";
import type {
	MeshCliApi,
	MeshCliApiResult,
	MeshCliArtifactsRequest,
	MeshCliCancelRequest,
	MeshCliCommand,
	MeshCliEnvelope,
	MeshCliEnvelopeCommand,
	MeshCliError,
	MeshCliFollowRequest,
	MeshCliFollowResult,
	MeshCliJson,
	MeshCliJsonObject,
	MeshCliStatusRequest,
	MeshCliSubmitRequest,
	MeshCliTraceRequest,
	MeshCliUnavailableResult,
	MeshCliWriter,
} from "./types";

const SCHEMA_VERSION = "ompk.mesh-cli/v1" as const;
const COMMANDS = new Set<MeshCliCommand>(["submit", "status", "follow", "cancel", "artifacts", "trace"]);
const VALUE_FLAGS = new Set(["request", "idempotency-key", "request-id", "task-id", "cursor", "limit", "reason", "goal"]);
const GLOBAL_FLAGS = new Set(["json", "help", "request-id"]);

type ParsedFlag = string | true;

interface ParsedArguments {
	readonly commandToken?: string;
	readonly flags: ReadonlyMap<string, ParsedFlag>;
	readonly positional: readonly string[];
}

interface ParsedInvocation {
	readonly command: MeshCliEnvelopeCommand;
	readonly requestId: string;
	readonly parsed: ParsedArguments;
}

interface KnownInvocation extends ParsedInvocation {
	readonly command: MeshCliCommand;
}

class MeshCliInputError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "MeshCliInputError";
	}
}

/** Public adapter error. Its message is redacted before it reaches output. */
export class MeshCliApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly options: Readonly<{ retryable?: boolean; unavailable?: boolean }> = {},
	) {
		super(message);
		this.name = "MeshCliApiError";
	}
}

/**
 * The library-first command dispatcher. Its only effect is yielding envelopes;
 * writers and all privileged behavior are supplied by the caller.
 */
export class MeshCliService {
	readonly #api: MeshCliApi;

	constructor(api: MeshCliApi) {
		this.#api = api;
	}

	async *dispatch(argv: readonly string[]): AsyncGenerator<MeshCliEnvelope, void, void> {
		const fallbackRequestId = requestIdFromRawArgs(argv);
		let invocation: ParsedInvocation | undefined;
		try {
			invocation = parseInvocation(argv, fallbackRequestId);
			if (invocation.command === "help") {
				yield successEnvelope("help", invocation.requestId, 0, "result", helpData());
				return;
			}
			if (!isKnownInvocation(invocation)) {
				throw new MeshCliInputError("unsupported_command", "The requested mesh command is not supported.");
			}
			for await (const envelope of this.#dispatchKnown(invocation)) yield envelope;
		} catch (error) {
			yield errorEnvelope(invocation?.command ?? "unknown", invocation?.requestId ?? fallbackRequestId, 0, toCliError(error));
		}
	}

	async *#dispatchKnown(invocation: KnownInvocation): AsyncGenerator<MeshCliEnvelope, void, void> {
		const { command, parsed, requestId } = invocation;
		assertKnownOptions(command, parsed.flags);
		switch (command) {
			case "submit": {
				const submit = this.#api.submit;
				if (!submit) {
					yield unavailableEnvelope(command, requestId);
					return;
				}
				yield resultEnvelope(command, requestId, await submit(submitRequest(parsed, requestId)));
				return;
			}
			case "status": {
				const status = this.#api.status;
				if (!status) {
					yield unavailableEnvelope(command, requestId);
					return;
				}
				yield resultEnvelope(command, requestId, await status(statusRequest(parsed, requestId)));
				return;
			}
			case "follow": {
				const follow = this.#api.follow;
				if (!follow) {
					yield unavailableEnvelope(command, requestId);
					return;
				}
				yield* followEnvelopes(command, requestId, await follow(followRequest(parsed, requestId)));
				return;
			}
			case "cancel": {
				const cancel = this.#api.cancel;
				if (!cancel) {
					yield unavailableEnvelope(command, requestId);
					return;
				}
				yield resultEnvelope(command, requestId, await cancel(cancelRequest(parsed, requestId)));
				return;
			}
			case "artifacts": {
				const artifacts = this.#api.artifacts;
				if (!artifacts) {
					yield unavailableEnvelope(command, requestId);
					return;
				}
				yield resultEnvelope(command, requestId, await artifacts(artifactsRequest(parsed, requestId)));
				return;
			}
			case "trace": {
				const trace = this.#api.trace;
				if (!trace) {
					yield unavailableEnvelope(command, requestId);
					return;
				}
				yield resultEnvelope(command, requestId, await trace(traceRequest(parsed, requestId)));
			}
		}
	}
}

export function createMeshCliService(api: MeshCliApi): MeshCliService {
	return new MeshCliService(api);
}

/** Empty adapter for the standalone executable before an OMPK bridge is configured. */
export function createUnavailableMeshCliApi(): MeshCliApi {
	return Object.freeze({});
}

/** Writes stable JSONL envelopes and returns a process-appropriate exit status. */
export async function runMeshCli(argv: readonly string[], api: MeshCliApi, writer: MeshCliWriter): Promise<number> {
	let exitCode = 0;
	for await (const envelope of createMeshCliService(api).dispatch(argv)) {
		if (!envelope.ok) exitCode = 1;
		await writer.write(`${JSON.stringify(envelope)}\n`);
	}
	return exitCode;
}

function parseInvocation(argv: readonly string[], fallbackRequestId: string): ParsedInvocation {
	const parsed = parseArguments(argv);
	const requestId = stringOption(parsed.flags, "request-id") ?? fallbackRequestId;
	if (!isSafeRequestId(requestId)) throw new MeshCliInputError("invalid_request_id", "The request identifier is invalid.");
	if (parsed.flags.has("help") || parsed.commandToken === undefined || parsed.commandToken === "help") {
		return Object.freeze({ command: "help" as const, requestId, parsed });
	}
	if (!COMMANDS.has(parsed.commandToken as MeshCliCommand)) {
		return Object.freeze({ command: "unknown" as const, requestId, parsed });
	}
	return Object.freeze({ command: parsed.commandToken as MeshCliCommand, requestId, parsed });
}

function parseArguments(argv: readonly string[]): ParsedArguments {
	const flags = new Map<string, ParsedFlag>();
	const positional: string[] = [];
	let commandToken: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token) continue;
		if (token === "--") {
			positional.push(...argv.slice(index + 1));
			break;
		}
		if (token.startsWith("--")) {
			const equalIndex = token.indexOf("=");
			const name = token.slice(2, equalIndex === -1 ? undefined : equalIndex);
			if (!name) throw new MeshCliInputError("invalid_option", "A command option is invalid.");
			if (flags.has(name)) throw new MeshCliInputError("duplicate_option", "A command option was supplied more than once.");
			if (equalIndex !== -1) {
				const value = token.slice(equalIndex + 1);
				if (!VALUE_FLAGS.has(name)) throw new MeshCliInputError("invalid_option", "This command option does not take a value.");
				if (value.length === 0) throw new MeshCliInputError("invalid_option", "A command option requires a value.");
				flags.set(name, value);
				continue;
			}
			if (VALUE_FLAGS.has(name)) {
				const value = argv[index + 1];
				if (!value || value.startsWith("--")) throw new MeshCliInputError("missing_option_value", "A command option requires a value.");
				flags.set(name, value);
				index += 1;
				continue;
			}
			flags.set(name, true);
			continue;
		}
		if (commandToken === undefined) commandToken = token;
		else positional.push(token);
	}
	return Object.freeze({ commandToken, flags, positional: Object.freeze(positional) });
}

function isKnownInvocation(invocation: ParsedInvocation): invocation is KnownInvocation {
	return COMMANDS.has(invocation.command as MeshCliCommand);
}

function assertKnownOptions(command: MeshCliCommand, flags: ReadonlyMap<string, ParsedFlag>): void {
	const allowed = new Set(GLOBAL_FLAGS);
	if (command === "submit") {
		allowed.add("request");
		allowed.add("idempotency-key");
		allowed.add("goal");
	} else if (command === "cancel") {
		allowed.add("task-id");
		allowed.add("idempotency-key");
		allowed.add("reason");
	} else {
		allowed.add("task-id");
		allowed.add("cursor");
		if (command === "follow") allowed.add("limit");
	}
	for (const name of flags.keys()) {
		if (!allowed.has(name)) throw new MeshCliInputError("unsupported_option", "The command option is not supported here.");
	}
}

function submitRequest(parsed: ParsedArguments, requestId: string): MeshCliSubmitRequest {
	if (parsed.positional.length > 0) throw new MeshCliInputError("unexpected_argument", "Submit accepts task fields only through options.");
	const payload = jsonObjectOption(parsed.flags, "request") ?? {};
	const goal = stringOption(parsed.flags, "goal");
	const goalFromPayload = typeof payload.goal === "string" ? payload.goal : undefined;
	if (goal !== undefined && goalFromPayload !== undefined && goal !== goalFromPayload) {
		throw new MeshCliInputError("conflicting_option", "The submission goal was supplied with conflicting values.");
	}
	const combinedPayload = Object.freeze({ ...payload, ...(goal === undefined ? {} : { goal }) });
	const idempotencyKey = consistentStringOption(parsed.flags, "idempotency-key", combinedPayload.idempotencyKey);
	if (!idempotencyKey) throw new MeshCliInputError("idempotency_key_required", "Submit requires an idempotency key.");
	return Object.freeze({ requestId, idempotencyKey, payload: combinedPayload });
}

function statusRequest(parsed: ParsedArguments, requestId: string): MeshCliStatusRequest {
	const taskId = optionalTaskId(parsed);
	return Object.freeze({ requestId, ...(taskId === undefined ? {} : { taskId }), ...cursorOption(parsed.flags) });
}

function followRequest(parsed: ParsedArguments, requestId: string): MeshCliFollowRequest {
	const taskId = requiredTaskId(parsed);
	const limit = positiveIntegerOption(parsed.flags, "limit");
	return Object.freeze({ requestId, taskId, ...cursorOption(parsed.flags), ...(limit === undefined ? {} : { limit }) });
}

function cancelRequest(parsed: ParsedArguments, requestId: string): MeshCliCancelRequest {
	const taskId = requiredTaskId(parsed);
	const idempotencyKey = stringOption(parsed.flags, "idempotency-key");
	if (!idempotencyKey) throw new MeshCliInputError("idempotency_key_required", "Cancel requires an idempotency key.");
	const reason = stringOption(parsed.flags, "reason");
	return Object.freeze({ requestId, taskId, idempotencyKey, ...(reason === undefined ? {} : { reason }) });
}

function artifactsRequest(parsed: ParsedArguments, requestId: string): MeshCliArtifactsRequest {
	return Object.freeze({ requestId, taskId: requiredTaskId(parsed), ...cursorOption(parsed.flags) });
}

function traceRequest(parsed: ParsedArguments, requestId: string): MeshCliTraceRequest {
	return Object.freeze({ requestId, taskId: requiredTaskId(parsed), ...cursorOption(parsed.flags) });
}

function optionalTaskId(parsed: ParsedArguments): string | undefined {
	if (parsed.positional.length > 1) throw new MeshCliInputError("unexpected_argument", "The command accepts at most one task identifier.");
	return consistentStringOption(parsed.flags, "task-id", parsed.positional[0]);
}

function requiredTaskId(parsed: ParsedArguments): string {
	const taskId = optionalTaskId(parsed);
	if (!taskId) throw new MeshCliInputError("task_id_required", "This command requires a task identifier.");
	return taskId;
}

function cursorOption(flags: ReadonlyMap<string, ParsedFlag>): Readonly<{ cursor?: string }> {
	const cursor = stringOption(flags, "cursor");
	return cursor === undefined ? {} : { cursor };
}

function jsonObjectOption(flags: ReadonlyMap<string, ParsedFlag>, name: string): MeshCliJsonObject | undefined {
	const raw = stringOption(flags, name);
	if (raw === undefined) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		const safe = toMeshCliJson(parsed);
		if (!isMeshCliJsonObject(safe)) throw new MeshCliInputError("invalid_json", "The JSON request must be an object.");
		return safe;
	} catch (error) {
		if (error instanceof MeshCliInputError) throw error;
		throw new MeshCliInputError("invalid_json", "The JSON request is invalid.");
	}
}

function consistentStringOption(
	flags: ReadonlyMap<string, ParsedFlag>,
	name: string,
	fallback: unknown,
): string | undefined {
	const direct = stringOption(flags, name);
	if (fallback !== undefined && typeof fallback !== "string") {
		throw new MeshCliInputError("invalid_option", "A command option must be a non-empty string.");
	}
	if (direct !== undefined && fallback !== undefined && direct !== fallback) {
		throw new MeshCliInputError("conflicting_option", "A command option was supplied with conflicting values.");
	}
	const value = direct ?? fallback;
	if (value === undefined) return undefined;
	if (value.length === 0) throw new MeshCliInputError("invalid_option", "A command option must be a non-empty string.");
	return value;
}

function stringOption(flags: ReadonlyMap<string, ParsedFlag>, name: string): string | undefined {
	const value = flags.get(name);
	if (value === undefined) return undefined;
	if (value === true || value.length === 0) throw new MeshCliInputError("missing_option_value", "A command option requires a value.");
	return value;
}

function positiveIntegerOption(flags: ReadonlyMap<string, ParsedFlag>, name: string): number | undefined {
	const value = stringOption(flags, name);
	if (value === undefined) return undefined;
	if (!/^\d+$/.test(value)) throw new MeshCliInputError("invalid_option", "A command option must be a positive integer.");
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 1) throw new MeshCliInputError("invalid_option", "A command option must be a positive integer.");
	return number;
}

function resultEnvelope(command: MeshCliCommand, requestId: string, result: MeshCliApiResult): MeshCliEnvelope {
	if (isUnavailableResult(result)) return unavailableEnvelope(command, requestId, result);
	return successEnvelope(command, requestId, 0, "result", toMeshCliJson(result));
}

async function* followEnvelopes(
	command: "follow",
	requestId: string,
	result: MeshCliFollowResult,
): AsyncGenerator<MeshCliEnvelope, void, void> {
	if (!isAsyncIterable(result)) {
		yield resultEnvelope(command, requestId, result);
		return;
	}
	let sequence = 0;
	for await (const event of result) {
		if (isUnavailableResult(event)) {
			yield unavailableEnvelope(command, requestId, event, sequence);
			return;
		}
		yield successEnvelope(command, requestId, sequence, "event", toMeshCliJson(event));
		sequence += 1;
	}
	yield successEnvelope(command, requestId, sequence, "complete", Object.freeze({ events: sequence }));
}

function isAsyncIterable(value: MeshCliFollowResult): value is AsyncIterable<MeshCliApiResult> {
	return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

function isUnavailableResult(value: unknown): value is MeshCliUnavailableResult {
	return (
		value !== null &&
		typeof value === "object" &&
		"status" in value &&
		((value as { readonly status?: unknown }).status === "unavailable" || (value as { readonly status?: unknown }).status === "unsupported")
	);
}

function unavailableEnvelope(
	command: MeshCliCommand,
	requestId: string,
	result: unknown = undefined,
	sequence = 0,
): MeshCliEnvelope {
	const unavailable = isUnavailableResult(result) ? result : undefined;
	return errorEnvelope(command, requestId, sequence, {
		code: unavailable?.code ?? "action_unavailable",
		message: redactMeshCliError(unavailable?.reason ?? "The requested mesh action is not available in this runtime."),
		retryable: unavailable?.retryable ?? false,
		unavailable: true,
	});
}

function successEnvelope(
	command: MeshCliEnvelopeCommand,
	requestId: string,
	sequence: number,
	type: "result" | "event" | "complete",
	data: MeshCliJson,
): MeshCliEnvelope {
	return Object.freeze({ schemaVersion: SCHEMA_VERSION, ok: true, command, requestId, sequence, type, data });
}

function errorEnvelope(command: MeshCliEnvelopeCommand, requestId: string, sequence: number, error: MeshCliError): MeshCliEnvelope {
	return Object.freeze({ schemaVersion: SCHEMA_VERSION, ok: false, command, requestId, sequence, type: "error", error: Object.freeze(error) });
}

function toCliError(error: unknown): MeshCliError {
	if (error instanceof MeshCliInputError) {
		return Object.freeze({ code: error.code, message: error.message, retryable: false });
	}
	if (error instanceof MeshCliApiError) {
		return Object.freeze({
			code: error.code,
			message: redactMeshCliError(error.message),
			retryable: error.options.retryable ?? false,
			...(error.options.unavailable === true ? { unavailable: true } : {}),
		});
	}
	return Object.freeze({ code: "mesh_api_failed", message: "The mesh service request failed.", retryable: true });
}

function requestIdFromRawArgs(argv: readonly string[]): string {
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--request-id") {
			const value = argv[index + 1];
			if (value && isSafeRequestId(value)) return value;
		}
		if (token?.startsWith("--request-id=")) {
			const value = token.slice("--request-id=".length);
			if (isSafeRequestId(value)) return value;
		}
	}
	return `mesh-cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isSafeRequestId(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value);
}

function helpData(): MeshCliJsonObject {
	return Object.freeze({
		commands: Object.freeze(["submit", "status", "follow", "cancel", "artifacts", "trace"]),
		format: "jsonl",
		usage: Object.freeze({
			artifacts: "ompk-mesh artifacts <task-id> [--cursor <cursor>]",
			cancel: "ompk-mesh cancel <task-id> --idempotency-key <key> [--reason <reason>]",
			follow: "ompk-mesh follow <task-id> [--cursor <cursor>] [--limit <count>]",
			status: "ompk-mesh status [task-id] [--cursor <cursor>]",
			submit: "ompk-mesh submit --request <json> --idempotency-key <key>",
			trace: "ompk-mesh trace <task-id> [--cursor <cursor>]",
		}),
	});
}
