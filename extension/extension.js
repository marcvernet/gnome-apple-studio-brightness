/* Apple Studio Display Brightness for GNOME — stable entry point.
 *
 * GNOME caches imported extension modules for the whole shell session: after
 * editing the code, `gnome-extensions disable/enable` would keep running the
 * old module. Importing the real implementation with a unique query string
 * defeats that cache, so code updates apply on re-enable without logging out.
 * Keep this file stable; put everything else in impl.js.
 */

import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class AppleStudioBrightnessExtension extends Extension {
    async enable() {
        this._settings = this.getSettings();
        const {Impl} = await import(
            `./impl.js?rev=${GLib.get_real_time()}`);
        this._impl = new Impl(this._settings, this.path);
        await this._impl.enable();
    }

    disable() {
        this._impl?.disable();
        this._impl = null;
        this._settings = null;
    }
}
