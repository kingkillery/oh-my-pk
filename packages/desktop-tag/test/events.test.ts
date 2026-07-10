import { describe, expect, it } from "bun:test";

import { parseAgentEvent, serializeAgentEvent, TaskEventChannel } from "../src/events";
import type { AgentEvent } from "../src/types";

describe("TaskEventChannel", () => {
	it("replays events published before subscription in order", async () => {
		const channel = new TaskEventChannel();
		const events: AgentEvent[] = [
			{ type: "task.started", taskId: "t1" },
			{ type: "agent.message.delta", text: "hello" },
		];
		for (const event of events) channel.push(event);
		channel.close();

		const received = await Array.fromAsync(channel.subscribe());
		expect(received).toEqual(events);
	});

	it("multicasts the full ordered stream to simultaneous subscribers", async () => {
		const channel = new TaskEventChannel();
		const first = Array.fromAsync(channel.subscribe());
		const second = Array.fromAsync(channel.subscribe());
		const events: AgentEvent[] = [
			{ type: "task.started", taskId: "t1" },
			{ type: "agent.message.delta", text: "one" },
			{ type: "agent.message.delta", text: "two" },
		];

		for (const event of events) channel.push(event);
		channel.close();

		expect(await first).toEqual(events);
		expect(await second).toEqual(events);
	});

	it("closes a waiting iterator without fabricating an event", async () => {
		const channel = new TaskEventChannel();
		const iterator = channel.subscribe()[Symbol.asyncIterator]();
		const next = iterator.next();

		channel.close();

		expect(await next).toEqual({ done: true, value: undefined });
		expect(await iterator.next()).toEqual({ done: true, value: undefined });
	});

	it("aborts one subscriber without interfering with another", async () => {
		const channel = new TaskEventChannel();
		const controller = new AbortController();
		const aborted = channel.subscribe(controller.signal)[Symbol.asyncIterator]();
		const active = channel.subscribe()[Symbol.asyncIterator]();
		const abortedNext = aborted.next();
		const activeNext = active.next();

		controller.abort();
		channel.push({ type: "agent.message.delta", text: "still active" });

		expect(await abortedNext).toEqual({ done: true, value: undefined });
		expect(await activeNext).toEqual({
			done: false,
			value: { type: "agent.message.delta", text: "still active" },
		});

		channel.close();
		expect(await active.next()).toEqual({ done: true, value: undefined });
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
