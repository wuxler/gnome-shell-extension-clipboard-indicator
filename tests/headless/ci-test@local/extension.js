// Test driver for the clipboard-indicator fork. Runs once after shell
// startup inside an isolated headless session (see ../run.sh) and logs
// one "CI-TEST PASS|FAIL <name>" line per check, then "CI-TEST END ...".
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
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

        // --- pin ---------------------------------------------------------------
        const textEntry = ind._history.find(e => e.isText() && !e.isFavorite() && e.getStringValue() === 'ci text B');
        ind._favoriteToggle(ind._menuItems.get(textEntry));
        this._check('pin moves entry to pinned section', textEntry.isFavorite() &&
            ind.favoritesSection._getMenuItems().includes(ind._menuItems.get(textEntry)));

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
