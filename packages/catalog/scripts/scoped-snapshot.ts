type Snapshot<T> = Record<string, Record<string, T>>;

/** Select generated rows without rewriting unrelated providers or models. */
export function selectGeneratedSnapshot<T>(
	previous: Snapshot<T>,
	generated: Snapshot<T>,
	providers: ReadonlySet<string>,
	models: ReadonlySet<string> = new Set(),
): Snapshot<T> {
	if (providers.size === 0) {
		if (models.size > 0) throw new Error("--models requires --providers");
		return generated;
	}
	const output = { ...previous };
	for (const provider of providers) {
		const entries = generated[provider];
		if (!entries) throw new Error(`No generated models for ${provider}`);
		if (models.size === 0) {
			output[provider] = entries;
			continue;
		}
		const selected = { ...previous[provider] };
		for (const id of models) {
			if (!Object.hasOwn(entries, id)) throw new Error(`No generated model for ${provider}/${id}`);
			selected[id] = entries[id];
		}
		output[provider] = selected;
	}
	return output;
}
