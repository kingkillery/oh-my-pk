#!/bin/sh
set -e

# oh-my-pk installer
# Usage: curl -fsSL https://oh-my-pk.pkking.computer/install.sh | sh
#
# Options:
#   --source       Install via bun (installs bun if needed)
#   --binary       Install prebuilt release binary (default)
#   --ref <ref>    Install specific tag/commit/branch
#   -r <ref>       Shorthand for --ref

REPO="kingkillery/oh-my-pk"
DIST_BASE="${OMP_DIST_BASE:-https://oh-my-pk.pkking.computer}"
PACKAGE="@pk-nerdsaver-ai/pi-coding-agent"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
MIN_BUN_VERSION="1.3.14"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# If a ref is provided, default to source install
if [ -n "$REF" ] && [ -z "$MODE" ]; then
    MODE="source"
fi
# Detect Google Colab environment
is_colab() {
    [ -d "/content" ] || [ -n "$COLAB_RELEASE_TAG" ] || [ -n "$COLAB_GPU" ]
}

# If in Google Colab, default to binary install (prebuilt standalone, avoids npm native gaps)
if is_colab && [ -z "$MODE" ] && [ -z "$REF" ]; then
    MODE="binary"
fi


# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Install bun
install_bun() {
    echo "Installing bun..."
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        echo "bash not found; attempting install with sh..."
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

# Install via bun
install_via_bun() {
    echo "Installing via bun..."
    if [ -n "$REF" ]; then
        if ! has_git; then
            echo "git is required for --ref when installing from source"
            exit 1
        fi

        TMP_DIR="$(mktemp -d)"
        trap 'rm -rf "$TMP_DIR"' EXIT

        if git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$TMP_DIR" >/dev/null 2>&1; then
            :
        else
            git clone "https://github.com/${REPO}.git" "$TMP_DIR"
            (cd "$TMP_DIR" && git checkout "$REF")
        fi

        # Pull LFS files
        if has_git_lfs; then
            (cd "$TMP_DIR" && git lfs pull)
        fi

        if [ ! -d "$TMP_DIR/packages/coding-agent" ]; then
            echo "Expected package at ${TMP_DIR}/packages/coding-agent"
            exit 1
        fi

        bun install -g "$TMP_DIR/packages/coding-agent" || {
            echo "Failed to install from source"
            exit 1
        }
    else
        bun install -g "$PACKAGE" || {
            echo "Failed to install $PACKAGE"
            exit 1
        }
    fi
    echo ""
    echo "✓ Installed oh-my-pk via bun"
    echo "Run 'oh-my-pk' (or 'ompk') to get started!"
}

# Preserve launchers before replacing them, including package-manager symlinks.
backup_launcher() {
    if [ -z "$BACKUP_DIR" ]; then
        backup_root="${XDG_STATE_HOME:-$HOME/.local/state}/oh-my-pk/command-backups"
        mkdir -p "$backup_root"
        BACKUP_DIR=$(mktemp -d "$backup_root/install.XXXXXX")
    fi
    BACKUP_INDEX=$((BACKUP_INDEX + 1))
    cp -pP "$1" "$BACKUP_DIR/$BACKUP_INDEX-${1##*/}"
    printf '%s\n' "$1" >> "$BACKUP_DIR/paths.txt"
}

link_launcher() {
    launcher="$1"
    if [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$INSTALL_DIR/oh-my-pk" ]; then
        return
    fi
    if [ -d "$launcher" ]; then
        echo "Cannot replace launcher directory: $launcher" >&2
        exit 1
    fi
    if [ "$LAUNCHER_CHECK_ONLY" = check ]; then
        return
    fi
    if [ -e "$launcher" ] || [ -L "$launcher" ]; then
        backup_launcher "$launcher"
    fi
    ln -s "$INSTALL_DIR/oh-my-pk" "$launcher.ompk-new.$$"
    mv -f "$launcher.ompk-new.$$" "$launcher"
}

align_launchers() {
    LAUNCHER_CHECK_ONLY=${1:-}
    link_launcher "$INSTALL_DIR/omp"
    link_launcher "$INSTALL_DIR/ompk"

    # Repair existing launchers without populating unrelated PATH directories.
    # Include Bun's bin even when it is not in this shell's PATH.
    remaining_paths="$PATH:${BUN_INSTALL:-$HOME/.bun}/bin"
    while [ -n "$remaining_paths" ]; do
        launcher_dir=${remaining_paths%%:*}
        case "$remaining_paths" in
            *:*) remaining_paths=${remaining_paths#*:} ;;
            *) remaining_paths="" ;;
        esac
        launcher_dir=${launcher_dir:-.}
        [ -d "$launcher_dir" ] || continue
        launcher_dir=$(cd "$launcher_dir" && pwd -P)
        [ "$launcher_dir" != "$INSTALL_DIR" ] || continue
        for name in oh-my-pk ompk omp; do
            candidate="$launcher_dir/$name"
            if [ -e "$candidate" ] || [ -L "$candidate" ]; then
                if [ ! -w "$launcher_dir" ]; then
                    echo "Cannot update $candidate: directory is not writable. Remove the stale launcher or rerun with a writable PATH." >&2
                    exit 1
                fi
                link_launcher "$candidate"
            fi
        done
    done
    if [ -n "$BACKUP_DIR" ]; then
        echo "Previous launchers backed up to $BACKUP_DIR (original paths in paths.txt)"
    fi
}

# Install the latest official release, retaining custom distribution support.
install_binary() {
    # Detect platform
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    BINARY="omp-${PLATFORM}-${ARCH}"
    # Explicit binary refs remain pinned. A custom distribution is authoritative;
    # otherwise resolve GitHub's latest release rather than npm's latest package.
    if [ -n "$REF" ]; then
        LATEST="$REF"
    else
        echo "Fetching latest release..."
        if [ -n "$OMP_DIST_BASE" ]; then
            LATEST=$(curl -fsSL "${DIST_BASE}/version" | tr -d '[:space:]')
        else
            RELEASE_URL=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")
            LATEST=${RELEASE_URL##*/}
            case "$LATEST" in
                v[0-9]*) ;;
                *) echo "Failed to resolve latest release: $RELEASE_URL" >&2; exit 1 ;;
            esac
        fi
    fi

    if [ -z "$LATEST" ]; then
        echo "Failed to resolve version"
        exit 1
    fi
    echo "Using version: $LATEST"

    mkdir -p "$INSTALL_DIR"
    INSTALL_DIR=$(cd "$INSTALL_DIR" && pwd -P)
    BACKUP_DIR=""
    BACKUP_INDEX=0
    if [ -d "$INSTALL_DIR/oh-my-pk" ]; then
        echo "Cannot replace launcher directory: $INSTALL_DIR/oh-my-pk" >&2
        exit 1
    fi
    # Fail before changing a working installation if a launcher cannot be repaired.
    align_launchers check
    BINARY_TMP=$(mktemp "$INSTALL_DIR/.oh-my-pk.XXXXXX")
    trap 'rm -f "$BINARY_TMP"' EXIT
    BINARY_URL="${DIST_BASE}/bin/${LATEST}/${BINARY}"
    GITHUB_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    FALLBACK_URL="$GITHUB_URL"
    if [ -z "$OMP_DIST_BASE" ]; then
        FALLBACK_URL="$BINARY_URL"
        BINARY_URL="$GITHUB_URL"
    fi
    echo "Downloading ${BINARY}..."
    if ! curl -fsSL "$BINARY_URL" -o "$BINARY_TMP"; then
        echo "Primary download unavailable; trying $FALLBACK_URL..."
        curl -fsSL "$FALLBACK_URL" -o "$BINARY_TMP" || {
            echo "Failed to download ${BINARY} from distribution endpoint and GitHub Releases."
            exit 1
        }
    fi
    chmod +x "$BINARY_TMP"
    # Validate before replacing a working installation or any launchers.
    "$BINARY_TMP" --version
    if [ -e "$INSTALL_DIR/oh-my-pk" ] || [ -L "$INSTALL_DIR/oh-my-pk" ]; then
        backup_launcher "$INSTALL_DIR/oh-my-pk"
    fi
    mv -f "$BINARY_TMP" "$INSTALL_DIR/oh-my-pk"
    align_launchers
    echo ""
    echo "✓ Installed oh-my-pk to ${INSTALL_DIR}/oh-my-pk (aliases: omp, ompk)"

    # Optional helper: the tool-issue collector (powers local collector mode).
    # Best-effort — older tags predate it, the collector is off by default, and
    # nothing here may fail the install. Downloads to a temp sibling and renames
    # only on success so a transient network failure or an older tag never
    # destroys an existing helper.
    COLLECTOR="ompk-collector-${PLATFORM}-${ARCH}"
    COLLECTOR_TMP="${INSTALL_DIR}/.ompk-collector.tmp.$$"
    COLLECTOR_DEST="${INSTALL_DIR}/ompk-collector"
    COLLECTOR_OK=false
    if curl -fsSL "${DIST_BASE}/bin/${LATEST}/${COLLECTOR}" -o "$COLLECTOR_TMP" 2>/dev/null \
        || curl -fsSL "https://github.com/${REPO}/releases/download/${LATEST}/${COLLECTOR}" -o "$COLLECTOR_TMP" 2>/dev/null; then
        if chmod +x "$COLLECTOR_TMP" 2>/dev/null && mv -f "$COLLECTOR_TMP" "$COLLECTOR_DEST" 2>/dev/null; then
            COLLECTOR_OK=true
        fi
    fi
    if [ "$COLLECTOR_OK" = true ]; then
        echo "✓ Installed the issue collector helper (${COLLECTOR_DEST})"
    else
        rm -f "$COLLECTOR_TMP" 2>/dev/null
        if [ -x "$COLLECTOR_DEST" ]; then
            echo "ℹ Issue collector helper download failed for ${LATEST}; keeping the existing ${COLLECTOR_DEST}."
        else
            echo "ℹ Issue collector helper not published for ${LATEST}; local collector mode stays unavailable."
        fi
    fi

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'oh-my-pk', 'ompk', or 'omp' to get started!" ;;
        *)
            if [ -f "$HOME/.bashrc" ] && ! grep -q "$INSTALL_DIR" "$HOME/.bashrc" 2>/dev/null; then
                echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$HOME/.bashrc"
            fi
            echo "Add ${INSTALL_DIR} to your PATH, then run 'oh-my-pk' or 'ompk'"
            ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        install_via_bun
        ;;
    binary)
        install_binary
        ;;
    *)
        # Release binaries are authoritative; source installs are opt-in.
        install_binary
        ;;
esac
