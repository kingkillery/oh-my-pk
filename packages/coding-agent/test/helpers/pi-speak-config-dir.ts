import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

export interface PiSpeakConfigDir {
	dir: TempDir;
	restore: () => void;
}

/**
 * Point the Pi Speak config dir (where `/collab` writes and `CollabHost.stop()` clears
 * `collab.json`) at a fresh temp dir, so tests never touch the checkout's `.pi-speak/`
 * or the developer's real `%LOCALAPPDATA%\pi-speak`. Call `restore()` after the last
 * host has stopped.
 */
export function isolatePiSpeakConfigDir(): PiSpeakConfigDir {
	const dir = TempDir.createSync("@pi-speak-config-");
	const previous = process.env.PI_SPEAK_CONFIG_DIR;
	process.env.PI_SPEAK_CONFIG_DIR = dir.path();
	return {
		dir,
		restore: () => {
			if (previous === undefined) delete process.env.PI_SPEAK_CONFIG_DIR;
			else process.env.PI_SPEAK_CONFIG_DIR = previous;
			dir.removeSync();
		},
	};
}
