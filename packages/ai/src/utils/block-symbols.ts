/** Stores streamed tool-call argument JSON for live renderers and parser recovery. */
export const kStreamingPartialJson = Symbol("provider.block.partialJson");

/** Carries streamed tool-call argument JSON without exposing a string-keyed property. */
export type StreamingPartialJsonCarrier = object & { [kStreamingPartialJson]?: string };

/** Reads streamed tool-call argument JSON from a block or event snapshot. */
export function getStreamingPartialJson(block: StreamingPartialJsonCarrier | null | undefined): string | undefined {
	return block?.[kStreamingPartialJson];
}

/** Writes streamed tool-call argument JSON to a block or clears it with `undefined`. */
export function setStreamingPartialJson(block: StreamingPartialJsonCarrier, value: string | undefined): void {
	block[kStreamingPartialJson] = value;
}

/** Clears streamed tool-call argument JSON without deleting or changing object shape. */
export function clearStreamingPartialJson(block: StreamingPartialJsonCarrier): void {
	if (Object.hasOwn(block, kStreamingPartialJson)) block[kStreamingPartialJson] = undefined;
}

/** Stores a provider-local stream block index without exposing a string-keyed property. */
export const kStreamingBlockIndex = Symbol("provider.block.index");

/** Stores the last parsed argument prefix length for throttled streaming JSON parsing. */
export const kStreamingLastParseLen = Symbol("provider.block.lastParseLen");

/** Marks streamed tool-call arguments that already received an authoritative done payload. */
export const kStreamingArgumentsDone = Symbol("provider.block.argumentsDone");

/** Classifies Cursor's in-flight tool-call kind without leaking provider-private state. */
export const kStreamingBlockKind = Symbol("provider.block.kind");

/** All provider-local streaming bookkeeping symbols that must never survive into a
 *  finalized message — deep-equality (`getOwnPropertySymbols`) would otherwise see them. */
const STREAMING_ONLY_SYMBOLS: readonly symbol[] = [
	kStreamingPartialJson,
	kStreamingBlockIndex,
	kStreamingLastParseLen,
	kStreamingArgumentsDone,
	kStreamingBlockKind,
];

/**
 * Removes every provider-local streaming bookkeeping symbol from a finalized content
 * block so the returned message deep-equals a plain block. Safe to call after the block
 * is done streaming: these symbols are never read from the finalized message.
 */
export function stripStreamingSymbols(block: object): void {
	for (const symbol of STREAMING_ONLY_SYMBOLS) {
		if (Object.hasOwn(block, symbol)) {
			delete (block as Record<symbol, unknown>)[symbol];
		}
	}
}
