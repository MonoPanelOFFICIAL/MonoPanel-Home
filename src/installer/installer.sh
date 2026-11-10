#!/usr/bin/env bash
#==============================================================================
# MonoPanel installer bootstrap
# Downloads the prebuilt monopanel-installer binary for this machine from the
# rolling `latest-build` release and runs it. The binary is a self-contained
# OpenTUI installer built by CI with `bun build --compile` - no git, no bun,
# no node, no source checkout is needed. It installs everything the panel and
# daemon need (Node, PostgreSQL, tunnel client, services) by itself.
#
# Works as root, with sudo, or with NO root at all (everything then lives in
# ~/.monopanel and runs as your user). Works on VPSes without a public IPv4
# (the binary opens a Cloudflare tunnel there).
#
# Platforms: linux-x64 / linux-arm64 (glibc).
#
# Usage:
#   bash <(curl -fsSL <url>/installer.sh)                  # interactive menu
#   curl -fsSL <url>/installer.sh | bash                   # same, piped
#   curl -fsSL <url>/installer.sh | bash -s -- --install-both --yes
#                                     # scripted: plain logs, no TTY, exit code = result
#   ./installer.sh --help        # usage; no TTY, no root needed
#   ./installer.sh --demo        # UI preview; no system changes
#   ./installer.sh --rootless    # never use sudo, install into ~/.monopanel
#
# Env:
#   MONOPANEL_INSTALLER_DL   download base URL (default: the latest-build release)
#   MONOPANEL_ROOTLESS=1     same as --rootless
#   any other MONOPANEL_*    passed through to the installer (see --help)
#==============================================================================
set -euo pipefail

DOWNLOAD_BASE="${MONOPANEL_INSTALLER_DL:-https://github.com/TeamMonoPanel/MonoPanel-Installer/releases/download/latest-build}"
SELF_NAME="monopanel-installer"

say()  { printf '\033[1;36m::\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

plain=0 want_help=0 want_demo=0 want_action=0 rootless=0
[ "${MONOPANEL_ROOTLESS:-}" = "1" ] && rootless=1
for a in "$@"; do
    case "$a" in
        --no-color)                 plain=1 ;;
        --help|-h)                  want_help=1 ;;
        --demo)                     want_demo=1 ;;
        --rootless)                 rootless=1 ;;
        --install-*|--uninstall-*)  want_action=1 ;;
    esac
done

# --- 1. platform -> asset name ----------------------------------------------
detect_platform() {
    os="$(uname -s)"
    [ "$os" = "Linux" ] || die "unsupported OS: $os - MonoPanel installs on Linux (x64 / arm64)"
    if ldd --version 2>&1 | grep -qi musl; then
        die "musl systems (Alpine) are not supported by the prebuilt installer - use a glibc distro (Debian/Ubuntu, RHEL/Fedora, Arch, openSUSE)"
    fi
    case "$(uname -m)" in
        x86_64|amd64)  arch=x64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) die "unsupported architecture: $(uname -m) - supported: x86_64, aarch64" ;;
    esac
    ASSET="${SELF_NAME}-linux-${arch}"
}

# fetch <url> <dest> - silent, retries; rc != 0 when the asset is missing
fetch_url() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 --connect-timeout 10 -o "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" "$1"
    else
        die "curl or wget is required to download the installer"
    fi
}

# --- 2. TTY guard ------------------------------------------------------------
# The TUI needs a terminal; --help and plain logs never do, and must work in
# pipes and CI. When this script is read from stdin (curl | bash), fd0 stays on
# the pipe - the TUI gets /dev/tty instead. With no TTY anywhere the binary is
# still run: it falls back to plain logs itself.
tty_in=""
have_tty=0
if [ "$want_help" -eq 0 ] && [ "$plain" -eq 0 ]; then
    if [ -t 0 ] && [ -t 1 ]; then
        have_tty=1
    elif { : < /dev/tty; } 2>/dev/null && [ -t 1 ]; then
        tty_in="</dev/tty"
        have_tty=1
    else
        warn "no TTY - falling back to plain logs"
    fi
fi

# --- 3. root, sudo, or rootless ------------------------------------------------
# --help / --demo / plain-without-an-action never touch the system and run as
# the invoking user. Real actions prefer root (system services, /opt/monopanel);
# without root they fall back to a per-user install instead of failing.
need_system=1
if [ "$want_help" -eq 1 ] || [ "$want_demo" -eq 1 ]; then need_system=0; fi
if [ "$plain" -eq 1 ] && [ "$want_action" -eq 0 ]; then need_system=0; fi

SUDO=()
if [ "$need_system" -eq 1 ] && [ "$(id -u)" -ne 0 ]; then
    if [ "$rootless" -eq 1 ]; then
        say "rootless install requested - using ~/.monopanel"
    elif command -v sudo >/dev/null 2>&1; then
        if [ "$have_tty" -eq 1 ] && { : < /dev/tty; } 2>/dev/null; then
            say "sudo password needed once for a system install (Ctrl+C or empty password -> rootless install)"
            if sudo -v </dev/tty; then SUDO=(sudo); fi
        elif sudo -n true 2>/dev/null; then
            SUDO=(sudo)
        fi
        if [ "${#SUDO[@]}" -eq 0 ]; then
            warn "no usable sudo - continuing without root: everything goes to ~/.monopanel and runs as $(id -un)"
        fi
    else
        warn "not root and no sudo - continuing without root: everything goes to ~/.monopanel and runs as $(id -un)"
    fi
fi

# --- 4. a directory we may execute from --------------------------------------
# /tmp is often mounted noexec on hardened VPSes; probe before trusting it.
pick_workdir() {
    local base d
    for base in "${TMPDIR:-/tmp}" "${HOME:-/nonexistent}/.cache" "$PWD"; do
        [ -d "$base" ] || mkdir -p "$base" 2>/dev/null || continue
        d="$(mktemp -d "$base/monopanel-installer.XXXXXX" 2>/dev/null)" || continue
        printf '#!/bin/sh\nexit 0\n' > "$d/probe.sh"
        chmod +x "$d/probe.sh" 2>/dev/null || { rm -rf "$d"; continue; }
        if "$d/probe.sh" 2>/dev/null; then printf '%s' "$d"; return 0; fi
        rm -rf "$d"
    done
    return 1
}

# --- 5. download the binary for this platform --------------------------------
detect_platform
ASSET_URL="${DOWNLOAD_BASE}/${ASSET}"

WORKDIR="$(pick_workdir)" || die "no writable directory that allows running programs (tried /tmp, ~/.cache, the current directory)"
# the sudo'd binary must be able to read its own file
chmod 755 "$WORKDIR"
trap 'rm -rf "$WORKDIR"' EXIT
BIN="${WORKDIR}/${SELF_NAME}"

# the plain asset is the UPX-packed binary; `${ASSET}.gz` is CI's fallback for
# a target the packer refused (raw bytes). Verify whichever one we fetched.
say "fetching ${ASSET}"
FETCH_URL="$ASSET_URL"
FETCHED="$BIN"
if ! fetch_url "$ASSET_URL" "$BIN"; then
    FETCH_URL="${ASSET_URL}.gz"
    FETCHED="${BIN}.gz"
    say "no plain asset - trying ${ASSET}.gz"
    fetch_url "$FETCH_URL" "$FETCHED" || die "download failed: $ASSET_URL
(no binary for this platform, or the release is missing - check github.com/TeamMonoPanel/MonoPanel-Installer/actions)"
fi

# checksum when CI published one; absence of tool or sidecar is never fatal
if fetch_url "${FETCH_URL}.sha256" "${FETCHED}.sha256" 2>/dev/null \
        && command -v sha256sum >/dev/null 2>&1; then
    want="$(cut -d' ' -f1 "${FETCHED}.sha256")"
    have="$(sha256sum "$FETCHED" | cut -d' ' -f1)"
    [ "$want" = "$have" ] || die "checksum mismatch for ${ASSET} (corrupted download) - re-run this script"
    say "checksum ok"
fi

if [ "$FETCHED" != "$BIN" ]; then
    gzip -dc "$FETCHED" > "$BIN" || die "decompressing ${ASSET}.gz failed - gzip is required"
    rm -f "$FETCHED"
fi
chmod 755 "$BIN"

# --- 6. run it ---------------------------------------------------------------
# sudo drops the environment: carry the MONOPANEL_* overrides across explicitly
ENVARGS=()
if [ "${#SUDO[@]}" -gt 0 ]; then
    while IFS= read -r name; do
        ENVARGS+=("${name}=${!name}")
    done < <(compgen -e | grep '^MONOPANEL_' || true)
    CMD=(sudo env ${ENVARGS[@]+"${ENVARGS[@]}"} "$BIN")
else
    CMD=("$BIN")
fi

say "starting monopanel installer"
set +e
if [ -n "$tty_in" ]; then
    # stdin is still the pipe carrying this script; give the TUI the real
    # terminal instead so bash can finish reading the script.
    "${CMD[@]}" "$@" </dev/tty
else
    "${CMD[@]}" "$@"
fi
rc=$?
set -e
exit "$rc"
