// Test driver for the clipboard-indicator fork. Runs once after shell
// startup inside an isolated headless session (see ../run.sh) and logs
// one "CI-TEST PASS|FAIL <name>" line per check, then "CI-TEST END ...".
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const UUID = 'clipboard-indicator@wuxler.github.com';
const CLIP = St.ClipboardType.CLIPBOARD;
const log = msg => console.log(`CI-TEST ${msg}`);
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r(); return GLib.SOURCE_REMOVE;
}));

async function waitFor (pred, timeoutMs, stepMs = 50) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (pred()) return true;
        await sleep(stepMs);
    }
    return pred();
}

// Resolves to a copy of the clipboard data (Uint8Array), or null if the
// owner does not answer within 3 s. The GLib.Bytes passed to the callback
// is freed by St once the callback returns, so it must be copied inside it.
function clipboardBytes (mimetype) {
    return new Promise(r => {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            log(`INFO get_content(${mimetype}) timed out`);
            r(null);
            return GLib.SOURCE_REMOVE;
        });
        St.Clipboard.get_default().get_content(CLIP, mimetype, (_c, b) => {
            GLib.source_remove(id);
            r(b ? b.get_data() : null);
        });
    });
}

function clipboardMimetypes () {
    return global.display.get_selection().get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD);
}

function makePng (w, h, rgba) {
    const pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, w, h);
    pb.fill(rgba);
    const [, buf] = pb.save_to_bufferv('png', [], []);
    return new GLib.Bytes(buf);
}

// A PNG that does not compress well, so writing it takes a while.
function makeNoisyPng (w, h, seed) {
    const data = new Uint8Array(w * h * 3);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < data.length; i++) {
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        data[i] = x & 0xff;
    }
    const pb = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(data),
        GdkPixbuf.Colorspace.RGB, false, 8, w, h, w * 3);
    const [, buf] = pb.save_to_bufferv('png', [], []);
    return new GLib.Bytes(buf);
}

async function clipboardText () {
    const data = await clipboardBytes('text/plain;charset=utf-8');
    return data ? new TextDecoder().decode(data) : null;
}

function listDir (path) {
    const names = [];
    if (!GLib.file_test(path, GLib.FileTest.IS_DIR)) return names;
    const en = Gio.File.new_for_path(path).enumerate_children('standard::name', 0, null);
    let info;
    while ((info = en.next_file(null)) !== null) names.push(info.get_name());
    return names;
}

export default class CiTest extends Extension {
    enable () {
        // Disabling clipboard-indicator during the run makes GNOME re-enable
        // every extension enabled after it, including this one.
        if (globalThis.__ciTestStarted) return;
        globalThis.__ciTestStarted = true;
        this._pass = 0;
        this._fail = 0;
        const run = () => this._run()
            .catch(e => this._check('no exception', false, `${e}\n${e.stack}`))
            .finally(() => log(`END pass=${this._pass} fail=${this._fail}`));
        if (Main.layoutManager._startingUp) {
            this._t0 = 0;
            const id = Main.layoutManager.connect('startup-complete', () => {
                Main.layoutManager.disconnect(id);
                this._t0 = Date.now();
                run();
            });
        }
        else {
            this._t0 = Date.now();
            run();
        }
    }

    disable () {}

    _check (name, ok, detail = '') {
        if (ok) this._pass++; else this._fail++;
        log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
    }

    // CI_SCENARIO=corrupt (with a seed and CORRUPT=1): an unparsable
    // registry must be kept as the backup and its images must survive.
    async _runCorrupt () {
        const loaded = await waitFor(() => this._ind()?._historyLoaded, 15000);
        this._check('history loads despite a corrupt registry', loaded);
        if (!loaded) return;
        const ind = this._ind();
        const images = () => listDir(ind.registry.REGISTRY_DIR).filter(n => /^\d+$/.test(n)).length;
        const before = images();

        this._check('corrupt registry starts an empty history', ind._history.length === 0);
        this._check('corrupt registry is kept as backup',
            GLib.file_test(ind.registry.BACKUP_REGISTRY_PATH, GLib.FileTest.EXISTS) &&
            !GLib.file_test(ind.registry.REGISTRY_PATH, GLib.FileTest.EXISTS));
        this._check('no pruning scheduled after a failed load', !ind._pruneTimeoutId);

        await ind.registry.pruneOrphanFiles(() => false);
        this._check('cached images survive a failed load', before > 0 && images() === before,
            `images ${before} -> ${images()}`);
    }

    // CI_SCENARIO=gtype: upstream is enabled first, then replaced by this
    // fork in the same shell process.
    async _runGtype () {
        const upstream = 'clipboard-indicator@tudmotu.com';
        const up = await waitFor(() => this._ind() !== undefined, 15000);
        this._check('upstream indicator loaded', up);

        // disableExtension() only edits the enabled list; the extension is
        // unloaded once the settings change arrives, which the keyfile
        // backend delivers late. Wait for the upstream indicator to go.
        await Main.extensionManager.disableExtension(upstream);
        const gone = await waitFor(() => this._ind() === undefined, 10000);
        this._check('upstream indicator removed', gone);
        await Main.extensionManager.enableExtension(UUID);
        const loaded = await waitFor(() => this._ind()?._historyLoaded, 10000);
        const ext = Main.extensionManager.lookup(UUID);
        this._check('fork loads after upstream in the same process',
            loaded && ext?.state === 1 && !ext?.error,
            `state=${ext?.state} error=${ext?.error}`);
    }

    // CI_SCENARIO=visual: open the menu, put the first history row's action
    // buttons into :hover one at a time and take screenshots. Works with
    // upstream too (it only uses the menu, not fork internals).
    async _runVisual () {
        const up = await waitFor(() => this._ind() !== undefined, 15000);
        if (!up) return this._check('indicator present', false);
        const ind = this._ind();
        St.Clipboard.get_default().set_text(CLIP, 'visual check row');
        await sleep(1500);
        ind.menu.open();
        await sleep(2500);

        const rows = [];
        const walk = actor => {
            for (const child of actor.get_children()) {
                if (child instanceof PopupMenu.PopupMenuItem && child.entry) rows.push(child);
                walk(child);
            }
        };
        walk(ind.menu.box);
        const row = rows.find(r => r.entry.getStringValue() === 'visual check row') ?? rows[0];
        this._check('history row found', !!row, `rows=${rows.length}`);
        if (!row) return;

        row.entry.setTag('ci tag');
        ind._updateTagLabel(row);
        await sleep(300);

        const variant = Main.getStyleVariant();
        const buttons = row.get_children().filter(c => c instanceof St.Button);
        const rgba = actor => {
            const c = actor.get_theme_node().get_foreground_color();
            return [c.red, c.green, c.blue, c.alpha];
        };
        const bgAlpha = actor => actor.get_theme_node().get_background_color().alpha;
        const shot = async name => {
            const path = GLib.getenv('CI_SHOT').replace(/menu\.png$/, `${name}.png`);
            const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
            await new Promise((res, rej) => new Shell.Screenshot().screenshot(false, stream, (sh, r) => {
                try { sh.screenshot_finish(r); res(); } catch (e) { rej(e); }
            }));
            stream.close(null);
        };

        // Visible means: not transparent and contrasting with the menu.
        const visibleOn = ([r, g, b, a]) => a >= 0x40 && (variant === 'light' ? r < 0x80 && g < 0x80 && b < 0x80 : r >= 0x80);
        const pin = buttons.find(btn => btn.style_class.includes('ci-pin-btn'));
        this._check(`pin icon visible (${variant})`, pin && visibleOn(rgba(pin)), `color=${pin && rgba(pin)}`);
        const tag = row.tagLabel;
        this._check(`tag label visible (${variant})`, tag && visibleOn(rgba(tag)), `color=${tag && rgba(tag)}`);

        // WCAG 1.4.11 contrast of the pin icon, from the colours the theme
        // actually resolved: menu background, row and button backgrounds
        // (which may be translucent), then the icon's foreground.
        const toRgba = c => [c.red, c.green, c.blue, c.alpha / 255];
        const over = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat([1]);
        const luminance = ([r, g, b]) => {
            const f = v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const contrast = (a, b) => {
            const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
            return (hi + 0.05) / (lo + 0.05);
        };
        const pinContrast = () => {
            let bg = toRgba(ind.menu.box.get_theme_node().get_background_color());
            for (const layer of [row, pin])
                bg = over(toRgba(layer.get_theme_node().get_background_color()), bg);
            return contrast(over(toRgba(pin.get_theme_node().get_foreground_color()), bg), bg);
        };
        const pinNormal = pinContrast();
        let pinHovered = null;

        await shot('visual-normal');
        // Real pointer motion through a virtual device, so crossing events
        // and hover tracking behave as with a mouse.
        const seat = Clutter.get_default_backend().get_default_seat();
        const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const moveTo = (x, y) => pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        const hoverOk = [];
        for (const [i, btn] of buttons.entries()) {
            const [bx, by] = btn.get_transformed_position();
            const [bw, bh] = btn.get_transformed_size();
            moveTo(bx + bw / 2, by + bh / 2);
            await sleep(500);
            await shot(`visual-hover-${i}`);
            if (btn === pin) pinHovered = pinContrast();
            const others = buttons.filter(o => o !== btn).map(bgAlpha);
            hoverOk.push(bgAlpha(btn) > 0 && others.every(alpha => alpha === 0));
        }
        this._check('hovered action button is highlighted, others are not',
            hoverOk.length > 0 && hoverOk.every(x => x), JSON.stringify(hoverOk));
        this._check(`pin icon contrast at least 3:1 (${variant})`,
            pinNormal >= 3 && pinHovered !== null && pinHovered >= 3,
            `normal=${pinNormal.toFixed(2)} hovered=${pinHovered?.toFixed(2)}`);
        moveTo(10, 500);
        await sleep(400);
        this._check('no highlight after the pointer leaves', buttons.every(btn => bgAlpha(btn) === 0));

        // Edit dialog, opened with the row's "e" key, for a visual check only.
        const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const tap = keyval => {
            keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED);
            keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED);
        };
        row.grab_key_focus();
        tap(Clutter.KEY_e);
        await sleep(1000);
        await shot('visual-edit');
        tap(Clutter.KEY_Escape);
        await sleep(500);

        // --- the pin button shows its action: pin, or pin-off when pinned --
        const pinButtonOf = r => r.get_children().find(c => c instanceof St.Button && c.style_class.includes('ci-pin-btn'));
        const iconOf = btn => {
            const gicon = btn.child.gicon;
            return gicon instanceof Gio.FileIcon ? gicon.get_file().get_basename() : gicon?.get_names?.()[0];
        };
        const findRow = () => {
            const found = [];
            const walk2 = actor => {
                for (const child of actor.get_children()) {
                    if (child instanceof PopupMenu.PopupMenuItem && child.entry) found.push(child);
                    walk2(child);
                }
            };
            walk2(ind.menu.box);
            return found.find(r => r.entry.getStringValue() === 'visual check row');
        };
        if (!ind.menu.isOpen) ind.menu.open();
        await sleep(500);
        let target = findRow();
        const before = [iconOf(pinButtonOf(target)), pinButtonOf(target).accessible_name];
        ind._favoriteToggle(target);
        await sleep(800);
        target = findRow();
        const pinBtn = pinButtonOf(target);
        const after = [iconOf(pinBtn), pinBtn.accessible_name];
        this._check('pin button shows pin, then pin-off once pinned',
            before[0] === 'view-pin-symbolic' && before[1] === 'Pin' &&
            target.entry.isFavorite() && after[0] === 'pin-off-symbolic.svg' && after[1] === 'Unpin',
            `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
        await shot('visual-pinned');

        // The shipped SVG must render, recoloured like a symbolic icon:
        // some pixel inside the button contrasts with the menu.
        const shooter = new Shell.Screenshot();
        const pick = (x, y) => new Promise((res, rej) => shooter.pick_color(x, y, (sh, r) => {
            try { res(sh.pick_color_finish(r)[1]); } catch (e) { rej(e); }
        }));
        const [px, py] = pinBtn.child.get_transformed_position();
        const [pw, ph] = pinBtn.child.get_transformed_size();
        let extreme = variant === 'light' ? 1 : 0;
        for (let i = 1; i < 6; i++) {
            for (let j = 1; j < 6; j++) {
                const c = await pick(Math.round(px + pw * i / 6), Math.round(py + ph * j / 6));
                const l = luminance([c.red, c.green, c.blue]);
                extreme = variant === 'light' ? Math.min(extreme, l) : Math.max(extreme, l);
            }
        }
        this._check(`pin-off icon renders in the ${variant} style`,
            variant === 'light' ? extreme < 0.2 : extreme > 0.6, `extreme luminance=${extreme.toFixed(3)}`);
        log(`INFO style variant=${variant}`);
    }

    _ind () {
        return Main.panel.statusArea.clipboardIndicator;
    }

    async _run () {
        // CI_PREFS_ONLY=<uuid>: only open that extension's preferences.
        const prefsOnly = GLib.getenv('CI_PREFS_ONLY');
        if (prefsOnly) {
            Main.extensionManager.openExtensionPrefs(prefsOnly, '', {});
            await sleep(6000);
            log(`INFO prefs windows=${JSON.stringify(global.get_window_actors().map(a => a.meta_window.get_title()))}`);
            return;
        }

        const scenario = GLib.getenv('CI_SCENARIO');
        if (scenario === 'corrupt') return this._runCorrupt();
        if (scenario === 'gtype') return this._runGtype();
        if (scenario === 'visual') return this._runVisual();

        const seeded = GLib.getenv('CI_SEEDED') === '1';

        // --- startup and lazy load -------------------------------------
        const loaded = await waitFor(() => this._ind()?._historyLoaded, 15000);
        this._check('history loads after startup', loaded,
            `load ${Date.now() - this._t0} ms after startup-complete`);
        if (!loaded) return;
        let ind = this._ind();
        const settings = ind.extension.settings;

        this._check('menu not populated before first open', ind._menuItems.size === 0,
            `menuItems=${ind._menuItems.size}`);

        // The newest entry is put on the clipboard at load; give it time.
        await sleep(1500);
        const images = ind._history.filter(e => e.isImage());
        const withBytes = images.filter(e => e.hasBytes());
        this._check('cached images not held in memory', withBytes.length === 0,
            `images=${images.length} withBytes=${withBytes.length}`);

        const nonFavImages = images.filter(e => !e.isFavorite());
        const maxImages = settings.get_int('max-cached-images');
        const maxBytes = settings.get_int('max-image-cache-size') * 1024 * 1024;
        const total = nonFavImages.slice(0, -1).reduce((s, e) => s + e.size(), 0);
        this._check('image quota enforced on load',
            nonFavImages.length <= maxImages && total <= maxBytes,
            `unpinnedImages=${nonFavImages.length}/${maxImages} bytes(excl. newest)=${total}/${maxBytes}`);

        if (seeded) {
            const favs = ind._history.filter(e => e.isFavorite()).length;
            this._check('pinned entries survive quota', favs === 2, `pinned=${favs}`);
        }

        // --- copy text, dedupe -----------------------------------------
        const clipboard = St.Clipboard.get_default();
        let n0 = ind._history.length;
        clipboard.set_text(CLIP, 'ci text A');
        await waitFor(() => ind._history.at(-1)?.getStringValue() === 'ci text A', 3000);
        this._check('copied text becomes newest entry',
            ind._history.at(-1)?.getStringValue() === 'ci text A' &&
            ind._selectedEntry === ind._history.at(-1),
            `len ${n0} -> ${ind._history.length}`);

        clipboard.set_text(CLIP, 'ci text B');
        await waitFor(() => ind._history.at(-1)?.getStringValue() === 'ci text B', 3000);
        n0 = ind._history.length;
        clipboard.set_text(CLIP, 'ci text A');
        await sleep(800);
        this._check('duplicate copy does not add an entry', ind._history.length === n0 &&
            ind._selectedEntry?.getStringValue() === 'ci text A',
            `len=${ind._history.length} expected=${n0}`);

        // --- burst of copies: none may be dropped -------------------------
        clipboard.set_text(CLIP, 'ci burst 1');
        clipboard.set_text(CLIP, 'ci burst 2');
        clipboard.set_text(CLIP, 'ci burst 3');
        await waitFor(() => ind._history.at(-1)?.getStringValue() === 'ci burst 3', 3000);
        this._check('last of a copy burst is recorded',
            ind._history.at(-1)?.getStringValue() === 'ci burst 3' &&
            ind._selectedEntry === ind._history.at(-1),
            `newest=${ind._history.at(-1)?.getStringValue()}`);
        for (const e of ind._history.filter(e => e.getStringValue().startsWith('ci burst')))
            ind._removeEntry(e);

        // --- copy image ----------------------------------------------------
        const png = makePng(800, 600, 0x3366ccff);
        clipboard.set_content(CLIP, 'image/png', png);
        const gotImage = await waitFor(() => ind._history.at(-1)?.isImage(), 3000);
        const img = ind._history.at(-1);
        const clipPng = await clipboardBytes('image/png');
        this._check('copied image becomes newest entry', gotImage,
            `id=${img?.id()} newest=${ind._history.at(-1)?.getStringValue().slice(0, 30)} ` +
            `clipboardPng=${clipPng?.length} expectedId=${png.hash()} ` +
            `inHistory=${ind._history.some(e => e.id() === String(png.hash()))}`);
        if (gotImage) {
            await waitFor(() => !img.hasBytes(), 5000);
            const file = ind.registry.getEntryFilename(img);
            const thumb = ind.registry.getThumbnailFilename(img);
            this._check('new image persisted and released',
                GLib.file_test(file, GLib.FileTest.EXISTS) && !img.hasBytes(),
                `file=${GLib.file_test(file, GLib.FileTest.EXISTS)} hasBytes=${img.hasBytes()}`);
            this._check('thumbnail created for new image', GLib.file_test(thumb, GLib.FileTest.EXISTS));
            this._check('image id matches upstream hash naming', img.id() === String(png.hash()));
        }

        // --- menu population -----------------------------------------------
        const tOpen = Date.now();
        ind.menu.open();
        const firstBatch = ind._menuItems.size;
        const ready = await waitFor(() => ind._menuState === 'ready', 15000);
        this._check('menu populates on first open', ready &&
            ind._menuItems.size === ind._history.length &&
            ind._history.every(e => ind._menuItems.has(e)),
            `firstBatch=${firstBatch} items=${ind._menuItems.size} history=${ind._history.length} in ${Date.now() - tOpen} ms`);

        // Pinned entries go to the pinned section, others to history.
        const sectionOk = ind._history.every(e => {
            const item = ind._menuItems.get(e);
            const section = e.isFavorite() ? ind.favoritesSection : ind.historySection;
            return section._getMenuItems().includes(item);
        });
        this._check('items placed in the right section', sectionOk);

        // Newest unpinned entry is the top item of the history section.
        const top = ind.historySection._getMenuItems()[0];
        const newestUnpinned = ind._history.filter(e => !e.isFavorite()).at(-1);
        this._check('newest entry is at the top', top?.entry === newestUnpinned);

        // Screenshot of the open menu, for a visual check of thumbnails.
        const shotPath = GLib.getenv('CI_SHOT');
        if (shotPath) {
            await sleep(1500);
            const stream = Gio.File.new_for_path(shotPath).replace(null, false, Gio.FileCreateFlags.NONE, null);
            const shooter = new Shell.Screenshot();
            await new Promise((res, rej) => shooter.screenshot(false, stream, (s, r) => {
                try { s.screenshot_finish(r); res(); } catch (e) { rej(e); }
            }));
            stream.close(null);
            log(`INFO screenshot ${shotPath}`);

            const allThumbs = await waitFor(() => ind._history.filter(e => e.isImage())
                .every(e => ind.registry.hasThumbnail(e)), 30000, 200);
            this._check('thumbnails created for all cached images', allThumbs,
                `${Date.now() - tOpen} ms after first open`);
            const shot2 = shotPath.replace(/\.png$/, '-later.png');
            const stream2 = Gio.File.new_for_path(shot2).replace(null, false, Gio.FileCreateFlags.NONE, null);
            await new Promise((res, rej) => shooter.screenshot(false, stream2, (s, r) => {
                try { s.screenshot_finish(r); res(); } catch (e) { rej(e); }
            }));
            stream2.close(null);
        }

        // --- search ----------------------------------------------------------
        // The indicator resets the search 50 ms after opening.
        await sleep(300);
        ind.searchEntry.set_text('ci text');
        await sleep(100);
        const visible = ind._getAllIMenuItems().filter(i => i.actor.visible).map(i => i.entry.getStringValue());
        this._check('search filters items', visible.length === 2 &&
            visible.every(v => v.startsWith('ci text')), `visible=${JSON.stringify(visible)}`);
        ind.searchEntry.set_text('');
        await sleep(100);
        this._check('clearing search shows all',
            ind._getAllIMenuItems().every(i => i.actor.visible));

        ind.menu.close();
        await sleep(300);

        // --- select a cached image: bytes read from disk -------------------
        const oldImage = ind._history.filter(e => e.isImage() && e !== img).at(0);
        if (oldImage) {
            ind._onMenuItemSelectedAndMenuClose(ind._menuItems.get(oldImage), true);
            await sleep(1500);
            const bytes = await clipboardBytes(oldImage.mimetype());
            const got = bytes?.length;
            this._check('selecting cached image puts it on the clipboard',
                got === oldImage.size() && ind._selectedEntry === oldImage,
                `clip=${got} expected=${oldImage.size()} ` +
                `selectedIsOld=${ind._selectedEntry === oldImage}`);
            this._check('cached image released after selection', !oldImage.hasBytes());
        }

        // --- cycle shortcuts ---------------------------------------------------
        const before = ind._selectedEntry;
        ind._nextEntry();
        await sleep(800);
        const afterNext = ind._selectedEntry;
        ind._previousEntry();
        await sleep(800);
        this._check('next/previous entry cycle', afterNext && afterNext !== before &&
            ind._selectedEntry === before);

        // --- a slow image read must not override a later selection --------
        {
            const image = ind._history.find(e => e.isImage() && !e.hasBytes() && e !== ind._selectedEntry);
            const text = ind._history.find(e => e.isText() && e.getStringValue() === 'ci text A');
            if (!image || !text) {
                log('INFO skipping selection race checks: no cached image to select');
            } else {
            ind._selectEntry(image);   // reads the image from disk
            ind._selectEntry(text);    // set immediately
            await sleep(1500);
            const now = await clipboardText();
            this._check('image read does not override a later text selection',
                now === 'ci text A' && ind._selectedEntry === text, `clipboard=${JSON.stringify(now)}`);
            this._check('superseded image read is released', !image.hasBytes());

            ind._selectEntry(text);
            ind._selectEntry(image);
            await sleep(1500);
            const data = await clipboardBytes(image.mimetype());
            this._check('image selected after text wins',
                data?.length === image.size() && ind._selectedEntry === image,
                `clipboard=${data?.length} expected=${image.size()}`);
            }
        }

        // --- an unresponsive clipboard owner costs one timeout -----------------
        {
            await sleep(1000);
            const real = ind.extension.clipboard;
            const asked = [];
            ind.extension.clipboard = {
                get_content: (type, mimetype, _cb) => asked.push(mimetype),  // never answers
                set_content: (...args) => real.set_content(...args),
                set_text: (...args) => real.set_text(...args),
            };
            const t0 = Date.now();
            await ind._refreshIndicator();
            const elapsed = Date.now() - t0;
            ind.extension.clipboard = real;
            this._check('clipboard read gives up after one timeout',
                asked.length === 1 && elapsed < 7000, `requests=${asked.length} elapsed=${elapsed} ms`);
        }

        // --- pin ---------------------------------------------------------------
        const textEntry = ind._history.find(e => e.isText() && !e.isFavorite() && e.getStringValue() === 'ci text B');
        ind._favoriteToggle(ind._menuItems.get(textEntry));
        this._check('pin moves entry to pinned section', textEntry.isFavorite() &&
            ind.favoritesSection._getMenuItems().includes(ind._menuItems.get(textEntry)));

        // --- unpinning an image applies the image quota at once -------------
        if (seeded) {
            const pinnedImage = ind._history.find(e => e.isImage() && e.isFavorite());
            const unpinned = () => ind._history.filter(e => e.isImage() && !e.isFavorite()).length;
            const limit = unpinned();
            settings.set_int('max-cached-images', limit);
            await sleep(300);
            ind._favoriteToggle(ind._menuItems.get(pinnedImage));
            await sleep(300);
            this._check('unpinning an image enforces the image quota',
                !pinnedImage.isFavorite() && unpinned() === limit, `unpinned=${unpinned()} limit=${limit}`);
            settings.set_int('max-cached-images', 50);
            await sleep(300);

            // Keep one image pinned for the teardown check at the end.
            ind._favoriteToggle(ind._menuItems.get(pinnedImage));
        }

        // --- delete image --------------------------------------------------
        if (gotImage) {
            const file = ind.registry.getEntryFilename(img);
            const thumb = ind.registry.getThumbnailFilename(img);
            ind._removeEntry(img, 'delete');
            await sleep(800);
            this._check('deleting image removes file and thumbnail',
                !ind._history.includes(img) && !ind._menuItems.has(img) &&
                !GLib.file_test(file, GLib.FileTest.EXISTS) && !GLib.file_test(thumb, GLib.FileTest.EXISTS));
        }

        // --- deleting an image while it is still being written ---------------
        {
            const big = makeNoisyPng(1600, 1200, 7);
            const id = String(big.hash());
            const origAdd = ind._addEntry.bind(ind);
            let deletedWhilePending = null;
            ind._addEntry = (entry, ...rest) => {
                origAdd(entry, ...rest);
                // Delete right after it is added, while its write is pending.
                if (entry.isImage() && entry.id() === id) {
                    Promise.resolve().then(() => {
                        deletedWhilePending = !ind.registry.hasEntryFile(entry);
                        ind._removeEntry(entry, 'delete');
                    });
                }
            };
            clipboard.set_content(CLIP, 'image/png', big);
            await waitFor(() => deletedWhilePending !== null, 5000);
            await sleep(3000);
            ind._addEntry = origAdd;
            const leftovers = listDir(ind.registry.REGISTRY_DIR).concat(listDir(ind.registry.THUMBNAIL_DIR))
                .filter(n => n.startsWith(id));
            this._check('image deleted during its write leaves no files',
                deletedWhilePending === true &&
                !ind._history.some(e => e.isImage() && e.id() === id) && leftovers.length === 0,
                `deletedWhilePending=${deletedWhilePending} leftovers=${JSON.stringify(leftovers)}`);
        }

        // --- cancel (undo last copy) -----------------------------------------
        clipboard.set_text(CLIP, 'ci text C');
        await waitFor(() => ind._history.at(-1)?.getStringValue() === 'ci text C', 3000);
        ind._cancelNotification();
        await sleep(300);
        this._check('cancel removes the newest copy',
            !ind._history.some(e => e.getStringValue() === 'ci text C'));

        // --- prune orphan files ----------------------------------------------
        const orphan = `${ind.registry.REGISTRY_DIR}/123456789`;
        GLib.file_set_contents(orphan, 'x');
        const referenced = ind._history.filter(e => e.isImage()).map(e => ind.registry.getEntryFilename(e));
        await ind.registry.pruneOrphanFiles(id => ind._history.some(e => e.isImage() && e.id() === id));
        this._check('prune deletes orphans and keeps referenced files',
            !GLib.file_test(orphan, GLib.FileTest.EXISTS) &&
            referenced.every(p => GLib.file_test(p, GLib.FileTest.EXISTS)),
            `referenced=${referenced.length}`);

        // --- prune leaves temporaries and backup-referenced images alone ----
        {
            const dir = ind.registry.REGISTRY_DIR;
            const temp = `${dir}/.goutputstream-CITEST`;
            const other = `${dir}/notes.txt`;
            const backedUp = `${dir}/987654321`;
            const orphan = `${dir}/123123123`;
            const stalePartial = `${dir}/555555555.partial`;
            for (const p of [temp, other, backedUp, orphan, stalePartial]) GLib.file_set_contents(p, 'x');
            GLib.file_set_contents(ind.registry.BACKUP_REGISTRY_PATH, JSON.stringify([
                { favorite: false, mimetype: 'image/png', contents: '/elsewhere/987654321' },
            ]));
            await ind.registry.pruneOrphanFiles(id => ind._history.some(e => e.isImage() && e.id() === id));
            const exists = p => GLib.file_test(p, GLib.FileTest.EXISTS);
            this._check('prune keeps temporaries, foreign files and backup images',
                exists(temp) && exists(other) && exists(backedUp) && !exists(orphan) && !exists(stalePartial),
                `temp=${exists(temp)} other=${exists(other)} backedUp=${exists(backedUp)} ` +
                `orphan=${exists(orphan)} stalePartial=${exists(stalePartial)}`);

            GLib.file_set_contents(ind.registry.BACKUP_REGISTRY_PATH, '[not json');
            GLib.file_set_contents(orphan, 'x');
            await ind.registry.pruneOrphanFiles(() => false);
            this._check('prune does nothing while the backup is unreadable', exists(orphan) && exists(backedUp));

            for (const p of [temp, other, backedUp, orphan, stalePartial, ind.registry.BACKUP_REGISTRY_PATH])
                GLib.unlink(p);
        }

        // --- registry edge cases, on a separate scratch registry ------------
        {
            const mod = await import(`file://${Main.extensionManager.lookup(UUID).path}/registry.js`);
            const reg = new mod.Registry({ settings, uuid: 'ci-registry-test' });
            const dir = reg.REGISTRY_DIR;
            GLib.mkdir_with_parents(dir, 0o755);
            const exists = p => GLib.file_test(p, GLib.FileTest.EXISTS);
            const write = (name, text) => GLib.file_set_contents(`${dir}/${name}`, text);

            // A record that fails to convert makes the load incomplete and
            // keeps the original registry as the backup.
            write('111', 'x');
            write('222', 'x');
            const original = JSON.stringify([
                { favorite: false, mimetype: 'image/png', contents: `${dir}/111` },
                { favorite: false, mimetype: 1, contents: `${dir}/222` },
            ]);
            write('registry.txt', original);
            // run.sh does not count extension errors logged between these markers.
            log('EXPECTED-ERRORS-BEGIN');
            const { entries, complete } = await reg.read();
            log('EXPECTED-ERRORS-END');
            const [, backup] = GLib.file_get_contents(reg.BACKUP_REGISTRY_PATH);
            this._check('malformed record makes the load incomplete and is backed up',
                !complete && entries.length === 1 && new TextDecoder().decode(backup) === original,
                `complete=${complete} entries=${entries.length}`);
            await reg.pruneOrphanFiles(id => id === '111');
            this._check('image of a malformed record survives pruning', exists(`${dir}/222`));

            // A backup that is not an array disables pruning.
            write('registry.txt~', '"just a string"');
            write('333', 'x');
            await reg.pruneOrphanFiles(() => false);
            this._check('non-array backup disables pruning', exists(`${dir}/333`));

            // A backup over the cache-size limit is not parsed.
            const limit = settings.get_int('cache-size');
            settings.set_int('cache-size', 1);
            write('registry.txt~', JSON.stringify([{ mimetype: 'text/plain', contents: 'y'.repeat(1100 * 1024) }]));
            write('444', 'x');
            await reg.pruneOrphanFiles(() => false);
            settings.set_int('cache-size', limit);
            this._check('oversized backup disables pruning', exists(`${dir}/444`));

            // Copying an image again while its files are being deleted must
            // leave a complete, usable file.
            const png = makePng(300, 200, 0x55aa33ff);
            const first = new mod.ClipboardEntry('image/png', png, false);
            await reg.writeEntryFile(first);
            const deletion = reg.deleteEntryFile(first, () => false);
            const again = new mod.ClipboardEntry('image/png', png, false);
            const rewrite = reg.writeEntryFile(again);
            await Promise.all([deletion, rewrite]);
            this._check('recopy during deletion keeps the image file',
                exists(reg.getEntryFilename(again)) && reg.hasEntryFile(again));

            reg.clearCacheFolder();
            Gio.File.new_for_path(dir).delete(null);
        }

        // --- clear history keeps pins --------------------------------------
        ind._clearHistory();
        await sleep(500);
        this._check('clear history keeps only pinned entries',
            ind._history.length > 0 && ind._history.every(e => e.isFavorite()) &&
            ind._menuItems.size === ind._history.length, `left=${ind._history.length}`);

        // --- registry persisted ------------------------------------------------
        await sleep(500);
        const [, raw] = GLib.file_get_contents(ind.registry.REGISTRY_PATH);
        const reg = JSON.parse(new TextDecoder().decode(raw));
        this._check('registry matches history', reg.length === ind._history.length &&
            reg.filter(r => r.mimetype.startsWith('image/')).every(r => r.id && typeof r.size === 'number'),
            `registry=${reg.length} history=${ind._history.length}`);

        // --- disabling while thumbnails are being made ----------------------
        // Delete the thumbnails and force the labels to be rebuilt, then
        // disable at once. run.sh fails the run on any "already disposed"
        // error logged by the late thumbnail callbacks.
        if (seeded) {
            for (const e of ind._history.filter(e => e.isImage()))
                GLib.unlink(ind.registry.getThumbnailFilename(e));
            settings.set_int('preview-size', settings.get_int('preview-size') + 1);
            log(`INFO disabling with ${ind._history.filter(e => e.isImage()).length} thumbnails pending`);
        }

        // --- disable / enable round trip ---------------------------------------
        const expected = ind._history.map(e => e.getStringValue());
        await Main.extensionManager.disableExtension(UUID);
        await sleep(500);
        await Main.extensionManager.enableExtension(UUID);
        const reloaded = await waitFor(() => this._ind()?._historyLoaded, 5000);
        ind = this._ind();
        // --- preferences window (screenshot for visual check) ---------------
        if (GLib.getenv('CI_SHOT')) {
            Main.extensionManager.openExtensionPrefs(UUID, '', {});
            await sleep(6000);
            const p = GLib.getenv('CI_SHOT').replace(/\.png$/, '-prefs.png');
            const st = Gio.File.new_for_path(p).replace(null, false, Gio.FileCreateFlags.NONE, null);
            const sh = new Shell.Screenshot();
            await new Promise((res, rej) => sh.screenshot(false, st, (s, r) => {
                try { s.screenshot_finish(r); res(); } catch (e) { rej(e); }
            }));
            st.close(null);
            const wins = global.get_window_actors().map(a => a.meta_window.get_title());
            log(`INFO prefs screenshot ${p} windows=${JSON.stringify(wins)}`);
        }

        this._check('re-enable reloads the same history', reloaded &&
            JSON.stringify(ind._history.map(e => e.getStringValue())) === JSON.stringify(expected),
            `len=${ind?._history.length} expected=${expected.length}`);
    }
}
