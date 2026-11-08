#!/bin/bash
# Install the Apple Studio Display brightness stack.
# Set SUDO=pkexec for non-interactive/polkit environments.
set -euo pipefail
cd "$(dirname "$0")"

UUID="apple-studio-brightness@marcvernet"
SUDO="${SUDO:-sudo}"

echo "==> Installing udev rule for the Studio Display USB HID interface"
RULE_TMP="$(mktemp)"
cat >"$RULE_TMP" <<'RULES'
# Apple Studio Display backlight control (usb hid feature reports)
SUBSYSTEM=="hidraw", KERNEL=="hidraw*", ATTRS{idVendor}=="05ac", ATTRS{idProduct}=="1114", MODE="0660", GROUP="wheel", TAG+="uaccess"
SUBSYSTEM=="hidraw", KERNEL=="hidraw*", ATTRS{idVendor}=="05ac", ATTRS{idProduct}=="1116", MODE="0660", GROUP="wheel", TAG+="uaccess"
SUBSYSTEM=="hidraw", KERNEL=="hidraw*", ATTRS{idVendor}=="05ac", ATTRS{idProduct}=="1118", MODE="0660", GROUP="wheel", TAG+="uaccess"
RULES
if ! cmp -s "$RULE_TMP" /etc/udev/rules.d/99-apple-studio-display.rules 2>/dev/null \
   && ! $SUDO cmp -s "$RULE_TMP" /etc/udev/rules.d/99-apple-studio-display.rules 2>/dev/null; then
    cat "$RULE_TMP" | $SUDO tee /etc/udev/rules.d/99-apple-studio-display.rules >/dev/null
    $SUDO udevadm control --reload
    $SUDO udevadm trigger --subsystem-match=hidraw
fi
rm -f "$RULE_TMP"

echo "==> Installing GNOME shell extension"
rm -f "$UUID".shell-extension.zip
# cli/ and impl.js must be listed explicitly or gnome-extensions pack
# silently drops them (impl.js is the hot-reloadable implementation; see
# extension.js for why that matters)
gnome-extensions pack extension --extra-source=cli --extra-source=impl.js \
    --force >/dev/null
EXTDIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
# The CLI's extraction helper fails on some setups; the very same code run
# through gjs, or a plain unzip, are reliable fallbacks.
extract_ext() {
    rm -rf "$EXTDIR"
    gnome-extensions install "$UUID".shell-extension.zip --force 2>/dev/null && return 0
    gjs -m /usr/share/gnome-shell/org.gnome.Shell.Extensions install \
        "$UUID".shell-extension.zip --force 2>/dev/null && return 0
    mkdir -p "$EXTDIR"
    unzip -q -o "$UUID".shell-extension.zip -d "$EXTDIR"
}
extract_ext
[ -f "$EXTDIR/extension.js" ] || { echo "extension extraction failed" >&2; exit 1; }
rm -f "$UUID".shell-extension.zip

# Make sure the per-extension gschemas are compiled (normally done by install).
chmod 0755 "$EXTDIR/cli/studio-brightness"
glib-compile-schemas --strict "$EXTDIR/schemas"

echo "==> Installing studio-brightness CLI"
mkdir -p "$HOME/.local/bin"
install -m 0755 extension/cli/studio-brightness "$HOME/.local/bin/studio-brightness"

echo "==> Enabling extension"
# The running shell only scans the extension directory at startup, so
# gnome-extensions enable fails until the next login; pre-setting the
# gsettings key makes it come up enabled after log out/in either way.
gnome-extensions enable "$UUID" 2>/dev/null || \
    gsettings set org.gnome.shell enabled-extensions \
        "$(python3 -c "
import ast, json, subprocess
cur = ast.literal_eval(subprocess.check_output(
    ['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True))
if '$UUID' not in cur:
    cur.append('$UUID')
print(json.dumps(cur))
")"

cat <<'EOF'

Done.

*** GNOME only loads new extensions at session start: LOG OUT AND BACK IN
    (or reboot) before the slider and brightness keys show up. ***

    After this first load, the extension hot-reloads: edit extension/impl.js,
    re-run install.sh, then
        gnome-extensions disable <uuid> && gnome-extensions enable <uuid>
    to run the new code without logging out.

Quick checks afterwards:
  gnome-extensions info apple-studio-brightness@marcvernet   # state: ACTIVE
  studio-brightness get
  journalctl --user -b -g studio-brightness | tail

The brightness menu (control centre -> brightness row -> arrow) should now
list the Studio Display, and the keyboard brightness keys should affect it.
EOF
