import { describe, expect, it } from "bun:test";

import { AgentEventChannel, parseAgentEvent, serializeAgentEvent } from "../src/events";
import type { AgentEvent } from "../src/types";

describe("AgentEventChannel", () => {
	it("pushes events to an async iterator", async () => {
		const channel = new AgentEventChannel();
		const event: AgentEvent = { type: "task.started", taskId: "t1" };
		channel.push(event);

		const iterator = channel.subscribe()[Symbol.asyncIterator]();
		const next = await iterator.next();
		expect(next.value).toEqual(event);
	});

	it("waits for new events when the buffer is empty", async () => {
		const channel = new AgentEventChannel();
		const iterator = channel.subscribe()[Symbol.asyncIterator]();

		const nextPromise = iterator.next();
		channel.push({ type: "agent.message.delta", text: "hello" });

		const next = await nextPromise;
		expect(next.value).toEqual({ type: "agent.message.delta", text: "hello" });
	});

	it("ends iteration after close", async () => {
		const channel = new AgentEventChannel();
		const iterator = channel.subscribe()[Symbol.asyncIterator]();
		channel.close();

		const next = await iterator.next();
		expect(next.done).toBe(true);
	});
});

describe("serializeAgentEvent / parseAgentEvent", () => {
	it("round-trips events", () => {
		const event: AgentEvent = { type: "task.completed", taskId: "t1", summary: "done" };
		const serialized = serializeAgentEvent(event);
		const parsed = parseAgentEvent(serialized);

		expect(parsed).toEqual(event);
	});

	it("returns undefined for malformed JSON", () => {
		expect(parseAgentEvent("not json")).toBeUndefined();
	});

	it("returns undefined for objects without a type", () => {
		expect(parseAgentEvent(JSON.stringify({ foo: "bar" }))).toBeUndefined();
	});
});
