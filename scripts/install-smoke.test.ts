import { describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function toShellPath(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	if (process.platform !== "win32") return normalized;
	return normalized.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

const INSTALLER_PATH = toShellPath(join(import.meta.dir, "install.sh"));
const SHELL_EXECUTABLE = Bun.which("sh") ?? "sh";
const POWERSHELL_EXECUTABLE = Bun.which("pwsh") ?? Bun.which("powershell.exe");
const powershellTest = POWERSHELL_EXECUTABLE ? test : test.skip;
const DIST_BASE = "https://dist.example.test";
const INSTALLER_HARNESS = `
uname() {
    case "$1" in
        -s) printf '%s\\n' "$MOCK_UNAME_OS" ;;
        -m) printf '%s\\n' "$MOCK_UNAME_ARCH" ;;
        *) return 2 ;;
    esac
}
curl() {
    printf '%s\\n' "$*" >> "$MOCK_CURL_LOG"
    request="$*"
    case "$*" in
        *"/version"*) printf '%s\\n' "$MOCK_VERSION"; return ;;
        *"/releases/latest"*) printf 'https://github.com/kingkillery/oh-my-pk/releases/tag/%s' "$MOCK_VERSION"; return ;;
    esac
    output=""
    while [ "$#" -gt 0 ]; do
        if [ "$1" = "-o" ]; then shift; output="$1"; fi
        shift
    done
    [ -n "$output" ] || return 2
    if [ "$MOCK_DOWNLOAD_FAILURE" = 1 ]; then
        printf 'partial download' > "$output"
        return 22
    fi
    if [ "$MOCK_DIST_FAILURE" = 1 ]; then
        case "$request" in *dist.example.test/bin/*) return 22 ;; esac
    fi
    if [ "$MOCK_BAD_BINARY" = 1 ]; then
        printf '#!/bin/sh\\nexit 1\\n' > "$output"
    else
        printf '#!/bin/sh\\nprintf "oh-my-pk/%%s\\\\n" "$MOCK_VERSION"\\n' > "$output"
    fi
}
bun() {
    printf '%s\\n' "$*" >> "$MOCK_BUN_LOG"
    if [ "$1" = "--version" ]; then
        printf '%s\\n' "1.3.14"
    fi
}
# All external filesystem commands operate only on the fixture's HOME and PATH.
installer_path="$1"
shift
. "$installer_path"
`;

interface InstallerFixture {
	os: string;
	arch: string;
	args?: string[];
	version?: string;
	env?: Record<string, string>;
	setup?: (fixtureDir: string) => void;
	inspect?: (fixtureDir: string) => void;
	runs?: number;
}

interface InstallerResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	curlCalls: string;
	bunCalls: string;
}

function runInstaller({
	os,
	arch,
	args = ["--binary", "--ref", "fixture-ref"],
	version = "v16.4.6",
	env = {},
	setup,
	inspect,
	runs = 1,
}: InstallerFixture): InstallerResult {
	const fixtureDir = mkdtempSync(join(tmpdir(), "ompk-install-smoke-"));
	const curlLog = join(fixtureDir, "curl.log");
	const bunLog = join(fixtureDir, "bun.log");
	const home = join(fixtureDir, "home with spaces");
	const shadowBin = join(home, ".bun", "bin");
	const tools = join(fixtureDir, "tools");
	const install = join(fixtureDir, "install");
	for (const dir of [home, shadowBin, tools, install]) mkdirSync(dir, { recursive: true });
	for (const command of ["mkdir", "chmod", "cp", "tr", "mktemp", "rm", "mv", "ln", "readlink"]) {
		const executable = Bun.which(command);
		if (!executable) throw new Error(`Missing test dependency: ${command}`);
		symlinkSync(executable, join(tools, command));
	}
	setup?.(fixtureDir);

	try {
		let result!: ReturnType<typeof Bun.spawnSync>;
		for (let run = 0; run < runs; run++) {
			result = Bun.spawnSync(
				[SHELL_EXECUTABLE, "-c", INSTALLER_HARNESS, "installer-smoke", INSTALLER_PATH, ...args],
				{
					cwd: import.meta.dir,
					env: {
						...process.env,
						MOCK_UNAME_OS: os,
						MOCK_UNAME_ARCH: arch,
						MOCK_VERSION: version,
						MOCK_CURL_LOG: toShellPath(curlLog),
						MOCK_BUN_LOG: toShellPath(bunLog),
						OMP_DIST_BASE: DIST_BASE,
						HOME: toShellPath(home),
						XDG_STATE_HOME: toShellPath(join(home, ".local", "state")),
						BUN_INSTALL: toShellPath(join(home, ".bun")),
						PATH: [shadowBin, tools].map(toShellPath).join(":"),
						PI_INSTALL_DIR: toShellPath(install),
						...env,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
		}
		inspect?.(fixtureDir);

		return {
			exitCode: result.exitCode,
			stdout: new TextDecoder().decode(result.stdout),
			stderr: new TextDecoder().decode(result.stderr),
			curlCalls: existsSync(curlLog) ? readFileSync(curlLog, "utf8") : "",
			bunCalls: existsSync(bunLog) ? readFileSync(bunLog, "utf8") : "",
		};
	} finally {
		rmSync(fixtureDir, { recursive: true, force: true });
	}
}
const POWERSHELL_HARNESS = `
$ErrorActionPreference = "Stop"
$installerPath = $env:MOCK_INSTALLER_PATH
$script:HarnessArchitecture = $env:MOCK_WINDOWS_ARCH
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $installerPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw "Installer parse failed: $($parseErrors[0].Message)"
}
$functionDefinitions = $ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $true)
foreach ($definition in $functionDefinitions) {
    Invoke-Expression $definition.Extent.Text
}

function Get-WindowsOsArchitecture {
    return $script:HarnessArchitecture
}

$script:NetworkCalls = 0
$script:DownloadUrl = ""
$Ref = "v16.4.6"
$DistBase = "https://dist.example.test"
$BinaryName = "omp-windows-x64.exe"
# Use a host-local temp path so Linux pwsh (CI) does not attempt to create
# a Windows drive path before the download mock can capture the request.
$InstallDir = Join-Path ([System.IO.Path]::GetTempPath()) "ompk-installer-smoke"

# Install-Binary creates the install directory before downloading. Stub the
# filesystem side effects so architecture/network assertions stay hermetic.
function New-Item {
    param($ItemType, $Path)
    return [pscustomobject]@{ FullName = $Path }
}

function Invoke-RestMethod {
    $script:NetworkCalls += 1
    return "v16.4.6"
}

function Invoke-WebRequest {
    param($Uri, $OutFile)
    $script:NetworkCalls += 1
    $script:DownloadUrl = $Uri
    throw "__download_captured__"
}

if ($script:HarnessArchitecture -eq "X64") {
    try {
        Install-Binary
        throw "__download_not_attempted__"
    } catch {
        if ($_.Exception.Message -ne "__download_captured__") {
            throw
        }
    }
    if ($script:NetworkCalls -ne 1) {
        throw "Expected one download, got $script:NetworkCalls network calls"
    }
    if ($script:DownloadUrl -ne "https://dist.example.test/bin/v16.4.6/omp-windows-x64.exe") {
        throw "Unexpected download URL: $script:DownloadUrl"
    }
    Write-Output "download=$script:DownloadUrl"
    exit 0
}

try {
    Install-Binary
    throw "__unsupported_architecture_accepted__"
} catch {
    if ($_.Exception.Message -notlike "*Unsupported architecture: ARM64*") {
        throw
    }
}
if ($script:NetworkCalls -ne 0) {
    throw "Unsupported architecture made $script:NetworkCalls network calls"
}
Write-Output "rejected=ARM64 network=0"
`;

function runPowerShellInstallerHarness(architecture: "X64" | "ARM64"): InstallerResult {
	if (!POWERSHELL_EXECUTABLE) {
		throw new Error("PowerShell is required for the Windows installer smoke tests");
	}
	const result = Bun.spawnSync(
		[POWERSHELL_EXECUTABLE, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_HARNESS],
		{
			cwd: import.meta.dir,
			env: {
				...process.env,
				MOCK_INSTALLER_PATH: join(import.meta.dir, "install.ps1"),
				MOCK_WINDOWS_ARCH: architecture,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		exitCode: result.exitCode,
		stdout: new TextDecoder().decode(result.stdout),
		stderr: new TextDecoder().decode(result.stderr),
		curlCalls: "",
		bunCalls: "",
	};
}

powershellTest(
	"install.ps1 downloads the Windows x64 binary for an x64 OS",
	() => {
		const result = runPowerShellInstallerHarness("X64");

		if (result.exitCode !== 0) {
			throw new Error(
				[
					`PowerShell x64 installer smoke failed with exit ${result.exitCode}`,
					`stdout:\n${result.stdout || "<empty>"}`,
					`stderr:\n${result.stderr || "<empty>"}`,
				].join("\n"),
			);
		}
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("download=https://dist.example.test/bin/v16.4.6/omp-windows-x64.exe");
	},
	30_000,
);

powershellTest(
	"install.ps1 rejects Windows ARM64 before any network call",
	() => {
		const result = runPowerShellInstallerHarness("ARM64");

		if (result.exitCode !== 0) {
			throw new Error(
				[
					`PowerShell ARM64 installer smoke failed with exit ${result.exitCode}`,
					`stdout:\n${result.stdout || "<empty>"}`,
					`stderr:\n${result.stderr || "<empty>"}`,
				].join("\n"),
			);
		}
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("rejected=ARM64 network=0");
	},
	30_000,
);

describe("install.sh", () => {
	test("defaults to the latest release binary instead of npm", () => {
		const result = runInstaller({ os: "Darwin", arch: "arm64", args: [], env: { OMP_DIST_BASE: "" } });

		expect(result.exitCode).toBe(0);
		expect(result.bunCalls).toBe("");
		expect(result.curlCalls).toContain("https://github.com/kingkillery/oh-my-pk/releases/latest");
		expect(result.curlCalls).toContain("/releases/download/v16.4.6/omp-darwin-arm64");
	});

	test("preserves explicit source installation", () => {
		const result = runInstaller({ os: "Linux", arch: "x86_64", args: ["--source"] });
		expect(result.exitCode).toBe(0);
		expect(result.bunCalls).toContain("install -g @pk-nerdsaver-ai/pi-coding-agent");
		expect(result.curlCalls).toBe("");
	});

	test("falls back to the matching GitHub release when distribution download fails", () => {
		const result = runInstaller({ os: "Darwin", arch: "arm64", env: { MOCK_DIST_FAILURE: "1" } });
		expect(result.exitCode).toBe(0);
		expect(result.curlCalls).toContain(
			"https://github.com/kingkillery/oh-my-pk/releases/download/fixture-ref/omp-darwin-arm64",
		);
	});

	test("links all commands to one binary, backing up stale PATH launchers", () => {
		const result = runInstaller({
			os: "Darwin",
			arch: "arm64",
			args: [],
			runs: 2,
			setup: fixture => {
				const bun = join(fixture, "home with spaces", ".bun", "bin");
				writeFileSync(join(bun, "omp"), "old npm wrapper");
				symlinkSync("missing-package", join(bun, "ompk"));
				writeFileSync(join(bun, "oh-my-pk"), "old binary");
				writeFileSync(join(fixture, "tools", "omp"), "old PATH binary");
			},
			inspect: fixture => {
				const binary = realpathSync(join(fixture, "install", "oh-my-pk"));
				const bun = join(fixture, "home with spaces", ".bun", "bin");
				for (const name of ["oh-my-pk", "ompk", "omp"]) {
					expect(realpathSync(join(fixture, "install", name))).toBe(binary);
					expect(realpathSync(join(bun, name))).toBe(binary);
				}
				expect(realpathSync(join(fixture, "tools", "omp"))).toBe(binary);
				expect(existsSync(join(fixture, "tools", "ompk"))).toBe(false);
				const backups = join(fixture, "home with spaces", ".local", "state", "oh-my-pk", "command-backups");
				const first = join(backups, readdirSync(backups).sort()[0]);
				const directories = readdirSync(backups).map(dir => join(backups, dir));
				const saved = directories.flatMap(dir => readdirSync(dir).map(file => join(dir, file)));
				expect(saved.some(file => file.endsWith("-omp") && readFileSync(file, "utf8") === "old npm wrapper")).toBe(
					true,
				);
				expect(
					saved.some(
						file =>
							file.endsWith("-ompk") &&
							lstatSync(file).isSymbolicLink() &&
							readlinkSync(file) === "missing-package",
					),
				).toBe(true);
				expect(existsSync(join(first, "paths.txt"))).toBe(true);
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
	});

	test("refuses launcher directories before replacing an existing binary", () => {
		const result = runInstaller({
			os: "Darwin",
			arch: "arm64",
			args: [],
			setup: fixture => {
				writeFileSync(join(fixture, "install", "oh-my-pk"), "working binary");
				mkdirSync(join(fixture, "home with spaces", ".bun", "bin", "omp"));
			},
			inspect: fixture => {
				expect(readFileSync(join(fixture, "install", "oh-my-pk"), "utf8")).toBe("working binary");
			},
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Cannot replace launcher directory");
	});

	for (const failure of ["MOCK_DOWNLOAD_FAILURE", "MOCK_BAD_BINARY"]) {
		test(`${failure} preserves the existing installation`, () => {
			const result = runInstaller({
				os: "Darwin",
				arch: "arm64",
				args: [],
				env: { [failure]: "1" },
				setup: fixture => {
					writeFileSync(join(fixture, "install", "oh-my-pk"), "working binary");
					writeFileSync(join(fixture, "home with spaces", ".bun", "bin", "omp"), "working wrapper");
				},
				inspect: fixture => {
					expect(readFileSync(join(fixture, "install", "oh-my-pk"), "utf8")).toBe("working binary");
					expect(readFileSync(join(fixture, "home with spaces", ".bun", "bin", "omp"), "utf8")).toBe(
						"working wrapper",
					);
					expect(readdirSync(join(fixture, "install"))).toEqual(["oh-my-pk"]);
				},
			});
			expect(result.exitCode).not.toBe(0);
		});
	}

	const supportedTargets = [
		["Darwin", "arm64", "omp-darwin-arm64"],
		["Darwin", "x86_64", "omp-darwin-x64"],
		["Linux", "aarch64", "omp-linux-arm64"],
		["Linux", "x86_64", "omp-linux-x64"],
	] as const;

	test("defaults to standalone binary on Google Colab", () => {
		const result = runInstaller({
			os: "Linux",
			arch: "x86_64",
			args: [],
			env: { COLAB_RELEASE_TAG: "colab-runtime" },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Downloading omp-linux-x64...");
		expect(result.curlCalls).toContain(`${DIST_BASE}/bin/v16.4.6/omp-linux-x64`);
		expect(result.bunCalls).toBe("");
	});

	for (const [os, arch, filename] of supportedTargets) {
		test(`downloads ${filename} for ${os} ${arch}`, () => {
			const result = runInstaller({ os, arch });

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain(`Downloading ${filename}...`);
			expect(result.curlCalls).toContain(`${DIST_BASE}/bin/fixture-ref/${filename}`);
		});
	}

	test("preserves a v-prefixed version in the download URL", () => {
		const result = runInstaller({ os: "Darwin", arch: "arm64", args: ["--binary"], version: "v16.4.6" });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Using version: v16.4.6");
		expect(result.curlCalls).toContain(`${DIST_BASE}/bin/v16.4.6/omp-darwin-arm64`);
	});

	test("rejects an unsupported OS before downloading", () => {
		const result = runInstaller({ os: "FreeBSD", arch: "x86_64" });

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("Unsupported OS: FreeBSD");
		expect(result.curlCalls).toBe("");
	});

	test("rejects an unsupported architecture before downloading", () => {
		const result = runInstaller({ os: "Linux", arch: "riscv64" });

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("Unsupported architecture: riscv64");
		expect(result.curlCalls).toBe("");
	});
});
