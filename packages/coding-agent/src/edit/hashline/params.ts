/**
 * Arktype schema for the `edit` tool's hashline mode payload. The schema is
 * deliberately permissive (allows extra keys) so providers can attach extra
 * keys without rejection; only `input` is required. `_input` is accepted as a
 * provider-emitted alias for `input`.
 */
import { withArkWireSchema } from "@pk-nerdsaver-ai/pi-ai/utils/schema";
import { type } from "arktype";

const requiredInputSchema = type({
	input: type("string").describe("hashline patch text"),
});

// `null` is tolerated on the inbound alias envelope only so the pipe below can
// recover the payload from `_input` when a provider emits `input: null` beside
// `_input`. `withArkWireSchema` pins the model-facing wire schema to
// `requiredInputSchema` (`required: ["input"]`, no `_input`), matching the
// original `z.preprocess(..., z.object({ input: z.string() }))` contract.
const inputAliasSchema = type({ "input?": "string | null", "_input?": "string | null" });

export const hashlineEditParamsSchema = withArkWireSchema(
	inputAliasSchema
		.pipe(raw => {
			if (typeof raw.input === "string" && raw.input.length > 0) return raw;
			if (typeof raw._input !== "string") return raw;
			return { ...raw, input: raw._input };
		})
		.pipe(requiredInputSchema),
	requiredInputSchema,
);

export type HashlineParams = Parameters<typeof hashlineEditParamsSchema.assert>[0];
