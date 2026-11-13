import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { SessionDrawer } from "./components/sessions/SessionDrawer";
import { Banners } from "./components/shell/Banners";
import { Composer } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { HeaderBar } from "./components/shell/HeaderBar";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import { GuestClient } from "./lib/client";
import { connectionView, shouldResumeNow } from "./lib/connection-state";
import type { PreviewScenario } from "./lib/preview";
import { createPreviewClient, readPreviewScenario, readPreviewTheme } from "./lib/preview";
import {
	forgetLink,
	localRememberStore,
	publicConnectError,
	readRememberedLink,
	rememberLink,
} from "./lib/remember-link";
import { setThemePreference } from "./lib/theme";
import { useGuestSnapshot } from "./lib/use-guest";
import { useNow } from "./lib/use-now";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

const NAME_KEY = "omp.collab.name";

interface Creds {
	link: string;
	name: string;
}

type ConnectSource = "hash" | "saved" | "form";

function storedName(): string {
	try {
		return localStorage.getItem(NAME_KEY) ?? "guest";
	} catch {
		return "guest";
	}
}

/** Deep link = everything after the FIRST `#` (legacy links carry a second `#` inside the fragment). */
function hashLink(): string | null {
	const href = window.location.href;
	const i = href.indexOf("#");
	if (i < 0 || i + 1 >= href.length) return null;
	return href.slice(i + 1);
}

function desktopRail(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia("(min-width: 769px)").matches;
}

/** Pin the app to the visual viewport so the composer stays above the keyboard. */
function useViewportFit(): void {
	useEffect(() => {
		const root = document.documentElement;
		const viewport = window.visualViewport;
		const sync = (): void => {
			const next = window.visualViewport;
			if (!next) {
				root.style.setProperty("--viewport-height", "100dvh");
				root.style.setProperty("--vv-offset-top", "0px");
				root.style.removeProperty("--safe-bottom");
				return;
			}
			root.style.setProperty("--viewport-height", `${next.height}px`);
			root.style.setProperty("--vv-offset-top", `${next.offsetTop}px`);
			const keyboard = window.innerHeight - next.height - next.offsetTop;
			if (keyboard > 80) root.style.setProperty("--safe-bottom", "0px");
			else root.style.removeProperty("--safe-bottom");
			window.scrollTo(0, 0);
		};
		sync();
		viewport?.addEventListener("resize", sync);
		viewport?.addEventListener("scroll", sync);
		window.addEventListener("orientationchange", sync);
		return () => {
			viewport?.removeEventListener("resize", sync);
			viewport?.removeEventListener("scroll", sync);
			window.removeEventListener("orientationchange", sync);
		};
	}, []);
}

export function App(): ReactNode {
	useViewportFit();
	const preview = readPreviewScenario(window.location);
	if (preview) return <PreviewApp scenario={preview} />;
	return <LiveApp />;
}

export function PreviewApp({ scenario }: { scenario: PreviewScenario }): ReactNode {
	const theme = typeof window === "undefined" ? null : readPreviewTheme(window.location);
	useLayoutEffect(() => {
		if (theme) setThemePreference(theme);
	}, [theme]);
	const clientRef = useRef<GuestClient | null>(null);
	if (clientRef.current === null) clientRef.current = createPreviewClient(scenario);
	return (
		<Session
			client={clientRef.current}
			remembered={false}
			onLeave={() => {}}
			onRejoin={() => {}}
			onRemember={() => {}}
			onForget={() => {}}
		/>
	);
}

function LiveApp(): ReactNode {
	const [client, setClient] = useState<GuestClient | null>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	const [remembered, setRemembered] = useState(false);
	const [savedAvailable, setSavedAvailable] = useState(() => readRememberedLink(localRememberStore()) !== null);
	const credsRef = useRef<Creds | null>(null);

	const connect = useCallback((link: string, name: string, source: ConnectSource, remember = false): void => {
		const trimmed = link.trim();
		let next: GuestClient;
		try {
			next = new GuestClient(trimmed, name);
		} catch (err) {
			setConnectError(publicConnectError(err, trimmed));
			return;
		}
		next.connect();
		try {
			localStorage.setItem(NAME_KEY, name);
		} catch {
			// storage unavailable (private mode) — non-fatal
		}
		const store = localRememberStore();
		if (source === "form") {
			if (remember) {
				const ok = rememberLink(store, trimmed);
				setRemembered(ok);
				setSavedAvailable(ok);
			} else {
				forgetLink(store);
				setRemembered(false);
				setSavedAvailable(false);
			}
		} else {
			setRemembered(readRememberedLink(store) === trimmed);
		}
		credsRef.current = { link: trimmed, name };
		window.location.hash = trimmed;
		setConnectError(null);
		setClient(prev => {
			prev?.close();
			return next;
		});
	}, []);

	const leave = useCallback((): void => {
		setClient(prev => {
			prev?.close();
			return null;
		});
		setRemembered(false);
		setSavedAvailable(readRememberedLink(localRememberStore()) !== null);
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}, []);

	const rejoin = useCallback((): void => {
		const creds = credsRef.current;
		if (creds) connect(creds.link, creds.name, "hash");
	}, [connect]);

	const continueSaved = useCallback((): void => {
		const saved = readRememberedLink(localRememberStore());
		if (!saved) {
			setSavedAvailable(false);
			return;
		}
		connect(saved, storedName(), "saved");
	}, [connect]);

	const forgetSaved = useCallback((): void => {
		forgetLink(localRememberStore());
		setRemembered(false);
		setSavedAvailable(false);
		setConnectError(null);
	}, []);

	const rememberCurrent = useCallback((): void => {
		const link = credsRef.current?.link;
		if (!link) return;
		const ok = rememberLink(localRememberStore(), link);
		setRemembered(ok);
		if (ok) setSavedAvailable(true);
	}, []);

	useEffect(() => {
		if (!client) return;
		const onVisibility = (): void => {
			if (!shouldResumeNow("visibility", document.visibilityState)) return;
			client.resume();
		};
		const onOnline = (): void => {
			if (!shouldResumeNow("online", document.visibilityState)) return;
			client.resume();
		};
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("online", onOnline);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("online", onOnline);
		};
	}, [client]);

	// Deep link: a page load with a hash auto-connects. Otherwise a saved link does.
	useEffect(() => {
		const link = hashLink();
		if (link) {
			connect(link, storedName(), "hash");
			return;
		}
		const saved = readRememberedLink(localRememberStore());
		if (saved) connect(saved, storedName(), "saved");
	}, [connect]);

	useEffect(() => {
		if (!client) document.title = "oh-my-pk";
	}, [client]);

	if (!client) {
		return (
			<ConnectScreen
				defaultName={storedName()}
				error={connectError}
				savedAvailable={savedAvailable}
				onConnect={(link, name, remember) => connect(link, name, "form", remember)}
				onContinue={continueSaved}
				onForget={forgetSaved}
			/>
		);
	}
	return (
		<Session
			client={client}
			remembered={remembered}
			onLeave={leave}
			onRejoin={rejoin}
			onRemember={rememberCurrent}
			onForget={forgetSaved}
		/>
	);
}

interface SessionProps {
	client: GuestClient;
	remembered: boolean;
	onLeave(): void;
	onRejoin(): void;
	onRemember(): void;
	onForget(): void;
}

export function Session({ client, remembered, onLeave, onRejoin, onRemember, onForget }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const ticking = snap.hostAwayUntil !== null && snap.phase !== "ended" && snap.phase !== "reconnecting";
	const now = useNow(ticking);
	const view = connectionView({
		phase: snap.phase,
		endedReason: snap.endedReason,
		hostAwayUntil: snap.hostAwayUntil,
		now,
		readOnly: snap.readOnly,
	});
	const [railOpen, setRailOpen] = useState(desktopRail);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [sessionsOpen, setSessionsOpen] = useState(false);
	const autoOpenedRef = useRef(false);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
	);

	// Auto-open when a subagent first appears on desktop; mobile keeps the transcript visible.
	useEffect(() => {
		if (subCount > 0 && !autoOpenedRef.current && desktopRail()) {
			autoOpenedRef.current = true;
			setRailOpen(true);
		}
	}, [subCount]);

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · oh-my-pk`;
	}, [title]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;

	return (
		<div
			className="sh-app"
			data-sidebar={railOpen ? "open" : "closed"}
			data-connection={view.kind}
			data-readonly={snap.readOnly ? "true" : "false"}
		>
			{railOpen && (
				<>
					<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
					<aside className="sh-rail" aria-label="Session agents">
						<div className="sh-sidebar-brand">
							<span className="sh-lockup-mark" aria-hidden="true" />
							<span className="sh-sidebar-wordmark">oh-my-pk</span>
							<span className="sh-sidebar-phase">
								<span className={`sh-dot sh-dot-${view.kind}`} aria-hidden="true" />
								{view.label}
							</span>
						</div>
						<div className="sh-sidebar-section">
							<span>Session agents</span>
							{subCount > 0 && <span className="sh-sidebar-count">{subCount}</span>}
						</div>
						<AgentsPanel
							agents={snap.agents}
							progress={snap.progress}
							lifecycle={snap.lifecycle}
							selectedId={selectedId}
							onSelect={setSelectedId}
						/>
						<div className="sh-sidebar-foot">
							<span className="sh-sidebar-foot-dot" aria-hidden="true" />
							End-to-end encrypted
						</div>
					</aside>
				</>
			)}
			<div className="sh-workspace">
				<HeaderBar
					snapshot={snap}
					view={view}
					subCount={subCount}
					railOpen={railOpen}
					remembered={remembered}
					onToggleRail={() => setRailOpen(open => !open)}
					onOpenSessions={() => setSessionsOpen(true)}
					onLeave={onLeave}
					onRemember={onRemember}
					onForget={onForget}
				/>
				<main className="sh-main">
					{view.kind !== "ended" && view.kind !== "room-closed" && (
						<Banners view={view} endedReason={snap.endedReason} onRejoin={onRejoin} onNewLink={onLeave} />
					)}
					<section className="sh-content">
						<div className="sh-transcript">
							<Transcript
								entries={snap.entries}
								stream={snap.stream}
								streamDone={snap.streamDone}
								activeTools={snap.activeTools}
								working={snap.working}
								host={toolHost}
							/>
						</div>
					</section>
				</main>
				<Composer client={client} snapshot={snap} />
			</div>
			{(view.kind === "ended" || view.kind === "room-closed") && (
				<Banners view={view} endedReason={snap.endedReason} onRejoin={onRejoin} onNewLink={onLeave} />
			)}
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={() => setSelectedId(null)} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						client={client}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={() => setSelectedId(null)}
					/>
				</>
			)}
			{sessionsOpen && (
				<>
					<div className="ss-drawer-backdrop" onClick={() => setSessionsOpen(false)} />
					<SessionDrawer client={client} onClose={() => setSessionsOpen(false)} />
				</>
			)}
			<Toasts notices={snap.notices} />
		</div>
	);
}
