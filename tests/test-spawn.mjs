/* Tests for the CLI subprocess spawner in impl.js. */

import GLib from 'gi://GLib';

import {SLICES, PREAMBLE, loadModule, runMain, ok, done} from './helpers.mjs';

const mod = await loadModule(`
${PREAMBLE}
${SLICES.cliTimeout.replace(/= \s*\d+;/, '= 1;')}
${SLICES.spawn}
export {spawn};
`);

// Successful command: stdout captured.
let r = await runMain(() => mod.spawn(['/bin/echo', 'hello-asd']));
ok(r.ok, 'echo succeeds');
ok(r.out.includes('hello-asd'), 'echo stdout captured');

// Failing command: ok=false, no throw.
r = await runMain(() => mod.spawn(['/bin/false']));
ok(!r.ok, 'false reports failure');

// Missing binary: resolved rejection, not an exception.
r = await runMain(() => mod.spawn(['/nonexistent-program-xyz']));
ok(!r.ok, 'missing program reports failure');

// Watchdog kills runaway children (timeout patched to 1s).
const t0 = GLib.get_real_time();
r = await runMain(() => mod.spawn(['/usr/bin/sleep', '60']));
const secs = (GLib.get_real_time() - t0) / GLib.TIME_SPAN_SECOND;
ok(!r.ok, 'killed child reports failure');
ok(secs < 5, `watchdog killed sleep after ${secs.toFixed(1)}s`);

done('test-spawn');
