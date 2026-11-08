#!/bin/bash
# Remove everything install.sh added.
set -euo pipefail
cd "$(dirname "$0")"

UUID="apple-studio-brightness@marcvernet"
SUDO="${SUDO:-sudo}"

gnome-extensions disable "$UUID" 2>/dev/null || true
gnome-extensions uninstall "$UUID" 2>/dev/null || true
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"
rm -f "$HOME/.local/bin/studio-brightness" "$UUID".shell-extension.zip
rm -f "$HOME/.cache/dconf-shm-"* 2>/dev/null || true

if $SUDO test -f /etc/udev/rules.d/99-apple-studio-display.rules; then
    $SUDO rm -f /etc/udev/rules.d/99-apple-studio-display.rules
    $SUDO udevadm control --reload
fi

echo "Removed. Log out/in (or restart GNOME Shell) to fully drop the extension."
