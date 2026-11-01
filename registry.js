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

/** Suffix of files being written; see writeFileAtomically(). */
const PARTIAL_SUFFIX = '.partial';

/**
 * Writes `bytes` to `path` so that `path` only ever holds complete data.
 *
 * Gio's replace creates a missing target directly and writes into it, so
 * the final name would be visible (and look valid) while still being
 * written, and would stay truncated after a crash. Writing to
 * `<path>.partial` and renaming afterwards avoids both.
 *
 * @param {string} path
 * @param {GLib.Bytes} bytes
 */
async function writeFileAtomically (path, bytes) {
    const partial = Gio.file_new_for_path(path + PARTIAL_SUFFIX);
    await callAsync(partial, 'replace_contents_bytes_async',
        (f, res) => f.replace_contents_finish(res),
        bytes, null, false, Gio.FileCreateFlags.NONE, null);
    partial.move(Gio.file_new_for_path(path), FileCopyFlags.OVERWRITE, null, null);
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
    #pendingDeletes = new Map();
    #thumbnailQueue = [];
    #runningThumbnails = 0;
    #nextRegistry = null;
    #registryWriting = null;

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

    /**
     * Writes the registry. Writes are serialized and coalesced: while one is
     * in progress, only the most recent content is kept and written next,
     * so an older snapshot can never land after a newer one.
     */
    writeToFile (registry) {
        this.#nextRegistry = new GLib.Bytes(JSON.stringify(registry));
        if (this.#registryWriting) return;

        this.#registryWriting = (async () => {
            GLib.mkdir_with_parents(this.REGISTRY_DIR, parseInt('0775', 8));
            while (this.#nextRegistry) {
                const contents = this.#nextRegistry;
                this.#nextRegistry = null;
                try {
                    await writeFileAtomically(this.REGISTRY_PATH, contents);
                }
                catch (e) {
                    console.error('Clipboard Indicator: failed to write registry');
                    console.error(e);
                }
            }
        })().finally(() => {
            this.#registryWriting = null;
        });
    }

    /**
     * Reads the history from disk.
     *
     * Only metadata is read for image entries; their bytes stay on disk until
     * an entry is actually put on the clipboard. Entries whose image file is
     * missing are dropped.
     *
     * An oversized or unparsable registry is moved to `registry.txt~` and
     * the history starts empty. Its image files are kept: pruneOrphanFiles()
     * treats images referenced by the backup as in use.
     *
     * @returns {Promise<{entries: ClipboardEntry[], complete: boolean}>}
     *   entries oldest first; `complete` is false if the registry could not
     *   be loaded, in which case callers must not treat cached files as
     *   unreferenced
     */
    async read () {
        if (!GLib.file_test(this.REGISTRY_PATH, FileTest.EXISTS)) {
            return { entries: [], complete: true };
        }

        const file = Gio.file_new_for_path(this.REGISTRY_PATH);
        const maxRegistryBytes = this.settings.get_int(PrefsFields.CACHE_FILE_SIZE) * 1024 * 1024;
        const moveAside = () => file.move(Gio.file_new_for_path(this.BACKUP_REGISTRY_PATH),
            FileCopyFlags.OVERWRITE, null, null);

        let registry;
        try {
            const info = await callAsync(file, 'query_info_async',
                (f, res) => f.query_info_finish(res),
                'standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);

            // An oversized registry is moved aside instead of being parsed.
            if (info.get_size() >= maxRegistryBytes) {
                moveAside();
                return { entries: [], complete: false };
            }

            const contents = await loadFileContents(file);
            const text = new TextDecoder().decode(contents);
            registry = text.trim().length === 0 ? [] : JSON.parse(text);
            if (!Array.isArray(registry)) throw new Error('registry is not an array');
        }
        catch (e) {
            console.error('Clipboard Indicator: failed to read registry, moved it to ' +
                this.BACKUP_REGISTRY_PATH);
            console.error(e);
            // Keep the unreadable file: the next write would overwrite it.
            try {
                moveAside();
            }
            catch (moveError) {
                console.error(moveError);
            }
            return { entries: [], complete: false };
        }

        const entries = [];
        let malformed = 0;
        for (const jsonEntry of registry) {
            try {
                const entry = ClipboardEntry.fromJSON(jsonEntry, this.REGISTRY_DIR);
                if (entry) entries.push(entry);
            }
            catch (e) {
                malformed++;
                console.error('Clipboard Indicator: skipping malformed registry entry');
                console.error(e);
            }
        }

        if (malformed > 0) {
            // The next write would drop the skipped entries for good, and
            // their images must not look unreferenced. Keep a copy of the
            // original as the backup (which pruning honours) and report the
            // load as incomplete.
            try {
                file.copy(Gio.file_new_for_path(this.BACKUP_REGISTRY_PATH),
                    FileCopyFlags.OVERWRITE, null, null);
            }
            catch (e) {
                console.error(e);
            }
            return { entries, complete: false };
        }
        return { entries, complete: true };
    }

    /**
     * @returns {Set<string>|null} image ids referenced by the backup
     *   registry, an empty set if there is none, or null if it exists but is
     *   too large, unparsable or not an array (then nothing may be pruned)
     */
    #backupImageIds () {
        if (!GLib.file_test(this.BACKUP_REGISTRY_PATH, FileTest.EXISTS)) return new Set();

        try {
            // The backup is often the registry that read() refused for being
            // too large; parsing it here would defeat that limit.
            const maxBytes = this.settings.get_int(PrefsFields.CACHE_FILE_SIZE) * 1024 * 1024;
            const size = Gio.file_new_for_path(this.BACKUP_REGISTRY_PATH)
                .query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
            if (size >= maxBytes) return null;

            const [, contents] = GLib.file_get_contents(this.BACKUP_REGISTRY_PATH);
            const backup = JSON.parse(new TextDecoder().decode(contents));
            if (!Array.isArray(backup)) return null;

            // Deliberately conservative: any record whose id or contents
            // basename looks like an image id protects that id, whatever its
            // mimetype says. Protecting too much only delays cleanup.
            const ids = new Set();
            for (const item of backup) {
                if (item === null || typeof item !== 'object') continue;
                for (const candidate of [item.id, typeof item.contents === 'string'
                    ? GLib.path_get_basename(item.contents) : null]) {
                    if (candidate !== undefined && candidate !== null && /^\d+$/.test(String(candidate)))
                        ids.add(String(candidate));
                }
            }
            return ids;
        }
        catch (e) {
            return null;
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
        const id = entry.id();
        if (this.#pendingThumbnails.has(id)) return this.#pendingThumbnails.get(id);

        // As in writeEntryFile, a thumbnail being deleted is recreated
        // once the deletion finished.
        const deleting = this.#pendingDeletes.get(id);
        if (!deleting && GLib.file_test(path, FileTest.EXISTS)) return Promise.resolve(path);

        const job = (async () => {
            if (deleting) await deleting;
            if (GLib.file_test(path, FileTest.EXISTS)) return path;
            return this.#throttled(() => this.#createThumbnail(entry, path));
        })()
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

        // Encode to memory, then write atomically, so a half-written
        // thumbnail is never picked up.
        const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
        if (!ok) throw new Error('could not encode thumbnail');
        await writeFileAtomically(path, new GLib.Bytes(buffer));
        return path;
    }

    /**
     * @returns {boolean} whether the entry's image is completely persisted
     *   on disk, i.e. its in-memory bytes may be released
     */
    hasEntryFile (entry) {
        const id = entry.id();
        return !this.#pendingWrites.has(id) && !this.#pendingDeletes.has(id) &&
            this.#entryFileExists(entry);
    }

    /**
     * Persists an image entry's bytes. Concurrent calls for the same entry
     * share one write.
     */
    writeEntryFile (entry) {
        // Checked first: a write in progress must be awaited, not skipped.
        const id = entry.id();
        if (this.#pendingWrites.has(id)) return this.#pendingWrites.get(id);

        // A file that is being deleted does not count as existing: the
        // write waits for the deletion and then recreates it.
        const deleting = this.#pendingDeletes.get(id);
        if (!entry.hasBytes()) return deleting ?? Promise.resolve();
        if (!deleting && this.#entryFileExists(entry)) return Promise.resolve();

        const bytes = entry.asBytes();
        const job = (async () => {
            if (deleting) await deleting;
            GLib.mkdir_with_parents(this.REGISTRY_DIR, parseInt('0775', 8));
            await writeFileAtomically(this.getEntryFilename(entry), bytes);
        })()
            .catch(e => {
                console.error('Clipboard Indicator: failed to cache image');
                console.error(e);
            })
            .finally(() => this.#pendingWrites.delete(id));
        this.#pendingWrites.set(id, job);
        return job;
    }

    /**
     * Deletes an image entry's cached file and thumbnail.
     *
     * Waits for pending writes and thumbnail jobs of the same id first;
     * otherwise a job finishing after the delete would recreate the files as
     * orphans. If the same image was copied again while waiting, nothing is
     * deleted.
     *
     * @param {ClipboardEntry} entry
     * @param {function(string): boolean} [isReferenced] called with the
     *   image id after pending jobs finished; return true to keep the files
     */
    async deleteEntryFile (entry, isReferenced = () => false) {
        const id = entry.id();
        for (;;) {
            const pending = [this.#pendingWrites.get(id), this.#pendingThumbnails.get(id),
                this.#pendingDeletes.get(id)].filter(job => job !== undefined);
            if (pending.length === 0) break;
            await Promise.allSettled(pending);
        }
        if (isReferenced(id)) return;

        // Registered synchronously after the last check, so a write or
        // thumbnail job for the same image started from here on waits for
        // the deletion and then recreates the files (see writeEntryFile).
        const job = (async () => {
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
        })().finally(() => this.#pendingDeletes.delete(id));
        this.#pendingDeletes.set(id, job);
        await job;
    }

    /**
     * Deletes cached image files and thumbnails that no entry references,
     * e.g. left behind by an interrupted write or an older version.
     *
     * Only names this cache creates are considered: `<id>` image files and
     * `thumbnails/<id>.png`, where an id is a decimal hash, plus stale
     * `*.partial` files of interrupted writes. Anything else,
     * notably the `.goutputstream-*` temporaries of in-flight replace_async
     * writes, is left alone. Images referenced by the backup registry count
     * as referenced; if the backup cannot be parsed, nothing is deleted.
     *
     * @param {function(string): boolean} isReferenced called for each file
     *   with its image id. It is evaluated per file rather than on a snapshot,
     *   so images copied while the scan runs are not deleted.
     */
    async pruneOrphanFiles (isReferenced) {
        const backupIds = this.#backupImageIds();
        if (backupIds === null) {
            console.warn(`Clipboard Indicator: ${this.BACKUP_REGISTRY_PATH} is unreadable, not pruning the cache`);
            return;
        }

        const isOrphanImage = id => !backupIds.has(id) && !isReferenced(id);

        // Leftovers of interrupted writes, unless that write is running now.
        const isStalePartial = name => {
            if (name === this.REGISTRY_FILE + PARTIAL_SUFFIX) return !this.#registryWriting;
            const image = name.match(/^(\d+)\.partial$/);
            if (image) return !this.#pendingWrites.has(image[1]);
            const thumb = name.match(/^(\d+)\.png\.partial$/);
            if (thumb) return !this.#pendingThumbnails.has(thumb[1]);
            return false;
        };

        const prune = async (dir, shouldDelete) => {
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
                    if (!shouldDelete(name)) continue;
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
            await prune(this.REGISTRY_DIR,
                name => (/^\d+$/.test(name) && isOrphanImage(name)) || isStalePartial(name));
            await prune(this.THUMBNAIL_DIR, name => {
                const id = name.match(/^(\d+)\.png$/)?.[1];
                return (id !== undefined && isOrphanImage(id)) || isStalePartial(name);
            });
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
