import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Pango from 'gi://Pango';
import Meta from 'gi://Meta';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { NEWS_API_URL, CATEGORIES } from './config.js';

class ArticleCard extends St.Button {
    static {
        GObject.registerClass(this);
    }

    _init(article, extensionDir) {
        super._init({
            style_class: 'article-item',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.FILL,
            reactive: true,
            can_focus: true,
            track_hover: true
        });

        this.connect('enter-event', () => {
            global.display.set_cursor(Meta.Cursor.POINTING_HAND);
        });
        this.connect('leave-event', () => {
            global.display.set_cursor(Meta.Cursor.DEFAULT);
        });

        this._extensionDir = extensionDir;

        this._cancellable = new Gio.Cancellable();
        this.connect('destroy', () => {
            this._cancellable.cancel();
        });

        this.article = article;

        this._box = new St.BoxLayout({
            style_class: 'article-box',
            x_expand: true
        });
        this.set_child(this._box);

        this._iconBin = new St.Bin({
            style_class: 'article-image-bin',
            x_expand: false,
            y_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._icon = new St.Icon({
            icon_name: 'image-missing',
            icon_size: 60,
            style_class: 'article-image-placeholder'
        });
        this._iconBin.set_child(this._icon);
        this._box.add_child(this._iconBin);

        this._contentBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'article-content-box',
            y_align: Clutter.ActorAlign.CENTER
        });
        this._box.add_child(this._contentBox);

        let title = this._truncateText(article.title || 'No Title');
        let titleLabel = new St.Label({
            text: title,
            style_class: 'article-title',
            x_expand: true
        });
        titleLabel.clutter_text.line_wrap = true;
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleLabel.clutter_text.maximum_width_chars = 40;
        this._contentBox.add_child(titleLabel);

        let dateStr = article.publishedAt ? article.publishedAt.split('T')[0] : '';
        let publisher = article.source && article.source.name ? article.source.name : 'Unknown';
        let metaLabel = new St.Label({
            text: `${dateStr} | ${publisher}`,
            style_class: 'article-meta'
        });
        this._contentBox.add_child(metaLabel);

        let descriptionLabel = new St.Label({
            text: this._truncateText(article.description) || 'No description',
            style_class: 'article-description'
        });
        this._contentBox.add_child(descriptionLabel);

        this._setDefaultImage();

        if (article.urlToImage) {
            this._loadImage(article.urlToImage);
        }
    }

    _setDefaultImage() {
        if (!this._extensionDir) return;

        let imagePath = this._extensionDir.get_child('data').get_child('images').get_child('default.png');
        let imageUri = imagePath.get_uri();

        let file = Gio.File.new_for_path(imagePath.get_path());

        file.read_async(GLib.PRIORITY_DEFAULT, this._cancellable, (f, res) => {
            if (this._cancellable.is_cancelled()) return;
            try {
                let stream = f.read_finish(res);
                this._processImageStream(stream, 'local-default-image');
            } catch (e) {
                console.error('Failed to load default image:', e);
                this._icon = new St.Icon({
                    icon_name: 'image-missing',
                    icon_size: 60,
                    style_class: 'article-image-placeholder'
                });
                this._iconBin.set_child(this._icon);
            }
        });
    }

    _processImageStream(stream, url = 'unknown') {
        GdkPixbuf.Pixbuf.new_from_stream_async(stream, null, (src, res) => {
            if (this._cancellable.is_cancelled()) return;
            try {
                let pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(res);
                this._displayPixbuf(pixbuf);
            } catch (e) {
                console.warn(`Failed to process image stream from ${url}: ${e.message}`);
            }
        });
    }

    _displayPixbuf(pixbuf) {
        let width = pixbuf.get_width();
        let height = pixbuf.get_height();

        let maxWidth = 100;
        let maxHeight = 70;

        let ratio = Math.min(maxWidth / width, maxHeight / height);
        let newWidth = Math.floor(width * ratio);
        let newHeight = Math.floor(height * ratio);

        let scaled = pixbuf.scale_simple(newWidth, newHeight, GdkPixbuf.InterpType.BILINEAR);

        let imageContent = new Clutter.Image();
        let success = imageContent.set_data(
            scaled.get_pixels(),
            scaled.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
            scaled.get_width(),
            scaled.get_height(),
            scaled.get_rowstride()
        );

        if (success && this._iconBin && this._iconBin.get_parent()) {
            let texture = new St.Widget({
                width: newWidth,
                height: newHeight,
                style_class: 'article-image'
            });
            texture.set_content(imageContent);
            this._iconBin.set_child(texture);
        }
    }

    _loadImage(url) {
        let session = new Soup.Session();
        let message = Soup.Message.new('GET', url);

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (sess, result) => {
            if (this._cancellable.is_cancelled()) return;
            try {
                let bytes = sess.send_and_read_finish(result);

                if (message.get_status() !== 200) {
                    console.warn(`Image load failed (HTTP ${message.get_status()}): ${url}`);
                    this._setDefaultImage();
                    return;
                }

                let contentType = message.response_headers.get_one('content-type');
                if (contentType && !contentType.startsWith('image/')) {
                    console.warn(`Skipping invalid image content-type '${contentType}' for ${url}`);
                    this._setDefaultImage();
                    return;
                }

                let stream = Gio.MemoryInputStream.new_from_bytes(bytes);

                this._processImageStream(stream, url);

            } catch (e) {
                console.error('Image fetch failed:', e);
            }
        });
    }

    _truncateText(description) {
        if (!description) return '';
        return description.length > 100 ? description.substring(0, 100) + '...' : description;
    }
}

const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {

        _init(extension) {
            super._init(0.0, _('Top Headlines'));

            this._extension = extension;

            let iconPath = extension.dir.get_child('data').get_child('icons').get_child('search-global-symbolic.svg');
            let gicon = new Gio.FileIcon({ file: iconPath });

            this.add_child(new St.Icon({
                gicon: gicon,
                style_class: 'system-status-icon',
            }));

            this._session = new Soup.Session();

            // --- Menu Layout ---

            let headerItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'news-header'
            });

            headerItem.actor.set_x_expand(true);
            headerItem.actor.set_x_align(Clutter.ActorAlign.FILL);

            let headerBox = new St.BoxLayout({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER
            });
            headerItem.add_child(headerBox);

            this._titleLabel = new St.Label({
                text: _('Top Headlines'),
                style_class: 'header-title',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true
            });
            headerBox.add_child(this._titleLabel);

            this._refreshButton = new St.Button({
                reactive: true,
                can_focus: true,
                style_class: 'refresh-button',
                child: new St.Icon({
                    icon_name: 'view-refresh-symbolic',
                    style_class: 'system-status-icon',
                })
            });
            this._refreshButton.connect('clicked', () => {
                this._fetchNews();
            });

            this._settingsButton = new St.Button({
                reactive: true,
                can_focus: true,
                style_class: 'settings-button',
                child: new St.Icon({
                    icon_name: 'system-settings-symbolic',
                    style_class: 'system-settings-icon',
                })
            });
            this._settingsButton.connect('clicked', () => {
                this._toggleSettings();
            });
            headerBox.add_child(this._refreshButton);
            headerBox.add_child(this._settingsButton);

            this.menu.addMenuItem(headerItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // --- Main Content Stack ---

            this._scrollContainerItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });
            this._scrollContainerItem.actor.set_x_expand(true);
            this._scrollContainerItem.actor.set_x_align(Clutter.ActorAlign.FILL);
            this.menu.addMenuItem(this._scrollContainerItem);

            this._mainContent = new St.BoxLayout({
                vertical: true,
                x_expand: true
            });
            this._scrollContainerItem.add_child(this._mainContent);

            this._scrollView = new St.ScrollView({
                style_class: 'news-scroll-view',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                enable_mouse_scrolling: true
            });

            this._newsList = new St.BoxLayout({
                vertical: true,
                x_expand: true
            });

            this._scrollView.set_child(this._newsList);
            this._mainContent.add_child(this._scrollView);
            this._settings = extension.getSettings();

            this._settingsPanel = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                visible: false,
                style_class: 'settings-panel'
            });
            this._buildSettingsPanel();
            this._mainContent.add_child(this._settingsPanel);


            this.menu.connect('open-state-changed', (menu, open) => {
                if (open) {
                    if (this._scrollView.visible && this._newsList.get_n_children() === 0) {
                        this._fetchNews();
                    }
                }
            });

            this._isFetching = false;
            this._fetchNews();
        }

        _buildSettingsPanel() {
            let label = new St.Label({
                text: _('Select Categories'),
                style_class: 'settings-label',
            });
            this._settingsPanel.add_child(label);

            this._categoryToggles = {};

            let currentCategories = this._settings ? this._settings.get_strv('categories') : ['general'];
            if (!this._settings || !currentCategories || currentCategories.length === 0) {
                currentCategories = ['general'];
            }

            for (let category of CATEGORIES) {
                let row = new St.BoxLayout({
                    style_class: 'popup-menu-item',
                    reactive: true,
                    can_focus: true,
                });

                let categoryLabel = new St.Label({
                    text: category.name,
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER
                });
                row.add_child(categoryLabel);

                let toggleIcon = new St.Icon({
                    icon_name: 'checkbox-symbolic',
                    style_class: 'popup-menu-icon'
                });
                this._categoryToggles[category.id] = toggleIcon;

                let toggleBtn = new St.Button({
                    child: toggleIcon,
                    reactive: true,
                    can_focus: true,
                    x_align: Clutter.ActorAlign.END
                });

                toggleBtn.connect('clicked', () => {
                    this._onCategoryToggle(category.id);
                });

                row.add_child(toggleBtn);
                this._settingsPanel.add_child(row);
            }

            this._updateToggles(currentCategories);
        }

        _onCategoryToggle(clickedId) {
            let currentCategories = this._settings.get_strv('categories');
            if (!currentCategories || currentCategories.length === 0) currentCategories = ['general'];

            let allSpecifics = CATEGORIES.filter(c => c.id !== 'general').map(c => c.id);
            let isDefaultGeneral = (currentCategories.length === 1 && currentCategories[0] === 'general');

            let newSelection = [];

            if (clickedId === 'general') {
                let isAllSelected = allSpecifics.every(id => currentCategories.includes(id));

                if (isAllSelected) {
                    newSelection = ['general'];
                } else {
                    newSelection = [...allSpecifics];
                }
            } else {
                let currentSet = new Set(currentCategories);
                if (isDefaultGeneral) currentSet.clear();

                if (currentSet.has(clickedId)) {
                    currentSet.delete(clickedId);
                } else {
                    currentSet.add(clickedId);
                }
                currentSet.delete('general');

                newSelection = Array.from(currentSet);
                if (newSelection.length === 0) newSelection = ['general'];
            }

            this._settings.set_strv('categories', newSelection);
            this._updateToggles(newSelection);
        }

        _updateToggles(currentCategories) {
            let allSpecifics = CATEGORIES.filter(c => c.id !== 'general').map(c => c.id);
            let isDefaultGeneral = (currentCategories.length === 0 || (currentCategories.length === 1 && currentCategories[0] === 'general'));
            let isAllSelected = allSpecifics.every(id => currentCategories.includes(id));

            for (let category of CATEGORIES) {
                let icon = this._categoryToggles[category.id];
                if (!icon) continue;

                let shouldCheck = false;
                if (category.id === 'general') {
                    shouldCheck = isAllSelected;
                } else {
                    if (isDefaultGeneral) {
                        shouldCheck = false;
                    } else {
                        shouldCheck = currentCategories.includes(category.id);
                    }
                }

                icon.icon_name = shouldCheck ? 'checkbox-checked-symbolic' : 'checkbox-symbolic';
            }
        }

        _toggleSettings() {
            let showingSettings = this._settingsPanel.visible;
            if (showingSettings) {
                // Switch to News
                this._titleLabel.text = _('Top Headlines');
                this._settingsButton.icon_name = 'preferences-system-symbolic';
                this._settingsPanel.hide();
                this._scrollView.show();
                this._refreshButton.show();

                // Check for changes
                let currentCategories = this._settings ? this._settings.get_strv('categories') : [];

                let initial = (this._initialCategories || []).slice().sort();
                let current = (currentCategories || []).slice().sort();

                let changed = initial.length !== current.length || !initial.every((val, index) => val === current[index]);

                if (changed || (this._newsList && this._newsList.get_n_children() === 0)) {
                    this._fetchNews();
                }
            } else {
                // Switch to Settings
                this._initialCategories = this._settings ? this._settings.get_strv('categories') : [];
                this._scrollView.hide();
                this._settingsPanel.show();
                this._refreshButton.hide();
                this._titleLabel.text = _('Settings');
                this._settingsButton.icon_name = 'go-previous-symbolic';
            }
        }

        _fetchNewsFromSource(category) {
            let url = `${NEWS_API_URL}/${category.id}.json`;
            return new Promise((resolve, reject) => {
                let message = Soup.Message.new('GET', url);
                message.request_headers.append('User-Agent', 'gnome-shell-extension-the-news-extension/1.0');

                this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                    try {
                        let bytes = session.send_and_read_finish(result);
                        if (message.get_status() !== 200) {
                            console.warn(`HTTP ${message.get_status()} for category ${category.id} url: ${url}`);
                            resolve([]);
                            return;
                        }
                        let decoder = new TextDecoder();
                        let json = JSON.parse(decoder.decode(bytes.get_data()));
                        resolve(json.articles || []);
                    } catch (e) {
                        console.error(`Failed to fetch ${url}:`, e);
                        resolve([]);
                    }
                });
            });
        }

        async _fetchNews() {
            if (this._isFetching) return;
            this._isFetching = true;

            try {
                if (!this._newsList) return;
                this._newsList.destroy_all_children();

                let loadingLabel = new St.Label({
                    text: _('Loading...'),
                    style_class: 'loading-label',
                });
                this._newsList.add_child(loadingLabel);

                let selectedCategoryIds = this._settings ? this._settings.get_strv('categories') : [];

                if (!selectedCategoryIds || selectedCategoryIds.length === 0) {
                    selectedCategoryIds = ['general'];
                }

                let categoriesToFetch = CATEGORIES.filter(c => selectedCategoryIds.includes(c.id));

                if (categoriesToFetch.length === 0) {
                    this._newsList.destroy_all_children();
                    this._newsList.add_child(new St.Label({ text: _('No categories selected. Please check settings.'), style: 'padding: 10px;' }));
                    return;
                }

                try {
                    let results = await Promise.all(categoriesToFetch.map(category => this._fetchNewsFromSource(category)));

                    let allArticles = results.flat();
                    allArticles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

                    if (!this._newsList) return;
                    this._newsList.destroy_all_children();

                    if (allArticles.length === 0) {
                        this._newsList.add_child(new St.Label({
                            text: _('No news found from selected categories'),
                            style: 'padding: 10px;'
                        }));
                    }

                    for (let article of allArticles) {
                        let card = new ArticleCard(article, this._extension.dir);
                        card.connect('clicked', () => {
                            this.menu.close();
                            Gio.AppInfo.launch_default_for_uri(article.url, null);
                        });
                        this._newsList.add_child(card);
                    }

                } catch (e) {
                    console.error('Error fetching news:', e);
                    if (this._newsList) {
                        this._newsList.destroy_all_children();
                        this._newsList.add_child(new St.Label({
                            text: `Error: ${e.toString()}`,
                            style: 'color: #ffcccc; padding: 10px;'
                        }));
                    }
                }
            } finally {
                this._isFetching = false;
            }
        }

        destroy() {
            if (this._session) {
                this._session.abort();
                this._session = null;
            }
            super.destroy();
        }
    });

export default class TheNewsExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}