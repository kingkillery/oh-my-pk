import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME } from "@pk-nerdsaver-ai/pi-utils";
import type { Args } from "../cli/args";
import type { Settings } from "../config/settings";
import { resolveToCwd } from "../tools/path-utils";
import type { ResolvedWorkspaceOptions, WorkspaceMode } from "./types";

export function defaultWorkspaceRoot(): string {
	return path.join(os.tmpdir(), APP_NAME, "workspaces");
}

export function resolveWorkspaceOptions(parsed: Args, settings: Settings, sourceCwd: string): ResolvedWorkspaceOptions {
	const rootSetting = parsed.workspaceRoot ?? settings.get("workspace.root");
	const preserve =
		parsed.cleanupWorkspace === true ? false : (parsed.preserveWorkspace ?? settings.get("workspace.preserve"));
	const enabled =
		parsed.ethereal === true || parsed.workspaceMode !== undefined || settings.get("workspace.enabled") === true;
	const mode: WorkspaceMode = parsed.workspaceMode ?? settings.get("workspace.mode");
	return {
		enabled,
		mode,
		root: rootSetting ? resolveToCwd(rootSetting, sourceCwd) : defaultWorkspaceRoot(),
		preserve,
		copyEnv: parsed.copyEnv ?? settings.get("workspace.copyEnv"),
		envFiles: parsed.envFiles ?? settings.get("workspace.envFiles"),
		secretFiles: parsed.secretFiles ?? settings.get("workspace.secretFiles"),
		secretAllowlist: parsed.secretAllowlist ?? settings.get("workspace.secretAllowlist"),
		exportPatch: parsed.exportPatch ?? settings.get("workspace.exportPatch"),
		name: parsed.workspaceName ?? settings.get("workspace.name"),
	};
}
