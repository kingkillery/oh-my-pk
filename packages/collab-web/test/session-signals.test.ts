import { describe, expect, it } from "bun:test";
import { sessionSignals } from "../src/lib/session-signals";

describe("session signals", () => {
	it("treats a running or streaming agent as working", () => {
		expect(sessionSignals({ working: true, streaming: false, activeToolNames: [] })).toEqual({
			working: true,
			needsInput: false,
		});
		expect(sessionSignals({ working: false, streaming: true, activeToolNames: ["bash"] })).toEqual({
			working: true,
			needsInput: false,
		});
	});

	it("treats an open ask or resolve tool as needing input", () => {
		expect(sessionSignals({ working: true, streaming: true, activeToolNames: ["ask"] })).toEqual({
			working: false,
			needsInput: true,
		});
		expect(sessionSignals({ working: false, streaming: false, activeToolNames: ["resolve"] })).toEqual({
			working: false,
			needsInput: true,
		});
	});

	it("stays idle when nothing is running", () => {
		expect(sessionSignals({ working: false, streaming: false, activeToolNames: [] })).toEqual({
			working: false,
			needsInput: false,
		});
	});
});
