import { Radio, ShieldCheck, TerminalSquare } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { ThemeToggle } from "./ThemeToggle";

export interface ConnectScreenProps {
	defaultName: string;
	error: string | null;
	/** A link is already stored on this device. The value itself is not shown. */
	savedAvailable: boolean;
	onConnect(link: string, name: string, remember: boolean): void;
	onContinue(): void;
	onForget(): void;
}

export function ConnectScreen({
	defaultName,
	error,
	savedAvailable,
	onConnect,
	onContinue,
	onForget,
}: ConnectScreenProps): ReactNode {
	const [link, setLink] = useState("");
	const [name, setName] = useState(defaultName);
	const [remember, setRemember] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	const [replace, setReplace] = useState(false);

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const trimmed = link.trim();
		if (!trimmed) {
			setLocalError("Paste a join link");
			return;
		}
		setLocalError(null);
		onConnect(trimmed, name.trim() || "guest", remember);
	};

	const shown = localError ?? error;
	const continueSaved = savedAvailable && !replace;

	return (
		<div className="sh-connect">
			<section className="sh-connect-intro" aria-label="oh-my-pk">
				<div className="sh-connect-brand">
					<span className="sh-lockup-mark" aria-hidden="true" />
					<span>oh-my-pk</span>
				</div>
				<div className="sh-connect-copy">
					<span className="sh-connect-kicker">Live workspace</span>
					<h1>Stay with the work, wherever the agent runs.</h1>
					<p>
						Follow the transcript, inspect tool calls and guide the host session from a focused browser workspace.
					</p>
				</div>
				<div className="sh-connect-features">
					<span>
						<Radio size={15} /> Streaming transcript
					</span>
					<span>
						<TerminalSquare size={15} /> Tool and subagent detail
					</span>
					<span>
						<ShieldCheck size={15} /> End-to-end encrypted
					</span>
				</div>
			</section>
			{continueSaved ? (
				<div className="sh-connect-card">
					<div className="sh-connect-brand sh-connect-brand-card">
						<span className="sh-lockup-mark" aria-hidden="true" />
						<span>oh-my-pk</span>
					</div>
					<div className="sh-connect-head">
						<h2>Session</h2>
						<ThemeToggle />
					</div>
					{shown && (
						<div className="sh-connect-error" role="alert">
							{shown}
						</div>
					)}
					<button type="button" className="sh-btn sh-btn-primary sh-connect-submit" onClick={onContinue}>
						Continue
					</button>
					<button type="button" className="sh-btn sh-connect-submit" onClick={onForget}>
						Forget
					</button>
					<button type="button" className="sh-btn sh-textbtn" onClick={() => setReplace(true)}>
						Use a different link
					</button>
				</div>
			) : (
				<form className="sh-connect-card" onSubmit={submit}>
					<div className="sh-connect-brand sh-connect-brand-card">
						<span className="sh-lockup-mark" aria-hidden="true" />
						<span>oh-my-pk</span>
					</div>
					<div className="sh-connect-head">
						<div>
							<h2>Join a session</h2>
							<p className="sh-connect-help">
								Use the link printed by <code>/collab</code>.
							</p>
						</div>
						<ThemeToggle />
					</div>
					<label className="sh-field">
						<span className="sh-field-label">Join link</span>
						<input
							className="sh-input sh-input-mono"
							type="text"
							value={link}
							onChange={e => setLink(e.target.value)}
							spellCheck={false}
							autoComplete="off"
							autoCapitalize="off"
							autoCorrect="off"
							autoFocus
						/>
						<span className="sh-field-hint">The room key stays in your browser.</span>
					</label>
					<label className="sh-field">
						<span className="sh-field-label">Display name</span>
						<input
							className="sh-input"
							type="text"
							value={name}
							onChange={e => setName(e.target.value)}
							placeholder="guest"
							spellCheck={false}
							autoComplete="off"
							maxLength={32}
						/>
					</label>
					<label className="sh-check">
						<input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
						<span>Remember on this device</span>
					</label>
					{shown && (
						<div className="sh-connect-error" role="alert">
							{shown}
						</div>
					)}
					<button className="sh-btn sh-btn-primary sh-connect-submit" type="submit">
						Connect
					</button>
				</form>
			)}
		</div>
	);
}
