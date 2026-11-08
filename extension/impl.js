/* Apple Studio Display Brightness for GNOME — implementation.
 *
 * GNOME 51's BrightnessManager (js/misc/brightnessManager.js) drives the
 * control-centre brightness slider, the per-monitor brightness menu, the OSD
 * and the XF86MonBrightness keys. It only builds a BrightnessScale for
 * monitors that expose a kernel backlight; the Apple Studio Display has
 * neither a kernel backlight nor a DDC/CI slave — its backlight is driven
 * through a USB HID feature report on the display's vendor interface.
 *
 * This file injects a custom BrightnessScale, backed by the bundled
 * `cli/studio-brightness` helper (pure python3 stdlib, HIDIOCSFEATURE on
 * /dev/hidrawN), into Main.brightnessManager._monitorScales.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {BrightnessScale} from 'resource:///org/gnome/shell/misc/brightnessManager.js';

const SCALE_VALUE_N_STEPS = 20;
/* Smallest slider move the ambient light sensor is allowed to make, so
 * sensor noise cannot thrash the panel over USB. */
const ALS_MIN_STEP = 0.02;
const CLI_TIMEOUT_SECS = 6;

function spawn(argv) {
    let proc;
    try {
        proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    } catch (e) {
        return Promise.resolve({ok: false, out: '', err: e.message});
    }

    return new Promise(resolve => {
        let killed = false;
        let watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            CLI_TIMEOUT_SECS, () => {
                killed = true;
                watchdog = 0; // removed by the SOURCE_REMOVE return below
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });

        proc.communicate_utf8_async(null, null, (p, res) => {
            if (watchdog) {
                GLib.source_remove(watchdog);
                watchdog = 0;
            }
            let out = '', err = null;
            try {
                [, out, err] = p.communicate_utf8_finish(res);
            } catch (e) {
                err = e.message;
            }
            resolve({ok: !killed && p.get_successful(), out, err});
        });
    });
}

/* Drives one Studio Display through the studio-brightness CLI. */
const UsbTarget = class {
    constructor(cliPath, hidrawOverride) {
        this._cli = cliPath;
        this._hidraw = hidrawOverride || null;
        this._ok = false;
        this._pending = null; // latest raw value waiting to be written
        this._writing = false;
        this._flushId = 0;
        this._resolvers = []; // settled once the write queue drains
        this._changed = null; // last changed callback
        this._lastWritten = -1; // raw value last confirmed on the display
    }

    _args(extra) {
        const argv = [this._cli, ...extra];
        if (this._hidraw)
            argv.push('--hidraw', this._hidraw);
        return argv;
    }

    static parseGet(out) {
        const raw = out.match(/\braw=(\d+)/);
        const min = out.match(/\bmin=(\d+)/);
        const max = out.match(/\bmax=(\d+)/);
        const hid = out.match(/\bhidraw=(\S+)/);
        if (!raw || !min || !max)
            return null;
        return {raw: parseInt(raw[1], 10),
            min: parseInt(min[1], 10),
            max: parseInt(max[1], 10),
            hidraw: hid ? hid[1] : null};
    }

    async _get() {
        const r = await spawn(this._args(['get']));
        return r.ok ? UsbTarget.parseGet(r.out) : null;
    }

    /* Try the configured hidraw node first (if any), then auto-detection. */
    async probe() {
        let r = await this._get();
        if (!r && this._hidraw) {
            const saved = this._hidraw;
            this._hidraw = null;
            r = await this._get();
            if (!r)
                this._hidraw = saved;
        }
        if (r) {
            this._ok = true;
            this._lastWritten = r.raw;
        }
        return r;
    }

    async get() {
        if (!this._ok)
            return null;
        const r = await this._get();
        if (r)
            this._lastWritten = r.raw; // reads are authoritative
        return r;
    }

    /* Coalesce writes: keep only the newest target raw value. The returned
     * promise settles when the write queue drains; every caller waiting on
     * the burst is resolved together. */
    scheduleWrite(raw, changed) {
        if (raw === this._lastWritten) {
            changed?.(raw);
            return Promise.resolve(false);
        }
        this._pending = raw;
        this._changed = changed ?? this._changed;
        if (!this._writing && !this._flushId) {
            this._flushId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, this._debounceMs ?? 100, () => {
                    this._flushId = 0;
                    this._flush();
                    return GLib.SOURCE_REMOVE;
                });
        }
        return new Promise(resolve => this._resolvers.push(resolve));
    }

    async _flush() {
        if (this._writing)
            return;
        this._writing = true;
        while (this._pending !== null) {
            const want = this._pending;
            this._pending = null;
            const r = await spawn(this._args(['set', `${want}`]));
            if (r.ok) {
                this._lastWritten = want;
                this._changed?.(want);
            } else {
                log(`studio-brightness: write failed: ${(r.err || r.out || '').trim()}`);
            }
        }
        this._writing = false;
        const resolvers = this._resolvers;
        this._resolvers = [];
        for (const resolve of resolvers)
            resolve(true);
    }
};

/* The hot-reload wrapper re-imports this file on every enable, but GTypes
 * can never be unregistered; give each module instance a unique type name so
 * re-registering the class does not collide with the previous instance. */
const TYPE_NS = GLib.get_real_time().toString(36);

const StudioScale = GObject.registerClass({
    GTypeName: `AppleStudioScale_${TYPE_NS}`,
    Signals: {'backlights-changed': {}},
}, class StudioScale extends BrightnessScale {
    constructor(logicalMonitor, target, settings, manager = null) {
        const pm = logicalMonitor.get_monitors()[0];
        super(pm.get_display_name() || _('Studio Display'), 1.0, SCALE_VALUE_N_STEPS);

        this._lm = logicalMonitor;
        this._target = target;
        this._settings = settings;
        this._manager = manager;
        this._scaleFactor = 1.0;
        this._destroyed = false;
        this._min = 0;
        this._max = 100;
        this._alsTarget = -1.0; // sensor-driven slider position, -1 = never
        this._bias = settings.get_double('als-bias') || 0.0;
        target._debounceMs = settings.get_int('debounce-ms');
    }

    get monitor() {
        return this._lm;
    }

    get destroyed() {
        return this._destroyed;
    }

    setRange(min, max) {
        this._min = min;
        this._max = max;
    }

    /* Slider position and perceived brightness are related by a power
     * (gamma) curve, like macOS: with a linear mapping every position near
     * the bottom of the slider is still tens of nits. The panel's raw range
     * is 400 (its firmware floor, ~4 nits) to 60000 (600 nits). */
    _curve() {
        return this._settings.get_double('brightness-curve') || 1.0;
    }

    /* float 0..1 (with user clamps) -> raw value on the display */
    toRaw(v) {
        const lo = this._settings.get_double('min-brightness');
        const hi = this._settings.get_double('max-brightness');
        const c = Math.min(Math.max(v, lo), hi);
        const p = Math.pow(c, this._curve());
        return Math.round(this._min + p * (this._max - this._min));
    }

    /* raw value on the display -> float 0..1 */
    toFloat(raw) {
        const p = Math.min(Math.max((raw - this._min) / (this._max - this._min), 0), 1);
        return Math.pow(p, 1 / this._curve());
    }

    /* BrightnessManager calls this to notice kernel-backlight changes;
     * there is no kernel backlight here, external changes come via polling. */
    syncWithBacklight() {
        return false;
    }

    setBacklight(brightness) {
        if (this._destroyed)
            return;
        /* BrightnessManager._sync() mixes the laptop's ambient-light target
         * into every write: target = abTarget + value - 0.5. That sensor
         * belongs to the laptop, not to this external panel, and the bias
         * keeps the Studio Display from ever reaching its dim end (the
         * slider's bottom silently writes abTarget - 0.5 instead of 0).
         * Make the slider position authoritative instead, like macOS; idle
         * dimming is still honoured as a cap. */
        let v = brightness;
        if (this._settings.get_boolean('ignore-ambient'))
            v = this._manager?.dimming ? Math.min(this.value, brightness) : this.value;
        this._target.scheduleWrite(this.toRaw(v),
            raw => {
                this._lastRaw = raw;
            });
    }

    updateScaleFactor(max) {
        this._scaleFactor = max > 0 ? this.value / max : 1.0;
    }

    syncWithScale(globalScale) {
        this.value = globalScale.value * this._scaleFactor;
    }

    /* Adopt a value the display itself reports (poll, or initial probe). */
    adoptRaw(raw) {
        const v = Math.min(Math.max(this.toFloat(raw), 0), 1);
        if (Math.abs(v - this.value) < 0.005)
            return;
        this._lastRaw = raw;
        this.value = v; // notify::value -> manager._sync; write-back skipped
    }

    /* Drive the slider from the display's ambient light sensor (macOS-style
     * auto-brightness). The slider visibly moves, but unlike a user drag
     * this must not flash the OSD, claim a user-update, or persist the
     * transient position: the notify::value handlers all bail out while
     * _inhibitUpdates is set, so do the panel write ourselves. */
    applyAls(target) {
        if (this._destroyed)
            return false;
        this._alsTarget = target;
        const v = Math.min(Math.max(target + this._bias, 0), 1);
        if (Math.abs(v - this.value) < ALS_MIN_STEP)
            return false;
        const m = this._manager;
        if (m)
            m._inhibitUpdates = true;
        try {
            this.value = v;
        } finally {
            if (m)
                m._inhibitUpdates = false;
        }
        this.setBacklight(this.value);
        return true;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        super.destroy();
    }
});

export class Impl {
    constructor(settings, path) {
        this._settings = settings;
        this._path = path;
    }

    enable() {
        log('studio-brightness: impl rev 4 (ALS-immune slider, gamma curve)');
        this._scales = new Map();
        this._manager = Main.brightnessManager;

        if (!this._manager) {
            logError(new Error('studio-brightness: no BrightnessManager'));
            return;
        }

        const bundled = GLib.build_filenamev([this._path, 'cli', 'studio-brightness']);
        this._cli = GLib.file_test(bundled, GLib.FileTest.EXISTS)
            ? bundled : GLib.find_program_in_path('studio-brightness');

        // We connect after BrightnessManager, so our handler runs after it
        // has rebuilt _monitorScales.
        this._monitorManager = global.backend.get_monitor_manager();
        this._mmId = this._monitorManager.connect('monitors-changed',
            () => this._reinject());

        this._pollId = 0;
        const poll = this._settings.get_int('poll-interval-secs');
        if (poll > 0) {
            this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, poll,
                () => {
                    this._poll();
                    return GLib.SOURCE_CONTINUE;
                });
        }

        /* macOS-style auto-brightness off the display's own light sensor.
         * user-update fires for every slider move: while auto-brightness is
         * on, a move is a personal offset over the sensor curve, not an
         * override. */
        this._alsLux = -1.0;
        this._alsOn = this._settings.get_boolean('auto-brightness');
        this._alsId = 0;
        this._alsBusy = false;
        this._mmUserUpdateId = this._manager.connect('user-update',
            () => this._onUserUpdate());

        this._enabled = true;
        this._reinject();

        const alsSecs = Math.max(1, this._settings.get_int('als-interval-secs'));
        this._alsId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, alsSecs,
            () => {
                this._alsTick();
                return GLib.SOURCE_CONTINUE;
            });
        this._alsTick();
    }

    disable() {
        this._enabled = false;
        if (this._mmId) {
            this._monitorManager.disconnect(this._mmId);
            this._mmId = 0;
        }
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        if (this._alsId) {
            GLib.source_remove(this._alsId);
            this._alsId = 0;
        }
        if (this._mmUserUpdateId) {
            this._manager.disconnect(this._mmUserUpdateId);
            this._mmUserUpdateId = 0;
        }
        for (const lm of [...this._scales.keys()])
            this._removeScale(lm);
        this._scales.clear();
        this._settings = null;
    }

    _findTargets() {
        const vendor = this._settings.get_string('match-vendor');
        const product = this._settings.get_string('match-product');
        const result = [];
        for (const lm of this._monitorManager.get_logical_monitors()) {
            const pms = lm.get_monitors();
            const pm = pms.find(m => m.is_active()) ?? pms[0];
            if (!pm)
                continue;
            if (pm.get_vendor() === vendor &&
                    (!product || pm.get_product() === product) &&
                    pms.some(m => m.is_active()))
                result.push({lm, connector: pm.get_connector()});
        }
        return result;
    }

    async _reinject() {
        if (!this._enabled)
            return;
        for (const lm of [...this._scales.keys()])
            this._removeScale(lm);

        if (!this._cli) {
            log('studio-brightness: helper CLI not found, run install.sh');
            return;
        }

        for (const {lm, connector} of this._findTargets()) {
            if (this._scales.has(lm))
                continue;
            const target = new UsbTarget(
                this._cli, this._settings.get_string('hidraw-device'));
            const info = await target.probe();
            if (!info) {
                log(`studio-brightness: no USB HID brightness interface ` +
                    `for ${connector}; run 'studio-brightness probe' and ` +
                    `install.sh (udev rule)`);
                continue;
            }
            if (!this._enabled)
                return;
            const scale = new StudioScale(lm, target, this._settings, this._manager);
            scale.setRange(info.min, info.max);
            this._injectScale(lm, scale, info.raw);
            log(`studio-brightness: managing ${connector} via ` +
                `${info.hidraw} (raw=${info.raw}, range=${info.min}..${info.max})`);
        }
    }

    _injectScale(lm, scale, initialRaw) {
        const m = this._manager;
        scale._scaleChanged = true;
        scale.connectObject('backlights-changed', () => m._sync(),
            'notify::value', () => {
                if (m._inhibitUpdates)
                    return;
                scale._scaleChanged = true;
                m._sync();
                m.emit('user-update');
            }, m);
        m._monitorScales.set(lm, scale);

        if (!m._globalScale) {
            // Mirror js/misc/brightnessManager.js: the global scale is only
            // created for kernel-backlight monitors, so create it ourselves.
            const maxSteps = Math.max(...[...m._monitorScales.values()]
                .map(s => s.nSteps));
            m._globalScale = new BrightnessScale(_('Brightness'), 1.0,
                Math.min(maxSteps, SCALE_VALUE_N_STEPS));
            m._globalScale.connect('notify::value', () => {
                if (m._inhibitUpdates)
                    return;
                m._globalScaleChanged = true;
                m._sync();
                m.emit('user-update');
            });
        }

        this._scales.set(lm, scale);
        // Adopt the display's current value without flashing the OSD.
        m._inhibitUpdates = true;
        scale.adoptRaw(initialRaw);
        m._inhibitUpdates = false;
        m._sync({showOSD: false});
        m.emit('changed');
    }

    _removeScale(lm) {
        const scale = this._scales.get(lm);
        if (!scale)
            return;
        const m = this._manager;
        if (m._monitorScales.get(lm) === scale)
            m._monitorScales.delete(lm);
        if (!scale.destroyed)
            scale.destroy();
        this._scales.delete(lm);
        if (m._monitorScales.size === 0)
            m._globalScale = null;
        m._sync({showOSD: false});
        m.emit('changed');
    }

    /* Illuminance -> slider position: logarithmic, the way light perception
     * (and macOS) behaves: a decade below als-min-lux pins the slider to
     * als-min-value, a decade above als-max-lux to als-max-value. */
    _alsTargetFor(lux) {
        const s = this._settings;
        const lo = Math.max(0.5, s.get_double('als-min-lux'));
        const hi = Math.max(lo * 2, s.get_double('als-max-lux'));
        const vmin = Math.min(Math.max(s.get_double('als-min-value'), 0), 1);
        const vmax = Math.min(Math.max(s.get_double('als-max-value'), 0), 1);
        const t = Math.log(Math.min(Math.max(lux, lo), hi) / lo) / Math.log(hi / lo);
        return vmin + t * (vmax - vmin);
    }

    /* The user (or a poll-adopted external change) moved the slider while
     * auto-brightness is on: treat the move as a persistent personal offset
     * over the sensor-driven curve, like macOS. */
    _onUserUpdate() {
        if (!this._alsOn)
            return;
        for (const [, scale] of this._scales) {
            if (scale.destroyed || scale._alsTarget < 0)
                continue;
            const bias = Math.min(Math.max(scale.value - scale._alsTarget, -1), 1);
            if (Math.abs(bias - scale._bias) > 0.005) {
                scale._bias = bias;
                this._settings.set_double('als-bias', bias);
            }
        }
    }

    async _alsTick() {
        if (!this._enabled || this._alsBusy || !this._cli)
            return;
        const on = this._settings.get_boolean('auto-brightness');
        const turnedOn = on && !this._alsOn;
        this._alsOn = on;
        if (!on || this._scales.size === 0) {
            this._alsLux = -1.0;
            return;
        }
        // Do not race a pending brightness write.
        for (const [, scale] of this._scales) {
            const t = scale._target;
            if (t._writing || t._pending !== null)
                return;
        }
        this._alsBusy = true;
        try {
            const r = await spawn([this._cli, 'als']);
            if (!r.ok) {
                log(`studio-brightness: als failed: ${(r.err || r.out || '').trim()}`);
                return;
            }
            const raw = r.out.match(/raw=(-?\d+)/);
            const scale = r.out.match(/scale=([-\d.eE+]+)/);
            if (!raw || !scale)
                return;
            const lux = Number(raw[1]) * Number(scale[1]);
            if (!Number.isFinite(lux) || lux < 0)
                return;
            // Smooth: the raw reading is per-report; jump on first read,
            // otherwise ease towards it so a waving shadow is ignored.
            this._alsLux = this._alsLux < 0 ? lux : 0.75 * this._alsLux + 0.25 * lux;
            const target = this._alsTargetFor(this._alsLux);
            let applied = 0;
            for (const [, sc] of this._scales) {
                if (sc.destroyed)
                    continue;
                if (turnedOn) {
                    // Re-anchor on activation: the slider the user is looking
                    // at becomes the new baseline instead of jumping.
                    sc._bias = Math.min(Math.max(sc.value - target, -1), 1);
                    this._settings.set_double('als-bias', sc._bias);
                }
                if (sc.applyAls(target))
                    applied++;
            }
            if (applied)
                log(`studio-brightness: auto-brightness lux=${this._alsLux.toFixed(0)} target=${target.toFixed(2)}`);
        } finally {
            this._alsBusy = false;
        }
    }

    async _poll() {
        if (!this._enabled)
            return;
        for (const [, scale] of this._scales) {
            const t = scale._target;
            if (t._writing || t._pending !== null)
                continue;
            const info = await t.get();
            if (info && !scale.destroyed && info.raw !== scale._lastRaw)
                scale.adoptRaw(info.raw);
        }
    }
}
