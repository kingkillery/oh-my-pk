import type { SlashCommandRuntime } from "../types";
import { resolveComputeAccount } from "./colab-compute-identity";
import { ColabComputePolicy, type ComputeConfirmation } from "./colab-compute-policy";

const tasks = new WeakMap<object, { policy: ColabComputePolicy; taskId: string }>();
export function harnessComputePolicy(runtime: SlashCommandRuntime) {
	let task = tasks.get(runtime.session);
	if (!task) {
		task = { policy: new ColabComputePolicy(), taskId: crypto.randomUUID() };
		tasks.set(runtime.session, task);
	}
	const confirm: ComputeConfirmation = async (_request, summary) => {
		const runner = runtime.session.extensionRunner;
		if (!runner?.hasUI()) {
			await runtime.output(summary + " Approval UI unavailable; allocation refused.");
			return "deny";
		}
		const choice = await runner
			.getUIContext()
			.select(summary, ["Deny", "Approve once", "Preapprove this bounded experiment"]);
		return choice === "Approve once" ? "once" : choice === "Preapprove this bounded experiment" ? "window" : "deny";
	};
	return { ...task, confirm, account: resolveComputeAccount };
}
