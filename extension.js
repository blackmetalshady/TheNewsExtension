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

const NEWS_API_URL = 'https://saurav.tech/NewsAPI/top-headlines';

const CATEGORIES = [
    { id: 'general', name: 'General' },
    { id: 'technology', name: 'Technology' },
    { id: 'business', name: 'Business' },
    { id: 'entertainment', name: 'Entertainment' },
    { id: 'health', name: 'Health' },
    { id: 'science', name: 'Science' },
    { id: 'sports', name: 'Sports' }
];
// Helper to create the visual card for an article
class ArticleCard extends St.Button {
    static {
        GObject.registerClass(this);
    }

    _init(article, extensionDir) {
        super._init({
            style_class: 'article-item',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.FILL, // IMPORTANT: Aligns content to fill
            reactive: true,
            can_focus: true,
            track_hover: true
        });

        // Hover Hand Cursor
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

        // Main container (Horizontal)
        this._box = new St.BoxLayout({
            style_class: 'article-box',
            x_expand: true
        });
        this.set_child(this._box);

        // Left: Image Bin
        this._iconBin = new St.Bin({
            style_class: 'article-image-bin',
            x_expand: false,
            y_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Placeholder icon
        this._icon = new St.Icon({
            icon_name: 'image-missing',
            icon_size: 60, // Slightly larger placeholder
            style_class: 'article-image-placeholder'
        });
        this._iconBin.set_child(this._icon);
        this._box.add_child(this._iconBin);

        // Right: Content (Vertical)
        this._contentBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'article-content-box',
            y_align: Clutter.ActorAlign.CENTER
        });
        this._box.add_child(this._contentBox);

        // Title
        let title = this._truncateText(article.title || 'No Title');
        let titleLabel = new St.Label({
            text: title,
            style_class: 'article-title',
            x_expand: true // Ensure it takes available width
        });
        titleLabel.clutter_text.line_wrap = true;
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleLabel.clutter_text.maximum_width_chars = 40; // Prevent super wide text breaking layout
        this._contentBox.add_child(titleLabel);

        // Meta: Date | Publisher
        let dateStr = article.publishedAt ? article.publishedAt.split('T')[0] : '';
        let publisher = article.source && article.source.name ? article.source.name : 'Unknown';
        let metaLabel = new St.Label({
            text: `${dateStr} • ${publisher}`,
            style_class: 'article-meta'
        });
        this._contentBox.add_child(metaLabel);

        let descriptionLabel = new St.Label({
            text: this._truncateText(article.description) || 'No description',
            style_class: 'article-description'
        });
        this._contentBox.add_child(descriptionLabel);

        // Initialize with default image
        this._setDefaultImage();

        // Load Image asynchronously
        if (article.urlToImage) {
            this._loadImage(article.urlToImage);
        }
    }

    _setDefaultImage() {
        if (!this._extensionDir) return;

        let imagePath = this._extensionDir.get_child('data').get_child('images').get_child('default.png');
        let imageUri = imagePath.get_uri(); // Use URI for file loading if needed, or stream

        // Load local file as stream
        let file = Gio.File.new_for_path(imagePath.get_path());

        file.read_async(GLib.PRIORITY_DEFAULT, this._cancellable, (f, res) => {
            if (this._cancellable.is_cancelled()) return;
            try {
                let stream = f.read_finish(res);
                this._processImageStream(stream, 'local-default-image');
            } catch (e) {
                console.error('Failed to load default image:', e);
                // Fallback to icon if file fails
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
        // Original Aspect Ratio Logic
        let width = pixbuf.get_width();
        let height = pixbuf.get_height();

        // Constraints
        let maxWidth = 100;
        let maxHeight = 70;

        // Calculate scale to FIT within box (Math.min)
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
                //this._setDefaultImage();
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

            // Load Custom Icon
            let iconPath = extension.dir.get_child('data').get_child('icons').get_child('search-global-symbolic.svg');
            let gicon = new Gio.FileIcon({ file: iconPath });

            // Icon
            this.add_child(new St.Icon({
                gicon: gicon,
                style_class: 'system-status-icon',
            }));

            // HTTP Session
            this._session = new Soup.Session();

            // --- Menu Layout ---

            // Header Section
            let headerItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'news-header'
            });

            // Allow header to expand
            headerItem.actor.set_x_expand(true);
            headerItem.actor.set_x_align(Clutter.ActorAlign.FILL);

            // Header Layout
            let headerBox = new St.BoxLayout({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER
            });
            headerItem.add_child(headerBox);

            // Title
            this._titleLabel = new St.Label({
                text: _('Top Headlines'),
                style_class: 'header-title',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true
            });
            headerBox.add_child(this._titleLabel);

            // Refresh Button
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

            // Settings Button
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

            // Scrollable Container Item (Holds the stack)
            this._scrollContainerItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });
            this._scrollContainerItem.actor.set_x_expand(true);
            this._scrollContainerItem.actor.set_x_align(Clutter.ActorAlign.FILL);
            this.menu.addMenuItem(this._scrollContainerItem);

            // We use a BoxLayout to stack News and Settings (showing only one)
            this._mainContent = new St.BoxLayout({
                vertical: true,
                x_expand: true
            });
            this._scrollContainerItem.add_child(this._mainContent);

            // News View (ScrollView)
            this._scrollView = new St.ScrollView({
                style_class: 'news-scroll-view',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                enable_mouse_scrolling: true
            });

            this._newsList = new St.BoxLayout({
                vertical: true,
                x_expand: true // Ensure children take full width
            });

            this._scrollView.set_child(this._newsList);
            this._mainContent.add_child(this._scrollView);

            // Initialize Settings
            this._settings = extension.getSettings();

            // Settings View (Hidden by default)
            this._settingsPanel = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                visible: false,
                style_class: 'settings-panel'
            });
            this._buildSettingsPanel();
            this._mainContent.add_child(this._settingsPanel);


            // Fetch on open if empty (only if showing news)
            this.menu.connect('open-state-changed', (menu, open) => {
                if (open) {
                    if (this._scrollView.visible && this._newsList.get_n_children() === 0) {
                        this._fetchNews();
                    }
                }
            });

            // Initialize fetching state
            this._isFetching = false;
            // Preload data asynchronously
            this._fetchNews();
        }

        _buildSettingsPanel() {
            let label = new St.Label({
                text: _('Select Categories'),
                style: 'font-weight: bold; padding-bottom: 10px; font-size: 1.1em;'
            });
            this._settingsPanel.add_child(label);

            let currentCategories = this._settings ? this._settings.get_strv('categories') : ['general'];
            // Handle case where settings might not be loaded yet or empty defaults
            if (!this._settings) currentCategories = ['general'];

            for (let category of CATEGORIES) {
                let row = new St.BoxLayout({
                    style_class: 'popup-menu-item',
                    reactive: true,
                    can_focus: true,
                    style: 'padding: 8px 0;'
                });

                let categoryLabel = new St.Label({
                    text: category.name,
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER
                });
                row.add_child(categoryLabel);

                let isChecked = currentCategories.includes(category.id);

                let toggleIcon = new St.Icon({
                    icon_name: isChecked ? 'checkbox-checked-symbolic' : 'checkbox-symbolic',
                    style_class: 'popup-menu-icon'
                });

                let toggleBtn = new St.Button({
                    child: toggleIcon,
                    reactive: true,
                    can_focus: true,
                    x_align: Clutter.ActorAlign.END
                });

                // Toggle Logic
                toggleBtn.connect('clicked', () => {
                    let current = this._settings.get_strv('categories');
                    if (current.includes(category.id)) {
                        current = current.filter(id => id !== category.id);
                        toggleIcon.icon_name = 'checkbox-symbolic';
                    } else {
                        current.push(category.id);
                        toggleIcon.icon_name = 'checkbox-checked-symbolic';
                    }
                    this._settings.set_strv('categories', current);
                });

                row.add_child(toggleBtn);
                this._settingsPanel.add_child(row);
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
                this._fetchNews();
            } else {
                // Switch to Settings
                this._scrollView.hide();
                this._settingsPanel.show();
                this._titleLabel.text = _('Settings');
                this._settingsButton.icon_name = 'go-previous-symbolic';
            }
        }

        _fetchNewsFromSource(category) {
            // NewsAPI requires country when source is not specified.
            let url = `${NEWS_API_URL}/category/${category.id}/us.json`;
            console.log(url);
            return new Promise((resolve, reject) => {
                let message = Soup.Message.new('GET', url);
                // Set User-Agent to avoid 400/403 from some APIs
                message.request_headers.append('User-Agent', 'gnome-shell-extension-technews/1.0');

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
                    style: 'padding: 10px; opacity: 0.7;'
                });
                this._newsList.add_child(loadingLabel);

                // Read 'categories' setting instead of 'sources'
                let selectedCategoryIds = this._settings ? this._settings.get_strv('categories') : [];
                console.log(`[TechNews] Raw settings categories: ${JSON.stringify(selectedCategoryIds)}`);

                // Default to 'general' if empty or not set
                if (!selectedCategoryIds || selectedCategoryIds.length === 0) {
                    console.log('[TheNews] Categories empty, defaulting to general');
                    selectedCategoryIds = ['general'];
                }

                // Filter CATEGORIES objects based on saved IDs
                let categoriesToFetch = CATEGORIES.filter(c => selectedCategoryIds.includes(c.id));
                console.log(`[TechNews] Fetching categories: ${categoriesToFetch.map(c => c.id).join(', ')}`);

                if (categoriesToFetch.length === 0) {
                    this._newsList.destroy_all_children();
                    this._newsList.add_child(new St.Label({ text: _('No categories selected. Please check settings.'), style: 'padding: 10px;' }));
                    return;
                }

                try {
                    // Fetch selected categories in parallel
                    let results = await Promise.all(categoriesToFetch.map(category => this._fetchNewsFromSource(category)));

                    // Flatten and Sort
                    let allArticles = results.flat();
                    // Filter out invalid dates or sort
                    allArticles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

                    if (!this._newsList) return; // In case destroyed during fetch
                    this._newsList.destroy_all_children();

                    if (allArticles.length === 0) {
                        this._newsList.add_child(new St.Label({
                            text: _('No news found from selected categories'),
                            style: 'padding: 10px;'
                        }));
                    }

                    for (let article of allArticles) {
                        // Pass extension directory to ArticleCard
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

export default class TechNewsExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}