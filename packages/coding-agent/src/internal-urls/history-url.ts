/**
 * Canonical `history://` URL for an agent id.
 *
 * `history://` accepts read selectors (`:raw`, `:N-M`, `:N`), and agent ids may
 * contain `:` (e.g. `background:<name>`). Percent-encoding `:` (and `%`) keeps a
 * selector-shaped tail such as `background:1` part of the id; `parse.ts`
 * decodes the host back to the real id.
 */
export function historyUrl(agentId: string): `history://${string}` {
	return `history://${agentId.replace(/[%:]/g, char => encodeURIComponent(char))}`;
}
