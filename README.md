# Apple Studio Display brightness for GNOME

Native-feeling brightness control for an **Apple Studio Display** connected to a
Linux laptop (tested on Fedora 45 / GNOME 51, Wayland, Intel Iris Xe).

The Studio Display exposes **no DDC/CI slave** (the I2C address simply does not
answer) — macOS drives its backlight through a **USB HID feature report** on
the display's vendor interface instead. This project does the same:

```
report id 0x01 + u32-le brightness (nits, 400..60000) + u16-le unknown  (7 bytes)
```

sent with `HIDIOCSFEATURE` to the display's `/dev/hidrawN` node.

GNOME 51's `BrightnessManager` already powers the control-centre brightness
slider, the per-monitor brightness menu, the OSD and the `XF86MonBrightnessUp/Down`
keys — but it only creates brightness controls for monitors exposing a kernel
backlight. The extension injects an extra `BrightnessScale` for the Studio
Display into the manager, so everything (slider, OSD, keys, per-monitor
persistence) behaves exactly like a native panel.

## What you get

- A **Studio Display slider** inside the control centre's Brightness menu
  (click the little arrow / long-press the slider), next to the built-in
  laptop-panel slider.
- The **brightness keys** (`XF86MonBrightnessUp/Down`) drive the whole setup
  like native GNOME brightness; `Shift+Up/Down` targets only the monitor the
  pointer is on. OSD included.
- Brightness is **remembered per display** across replug/reconnect (reuses
  GNOME's persistent state).
- The slider follows a **perceived-brightness (gamma) curve like macOS**, so
  the bottom of the slider actually reaches the panel's dimmest levels
  (its firmware floor is raw 400 ≈ 4 nits; a linear slider would feel far too
  bright near the bottom). Tune with the `brightness-curve` setting.
- A `studio-brightness` CLI for terminal control:

  ```sh
  studio-brightness probe          # list hidraw nodes and which one answers
  studio-brightness get            # hidraw=/dev/hidraw8 raw=18280 percent=30 ...
  studio-brightness set 27000      # raw nits
  studio-brightness set-percent 60 # percentage
  ```

## Install

```sh
./install.sh          # uses sudo; set SUDO=pkexec to use polkit instead
```

which:
1. installs a udev rule giving your session (wheel) rw access to the Studio
   Display's `/dev/hidraw*` nodes,
2. packs and installs the GNOME extension (`gnome-extensions install`),
3. installs the `studio-brightness` CLI to `~/.local/bin`,
4. enables the extension.

**GNOME only scans for new extensions at session start — log out and back in
after installing.** (Same for removing it.)

## Requirements

- GNOME Shell 51 (the extension subclasses private `BrightnessManager`
  internals; other shell versions need re-verification).
- The display must be connected such that its USB interface enumerates
  (USB-C/Thunderbolt cable to the Mac-facing upstream port).
- `python3` (stdlib only) — the CLI uses `fcntl.ioctl`, no extra packages.
- No ddcutil: DDC/CI is unresponsive on this panel and unused here.

## How it works

`extension/extension.js` is a thin stable wrapper; the real code lives in
`extension/impl.js`, which the wrapper imports with a unique query string
each time so **code updates apply on disable/enable without logging out**
(GNOME otherwise caches the extension module for the whole session).
`extension/impl.js`:

1. Finds the Studio Display among mutter's logical monitors by EDID
   vendor (`APP`) and product (`StudioDisplay`) — configurable.
2. Probes the display's `/dev/hidraw*` nodes (USB products `05ac:1114`,
   `05ac:1116`, `05ac:1118`) for the one whose HID feature report 1 answers,
   via the bundled `extension/cli/studio-brightness` helper
   (`HIDIOCGFEATURE` read).
3. Subclasses the shell's `BrightnessScale` and registers it in
   `Main.brightnessManager._monitorScales`, replicating the manager's own
   wiring (`_scaleChanged`, `_sync`, `user-update`, global scale creation),
   and re-injects after every `monitors-changed`.
4. Slider/key changes flow through the manager to `setBacklight()`, which
   maps position → raw through the gamma curve, then debounces
   (`debounce-ms`) into a single coalesced `HIDIOCSFEATURE` write via the
   CLI. A poll (`poll-interval-secs`) picks up changes made outside GNOME.

## Settings

```sh
gsettings list-recursively org.gnome.shell.extensions.apple-studio-brightness
```

| key | default | meaning |
|-----|---------|---------|
| `match-vendor` | `APP` | EDID vendor to control |
| `match-product` | `StudioDisplay` | mutter product string (empty = any) |
| `hidraw-device` | `` (auto) | pin a specific `/dev/hidrawN` node |
| `poll-interval-secs` | `30` | detect external brightness changes (0=off) |
| `debounce-ms` | `100` | coalesce slider drags into one USB write |
| `min-brightness` / `max-brightness` | `0` / `1` | clamp range |
| `brightness-curve` | `2.2` | gamma of the slider response; 1 = linear, higher = dimmer low end (macOS-like) |
| `ignore-ambient` | `true` | write the slider verbatim instead of letting GNOME's laptop-light-sensor bias spill onto this display |
| `auto-brightness` | `false` | use the display's built-in light sensor to move the slider, like macOS |
| `als-interval-secs` | `2` | sensor read interval while auto-brightness is on |
| `als-min-lux` / `als-max-lux` | `20` / `200000` | sensor-reading range the curve is stretched across |
| `als-min-value` / `als-max-value` | `0.1` / `0.95` | slider position driven at the dim / bright end |
| `als-bias` | `0` | your personal offset over the sensor curve (kept automatically when you move the slider) |

## Auto-brightness

The Studio Display's ambient light sensor is a plain HID sensor on its USB
cable, so the kernel's `hid-sensor-als` driver already exposes it as an IIO
device; `studio-brightness als` prints the reading:

```sh
studio-brightness als        # raw=19000 scale=1.0 lux=19000.0
```

Turn the macOS-style behaviour on:

```sh
gsettings set org.gnome.shell.extensions.apple-studio-brightness auto-brightness true
```

The slider in quick settings then tracks the room's light on a logarithmic
curve and visibly slides as the light changes. Note the sensor's scale runs
roughly 50x ahead of true lux — measurements on a real panel read about 16–40
fully covered and ~19000 in a normally lit room — so the `als-min-lux` /
`als-max-lux` defaults are calibrated to that scale (a lit room lands near
73%, i.e. ~300 nits, like macOS; ten times room light pins at the bright
end). If your room pins the slider too high or too low, move the slider to
where you like it: the move is kept as a persistent personal offset over the
sensor curve, exactly how macOS treats the slider in "Auto brightness" mode.
Unlike a user drag, sensor moves never flash the OSD brightness bar, and
switching auto-brightness back on re-anchors at wherever you left the slider
instead of jumping. `studio-brightness als` shows what the sensor sees while
you cover it, which is how you check whether `als-min-lux`/`als-max-lux`
need moving.

## Development

```sh
./tests/run-all.sh    # standalone gjs suites: spawn, USB target, scale mapping, Impl integration
```

The suites slice the real classes out of `extension/impl.js` and exercise
them against stubs, so they stay honest when the code changes.

Iterate on code without logging out: edit `extension/impl.js`, run
`./install.sh`, then

```sh
gnome-extensions disable apple-studio-brightness@marcvernet
gnome-extensions enable  apple-studio-brightness@marcvernet
```

(The first install of the wrapper itself still needs one fresh session;
GNOME only discovers new extension directories at session start.)

## Troubleshooting

- No slider after logout/in: `gnome-extensions info
  apple-studio-brightness@marcvernet` should say `state: ACTIVE`; check
  `journalctl --user -b -g studio-brightness` — expect
  `managing DP-2 via /dev/hidraw8 (raw=..., range=400..60000)`.
- `no USB HID brightness interface`: `studio-brightness probe` should show one
  `OK` node; `ls -l /dev/hidraw*` should show group `wheel` on the display's
  nodes (the udev rule). Only one of the display's several HID interfaces
  accepts the feature report; if auto-detection ever picks wrong, pin it with
  `gsettings set ... hidraw-device /dev/hidrawN`.
- `sudo: a password is required`: `SUDO=pkexec ./install.sh` uses polkit.
- SELinux: gnome-shell runs `unconfined_t` on Fedora Workstation, so spawning
  the CLI from the shell is permitted.

## Uninstall

```sh
./uninstall.sh
```

then log out and back in.

## Tear-free 5K display mode

Scroll tearing at 5120x2880@60? This panel's TCON fails only at its exact
nominal 936.000 MHz pixel clock — the same timing at 935.060 MHz (59.94 Hz)
is flawless. The [`display/`](display/README.md) directory ships the fix: an
EDID ladder advertising 5K at 50–59.94 Hz (persisted via
`drm.edid_firmware`), forced DSC for true 8-bit output, auto-arming after
login/replug, and a `studio-display` CLI (`status`, `dsc on|off`, `install`,
`uninstall`).

```sh
cd display && sudo ./studio-display install
studio-display status
```
