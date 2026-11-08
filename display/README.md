# Tear-free 5K mode for the Apple Studio Display (Linux / i915)

The Studio Display's panel controller misbehaves at its **nominal
5120x2880@60.00 Hz timing — exactly 936.000 MHz input pixel clock**:

| timing (5K)          | pixel clock | plain (6bpc)        | forced DSC (8bpc) |
| -------------------- | ----------- | ------------------- | ----------------- |
| 60.00 Hz             | 936.000 MHz | scroll **tearing**  | **no sync** (black) |
| 59.94 Hz             | 935.060 MHz | clean               | clean             |
| 58 / 56 / 54 / 50 Hz | lower       | clean               | clean             |

Both link load (97.5 % vs 97.4 %) and refresh difference (0.1 %) are far too
small to explain this — the failure is specific to the **exact nominal
clock**, a TCON-side issue (macOS never exercises the plain-60 path: over the
Thunderbolt tunnel it always runs DSC, which this panel cannot sync at 60 Hz
on Linux). Note the panel's own EDID advertises 5K@60 as its only 5K timing,
so GNOME has no clean mode to pick.

## Solution

1. **EDID ladder** (`edid/apple-studio-display-5k-ladder.bin`): the stock
   EDID plus one appended DisplayID block advertising 5120x2880 at
   **50/54/56/58/59.94 Hz** (same native porches: htot 5200, vtot 3000).
   GNOME then offers 59.94 Hz in Settings → Displays; the choice is kept in
   `~/.config/monitors.xml` and survives replug/reboot.
2. **Forced DSC** (`i915_dsc_fec_support` + link retrain): the DP link runs
   Display Stream Compression, giving **full bit depth with no FRC
   dithering** (`dither=no`, bpp 24–36 depending on the negotiated depth) at
   ~40 % link load. Safe on all sub-60 timings; at exactly 60 Hz it blacks
   the panel, so the tool refuses to arm DSC there.
3. **Persistence**: the EDID lives in `/lib/firmware/edid/` and is applied on
   every boot/hotplug via the kernel cmdline
   `drm.edid_firmware=DP-2:edid/apple-studio-display-5k-ladder.bin`. The
   `DP-2:` prefix is **required** — an unprefixed value would override *every*
   connector including the laptop's eDP panel. `install` also drops a dracut
   config so the EDID is inside the initramfs (i915 probes from the initrd,
   where `/lib/firmware` is otherwise unavailable).
4. **DSC convergence**: mutter clears the DSC force flag on *every* modeset
   (login, resume, replug), and a cold-plugged panel fires no hotplug event,
   so a single "arm at boot" step always loses the race. Instead the desired
   state lives in `/var/lib/studio-display/dsc` and a systemd **timer**
   (boot + every 2 min) plus a hotplug udev rule converge the hardware to it.
   Already-converged → instant no-op; `dsc off` is therefore **sticky** (it
   moves the desired state, not just the flag).

## Use

```sh
# one-time setup (from this directory):
sudo ./studio-display install      # or: pkexec ./studio-display install

# afterwards, anytime:
studio-display status              # mode, refresh, clock, DSC, bpp, dither, link, verdict
studio-display dsc on | off        # desired DSC state (remembered; timer keeps converging)
sudo studio-display uninstall      # revert everything
```

`status` on a healthy setup:

```
== Apple Studio Display (card1-DP-2, kernel ...) ==
Connector   : connected   EDID: firmware /lib/firmware/edid/apple-studio-display-5k-ladder.bin (4 extensions)
Mode        : 5120x2880 @ 59.94 Hz  (clock 935060 kHz, htot 5200, vtot 3000)
Pipe        : bpp 36, dither no
DSC         : on (force flag: on, desired: on)
Link        : HBR2 x4 (SST)        # "standby (idle)" while the panel sleeps
EDID param  : drm.edid_firmware=edid/... (kernel cmdline, persistent)
-- verdict --
  ✓  tear-free timing (clock ≤ 935500 kHz)
  ✓  full bit depth via DSC (bpp 36) — no FRC dithering
```

## Files

| file | role |
| ---- | ---- |
| `build_ladder.py` | regenerates the EDID from `edid/apple-studio-display-stock.bin` (self-checks against the kernel's DisplayID parser) |
| `edid/apple-studio-display-stock.bin` | stock EDID dumped from the panel |
| `edid/apple-studio-display-5k-ladder.bin` | the override actually installed |
| `studio-display` | CLI: `status`, `dsc`, `install`, `uninstall`; installs its own systemd service + timer + udev rule |

## Notes & safety

* **Never force DSC at exactly 60.00 Hz** on this panel (black screen, ×3
  observed). The `dsc on` command refuses when the active DP-2 CRTC clock is
  above 935500 kHz; the boot/udev auto-arm silently skips in that case.
* The force flag is cleared by connector re-detects and mode switches —
  that is why arming must happen *after* the mode commit. The convergence
  timer (every 2 min) and the udev rule re-check continuously instead of
  trusting one arming moment; each pass is a no-op (~30 ms) when hardware
  already matches the desired state, so the panel is not retrained needlessly.
* `studio-display dsc off` records the desired state as off, so the timer
  respects it (and actively disarms a stray `Force_DSC_Enable`). Re-enable
  with `studio-display dsc on`.
* `install` also clears any debugfs `edid_override` (writing `reset`) so the
  firmware EDID is the single source of truth.
* The connector name is configurable: `STUDIO_DISPLAY_CONNECTOR=DP-4
  sudo ./studio-display install` (the udev rule is generated with it).
* Requires i915 debugfs mounted and root (pkexec) for debugfs access.
* If you plug into the *other* Thunderbolt port, the connector may enumerate
  as `DP-1`/`DP-4`; `status` tells you which EDID/mode is live — re-run
  `install` with the right `STUDIO_DISPLAY_CONNECTOR` if needed.
