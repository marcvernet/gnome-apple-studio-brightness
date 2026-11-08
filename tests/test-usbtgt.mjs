/* Tests for UsbTarget: CLI argument building, get-output parsing and
 * write coalescing (a burst of slider moves must collapse into one write
 * of the newest value). */

import {SLICES, PREAMBLE, loadModule, runMain, ok, done} from './helpers.mjs';

const GET_OUT = 'brightness: 27% raw=16200 min=400 max=60000 hidraw=/dev/hidraw8';

const mod = await loadModule(`
${PREAMBLE}
${SLICES.cliTimeout}
export const calls = [];
export const completions = [];
function spawn(argv) {
    calls.push(argv);
    let out = '';
    if (argv[1] === 'get')
        out = ${JSON.stringify(GET_OUT)};
    if (argv[1] === 'set' && argv[2] === '9999')
        return Promise.resolve({ok: false, out: '', err: 'device busy'});
    return Promise.resolve({ok: true, out, err: null});
}
${SLICES.usbTarget}
export {UsbTarget};
`);

// --- parseGet -------------------------------------------------------------
let info = mod.UsbTarget.parseGet(GET_OUT);
ok(info && info.raw === 16200 && info.min === 400 && info.max === 60000,
    'parseGet extracts raw/min/max');
ok(info.hidraw === '/dev/hidraw8', 'parseGet extracts hidraw');
ok(mod.UsbTarget.parseGet('nonsense') === null, 'parseGet rejects junk');

// --- argument building ----------------------------------------------------
let t = new mod.UsbTarget('/usr/bin/studio-brightness', '/dev/hidraw3');
ok(t._args(['get']).join(' ') ===
    '/usr/bin/studio-brightness get --hidraw /dev/hidraw3',
    'hidraw override is passed through');
t = new mod.UsbTarget('/usr/bin/studio-brightness', '');
ok(t._args(['set', '1000']).join(' ') ===
    '/usr/bin/studio-brightness set 1000',
    'no hidraw flag when unset');

// --- probe / get ----------------------------------------------------------
t = new mod.UsbTarget('/usr/bin/studio-brightness', null);
mod.calls.length = 0;
info = await runMain(() => t.probe());
ok(info && info.raw === 16200, 'probe returns parsed state');
ok(t._ok && t._lastWritten === 16200, 'probe records initial value');

// A bad explicit node falls back to auto-detection.
t = new mod.UsbTarget('/usr/bin/studio-brightness', '/dev/hidraw99');
let attempts = 0;
t._get = async () => {
    attempts++;
    return attempts === 1
        ? null // configured node answers nothing
        : {raw: 16200, min: 400, max: 60000, hidraw: '/dev/hidraw8'};
};
info = await runMain(() => t.probe());
ok(info && attempts === 2, 'probe falls back to autodetect once');
ok(t._hidraw === null, 'fallback clears the broken override');

// --- write coalescing -----------------------------------------------------
t = new mod.UsbTarget('/usr/bin/studio-brightness', null);
t._debounceMs = 10;
mod.calls.length = 0;
// Burst of slider positions during the debounce window.
await runMain(async () => {
    await Promise.all([
        t.scheduleWrite(1000),
        t.scheduleWrite(2000),
        t.scheduleWrite(3000),
    ]);
});
const writes = mod.calls.filter(a => a[1] === 'set');
ok(writes.length === 1, `burst -> single write (got ${writes.length})`);
ok(writes[0]?.[2] === '3000', 'burst writes the newest value');

// Re-requesting the current value is a no-op.
mod.calls.length = 0;
let fired = true;
await runMain(() => t.scheduleWrite(3000).then(wrote => {
    fired = wrote;
}));
ok(!fired, 'unchanged value reports no write');
ok(mod.calls.filter(a => a[1] === 'set').length === 0,
    'unchanged value spawns nothing');

// A failed write must not fire changed nor poison the last-written cache.
t = new mod.UsbTarget('/usr/bin/studio-brightness', null);
t._debounceMs = 10;
let changedFired = false;
await runMain(() => t.scheduleWrite(9999, () => {
    changedFired = true;
}));
ok(!changedFired, 'failed write does not fire changed callback');
ok(t._lastWritten === -1, 'failed write leaves lastWritten stale');

// changed callback fires with the raw value on success.
t = new mod.UsbTarget('/usr/bin/studio-brightness', null);
t._debounceMs = 10;
let changedTo = null;
await runMain(() => t.scheduleWrite(4242, raw => {
    changedTo = raw;
}));
ok(changedTo === 4242, 'changed callback gets the raw value');

done('test-usbtgt');
