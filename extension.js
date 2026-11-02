import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AnimationUtils from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Registry, ClipboardEntry } from './registry.js';
import { DialogManager } from './confirmDialog.js';
import { PrefsFields } from './constants.js';
import { Keyboard } from './keyboard.js';

const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

const INDICATOR_ICON = 'edit-paste-symbolic';

// Menu items are created lazily on first open, this many per main loop
// iteration, so a long history never blocks the shell for long.
const MENU_BATCH_SIZE = 40;
// Delay before scanning the cache directory for unreferenced files.
const PRUNE_DELAY_MS = 30 * 1000;
// Give up on a clipboard owner that does not deliver its data in time.
const CLIPBOARD_READ_TIMEOUT_MS = 5 * 1000;
const CLIPBOARD_READ_TIMED_OUT = Symbol('clipboard read timed out');

let DELAYED_SELECTION_TIMEOUT = 750;
let MAX_REGISTRY_LENGTH       = 15;
let MAX_CACHED_IMAGES         = 50;
let MAX_IMAGE_CACHE_SIZE      = 100;
let MAX_ENTRY_LENGTH          = 50;
let CACHE_ONLY_FAVORITE       = false;
let DELETE_ENABLED            = true;
let MOVE_ITEM_FIRST           = false;
let ENABLE_KEYBINDING         = true;
let PRIVATEMODE               = false;
let NOTIFY_ON_COPY            = true;
let NOTIFY_ON_CYCLE           = true;
let NOTIFY_ON_CLEAR           = true;
let CONFIRM_ON_CLEAR          = true;
let CONFIRM_ON_PINNED_DELETE  = false;
let MAX_TOPBAR_LENGTH         = 15;
let TOPBAR_DISPLAY_MODE       = 1; //0 - only icon, 1 - only clipboard content, 2 - both, 3 - neither
let CLEAR_ON_BOOT             = false;
let PASTE_ON_SELECT           = false;
let DISABLE_DOWN_ARROW        = false;
let BLINK_ICON_ON_COPY        = false;
let STRIP_TEXT                = false;
let KEEP_SELECTED_ON_CLEAR    = false;
let PASTE_BUTTON              = true;
let PINNED_ON_BOTTOM          = false;
let CACHE_IMAGES              = true;
let EXCLUDED_APPS             = [];
let CLEAR_HISTORY_ON_INTERVAL = false;
let CLEAR_HISTORY_INTERVAL    = 60;
let NEXT_HISTORY_CLEAR        = -1;
let CASE_SENSITIVE_SEARCH     = false;
let REGEX_SEARCH              = false;
let OPEN_AT_CURSOR            = false;
let SHOW_SEARCH_BAR           = true;
let SHOW_PRIVATE_MODE         = true;
let SHOW_SETTINGS_BUTTON      = true;
let SHOW_CLEAR_HISTORY_BUTTON = true;
let SHOW_DELETE_BUTTON        = true;
let SHOW_TAG_BUTTON           = true;
let SHOW_PIN_BUTTON           = true;
let SHOW_EDIT_BUTTON          = true;
let SHOW_PREVIEW_BUTTON       = true;

/**
 * Creates a colour for Clutter properties from components in [0, 1].
 *
 * GNOME 46 (Clutter 14) only accepts Clutter.Color; GNOME 47 removed
 * Clutter.Color in favour of Cogl.Color.
 */
function makeColor (red, green, blue, alpha) {
    if (Clutter.Color) {
        return new Clutter.Color({
            red: Math.round(red * 255),
            green: Math.round(green * 255),
            blue: Math.round(blue * 255),
            alpha: Math.round(alpha * 255),
        });
    }
    const color = new Cogl.Color();
    color.init_from_4f(red, green, blue, alpha);
    return color;
}

export default class ClipboardIndicatorExtension extends Extension {
    enable () {
        this.clipboardIndicator = new ClipboardIndicator({
            clipboard: St.Clipboard.get_default(),
            settings: this.getSettings(),
            openSettings: this.openPreferences,
            uuid: this.uuid,
            path: this.path
        });

        Main.panel.addToStatusArea('clipboardIndicator', this.clipboardIndicator, 1);
    }

    disable () {
        this.clipboardIndicator.destroy();
        this.clipboardIndicator = null;
        EXCLUDED_APPS = [];
    }
}

// The GType name must differ from upstream's 'ClipboardIndicator': GTypes
// cannot be unregistered, so if upstream was loaded earlier in the same
// shell process, registering the same name again would fail.
const ClipboardIndicator = GObject.registerClass({
    GTypeName: 'ClipboardIndicatorLazyFork'
}, class ClipboardIndicator extends PanelMenu.Button {
    #refreshInProgress = false;
    #refreshPending = false;
    #clipboardRequest = 0;
    #_imagePreviewOverlay = null;

    destroy () {
        this._destroyed = true;
        if (this._startupCompleteId) {
            Main.layoutManager.disconnect(this._startupCompleteId);
            this._startupCompleteId = 0;
        }
        if (this._populateSourceId) {
            GLib.source_remove(this._populateSourceId);
            this._populateSourceId = 0;
        }
        if (this._pruneTimeoutId) {
            clearTimeout(this._pruneTimeoutId);
            this._pruneTimeoutId = null;
        }
        this._disconnectSettings();
        this._unbindShortcuts();
        this._disconnectSelectionListener();
        this._clearDelayedSelectionTimeout();
        this.#clearTimeouts();
        this.#closeImagePreview();
        this._removeHistoryLabel();
        this._destroyNotifSource();
        this.dialogManager.destroy();
        this.keyboard.destroy();
        this._cursorActor.destroy();
        this._cursorActor = null;

        // The menu items are destroyed with the menu below.
        this._menuItems.clear();

        super.destroy();
    }

    _init (extension) {
        super._init(0.0, "ClipboardIndicator");

        this._cursorActor = new Clutter.Actor({ opacity: 0, width: 1, height: 1 });
        Main.uiGroup.add_child(this._cursorActor);

        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (!isOpen)
                this.menu.sourceActor = this;
        });

        this.extension = extension;
        this._destroyed = false;
        this.registry = new Registry(extension);
        this.keyboard = new Keyboard();
        this._settingsChangedId = null;
        this._selectionOwnerChangedId = null;
        this._historyLabel = null;
        this._buttonText = null;
        this._disableDownArrow = null;

        this._shortcutsBindingIds = [];

        // The history is the single source of truth: entries, oldest first.
        // Menu items exist only for entries that have been rendered, which
        // happens the first time the menu is opened (see #populateMenu).
        this._history = [];
        this._menuItems = new Map();      // ClipboardEntry -> PopupMenuItem
        this._selectedEntry = null;
        this._historyLoaded = false;
        this._menuState = 'empty';        // 'empty' | 'populating' | 'ready'
        this._removedWhilePopulating = new Set();

        let hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box clipboard-indicator-hbox'
        });

        this.hbox = hbox;

        this.icon = new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon'
        });

        this._buttonText = new St.Label({
            text: _('Text will be here'),
            y_align: Clutter.ActorAlign.CENTER
        });

        this._buttonImgPreview = new St.Bin({
            style_class: 'clipboard-indicator-topbar-preview'
        });

        hbox.add_child(this.icon);
        hbox.add_child(this._buttonText);
        hbox.add_child(this._buttonImgPreview);
        this._downArrow = PopupMenu.arrowIcon(St.Side.BOTTOM);
        hbox.add_child(this._downArrow);
        this.add_child(hbox);
        this._createHistoryLabel();
        this._loadSettings();

        if (CLEAR_ON_BOOT) this.registry.clearCacheFolder();

        this.dialogManager = new DialogManager();
        this._runAfterStartup(() => {
            this._buildMenu().then(() => {
                if (this._destroyed) {
                    return;
                }
                this._updateTopbarLayout();
                this._setupListener();
                this._setupHistoryIntervalClearing();
            });
        });
    }

    /**
     * Runs `callback` once GNOME Shell has finished its startup sequence.
     *
     * Extensions are enabled before the shell emits `startup-complete`, and
     * the shell keeps input grabbed until then. Loading a large history at
     * that point competes with the startup animation on the main thread and
     * can keep the session from ever becoming usable, so the history is
     * loaded only after startup. When the extension is enabled later (e.g.
     * from the Extensions app) the callback runs immediately.
     *
     * NOTE: `_startingUp` is a private LayoutManager field; there is no
     * public API for this as of GNOME 46. This is a regular method because
     * GJS does not allow `#private` members to be used during `_init` of a
     * GObject class.
     *
     * @param {Function} callback
     */
    _runAfterStartup (callback) {
        if (!Main.layoutManager._startingUp) {
            callback();
            return;
        }

        this._startupCompleteId = Main.layoutManager.connect('startup-complete', () => {
            Main.layoutManager.disconnect(this._startupCompleteId);
            this._startupCompleteId = 0;
            if (!this._destroyed) callback();
        });
    }

    #updateIndicatorContent(entry) {
        if (this.preventIndicatorUpdate || (TOPBAR_DISPLAY_MODE !== 1 && TOPBAR_DISPLAY_MODE !== 2)) {
            return;
        }

        if (!entry || PRIVATEMODE) {
            this._buttonImgPreview.destroy_all_children();
            this._buttonText.set_text("...");
        } else {
            if (entry.isText()) {
                this._buttonText.set_text(this._truncate(entry.getStringValue(), MAX_TOPBAR_LENGTH));
                this._buttonImgPreview.destroy_all_children();
            }
            else if (entry.isImage()) {
                this._buttonText.set_text('');
                this._buttonImgPreview.destroy_all_children();
                this.registry.getEntryAsImage(entry).then(img => {
                    if (!img) return;
                    if (this._destroyed) {
                        img.destroy();
                        return;
                    }
                    img.add_style_class_name('clipboard-indicator-img-preview');
                    img.y_align = Clutter.ActorAlign.CENTER;

                    // icon only renders properly in setTimeout for some arcane reason
                    this._imagePreviewTimeout = setTimeout(() => {
                        this._buttonImgPreview.set_child(img);
                    }, 0);
                });
            }
        }
    }

    _blinkIcon () {
        if (!BLINK_ICON_ON_COPY || !this.icon) {
            return;
        }

        // Set inverted colors
        this.set_style('background-color: rgba(255, 255, 255, 0.9);');
        this.icon.set_style('color: rgba(0, 0, 0, 0.9);');

        // Revert back to normal after delay
        this._blinkAnimationTimeout = setTimeout(() => {
            this._blinkAnimationTimeout = null;
            this.set_style(null);
            this.icon.set_style(null);
        }, 200);
    }

    async _buildMenu () {
        const { entries: clipHistory, complete: historyComplete } = await this._getCache();
        if (this._destroyed) {
            return;
        }

        /* This create the search entry, which is add to a menuItem.
        The searchEntry is connected to the function for research.
        The menu itself is connected to some shitty hack in order to
        grab the focus of the keyboard. */
        this._entryItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false
        });
        this.searchEntry = new St.Entry({
            name: 'searchEntry',
            style_class: 'search-entry',
            can_focus: true,
            hint_text: _('Type here to search...'),
            track_hover: true,
            x_expand: true,
            y_expand: true,
            primary_icon: new St.Icon({ icon_name: 'edit-find-symbolic' })
        });

        this.searchEntry.get_clutter_text().connect(
            'text-changed',
            this._onSearchTextChanged.bind(this)
        );

        this._entryItem.add_child(this.searchEntry);

        this.menu.connect('open-state-changed', (self, open) => {
            if (open) this.#populateMenu();

            this._setFocusOnOpenTimeout = setTimeout(() => {
                if (!open) return;

                if (this._focusItemOnOpen) {
                    const item = this._focusItemOnOpen;
                    this._focusItemOnOpen = null;
                    global.stage.set_key_focus(item.actor);
                } else if (SHOW_SEARCH_BAR && this._history.length > 0) {
                    this.searchEntry.set_text('');
                    global.stage.set_key_focus(this.searchEntry);
                } else if (this._history.length > 0) {
                    const currentItem = this._getCurrentlySelectedItem();
                    if (currentItem) global.stage.set_key_focus(currentItem.actor);
                } else if (SHOW_PRIVATE_MODE && this.privateModeMenuItem) {
                    global.stage.set_key_focus(this.privateModeMenuItem.actor);
                }
            }, 50);
        });

        // Create menu sections for items
        // Favorites
        this.favoritesSection = new PopupMenu.PopupMenuSection();

        this.scrollViewFavoritesMenuSection = new PopupMenu.PopupMenuSection();
        this.favoritesScrollView = new St.ScrollView({
            style_class: 'ci-history-menu-section',
            overlay_scrollbars: true
        });
        this.favoritesScrollView.add_child(this.favoritesSection.actor);

        this.scrollViewFavoritesMenuSection.actor.add_child(this.favoritesScrollView);
        this.favoritesSeparator = new PopupMenu.PopupSeparatorMenuItem();

        // History
        this.historySection = new PopupMenu.PopupMenuSection();

        this.scrollViewMenuSection = new PopupMenu.PopupMenuSection();
        this.historyScrollView = new St.ScrollView({
            style_class: 'ci-main-menu-section ci-history-menu-section',
            overlay_scrollbars: true
        });
        this.historyScrollView.add_child(this.historySection.actor);

        this.scrollViewMenuSection.actor.add_child(this.historyScrollView);

        // Add separator
        this.historySeparator = new PopupMenu.PopupSeparatorMenuItem();

        // Add sections ordered according to settings
        if (PINNED_ON_BOTTOM) {
            this.menu.addMenuItem(this.scrollViewMenuSection);
            this.menu.addMenuItem(this.scrollViewFavoritesMenuSection);
        }
        else {
            this.menu.addMenuItem(this.scrollViewFavoritesMenuSection);
            this.menu.addMenuItem(this.scrollViewMenuSection);
        }

        // Private mode switch
        this.privateModeMenuItem = new PopupMenu.PopupSwitchMenuItem(
            _("Private mode"), PRIVATEMODE, { reactive: true });
        this.privateModeMenuItem.connect('toggled',
            this._onPrivateModeSwitch.bind(this));
        this.privateModeMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'security-medium-symbolic',
                style_class: 'clipboard-menu-icon',
                y_align: Clutter.ActorAlign.CENTER
            }),
            0
        );
        this.menu.addMenuItem(this.privateModeMenuItem);

        // Add 'Clear' button which removes all items from cache
        this.clearMenuItem = new PopupMenu.PopupMenuItem(_('Clear history'));
        this.clearMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'clipboard-menu-icon',
                y_align: Clutter.ActorAlign.CENTER
            }),
            0
        );

        let timerBox = new St.BoxLayout({
            x_align: Clutter.ActorAlign.END,
            x_expand: true
        });

        this.timerLabel = new St.Label({
            text: '',
            style: 'font-family: monospace;',
            x_align: Clutter.ActorAlign.END,
            x_expand: true
        });

        this.resetTimerButton = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            accessible_name: _('Reset Timer'),
            child: new St.Icon({
                icon_name: 'view-refresh-symbolic',
                style_class: 'system-status-icon',
                icon_size: 14
            }),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.resetTimerButton.connect('clicked', () => {
            this._scheduleNextHistoryClear();
        });

        timerBox.add_child(this.timerLabel);
        timerBox.add_child(this.resetTimerButton);
        this.clearMenuItem.add_child(timerBox);

        this.clearMenuItem.connect('activate', this._removeAll.bind(this));

        // Add 'Settings' menu item to open settings
        this.settingsMenuItem = new PopupMenu.PopupMenuItem(_('Settings'));
        this.settingsMenuItem.insert_child_at_index(
            new St.Icon({
                icon_name: 'preferences-system-symbolic',
                style_class: 'clipboard-menu-icon',
                y_align: Clutter.ActorAlign.CENTER
            }),
            0
        );
        this.settingsMenuItem.connect('activate', this._openSettings.bind(this));

        // Empty state section
        this.emptyStateSection = new St.BoxLayout({
            style_class: 'clipboard-indicator-empty-state',
            vertical: true
        });
        this.emptyStateSection.add_child(new St.Icon({
            icon_name: INDICATOR_ICON,
            style_class: 'system-status-icon clipboard-indicator-icon',
            x_align: Clutter.ActorAlign.CENTER
        }));
        this.emptyStateSection.add_child(new St.Label({
            text: _('Clipboard is empty'),
            x_align: Clutter.ActorAlign.CENTER
        }));

        // Only the data is loaded here. Menu items are created the first
        // time the menu opens, so startup cost does not grow with history size.
        this._history = clipHistory;
        this._historyLoaded = true;
        this._removeOldestEntries();
        this._enforceImageQuota();

        const newest = this._history[this._history.length - 1];
        if (newest) {
            this._selectEntry(newest);
        }

        this.#showElements();

        // If the registry could not be loaded, the cached images may still
        // belong to it (now in registry.txt~), so nothing is pruned.
        if (historyComplete) {
            this._pruneTimeoutId = setTimeout(() => {
                this._pruneTimeoutId = null;
                this.registry.pruneOrphanFiles(id => this.#isImageReferenced(id));
            }, PRUNE_DELAY_MS);
        }
    }

    /** @returns {boolean} whether an image with this id is in the history */
    #isImageReferenced (id) {
        return this._history.some(entry => entry.isImage() && entry.id() === id);
    }

    /**
     * Creates the menu items for the loaded history.
     *
     * Runs on first open. The newest entries are created synchronously so the
     * visible part of the menu is filled immediately; the rest are added in
     * batches from a low-priority idle callback, which lets input and redraws
     * run in between.
     */
    #populateMenu () {
        if (this._menuState !== 'empty' || !this._historyLoaded) return;
        this._menuState = 'populating';
        this._removedWhilePopulating.clear();

        const pending = [...this._history].reverse();
        const step = () => {
            if (this._destroyed) return GLib.SOURCE_REMOVE;

            for (let n = 0; n < MENU_BATCH_SIZE && pending.length > 0;) {
                const entry = pending.shift();
                // Entries removed, or already re-added by a move, since the
                // snapshot was taken are skipped.
                if (this._menuItems.has(entry) || this._removedWhilePopulating.has(entry)) continue;
                this.#createMenuItem(entry, false);
                n++;
            }
            this.#showElements();

            if (pending.length > 0) return GLib.SOURCE_CONTINUE;

            this._menuState = 'ready';
            this._removedWhilePopulating.clear();
            this._populateSourceId = 0;
            return GLib.SOURCE_REMOVE;
        };

        if (step() === GLib.SOURCE_CONTINUE) {
            this._populateSourceId = GLib.idle_add(GLib.PRIORITY_LOW, step);
        }
    }

    #hideElements() {
        if (this._destroyed) {
            return;
        }
        if (this.menu.box.contains(this._entryItem)) this.menu.box.remove_child(this._entryItem);
        if (this.menu.box.contains(this.favoritesSeparator)) this.menu.box.remove_child(this.favoritesSeparator);
        if (this.menu.box.contains(this.historySeparator)) this.menu.box.remove_child(this.historySeparator);
        if (this.clearMenuItem?.actor && this.menu.box.contains(this.clearMenuItem.actor))
            this.menu.box.remove_child(this.clearMenuItem.actor);
        if (this.settingsMenuItem?.actor && this.menu.box.contains(this.settingsMenuItem.actor))
            this.menu.box.remove_child(this.settingsMenuItem.actor);
        if (this.menu.box.contains(this.emptyStateSection)) this.menu.box.remove_child(this.emptyStateSection);
    }

    #showElements() {
        if (this._destroyed || !this._historyLoaded) {
            return;
        }

        // Counted from the history rather than the menu sections, which may
        // not be populated yet.
        const total = this._history.length;
        let favorites = 0;
        for (const entry of this._history) if (entry.isFavorite()) favorites++;
        const nonFavorites = total - favorites;

        // Remove empty-state if items exist
        if (total > 0 &&
            this.menu.box.contains(this.emptyStateSection)) {
            this.menu.box.remove_child(this.emptyStateSection);
        }

        // Search bar
        if (SHOW_SEARCH_BAR && !PRIVATEMODE) {
            if (!this.menu.box.contains(this._entryItem))
                this.menu.box.insert_child_at_index(this._entryItem, 0);
        } else {
            if (this.menu.box.contains(this._entryItem))
                this.menu.box.remove_child(this._entryItem);
        }

        // Keep the private-mode switch in place; only gate its visibility
        if (this.privateModeMenuItem?.actor) {
            this.privateModeMenuItem.actor.visible = SHOW_PRIVATE_MODE;
        }

        // Favorites separator (only when there are favorites and any items at all)
        if (total > 0) {
            if (favorites > 0 && !PRIVATEMODE) {
                if (this.menu.box.contains(this.favoritesSeparator) === false) {
                    this.menu.box.insert_child_above(this.favoritesSeparator, this.scrollViewFavoritesMenuSection.actor);
                }
            }
            else if (this.menu.box.contains(this.favoritesSeparator) === true) {
                this.menu.box.remove_child(this.favoritesSeparator);
            }
        }

        // History separator (between history and toggled buttons)
        if (total > 0 &&
            nonFavorites > 0 && !PRIVATEMODE &&
            (SHOW_PRIVATE_MODE || SHOW_SETTINGS_BUTTON || SHOW_CLEAR_HISTORY_BUTTON)) {
            if (!this.menu.box.contains(this.historySeparator))
                this.menu.box.insert_child_above(this.historySeparator, this.scrollViewMenuSection.actor);
        } else if (this.menu.box.contains(this.historySeparator)) {
            this.menu.box.remove_child(this.historySeparator);
        }

        // If no items, render empty state and (if toggled on) only show Private/Settings
        if (total === 0) {
            if (!this.menu.box.contains(this.emptyStateSection))
                this.#renderEmptyState();
            // Re-append toggled buttons after the empty state
            if (this.menu.box.contains(this.settingsMenuItem?.actor))
                this.menu.box.remove_child(this.settingsMenuItem.actor);

            let index = this.menu.box.get_n_children(); // append after empty state
            if (SHOW_SETTINGS_BUTTON && this.settingsMenuItem)
                this.menu.box.insert_child_at_index(this.settingsMenuItem.actor, index++);
            return;
        }

        // Re-append toggled buttons at end in fixed order
        if (this.menu.box.contains(this.settingsMenuItem?.actor))
            this.menu.box.remove_child(this.settingsMenuItem.actor);
        if (this.menu.box.contains(this.clearMenuItem?.actor))
            this.menu.box.remove_child(this.clearMenuItem.actor);

        let index = this.menu.box.get_n_children(); // append
        if (SHOW_SETTINGS_BUTTON && this.settingsMenuItem)
            this.menu.box.insert_child_at_index(this.settingsMenuItem.actor, index++);
        if (SHOW_CLEAR_HISTORY_BUTTON && this.clearMenuItem && !PRIVATEMODE)
            this.menu.box.insert_child_at_index(this.clearMenuItem.actor, index++);
    }

    #renderEmptyState () {
        if (this._destroyed) {
            return;
        }
        this.#hideElements();
        this.menu.box.insert_child_at_index(this.emptyStateSection, 0);
    }

    /* When text change, this function will check, for each item of the
    historySection and favoritesSestion, if it should be visible or not (based on words contained
    in the clipContents attribute of the item). It doesn't destroy or create
    items. It the entry is empty, the section is restored with all items
    set as visible. */
    _onSearchTextChanged () {
        const matches = this.#searchMatcher();
        this._getAllIMenuItems().forEach(mItem => {
            mItem.actor.visible = matches(mItem);
        });
    }

    /**
     * @returns {function(PopupMenu.PopupMenuItem): boolean} predicate for the
     *   current search text. Also applied to items created while a search is
     *   active.
     */
    #searchMatcher () {
        // Text to be searched converted to lowercase if search is case insensitive
        let searchedText = this.searchEntry?.get_text() ?? '';
        if (!CASE_SENSITIVE_SEARCH) searchedText = searchedText.toLowerCase();

        if (searchedText === '') return () => true;

        let re = null;
        if (REGEX_SEARCH) {
            try {
                re = new RegExp(searchedText, 'm' + (CASE_SENSITIVE_SEARCH ? '' : 'i'));
            }
            catch (e) {
                // Incomplete pattern while typing: hide nothing.
                return () => true;
            }
        }

        return mItem => {
            let text = mItem.clipContents;
            let tag = mItem.entry.getTag() || '';
            if (!CASE_SENSITIVE_SEARCH) {
                text = text.toLowerCase();
                tag = tag.toLowerCase();
            }
            return re
                ? re.test(text) || re.test(tag)
                : text.includes(searchedText) || tag.includes(searchedText);
        };
    }

    _truncate (string, length) {
        let shortened = string.replace(/\s+/g, ' ');

        let chars = [...shortened]
        if (chars.length > length)
            shortened = chars.slice(0, length - 1).join('') + '...';

        return shortened;
    }

    _setEntryLabel (menuItem) {
        const { entry } = menuItem;
        if (entry.isText()) {
            menuItem.label.set_text(this._truncate(entry.getStringValue(), MAX_ENTRY_LENGTH));
        }
        else if (entry.isImage()) {
            // Until its thumbnail exists (first open after upgrading, or a
            // just-copied image) the row shows a generic image icon.
            if (!menuItem.previewImage && !this.registry.hasThumbnail(entry)) {
                this.#setPreviewImage(menuItem, new St.Icon({ icon_name: 'image-x-generic-symbolic' }));
            }
            this.registry.getEntryAsImage(entry).then(img => {
                if (!img) return;
                // The item may have been removed, or the whole indicator
                // destroyed, while the thumbnail loaded.
                if (this._destroyed || this._menuItems.get(entry) !== menuItem) {
                    img.destroy();
                    return;
                }
                this.#setPreviewImage(menuItem, img);
            });
        }
    }

    #setPreviewImage (menuItem, img) {
        img.add_style_class_name('clipboard-menu-img-preview');
        if (menuItem.previewImage) {
            menuItem.previewImage.destroy();
        }
        menuItem.previewImage = img;
        menuItem.insert_child_below(img, menuItem.label);
    }

    _findNextMenuItem (currentMenutItem) {
        // Rendered items in history order (oldest first).
        const items = this._history
            .map(entry => this._menuItems.get(entry))
            .filter(item => item !== undefined);
        let currentIndex = items.indexOf(currentMenutItem);

        // for only one item
        if(items.length === 1) {
            return null;
        }

        // when focus is in middle of the displayed list
        for (let i = currentIndex - 1; i >= 0; i--) {
            let menuItem = items[i];
            if (menuItem.actor.visible) {
                return menuItem;
            }
        }

        // when focus is at the last element of the displayed list
        let beforeMenuItem = items[currentIndex + 1];
        if(beforeMenuItem?.actor.visible){
          return beforeMenuItem;
        }

        return null;
    }

    #selectNextMenuItem (menuItem) {
        let nextMenuItem = this._findNextMenuItem(menuItem);

        if (nextMenuItem) {
            nextMenuItem.actor.grab_key_focus();
        } else if (this.privateModeMenuItem?.actor) {
            this.privateModeMenuItem.actor.grab_key_focus();
        }
    }

    /**
     * Appends an entry to the history (as the newest) and, if the menu has
     * been rendered, adds its menu item at the top.
     */
    _addEntry (entry, autoSelect, autoSetClip) {
        this._history.push(entry);

        if (this._menuState !== 'empty') {
            this._removedWhilePopulating.delete(entry);
            this.#createMenuItem(entry, true);
        }

        if (autoSelect === true) {
            this._selectEntry(entry, autoSetClip);
        }

        this.#showElements();
    }

    /**
     * Builds the menu item for an entry and inserts it into its section.
     *
     * @param {ClipboardEntry} entry
     * @param {boolean} atTop insert as the first item (newest) instead of
     *   appending, which is used while populating newest-first
     */
    #createMenuItem (entry, atTop) {
        let menuItem = new PopupMenu.PopupMenuItem('');

        menuItem.menu = this.menu;
        menuItem.entry = entry;
        menuItem.clipContents = entry.getStringValue();

        // CLICK fix for Paste on Select: clicking behaves like Enter
        menuItem.connect('activate', () => {
            if (PASTE_ON_SELECT) {
                this.#pasteItem(menuItem);
                this._onMenuItemSelectedAndMenuClose(menuItem, false);
            } else {
                this._onMenuItemSelectedAndMenuClose(menuItem, true);
            }
        });

        menuItem.connect('key-focus-in', () => {
            const viewToScroll = menuItem.entry.isFavorite() ?
                this.favoritesScrollView : this.historyScrollView;
            AnimationUtils.ensureActorVisibleInScrollView(viewToScroll, menuItem);
        });
        menuItem.actor.connect('key-press-event', (actor, event) => {
            switch (event.get_key_symbol()) {
                case Clutter.KEY_Delete:
                    if (menuItem.entry.isFavorite()) {
                        if (CONFIRM_ON_PINNED_DELETE) {
                            this._confirmRemovePinnedEntry(menuItem, true);
                        } else {
                            this.#selectNextMenuItem(menuItem);
                            this._removeEntry(menuItem.entry, 'delete');
                        }
                    } else {
                        this.#selectNextMenuItem(menuItem);
                        this._removeEntry(menuItem.entry, 'delete');
                    }
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_p:
                    this.#selectNextMenuItem(menuItem);
                    this._favoriteToggle(menuItem);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_v:
                    this.#pasteItem(menuItem);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_h:
                    if (entry.isImage()) {
                        this.#showImagePreview(entry, () => {
                            this._focusItemOnOpen = menuItem;
                            this.menu.open();
                        });
                        return Clutter.EVENT_STOP;
                    }
                    break;
                case Clutter.KEY_e:
                    if (entry.isText()) {
                        this.#showEditDialog(menuItem, true);
                        return Clutter.EVENT_STOP;
                    }
                    break;
                case Clutter.KEY_t:
                    this.#showTagDialog(menuItem, true);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_KP_Enter:
                case Clutter.KEY_Return:
                    if (PASTE_ON_SELECT) {
                        this.#pasteItem(menuItem);
                        this._onMenuItemSelectedAndMenuClose(menuItem, false);
                    } else {
                        this._onMenuItemSelectedAndMenuClose(menuItem, true);
                    }
                    return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Registered before the label so the async thumbnail callback in
        // _setEntryLabel can tell whether the item is still current.
        this._menuItems.set(entry, menuItem);
        this._setEntryLabel(menuItem);

        if (entry.getTag()) {
            menuItem.tagLabel = new St.Label({
                text: entry.getTag(),
                style_class: 'ci-tag-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            menuItem.actor.add_child(menuItem.tagLabel);
        }

        menuItem.actionsSpacer = new St.Widget({
            x_expand: true,
        });
        menuItem.actor.add_child(menuItem.actionsSpacer);

        // Image preview button
        if (entry.isImage()) {
            menuItem.imagePreviewBtn = new St.Button({
                style_class: 'ci-action-btn',
                can_focus: true,
                accessible_name: _('Preview Image'),
                child: new St.Icon({
                    icon_name: 'image-x-generic-symbolic',
                    style_class: 'system-status-icon'
                }),
                visible: SHOW_PREVIEW_BUTTON,
                x_expand: false,
                y_expand: true,
            });
            menuItem.imagePreviewBtn.connect('clicked', () => this.#showImagePreview(entry));
            menuItem.actor.add_child(menuItem.imagePreviewBtn);
        }

        // Edit button (text entries only)
        if (entry.isText()) {
            menuItem.editBtn = new St.Button({
                style_class: 'ci-action-btn',
                can_focus: true,
                accessible_name: _('Edit'),
                child: new St.Icon({
                    icon_name: 'document-edit-symbolic',
                    style_class: 'system-status-icon',
                }),
                visible: SHOW_EDIT_BUTTON,
                x_expand: false,
                y_expand: true,
            });
            menuItem.editBtn.connect('clicked', () => this.#showEditDialog(menuItem));
            menuItem.actor.add_child(menuItem.editBtn);
        }

        // Favorite button
        let iconfav = new St.Icon({
            style_class: 'system-status-icon'
        });

        let icofavBtn = new St.Button({
            style_class: 'ci-pin-btn ci-action-btn',
            can_focus: true,
            child: iconfav,
            visible: SHOW_PIN_BUTTON,
            x_expand: false,
            y_expand: true
        });

        menuItem.actor.add_child(icofavBtn);
        menuItem.icofavBtn = icofavBtn;
        this.#updatePinButton(menuItem);
        menuItem.favoritePressId = icofavBtn.connect('clicked',
            () => this._favoriteToggle(menuItem)
        );

        // Paste button
        menuItem.pasteBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            accessible_name: _('Paste'),
            child: new St.Icon({
                icon_name: 'edit-paste-symbolic',
                style_class: 'system-status-icon'
            }),
            x_expand: false,
            y_expand: true,
            visible: PASTE_BUTTON
        });

        menuItem.pasteBtn.connect('clicked',
            () => this.#pasteItem(menuItem)
        );

        menuItem.actor.add_child(menuItem.pasteBtn);

        // Tag button
        const tagIcon = new St.Icon({
            icon_name: 'user-bookmarks-symbolic',
            style_class: 'system-status-icon',
        });

        menuItem.tagBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            child: tagIcon,
            visible: SHOW_TAG_BUTTON,
            x_expand: false,
            y_expand: true,
        });
        menuItem.tagBtn.connect('clicked', () => this.#showTagDialog(menuItem));
        menuItem.actor.add_child(menuItem.tagBtn);

        // Delete button
        let icon = new St.Icon({
            icon_name: 'edit-delete-symbolic', //'mail-attachment-symbolic',
            style_class: 'system-status-icon'
        });

        let icoBtn = new St.Button({
            style_class: 'ci-action-btn',
            can_focus: true,
            child: icon,
            visible: SHOW_DELETE_BUTTON,
            x_expand: false,
            y_expand: true
        });

        menuItem.actor.add_child(icoBtn);
        menuItem.icoBtn = icoBtn;
        menuItem.deletePressId = icoBtn.connect('clicked',
            () => menuItem.entry.isFavorite()
                ? (CONFIRM_ON_PINNED_DELETE
                    ? this._confirmRemovePinnedEntry(menuItem)
                    : this._removeEntry(menuItem.entry, 'delete'))
                : this._removeEntry(menuItem.entry, 'delete')
        );

        const section = entry.isFavorite() ? this.favoritesSection : this.historySection;
        section.addMenuItem(menuItem, atTop ? 0 : undefined);

        this.#updateOrnament(menuItem);
        menuItem.actor.visible = this.#searchMatcher()(menuItem);

        return menuItem;
    }

    /**
     * Shows the action the pin button performs: a pin on unpinned rows and
     * a crossed-out pin on pinned ones. No icon theme provides the latter,
     * so it ships with the extension (icons/pin-off-symbolic.svg); St
     * recolours it like a themed symbolic icon because of its -symbolic
     * file name.
     */
    #updatePinButton (menuItem) {
        const pinned = menuItem.entry.isFavorite();
        menuItem.icofavBtn.child.gicon = pinned
            ? Gio.FileIcon.new(Gio.File.new_for_path(`${this.extension.path}/icons/pin-off-symbolic.svg`))
            : Gio.ThemedIcon.new('view-pin-symbolic');
        menuItem.icofavBtn.accessible_name = pinned ? _('Unpin') : _('Pin');
    }

    #updateOrnament (menuItem) {
        menuItem.setOrnament(PopupMenu.Ornament.DOT);
        if (menuItem._ornamentIcon) {
            menuItem._ornamentIcon.opacity = menuItem.entry === this._selectedEntry ? 255 : 0;
        }
    }

    #refreshOrnaments () {
        for (const menuItem of this._menuItems.values()) this.#updateOrnament(menuItem);
    }

    _favoriteToggle (menuItem) {
        menuItem.entry.favorite = menuItem.entry.isFavorite() ? false : true;
        this._moveItemFirst(menuItem.entry);
        // An unpinned image starts counting towards the image limits.
        this._enforceImageQuota();
        this.#showElements();
    }

    _confirmRemovePinnedEntry (menuItem, selectNext = false) {
        const title = _("Delete pinned item?");
        const message = _("Are you sure you want to delete this pinned item?");
        const sub_message = _("This operation cannot be undone.");

        this.dialogManager.open(title, message, sub_message, _("Delete"), _("Cancel"), () => {
            if (selectNext) this.#selectNextMenuItem(menuItem);
            this._removeEntry(menuItem.entry, 'delete');
        });
    }

    _confirmRemoveAll () {
        const title = _("Clear all?");
        const message = _("Are you sure you want to delete all clipboard items?");
        const sub_message = _("This operation cannot be undone.");

        this.dialogManager.open(title, message, sub_message, _("Clear"), _("Cancel"), () => {
            this._clearHistory();
        }
      );
    }

    _clearHistory (invokedAutomatically = false) {
        if (!this._historyLoaded) return;

        // Don't remove pinned items
        this._history
            .filter(entry => !entry.isFavorite())
            .forEach(entry => {
                if (KEEP_SELECTED_ON_CLEAR === false || entry !== this._selectedEntry) {
                    this._removeEntry(entry, 'delete', { batch: true });
                }
            });
        this._updateCache();
        this.#showElements();

        if (NOTIFY_ON_CLEAR) {
            const message = invokedAutomatically
                ? _("Clipboard history cleared automatically")
                : _("Clipboard history cleared");
            this._showNotification(message);
        }
    }

    _removeAll () {
        if (PRIVATEMODE) return;

        if (CONFIRM_ON_CLEAR) {
            this._confirmRemoveAll();
        } else {
            this._clearHistory();
        }
    }

    /**
     * Removes an entry from the history and, if rendered, from the menu.
     *
     * @param {ClipboardEntry} entry
     * @param {string} [event] 'delete' when the user deletes the entry (the
     *   clipboard is cleared if it held it); 'move' when the entry is about
     *   to be re-added, in which case its cached image is kept.
     * @param {object} [options]
     * @param {boolean} [options.batch] skip writing the registry and updating
     *   the menu chrome; the caller does both once after a batch of removals
     */
    _removeEntry (entry, event, { batch = false } = {}) {
        const idx = this._history.indexOf(entry);
        if (idx < 0) return;

        if (event === 'delete' && entry === this._selectedEntry) {
            this.#clearClipboard();
        }
        if (event !== 'move' && entry === this._selectedEntry) {
            this._selectedEntry = null;
        }

        this._history.splice(idx, 1);

        const menuItem = this._menuItems.get(entry);
        if (menuItem) {
            this._menuItems.delete(entry);
            menuItem.destroy();
        }
        if (this._menuState === 'populating') {
            this._removedWhilePopulating.add(entry);
        }

        if (entry.isImage() && event !== 'move') {
            this.registry.deleteEntryFile(entry, id => this.#isImageReferenced(id));
        }

        if (!batch) {
            this._updateCache();
            this.#showElements();
        }
    }

    _removeOldestEntries () {
        const nonFavorites = this._history.filter(entry => !entry.isFavorite());
        const excess = nonFavorites.length - MAX_REGISTRY_LENGTH;
        if (excess <= 0) return;

        nonFavorites.slice(0, excess)
            .forEach(entry => this._removeEntry(entry, undefined, { batch: true }));
        this._updateCache();
        this.#showElements();
    }

    /**
     * Drops the oldest unpinned images until both the image count and the
     * total size of cached images are within the configured limits.
     *
     * Pinned images are never removed. The newest image is always kept, even
     * if it alone exceeds the size limit, so a fresh copy is not lost at once.
     */
    _enforceImageQuota () {
        const images = this._history.filter(entry => entry.isImage() && !entry.isFavorite());
        const maxBytes = MAX_IMAGE_CACHE_SIZE * 1024 * 1024;

        let count = images.length;
        let total = images.reduce((sum, entry) => sum + entry.size(), 0);
        const toRemove = [];
        for (const entry of images.slice(0, -1)) {
            if (count <= MAX_CACHED_IMAGES && total <= maxBytes) break;
            toRemove.push(entry);
            count--;
            total -= entry.size();
        }
        if (toRemove.length === 0) return;

        toRemove.forEach(entry => this._removeEntry(entry, undefined, { batch: true }));
        this._updateCache();
        this.#showElements();
    }

    /**
     * Marks an entry as the current clipboard item.
     *
     * @param {ClipboardEntry} entry
     * @param {boolean} [autoSet] unless false, also put it on the clipboard
     */
    _selectEntry (entry, autoSet) {
        if (entry.getStringValue()) {
            this._selectedEntry = entry;
            if (autoSet !== false)
                this.#updateClipboard(entry);
        }
        else {
            this._selectedEntry = null;
        }
        this.#refreshOrnaments();
        this.#updateIndicatorContent(entry);
    }

    _onMenuItemSelectedAndMenuClose (menuItem, autoSet) {
        const entry = menuItem.entry;
        if (entry.getStringValue()) {
            this._selectedEntry = entry;
            if (autoSet !== false)
                this.#updateClipboard(entry);
        }
        else {
            this._selectedEntry = null;
        }
        this.#refreshOrnaments();

        // Ensure MOVE_ITEM_FIRST also applies when PASTE_ON_SELECT fast-path skips _refreshIndicator()
        if (PASTE_ON_SELECT && MOVE_ITEM_FIRST && !entry.isFavorite()) {
            this._moveItemFirst(entry);
        }

        this.menu.close();
    }

    _getCache () {
        return this.registry.read();
    }

    #cachedEntries () {
        return this._history
            .filter(entry => CACHE_ONLY_FAVORITE == false || entry.isFavorite());
    }

    #addToCache (entry) {
        this.registry.write(this.#cachedEntries().concat([entry]));
    }

    _updateCache () {
        this.registry.write(this.#cachedEntries());
    }

    async _onSelectionChange (selection, selectionType, selectionSource) {
        if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
            // A new owner makes pending image writes stale. Our own
            // set_content() emits this synchronously, before it returns,
            // so it never invalidates a request started after it.
            this.#clipboardRequest++;
            this._refreshIndicator();
        }
    }

    async _refreshIndicator () {
        if (PRIVATEMODE || this._destroyed || !this._historyLoaded) return; // Private mode, do not.

        const focussedWindow = Shell.Global.get().display.focusWindow;
        const wmClass = focussedWindow?.get_wm_class();

        if (wmClass && EXCLUDED_APPS.includes(wmClass)) return; // Excluded app, do not.

        // A clipboard change that arrives while the previous one is still
        // being read is handled right after it, instead of being dropped.
        if (this.#refreshInProgress) {
            this.#refreshPending = true;
            return;
        }
        this.#refreshInProgress = true;

        try {
            const result = await this.#getClipboardContent();
            if (this._destroyed) {
                return;
            }

            if (result) {
                // Duplicates are detected by value: text contents, or the
                // image id (hash), so cached images never need to be read.
                const existing = this._history.find(entry => entry.equals(result));
                if (existing) {
                    this._selectEntry(existing, false);

                    if (!existing.isFavorite() && MOVE_ITEM_FIRST) {
                        this._moveItemFirst(existing);
                    }

                    return;
                }

                this.#addToCache(result);
                this._addEntry(result, true, false);
                this._removeOldestEntries();
                this._enforceImageQuota();
                if (result.isImage()) this.#persistNewImage(result);
                if (NOTIFY_ON_COPY) {
                    this._showNotification(_("Copied to clipboard"), notif => {
                        notif.addAction(_('Cancel'), () => this._cancelNotification());
                    });
                }
                this._blinkIcon();
            }
        }
        catch (e) {
            console.error('Clipboard Indicator: Failed to refresh indicator');
            console.error(e);
        }
        finally {
            this.#refreshInProgress = false;
            if (this.#refreshPending && !this._destroyed) {
                this.#refreshPending = false;
                this._refreshIndicator();
            }
        }
    }

    /**
     * Writes a newly copied image and its thumbnail to the cache, then drops
     * the in-memory copy. The bytes are kept if the write failed, so the
     * entry stays usable for this session.
     */
    async #persistNewImage (entry) {
        await Promise.allSettled([
            this.registry.writeEntryFile(entry),
            this.registry.ensureThumbnail(entry),
        ]);
        if (this.registry.hasEntryFile(entry)) entry.releaseBytes();
    }

    _moveItemFirst (entry) {
        const wasSelected = entry === this._selectedEntry;
        this._removeEntry(entry, 'move', { batch: true });
        this._addEntry(entry, wasSelected, false);
        this._updateCache();
    }

    /** @returns {PopupMenu.PopupMenuItem|undefined} the rendered item of the selected entry */
    _getCurrentlySelectedItem () {
        return this._selectedEntry ? this._menuItems.get(this._selectedEntry) : undefined;
    }

    /** @returns {PopupMenu.PopupMenuItem[]} all rendered history items */
    _getAllIMenuItems () {
        return [...this._menuItems.values()];
    }

    _setupListener () {
        const metaDisplay = Shell.Global.get().get_display();
        const selection = metaDisplay.get_selection();
        this._setupSelectionTracking(selection);
    }

    _setupSelectionTracking (selection) {
        this.selection = selection;
        this._selectionOwnerChangedId = selection.connect('owner-changed', (selection, selectionType, selectionSource) => {
            this._onSelectionChange(selection, selectionType, selectionSource);
        });
    }

    _setupHistoryIntervalClearing() {
        this._fetchSettings();

        if (this._intervalSettingChangedId) {
            this.extension.settings.disconnect(this._intervalSettingChangedId);
            this._intervalSettingChangedId = null;
        }
        if (this._intervalToggleChangedId) {
            this.extension.settings.disconnect(this._intervalToggleChangedId);
            this._intervalToggleChangedId = null;
        }
        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = null;
        }

        this._intervalSettingChangedId = this.extension.settings.connect(
            `changed::${PrefsFields.CLEAR_HISTORY_INTERVAL}`,
            this._onHistoryIntervalClearSettingsChanged.bind(this)
        );
        this._intervalToggleChangedId = this.extension.settings.connect(
            `changed::${PrefsFields.CLEAR_HISTORY_ON_INTERVAL}`,
            this._onHistoryIntervalClearSettingsChanged.bind(this)
        );

        if (!CLEAR_HISTORY_ON_INTERVAL) {
            this._updateIntervalTimer();
            return;
        }

        const currentTime = Math.ceil(new Date().getTime() / 1000);

        if (NEXT_HISTORY_CLEAR === -1) { //new timer
            this._scheduleNextHistoryClear();
        }
        else if (NEXT_HISTORY_CLEAR < currentTime) { //timer expired
            this._clearHistory(true);
            this._scheduleNextHistoryClear();
        }
        else { //timer already set, but not expired
            // Clean up existing timers before reassigning
            if (this._historyClearTimeoutId) {
                clearTimeout(this._historyClearTimeoutId);
                this._historyClearTimeoutId = null;
            }
            if (this._timerIntervalId) {
                clearInterval(this._timerIntervalId);
                this._timerIntervalId = null;
            }
            
            const timeoutMs = (NEXT_HISTORY_CLEAR - currentTime) * 1000;
            this._historyClearTimeoutId = setTimeout(() => {
                this._clearHistory(true);
                this._scheduleNextHistoryClear();
            }, timeoutMs);
            this._timerIntervalId = setInterval(() => {
                this._updateIntervalTimer();
            }, 1000);
        }
    }

    _onHistoryIntervalClearSettingsChanged(_settings, key) {
        this._fetchSettings();
        if (key === PrefsFields.CLEAR_HISTORY_INTERVAL) {
            this._scheduleNextHistoryClear();
        }
        else if (key === PrefsFields.CLEAR_HISTORY_ON_INTERVAL) {
            if (CLEAR_HISTORY_ON_INTERVAL) {
                this._resetHistoryClearTimer();
                this._setupHistoryIntervalClearing();
            } else {
                this._resetHistoryClearTimer();
            }
        }
    }

    _scheduleNextHistoryClear() {
        this._fetchSettings();

        clearInterval(this._timerIntervalId);
        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = null;
        }

        if(!CLEAR_HISTORY_ON_INTERVAL) {
            this._resetHistoryClearTimer();
            return;
        }

        const currentTime = Math.ceil(new Date().getTime() / 1000);
        NEXT_HISTORY_CLEAR = currentTime + CLEAR_HISTORY_INTERVAL * 60;
        const timeoutMs = (NEXT_HISTORY_CLEAR - currentTime) * 1000;

        this.extension.settings.set_int(PrefsFields.NEXT_HISTORY_CLEAR, NEXT_HISTORY_CLEAR);

        this._updateIntervalTimer();
        this._timerIntervalId = setInterval(() => {
            this._updateIntervalTimer();
        }, 1000);

        this._historyClearTimeoutId = setTimeout(() => {
            this._clearHistory(true);
            this._scheduleNextHistoryClear();
        }, timeoutMs);
    }

    _resetHistoryClearTimer() {
        //basically just reset and stop the timer
        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = null;
        }
        clearInterval(this._timerIntervalId);
        this._timerIntervalId = null;
        this._updateIntervalTimer();
        this.extension.settings.set_int(PrefsFields.NEXT_HISTORY_CLEAR, -1);
    }

    _updateIntervalTimer() {
        this._fetchSettings();
        this.resetTimerButton.visible = CLEAR_HISTORY_ON_INTERVAL;
        this.timerLabel.visible = CLEAR_HISTORY_ON_INTERVAL;
        if (!CLEAR_HISTORY_ON_INTERVAL) return;


        let currentTime = Math.ceil(new Date().getTime() / 1000);
        let timeLeft = NEXT_HISTORY_CLEAR - currentTime;

        if (timeLeft <= 0) {
            this.timerLabel.set_text('');
            return;
        }

        let hours = Math.floor(timeLeft / 3600);
        let minutes = Math.floor((timeLeft % 3600) / 60);
        let seconds = Math.floor(timeLeft % 60);

        let formattedTime = '';
        if (hours > 0) {
            formattedTime += `${hours}h `;
        }
        if (minutes > 0) {
            formattedTime += `${minutes}m `;
        }
        formattedTime += `${seconds}s`;
        this.timerLabel.set_text(formattedTime);
    }

    _openSettings () {
        this.extension.openSettings();
        this.menu.close();
    }

    _initNotifSource () {
        if (!this._notifSource) {
            this._notifSource = new MessageTray.Source({
                title: 'Clipboard Indicator',
                'icon-name': INDICATOR_ICON
            });

            this._notifSource.connect('destroy', () => {
                this._notifSource = null;
            });

            Main.messageTray.add(this._notifSource);
        }
    }

    _destroyNotifSource () {
        if (this._notifSource) {
            this._notifSource.destroy();
            this._notifSource = null;
        }
    }

    /** Undoes the latest copy: restores the previous entry and drops the newest. */
    _cancelNotification () {
        const count = this._history.length;
        if (count === 0) return;

        const newest = this._history[count - 1];
        if (count >= 2) {
            this._selectEntry(this._history[count - 2]);
        } else {
            this.#clearClipboard();
        }
        this._removeEntry(newest);
    }

    _showNotification (message, transformFn) {
        const dndOn = () =>
            !Main.panel.statusArea.dateMenu._indicator._settings.get_boolean(
                'show-banners',
            );
        if (PRIVATEMODE || dndOn()) {
            return;
        }

        let notification = null;

        this._initNotifSource();

        if (this._notifSource.count === 0) {
            notification = new MessageTray.Notification({
                source: this._notifSource,
                body: message,
                'is-transient': true
            });
        }
        else {
            notification = this._notifSource.notifications[0];
            notification.body = message;
            notification.clearActions();
        }

        if (typeof transformFn === 'function') {
            transformFn(notification);
        }

        this._notifSource.addNotification(notification);
    }

    _createHistoryLabel () {
        this._historyLabel = new St.Label({
            style_class: 'ci-notification-label',
            text: ''
        });

        global.stage.add_child(this._historyLabel);

        this._historyLabel.hide();
    }

    _removeHistoryLabel () {
        if (this._historyLabel) {
            if (this._historyLabel.get_parent()) {
                global.stage.remove_child(this._historyLabel);
            }
            this._historyLabel.destroy();
            this._historyLabel = null;
        }
    }

    togglePrivateMode () {
        this.privateModeMenuItem.toggle();
    }

    _onPrivateModeSwitch () {
        PRIVATEMODE = this.privateModeMenuItem.state;
        // We hide the history in private ModeTypee because it will be out of sync (selected item will not reflect clipboard)
        this.scrollViewMenuSection.actor.visible = !PRIVATEMODE;
        this.scrollViewFavoritesMenuSection.actor.visible = !PRIVATEMODE;
        // If we get out of private mode then we restore the clipboard to old state
        if (!PRIVATEMODE) {
            if (this._selectedEntry) {
                this._selectEntry(this._selectedEntry);
            } else {
                // Nothing to return to, let's empty it instead
                this.#clearClipboard();
            }

            this.#getClipboardContent().then(entry => {
                if (!entry) return;
                this.#updateIndicatorContent(entry);
            }).catch(e => console.error(e));

            this.hbox.remove_style_class_name('private-mode');
            this.#showElements();
        } else {
            this.hbox.add_style_class_name('private-mode');
            this.#updateIndicatorContent(null);
            this.#showElements();
        }
    }

    _loadSettings () {
        this._settingsChangedId = this.extension.settings.connect('changed',
            this._onSettingsChange.bind(this));

        this._fetchSettings();

        if (ENABLE_KEYBINDING)
            this._bindShortcuts();
    }

    _fetchSettings () {
        const { settings } = this.extension;
        MAX_REGISTRY_LENGTH         = settings.get_int(PrefsFields.HISTORY_SIZE);
        MAX_CACHED_IMAGES           = settings.get_int(PrefsFields.MAX_CACHED_IMAGES);
        MAX_IMAGE_CACHE_SIZE        = settings.get_int(PrefsFields.MAX_IMAGE_CACHE_SIZE);
        MAX_ENTRY_LENGTH            = settings.get_int(PrefsFields.PREVIEW_SIZE);
        CACHE_ONLY_FAVORITE         = settings.get_boolean(PrefsFields.CACHE_ONLY_FAVORITE);
        DELETE_ENABLED              = settings.get_boolean(PrefsFields.DELETE);
        MOVE_ITEM_FIRST             = settings.get_boolean(PrefsFields.MOVE_ITEM_FIRST);
        NOTIFY_ON_COPY              = settings.get_boolean(PrefsFields.NOTIFY_ON_COPY);
        NOTIFY_ON_CYCLE             = settings.get_boolean(PrefsFields.NOTIFY_ON_CYCLE);
        NOTIFY_ON_CLEAR             = settings.get_boolean(PrefsFields.NOTIFY_ON_CLEAR);
        CONFIRM_ON_CLEAR            = settings.get_boolean(PrefsFields.CONFIRM_ON_CLEAR);
        CONFIRM_ON_PINNED_DELETE    = settings.get_boolean(PrefsFields.CONFIRM_ON_PINNED_DELETE);
        ENABLE_KEYBINDING           = settings.get_boolean(PrefsFields.ENABLE_KEYBINDING);
        MAX_TOPBAR_LENGTH           = settings.get_int(PrefsFields.TOPBAR_PREVIEW_SIZE);
        TOPBAR_DISPLAY_MODE         = settings.get_int(PrefsFields.TOPBAR_DISPLAY_MODE_ID);
        CLEAR_ON_BOOT               = settings.get_boolean(PrefsFields.CLEAR_ON_BOOT);
        PASTE_ON_SELECT             = settings.get_boolean(PrefsFields.PASTE_ON_SELECT);
        DISABLE_DOWN_ARROW          = settings.get_boolean(PrefsFields.DISABLE_DOWN_ARROW);
        BLINK_ICON_ON_COPY          = settings.get_boolean(PrefsFields.BLINK_ICON_ON_COPY);
        STRIP_TEXT                  = settings.get_boolean(PrefsFields.STRIP_TEXT);
        KEEP_SELECTED_ON_CLEAR      = settings.get_boolean(PrefsFields.KEEP_SELECTED_ON_CLEAR);
        PASTE_BUTTON                = settings.get_boolean(PrefsFields.PASTE_BUTTON);
        PINNED_ON_BOTTOM            = settings.get_boolean(PrefsFields.PINNED_ON_BOTTOM);
        CACHE_IMAGES                = settings.get_boolean(PrefsFields.CACHE_IMAGES);
        EXCLUDED_APPS               = settings.get_strv(PrefsFields.EXCLUDED_APPS);
        CLEAR_HISTORY_ON_INTERVAL   = settings.get_boolean(PrefsFields.CLEAR_HISTORY_ON_INTERVAL);
        CLEAR_HISTORY_INTERVAL      = settings.get_int(PrefsFields.CLEAR_HISTORY_INTERVAL);
        NEXT_HISTORY_CLEAR          = settings.get_int(PrefsFields.NEXT_HISTORY_CLEAR);
        CASE_SENSITIVE_SEARCH       = settings.get_boolean(PrefsFields.CASE_SENSITIVE_SEARCH);
        REGEX_SEARCH                = settings.get_boolean(PrefsFields.REGEX_SEARCH);
        OPEN_AT_CURSOR              = settings.get_boolean(PrefsFields.OPEN_AT_CURSOR);
        SHOW_SEARCH_BAR             = settings.get_boolean(PrefsFields.SHOW_SEARCH_BAR);
        SHOW_PRIVATE_MODE           = settings.get_boolean(PrefsFields.SHOW_PRIVATE_MODE);
        SHOW_SETTINGS_BUTTON        = settings.get_boolean(PrefsFields.SHOW_SETTINGS_BUTTON);
        SHOW_CLEAR_HISTORY_BUTTON   = settings.get_boolean(PrefsFields.SHOW_CLEAR_HISTORY_BUTTON);
        SHOW_DELETE_BUTTON          = settings.get_boolean(PrefsFields.SHOW_DELETE_BUTTON);
        SHOW_TAG_BUTTON             = settings.get_boolean(PrefsFields.SHOW_TAG_BUTTON);
        SHOW_PIN_BUTTON             = settings.get_boolean(PrefsFields.SHOW_PIN_BUTTON);
        SHOW_EDIT_BUTTON            = settings.get_boolean(PrefsFields.SHOW_EDIT_BUTTON);
        SHOW_PREVIEW_BUTTON         = settings.get_boolean(PrefsFields.SHOW_PREVIEW_BUTTON);
    }

    async _onSettingsChange () {
        try {
            // Load the settings into variables
            this._fetchSettings();

            if (this._historyLoaded) {
                this.#applyHistorySettings();
            }

            //update topbar
            this._updateTopbarLayout();
            this.#updateIndicatorContent(await this.#getClipboardContent());

            // Bind or unbind shortcuts
            if (ENABLE_KEYBINDING)
                this._bindShortcuts();
            else
                this._unbindShortcuts();
        } catch (e) {
            console.error('Clipboard Indicator: Failed to update registry');
            console.error(e);
        }
    }

    /** Applies changed settings to the loaded history and its menu. */
    #applyHistorySettings () {
        // If the toggle is hidden but private mode is on, force it off now
        if (!SHOW_PRIVATE_MODE && PRIVATEMODE && this.privateModeMenuItem) {
            this.privateModeMenuItem.setToggleState(false);
            this._onPrivateModeSwitch();
        }

        // Remove old entries in case the registry size or image limits changed
        this._removeOldestEntries();
        this._enforceImageQuota();

        // Re-set menu-items lables in case preview size changed
        this._getAllIMenuItems().forEach(mItem => {
            this._setEntryLabel(mItem);
            mItem.pasteBtn.visible = PASTE_BUTTON;
            mItem.icoBtn.visible = SHOW_DELETE_BUTTON;
            mItem.tagBtn.visible = SHOW_TAG_BUTTON;
            mItem.icofavBtn.visible = SHOW_PIN_BUTTON;
            if (mItem.editBtn) mItem.editBtn.visible = SHOW_EDIT_BUTTON;
            if (mItem.imagePreviewBtn) mItem.imagePreviewBtn.visible = SHOW_PREVIEW_BUTTON;
        });

        // Respect UI toggles
        this.#showElements();
    }

    _bindShortcuts () {
        this._unbindShortcuts();
        this._bindShortcut(PrefsFields.BINDING_CLEAR_HISTORY, this._removeAll);
        this._bindShortcut(PrefsFields.BINDING_PREV_ENTRY, this._previousEntry);
        this._bindShortcut(PrefsFields.BINDING_NEXT_ENTRY, this._nextEntry);
        this._bindShortcut(PrefsFields.BINDING_TOGGLE_MENU, this._toggleMenu);
        this._bindShortcut(PrefsFields.BINDING_PRIVATE_MODE, this.togglePrivateMode);
    }

    _unbindShortcuts () {
        this._shortcutsBindingIds.forEach(
            (id) => Main.wm.removeKeybinding(id)
        );

        this._shortcutsBindingIds = [];
    }

    _bindShortcut (name, cb) {
        Main.wm.addKeybinding(
            name,
            this.extension.settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            cb.bind(this)
        );

        this._shortcutsBindingIds.push(name);
    }

    _updateTopbarLayout () {
        if(TOPBAR_DISPLAY_MODE === 0){
            this.icon.visible = true;
            this._buttonText.visible = false;
            this._buttonImgPreview.visible = false;
            this.show();
        }
        if(TOPBAR_DISPLAY_MODE === 1){
            this.icon.visible = false;
            this._buttonText.visible = true;
            this._buttonImgPreview.visible = true;
            this.show();
        }
        if(TOPBAR_DISPLAY_MODE === 2){
            this.icon.visible = true;
            this._buttonText.visible = true;
            this._buttonImgPreview.visible = true;
            this.show();
        }
        if (TOPBAR_DISPLAY_MODE === 3) {
            this.hide();
        }
        if(!DISABLE_DOWN_ARROW) {
            this._downArrow.visible = true;
        } else {
            this._downArrow.visible = false;
        }
    }

    _disconnectSettings () {
        if (!this._settingsChangedId)
            return;

        this.extension.settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;

        if (this._intervalSettingChangedId) {
            this.extension.settings.disconnect(this._intervalSettingChangedId);
            this._intervalSettingChangedId = null;
        }

        if (this._intervalToggleChangedId) {
            this.extension.settings.disconnect(this._intervalToggleChangedId);
            this._intervalToggleChangedId = null;
        }

        if (this._historyClearTimeoutId) {
            clearTimeout(this._historyClearTimeoutId);
            this._historyClearTimeoutId = null;
        }
    }

    _disconnectSelectionListener () {
        if (!this._selectionOwnerChangedId)
            return;

        this.selection.disconnect(this._selectionOwnerChangedId);
    }

    _clearDelayedSelectionTimeout () {
        if (this._delayedSelectionTimeoutId) {
            clearInterval(this._delayedSelectionTimeoutId);
        }
    }

    _selectEntryWithDelay (entry) {
        this._selectEntry(entry, false);

        this._delayedSelectionTimeoutId = setTimeout(() => {
            this._selectEntry(entry);  //select the item
            this._delayedSelectionTimeoutId = null;
        }, DELAYED_SELECTION_TIMEOUT);
    }

    /**
     * Order used by the previous/next shortcuts, matching the menu: unpinned
     * entries newest first, then pinned entries newest first.
     */
    #cycleOrder () {
        const newestFirst = [...this._history].reverse();
        return newestFirst.filter(entry => !entry.isFavorite())
            .concat(newestFirst.filter(entry => entry.isFavorite()));
    }

    #cycleEntry (step) {
        if (PRIVATEMODE || !this._historyLoaded) return;

        this._clearDelayedSelectionTimeout();

        const order = this.#cycleOrder();
        let i = order.indexOf(this._selectedEntry);
        if (i < 0) return;

        i = (i + step + order.length) % order.length;  //cycle if out of bound

        if(NOTIFY_ON_CYCLE) {
            this._showNotification((i + 1) + ' / ' + order.length + ': ' + order[i].getStringValue());
        }
        if (MOVE_ITEM_FIRST) {
            this._selectEntryWithDelay(order[i]);
        }
        else {
            this._selectEntry(order[i]);
        }
    }

    _previousEntry () {
        this.#cycleEntry(-1);
    }

    _nextEntry () {
        this.#cycleEntry(1);
    }

    _toggleMenu () {
        if (!this._historyLoaded) return;
        if (!this.menu.isOpen && OPEN_AT_CURSOR) {
            const [x, y] = global.get_pointer();
            this._cursorActor.set_position(x, y);
            this.menu.sourceActor = this._cursorActor;
        }
        this.menu.toggle();
    }




    async #pasteItem (menuItem) {
        this.menu.close();
        const previousEntry = this._selectedEntry;
        this.preventIndicatorUpdate = true;
        // Wait until an image has been read from disk and is on the
        // clipboard before sending the paste keystroke.
        if (!await this.#updateClipboard(menuItem.entry)) {
            this.preventIndicatorUpdate = false;
            return;
        }
        this._pastingKeypressTimeout = setTimeout(() => {
            if (this.keyboard.purpose === Clutter.InputContentPurpose.TERMINAL) {
                this.keyboard.press(Clutter.KEY_Control_L);
                this.keyboard.press(Clutter.KEY_Shift_L);
                this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Shift_L);
                this.keyboard.release(Clutter.KEY_Control_L);
            }
            else {
                this.keyboard.press(Clutter.KEY_Shift_L);
                this.keyboard.press(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Insert);
                this.keyboard.release(Clutter.KEY_Shift_L);
            }

            this._pastingResetTimeout = setTimeout(() => {
                this.preventIndicatorUpdate = false;
                if (previousEntry)
                    this.#updateClipboard(previousEntry);
            }, 50);
        }, 50);
    }

    #showImagePreview (entry, onClose = null) {
        this.#closeImagePreview();
        this.menu.close();

        const monitor = Main.layoutManager.currentMonitor;

        const overlay = new St.Widget({
            reactive: true,
            can_focus: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            style: 'background-color: rgba(0, 0, 0, 0.75);',
        });

        this.#_imagePreviewOverlay = overlay;
        global.stage.add_child(overlay);
        overlay.grab_key_focus();

        const close = () => {
            this.#closeImagePreview();
            if (onClose) onClose();
        };

        overlay._previewClickId = overlay.connect('button-press-event', () => {
            close();
            return Clutter.EVENT_STOP;
        });

        overlay._previewKeyId = overlay.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        const maxW = Math.floor(monitor.width * 0.5);
        const maxH = Math.floor(monitor.height * 0.4);

        const bin = new St.Bin({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        bin.add_constraint(new Clutter.AlignConstraint({
            source: overlay,
            align_axis: Clutter.AlignAxis.X_AXIS,
            factor: 0.5,
        }));
        bin.add_constraint(new Clutter.AlignConstraint({
            source: overlay,
            align_axis: Clutter.AlignAxis.Y_AXIS,
            factor: 0.5,
        }));
        overlay.add_child(bin);

        this.registry.getEntryAsTexture(entry).then(actor => {
            if (this.#_imagePreviewOverlay !== overlay) return;
            if (!actor) return;

            let contentHandlerId = actor.connect('notify::content', () => {
                const [, natW] = actor.get_preferred_width(-1);
                const [, natH] = actor.get_preferred_height(-1);

                if (natW > 0 && natH > 0) {
                    actor.disconnect(contentHandlerId);
                    contentHandlerId = null;
                    const scale = Math.min(1, maxW / natW, maxH / natH);
                    bin.set_size(Math.round(natW * scale), Math.round(natH * scale));
                }
            });

            actor.connect('destroy', () => {
                if (contentHandlerId) {
                    actor.disconnect(contentHandlerId);
                    contentHandlerId = null;
                }
            });

            bin.set_child(actor);
        }).catch(e => {
            console.error('Clipboard Indicator: failed to load image preview');
            console.error(e);
        });
    }

    #showTagDialog (menuItem, reopenOnClose = false) {
        const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true });

        const onDialogClose = () => {
            if (reopenOnClose) {
                this._focusItemOnOpen = menuItem;
                this.menu.open();
            }
        };

        const textEntry = new St.Entry({
            text: menuItem.entry.getTag() || '',
            hint_text: _('Enter tag…'),
            can_focus: true,
            x_expand: true,
            style: 'min-width: 300px;',
        });

        dialog.contentLayout.add_child(textEntry);

        dialog.addButton({
            label: _('Discard'),
            action: () => {
                dialog.close();
                onDialogClose();
            },
            key: Clutter.KEY_Escape,
        });

        dialog.addButton({
            label: _('Save'),
            action: () => {
                const tag = textEntry.get_text().trim() || null;
                menuItem.entry.setTag(tag);
                this._updateTagLabel(menuItem);
                this._updateCache();
                dialog.close();
                onDialogClose();
            },
            default: true,
        });

        dialog.open();
        textEntry.grab_key_focus();
    }

    _updateTagLabel (menuItem) {
        if (menuItem.tagLabel) {
            menuItem.actor.remove_child(menuItem.tagLabel);
            menuItem.tagLabel.destroy();
            menuItem.tagLabel = null;
        }

        const tag = menuItem.entry.getTag();
        if (tag) {
            menuItem.tagLabel = new St.Label({
                text: tag,
                style_class: 'ci-tag-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            menuItem.actor.insert_child_above(menuItem.tagLabel, menuItem.label);
        }
    }

    #showEditDialog (menuItem, reopenOnClose = false) {
        const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true });

        const onDialogClose = () => {
            if (reopenOnClose) {
                this._focusItemOnOpen = menuItem;
                this.menu.open();
            }
        };

        const scrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: false,
            style: 'min-width: 400px; min-height: 100px; max-height: 400px;',
        });

        const clutterText = new Clutter.Text({
            text: menuItem.entry.getStringValue(),
            editable: true,
            reactive: true,
            single_line_mode: false,
            activatable: false,
            line_wrap: true,

        });

        // Clutter.Text is not styled by the shell theme, so its colours are
        // set here, following the shell's light or dark style.
        const lightStyle = Main.getStyleVariant() === 'light';
        const textColor = lightStyle ? makeColor(0.18, 0.18, 0.18, 1.0) : makeColor(1.0, 1.0, 1.0, 1.0);
        clutterText.color = textColor;
        clutterText.selection_color = makeColor(0.39, 0.59, 1.0, 0.71);
        clutterText.selected_text_color = textColor;

        const textBox = new St.BoxLayout({
            style_class: 'ci-edit-textbox',
            x_expand: true,
            y_expand: true,
            vertical: true,
        });

        textBox.add_child(clutterText);

        scrollView.add_child(textBox);
        dialog.contentLayout.add_child(scrollView);

        dialog.addButton({
            label: _('Discard'),
            action: () => {
                dialog.close();
                onDialogClose();
            },
            key: Clutter.KEY_Escape,
        });

        dialog.addButton({
            label: _('Save'),
            action: () => {
                const newText = clutterText.get_text();
                menuItem.entry.setText(newText);
                menuItem.clipContents = newText;
                this._setEntryLabel(menuItem);
                this._updateCache();
                if (menuItem.entry === this._selectedEntry)
                    this.#updateClipboard(menuItem.entry);
                dialog.close();
                onDialogClose();
            },
            default: true,
        });

        if (reopenOnClose) this.menu.close();
        dialog.open();
        clutterText.grab_key_focus();
    }

    #closeImagePreview () {
        if (!this.#_imagePreviewOverlay) return;

        const overlay = this.#_imagePreviewOverlay;
        this.#_imagePreviewOverlay = null;

        if (overlay._previewClickId) overlay.disconnect(overlay._previewClickId);
        if (overlay._previewKeyId) overlay.disconnect(overlay._previewKeyId);

        if (overlay.get_parent()) global.stage.remove_child(overlay);
        overlay.destroy();
    }

    #clearTimeouts () {
        if (this._imagePreviewTimeout) clearTimeout(this._imagePreviewTimeout);
        if (this._setFocusOnOpenTimeout) clearTimeout(this._setFocusOnOpenTimeout);
        if (this._pastingKeypressTimeout) clearTimeout(this._pastingKeypressTimeout);
        if (this._pastingResetTimeout) clearTimeout(this._pastingResetTimeout);
        if (this._historyClearTimeoutId) clearTimeout(this._historyClearTimeoutId);
        if (this._timerIntervalId) clearInterval(this._timerIntervalId);
        if (this._blinkAnimationTimeout) clearTimeout(this._blinkAnimationTimeout);
    }

    #clearClipboard () {
        this.#clipboardRequest++;
        this.extension.clipboard.set_text(CLIPBOARD_TYPE, "");
        this.#updateIndicatorContent(null);
    }

    /**
     * Puts an entry on the clipboard. Cached images are read from disk
     * first and released again afterwards; St.Clipboard keeps its own copy.
     *
     * @returns {Promise<boolean>} false if the image could not be read
     */
    async #updateClipboard (entry) {
        // Reading a cached image is asynchronous. If anything else changes
        // the clipboard meanwhile (another selection, an external copy, a
        // clear), this request is stale and must not overwrite it.
        const request = ++this.#clipboardRequest;
        try {
            if (entry.isImage() && !entry.hasBytes()) {
                await this.registry.loadEntryBytes(entry);
                if (this._destroyed || request !== this.#clipboardRequest) {
                    // Superseded: do not keep the image in memory. A newer
                    // request for the same entry reads it again if needed.
                    if (this.registry.hasEntryFile(entry)) entry.releaseBytes();
                    return false;
                }
            }
            this.extension.clipboard.set_content(CLIPBOARD_TYPE, entry.mimetype(), entry.asBytes());
            if (entry.isImage() && this.registry.hasEntryFile(entry)) entry.releaseBytes();
        }
        catch (e) {
            console.error('Clipboard Indicator: failed to set clipboard content');
            console.error(e);
            return false;
        }
        this.#updateIndicatorContent(entry);
        return true;
    }

    /**
     * Reads one mimetype from the clipboard.
     *
     * @param {string} type
     * @returns {Promise<ClipboardEntry|null|symbol>} the entry, null if the
     *   clipboard has no data of this type, or CLIPBOARD_READ_TIMED_OUT if
     *   the owner did not deliver within CLIPBOARD_READ_TIMEOUT_MS
     */
    #readClipboard (type) {
        return new Promise(resolve => {
            // An owner that never answers (e.g. a frozen app) would
            // otherwise stall every later clipboard refresh.
            let settled = false;
            const timeoutId = setTimeout(() => {
                settled = true;
                console.warn(`Clipboard Indicator: reading ${type} from the clipboard timed out`);
                resolve(CLIPBOARD_READ_TIMED_OUT);
            }, CLIPBOARD_READ_TIMEOUT_MS);

            this.extension.clipboard.get_content(CLIPBOARD_TYPE, type, (clipBoard, bytes) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);

                // NOTE: `bytes` is freed when this callback returns; it must
                // be copied (ClipboardEntry does) before any await.
                if (bytes === null || bytes.get_size() === 0) {
                    resolve(null);
                    return;
                }

                // HACK: workaround for GNOME 2nd+ copy mangling mimetypes https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/8233
                // In theory GNOME or XWayland should auto-convert this back to UTF8_STRING for legacy apps when it's needed https://gitlab.gnome.org/GNOME/gtk/-/merge_requests/5300
                const mimetype = type === "UTF8_STRING" ? "text/plain;charset=utf-8" : type;

                // New images are written to the cache by _refreshIndicator,
                // only once they are known not to be duplicates.
                resolve(new ClipboardEntry(mimetype, bytes, false));
            });
        });
    }

    async #getClipboardContent () {
        const mimetypes = [
            "text/plain;charset=utf-8",
            "UTF8_STRING",
            "text/plain",
            "STRING",
            'image/gif',
            'image/png',
            'image/jpg',
            'image/jpeg',
            'image/webp',
            'image/svg+xml',
            'text/html',
        ];

        for (let type of mimetypes) {
            const result = await this.#readClipboard(type);

            // The owner did not answer: give up on this change entirely
            // rather than waiting again for each remaining mimetype.
            if (result === CLIPBOARD_READ_TIMED_OUT) {
                return null;
            }

            if (result) {
                if (!CACHE_IMAGES && result.isImage()) {
                    return null;
                }
                else {
                    return result;
                }
            }
        }

        return null;
    }
});
