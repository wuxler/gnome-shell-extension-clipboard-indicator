import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import St from 'gi://St';
import { PrefsFields } from './constants.js';

const FileCopyFlags = Gio.FileCopyFlags;
const FileTest = GLib.FileTest;

/** Longest side of generated thumbnails, in pixels. */
const THUMBNAIL_SIZE = 128;
const THUMBNAIL_DIR = 'thumbnails';
/**
 * Thumbnails decoded at the same time. The first menu open after upgrading
 * may need thumbnails for every cached image; decoding them all at once
 * would saturate the CPU.
 */
const MAX_CONCURRENT_THUMBNAILS = 2;

/**
 * Promise wrapper for a Gio-style `*_async` / `*_finish` pair.
 *
 * Extensions cannot rely on which Gio methods GNOME Shell has promisified,
 * so the callbacks are wrapped explicitly.
 */
function callAsync (obj, method, finish, ...args) {
    return new Promise((resolve, reject) => {
        obj[method](...args, (source, res) => {
            try {
                resolve(finish(source, res));
            }
            catch (e) {
                reject(e);
            }
        });
    });
}

function loadFileContents (file) {
    return callAsync(file, 'load_contents_async',
        (f, res) => f.load_contents_finish(res)[1], null);
}

async function writeFileContents (file, bytes) {
    const stream = await callAsync(file, 'replace_async',
        (f, res) => f.replace_finish(res),
        null, false, Gio.FileCreateFlags.NONE, GLib.PRIORITY_LOW, null);
    await callAsync(stream, 'write_bytes_async',
        (s, res) => s.write_bytes_finish(res),
        bytes, GLib.PRIORITY_LOW, null);
    await callAsync(stream, 'close_async',
        (s, res) => s.close_finish(res),
        GLib.PRIORITY_LOW, null);
}

/**
 * Stores clipboard history on disk.
 *
 * Layout of the cache directory (`$XDG_CACHE_HOME/<uuid>/`):
 * - `registry.txt`: JSON array of entries, oldest first. Text entries hold
 *   their contents inline; image entries reference a file in this directory.
 * - `<id>`: one file per cached image, named after the image id.
 * - `thumbnails/<id>.png`: downscaled previews used by the menu.
 *
 * Reading the registry never loads image data, so its cost does not grow
 * with the size of the cached images.
 */
export class Registry {
    #pendingThumbnails = new Map();
    #pendingWrites = new Map();
    #thumbnailQueue = [];
    #runningThumbnails = 0;

    constructor ({ settings, uuid }) {
        this.uuid = uuid;
        this.settings = settings;
        this.REGISTRY_FILE = 'registry.txt';
        this.REGISTRY_DIR = GLib.get_user_cache_dir() + '/' + this.uuid;
        this.REGISTRY_PATH = this.REGISTRY_DIR + '/' + this.REGISTRY_FILE;
        this.BACKUP_REGISTRY_PATH = this.REGISTRY_PATH + '~';
        this.THUMBNAIL_DIR = this.REGISTRY_DIR + '/' + THUMBNAIL_DIR;
    }

    write (entries) {
        const registryContent = [];

        for (let entry of entries) {
            const item = {
                favorite: entry.isFavorite(),
                mimetype: entry.mimetype()
            };

            registryContent.push(item);

            if (entry.isText()) {
                item.contents = entry.getStringValue();
            }
            else if (entry.isImage()) {
                item.contents = this.getEntryFilename(entry);
                item.id = entry.id();
                item.size = entry.size();
                if (entry.hasBytes()) this.writeEntryFile(entry);
            }

            if (entry.getTag()) item.tag = entry.getTag();
        }

        this.writeToFile(registryContent);
    }

    writeToFile (registry) {
        const contents = new GLib.Bytes(JSON.stringify(registry));

        GLib.mkdir_with_parents(this.REGISTRY_DIR, parseInt('0775', 8));

        const file = Gio.file_new_for_path(this.REGISTRY_PATH);
        writeFileContents(file, contents).catch(e => {
            console.error('Clipboard Indicator: failed to write registry');
            console.error(e);
        });
    }

    /**
     * Reads the history from disk.
     *
     * Only metadata is read for image entries; their bytes stay on disk until
     * an entry is actually put on the clipboard. Entries whose image file is
     * missing are dropped.
     *
     * @returns {Promise<ClipboardEntry[]>} entries, oldest first
     */
    async read () {
        if (!GLib.file_test(this.REGISTRY_PATH, FileTest.EXISTS)) return [];

        const file = Gio.file_new_for_path(this.REGISTRY_PATH);
        const maxRegistryBytes = this.settings.get_int(PrefsFields.CACHE_FILE_SIZE) * 1024 * 1024;

        try {
            const info = await callAsync(file, 'query_info_async',
                (f, res) => f.query_info_finish(res),
                'standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);

            // An oversized registry is moved aside instead of being parsed.
            if (info.get_size() >= maxRegistryBytes) {
                file.move(Gio.file_new_for_path(this.BACKUP_REGISTRY_PATH),
                    FileCopyFlags.OVERWRITE, null, null);
                return [];
            }

            const contents = await loadFileContents(file);
            const text = new TextDecoder().decode(contents);
            const registry = text.trim().length === 0 ? [] : JSON.parse(text);

            return registry
                .map(jsonEntry => ClipboardEntry.fromJSON(jsonEntry, this.REGISTRY_DIR))
                .filter(entry => entry !== null);
        }
        catch (e) {
            console.error('Clipboard Indicator: failed to read registry');
            console.error(e);
            return [];
        }
    }

    getEntryFilename (entry) {
        return `${this.REGISTRY_DIR}/${entry.id()}`;
    }

    getThumbnailFilename (entry) {
        return `${this.THUMBNAIL_DIR}/${entry.id()}.png`;
    }

    #entryFileExists (entry) {
        return GLib.file_test(this.getEntryFilename(entry), FileTest.EXISTS);
    }

    /**
     * Makes sure the entry's bytes are in memory, reading the cached image
     * file if needed.
     *
     * @param {ClipboardEntry} entry
     */
    async loadEntryBytes (entry) {
        if (entry.hasBytes()) return;

        const contents = await loadFileContents(
            Gio.file_new_for_path(this.getEntryFilename(entry)));
        entry.setBytes(contents);
    }

    /** @returns {boolean} whether the entry's thumbnail is already on disk */
    hasThumbnail (entry) {
        return GLib.file_test(this.getThumbnailFilename(entry), FileTest.EXISTS);
    }

    /**
     * @returns {Promise<St.Icon|null>} a small preview icon for an image entry.
     *   Falls back to a generic image icon if no thumbnail can be made.
     */
    async getEntryAsImage (entry) {
        if (entry.isImage() === false) return null;

        let gicon;
        try {
            const path = await this.ensureThumbnail(entry);
            gicon = Gio.FileIcon.new(Gio.file_new_for_path(path));
        }
        catch (e) {
            console.error(`Clipboard Indicator: no thumbnail for image ${entry.id()}`);
            console.error(e);
            gicon = Gio.ThemedIcon.new('image-x-generic-symbolic');
        }

        return new St.Icon({ gicon });
    }

    /** @returns {Promise<Clutter.Actor|null>} the full-size image, loaded off the main thread. */
    async getEntryAsTexture (entry) {
        if (entry.isImage() === false) return null;

        if (this.#entryFileExists(entry) === false) {
            await this.writeEntryFile(entry);
        }

        const file = Gio.file_new_for_path(this.getEntryFilename(entry));
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return St.TextureCache.get_default().load_file_async(file, -1, -1, scaleFactor, 1.0);
    }

    /**
     * Creates the thumbnail for an image entry unless it already exists.
     *
     * Decoding runs in a GdkPixbuf worker thread. Concurrent calls for the
     * same entry share one job.
     *
     * @returns {Promise<string>} path of the thumbnail
     */
    ensureThumbnail (entry) {
        const path = this.getThumbnailFilename(entry);
        if (GLib.file_test(path, FileTest.EXISTS)) return Promise.resolve(path);

        const id = entry.id();
        if (this.#pendingThumbnails.has(id)) return this.#pendingThumbnails.get(id);

        const job = this.#throttled(() => this.#createThumbnail(entry, path))
            .finally(() => this.#pendingThumbnails.delete(id));
        this.#pendingThumbnails.set(id, job);
        return job;
    }

    /** Runs `task` once fewer than MAX_CONCURRENT_THUMBNAILS are running. */
    #throttled (task) {
        return new Promise((resolve, reject) => {
            this.#thumbnailQueue.push({ task, resolve, reject });
            this.#drainThumbnailQueue();
        });
    }

    #drainThumbnailQueue () {
        while (this.#runningThumbnails < MAX_CONCURRENT_THUMBNAILS && this.#thumbnailQueue.length > 0) {
            const { task, resolve, reject } = this.#thumbnailQueue.shift();
            this.#runningThumbnails++;
            task().then(resolve, reject).finally(() => {
                this.#runningThumbnails--;
                this.#drainThumbnailQueue();
            });
        }
    }

    async #createThumbnail (entry, path) {
        let stream;
        if (entry.hasBytes()) {
            stream = Gio.MemoryInputStream.new_from_bytes(entry.asBytes());
        }
        else {
            const file = Gio.file_new_for_path(this.getEntryFilename(entry));
            stream = await callAsync(file, 'read_async',
                (f, res) => f.read_finish(res), GLib.PRIORITY_LOW, null);
        }

        const pixbuf = await callAsync(GdkPixbuf.Pixbuf, 'new_from_stream_at_scale_async',
            (_s, res) => GdkPixbuf.Pixbuf.new_from_stream_finish(res),
            stream, THUMBNAIL_SIZE, THUMBNAIL_SIZE, true, null);
        stream.close(null);

        GLib.mkdir_with_parents(this.THUMBNAIL_DIR, parseInt('0775', 8));

        // Encode to memory first, then write atomically through replace_async,
        // so a half-written thumbnail is never picked up.
        const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
        if (!ok) throw new Error('could not encode thumbnail');
        await writeFileContents(Gio.file_new_for_path(path), new GLib.Bytes(buffer));
        return path;
    }

    /** @returns {boolean} whether the entry's image is persisted on disk */
    hasEntryFile (entry) {
        return this.#entryFileExists(entry);
    }

    /**
     * Persists an image entry's bytes. Concurrent calls for the same entry
     * share one write.
     */
    writeEntryFile (entry) {
        if (this.#entryFileExists(entry) || !entry.hasBytes()) return Promise.resolve();

        const id = entry.id();
        if (this.#pendingWrites.has(id)) return this.#pendingWrites.get(id);

        GLib.mkdir_with_parents(this.REGISTRY_DIR, parseInt('0775', 8));
        const job = writeFileContents(
            Gio.file_new_for_path(this.getEntryFilename(entry)), entry.asBytes())
            .catch(e => {
                console.error('Clipboard Indicator: failed to cache image');
                console.error(e);
            })
            .finally(() => this.#pendingWrites.delete(id));
        this.#pendingWrites.set(id, job);
        return job;
    }

    async deleteEntryFile (entry) {
        for (const path of [this.getEntryFilename(entry), this.getThumbnailFilename(entry)]) {
            if (!GLib.file_test(path, FileTest.EXISTS)) continue;
            try {
                await callAsync(Gio.file_new_for_path(path), 'delete_async',
                    (f, res) => f.delete_finish(res), GLib.PRIORITY_LOW, null);
            }
            catch (e) {
                console.error(e);
            }
        }
    }

    /**
     * Deletes cached image files and thumbnails that no entry references,
     * e.g. left behind by an interrupted write or an older version.
     *
     * @param {function(string): boolean} isReferenced called for each file
     *   with its image id. It is evaluated per file rather than on a snapshot,
     *   so images copied while the scan runs are not deleted.
     */
    async pruneOrphanFiles (isReferenced) {
        const keep = new Set([this.REGISTRY_FILE, this.REGISTRY_FILE + '~', THUMBNAIL_DIR]);

        const prune = async (dir, idOf) => {
            const folder = Gio.file_new_for_path(dir);
            if (!GLib.file_test(dir, FileTest.IS_DIR)) return;

            const enumerator = await callAsync(folder, 'enumerate_children_async',
                (f, res) => f.enumerate_children_finish(res),
                'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_LOW, null);

            for (;;) {
                const infos = await callAsync(enumerator, 'next_files_async',
                    (en, res) => en.next_files_finish(res), 64, GLib.PRIORITY_LOW, null);
                if (infos.length === 0) break;

                for (const info of infos) {
                    const name = info.get_name();
                    if (keep.has(name) || isReferenced(idOf(name))) continue;
                    try {
                        await callAsync(folder.get_child(name), 'delete_async',
                            (f, res) => f.delete_finish(res), GLib.PRIORITY_LOW, null);
                    }
                    catch (e) {
                        console.error(e);
                    }
                }
            }
            enumerator.close(null);
        };

        try {
            await prune(this.REGISTRY_DIR, name => name);
            await prune(this.THUMBNAIL_DIR, name => name.replace(/\.png$/, ''));
        }
        catch (e) {
            console.error('Clipboard Indicator: failed to prune cache');
            console.error(e);
        }
    }

    clearCacheFolder() {
        const CANCELLABLE = null;
        const clear = path => {
            const folder = Gio.file_new_for_path(path);
            const enumerator = folder.enumerate_children('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, CANCELLABLE);

            let info;
            while ((info = enumerator.next_file(CANCELLABLE)) !== null) {
                const child = folder.get_child(info.get_name());
                if (info.get_file_type() === Gio.FileType.DIRECTORY) clear(child.get_path());
                child.delete(CANCELLABLE);
            }
        };

        try {
            if (GLib.file_test(this.REGISTRY_DIR, FileTest.IS_DIR)) clear(this.REGISTRY_DIR);
        }
        catch (e) {
            console.error(e);
        }
    }
}

/**
 * One clipboard history item.
 *
 * Text entries keep their contents in memory. Image entries are identified
 * by `id()` (the decimal `GLib.Bytes.hash()` of the image, which is also the
 * cache file name) and hold their bytes only transiently: right after being
 * copied, or while being put back on the clipboard. Call
 * `Registry.loadEntryBytes()` before `asBytes()` on an image entry.
 */
export class ClipboardEntry {
    #mimetype;
    #bytes;
    #favorite;
    #id = null;
    #size = 0;
    #tag = null;

    static __isText (mimetype) {
        return mimetype.startsWith('text/') ||
            mimetype === 'STRING' ||
            mimetype === 'UTF8_STRING';
    }

    /**
     * @param {object} jsonEntry one element of registry.txt
     * @param {string} registryDir directory holding the cached image files
     * @returns {ClipboardEntry|null} null if the entry's image file is gone
     */
    static fromJSON (jsonEntry, registryDir) {
        const mimetype = jsonEntry.mimetype || 'text/plain;charset=utf-8';
        const favorite = !!jsonEntry.favorite;
        let entry;

        if (ClipboardEntry.__isText(mimetype)) {
            entry = new ClipboardEntry(mimetype, new TextEncoder().encode(jsonEntry.contents), favorite);
        }
        else {
            // Registries written by upstream versions only have `contents`,
            // an absolute path whose basename is the image hash. Resolve it
            // against the current directory so a moved cache still works.
            const id = jsonEntry.id ?? GLib.path_get_basename(jsonEntry.contents ?? '');
            const path = `${registryDir}/${id}`;
            if (!id || !GLib.file_test(path, FileTest.EXISTS)) return null;

            let size = jsonEntry.size;
            if (typeof size !== 'number') {
                // Older registries have no size; a stat is cheap compared to reading the file.
                size = Gio.file_new_for_path(path)
                    .query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null)
                    .get_size();
            }

            entry = ClipboardEntry.forImage(mimetype, String(id), size, favorite);
        }

        if (jsonEntry.tag) entry.setTag(jsonEntry.tag);
        return entry;
    }

    /** Creates an image entry whose bytes are still on disk. */
    static forImage (mimetype, id, size, favorite) {
        const entry = new ClipboardEntry(mimetype, null, favorite);
        entry.#id = id;
        entry.#size = size;
        return entry;
    }

    /**
     * @param {string} mimetype
     * @param {Uint8Array|null} bytes
     * @param {boolean} favorite
     */
    constructor (mimetype, bytes, favorite) {
        this.#mimetype = mimetype;
        this.#favorite = !!favorite;
        if (bytes) this.setBytes(bytes);
    }

    /**
     * Identifier of an image entry, stable across sessions. Matches the
     * `GLib.Bytes.hash()` based file names used by upstream versions.
     */
    id () {
        return this.#id;
    }

    /** Size of the entry's data in bytes. */
    size () {
        return this.#size;
    }

    hasBytes () {
        return this.#bytes !== null && this.#bytes !== undefined;
    }

    /** @param {GLib.Bytes|Uint8Array} bytes */
    setBytes (bytes) {
        let hash = null;
        if (bytes instanceof GLib.Bytes) {
            if (this.isImage() && this.#id === null) hash = bytes.hash();
            bytes = bytes.get_data() ?? new Uint8Array();
        }
        this.#bytes = bytes;
        this.#size = bytes.length;
        if (this.isImage() && this.#id === null) {
            this.#id = String(hash ?? GLib.Bytes.new(bytes).hash());
        }
    }

    /** Drops the in-memory copy of an image; it can be reloaded from disk. */
    releaseBytes () {
        if (this.isImage()) this.#bytes = null;
    }

    getStringValue () {
        if (this.isImage()) {
            return `[Image ${this.#id}]`;
        }
        return new TextDecoder().decode(this.#bytes);
    }

    mimetype () {
        return this.#mimetype;
    }

    isFavorite () {
        return this.#favorite;
    }

    set favorite (val) {
        this.#favorite = !!val;
    }

    isText () {
        return ClipboardEntry.__isText(this.#mimetype);
    }

    isImage () {
        return this.#mimetype.startsWith('image/');
    }

    setText (text) {
        if (!this.isText()) return;
        this.setBytes(new TextEncoder().encode(text));
    }

    getTag () {
        return this.#tag;
    }

    setTag (tag) {
        this.#tag = tag || null;
    }

    asBytes () {
        if (!this.hasBytes()) {
            throw new Error(`Clipboard Indicator: bytes of image ${this.#id} are not loaded`);
        }
        return GLib.Bytes.new(this.#bytes);
    }

    equals (otherEntry) {
        return this.getStringValue() === otherEntry.getStringValue();
    }
}
