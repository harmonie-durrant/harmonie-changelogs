import { localize } from './localize.js';
import { ensureHaElement, hashContent } from './helpers.js';

// Key in Home Assistant's per-user frontend storage (synced across devices).
// Value shape: { "<seen key>": "<hash of the content the user saw>" }
const USER_DATA_KEY = 'harmonie_changelogs_seen';
// Versions up to v0.0.4 stored a "last viewed" timestamp per browser here.
const LEGACY_LAST_VIEWED_KEY = 'changelog_last_viewed';
// How often a markdown file source is re-checked while the dashboard stays open.
const FILE_REFRESH_MS = 10 * 60 * 1000;

const CARD_STYLES = `
    [hidden] {
        display: none !important;
    }

    .button-wrapper {
        position: relative;
    }

    .open-button {
        width: 100%;
    }

    .badge {
        position: absolute;
        top: -3px;
        right: -3px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--accent-color, var(--primary-color));
        border: 2px solid var(--card-background-color, var(--primary-background-color));
        pointer-events: none;
    }

    .placeholder {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        border: 1px dashed var(--divider-color);
        border-radius: var(--ha-card-border-radius, 12px);
        color: var(--secondary-text-color);
    }

    ha-alert {
        display: block;
        margin-bottom: 8px;
    }

    ha-markdown {
        display: block;
    }

    .footer {
        display: flex;
        justify-content: flex-end;
        width: 100%;
    }
`;

export class ChangeLogCard extends HTMLElement {
    static getConfigElement() {
        return document.createElement('changelog-card-editor');
    }

    // Pre-fill the entity when the card is added from the card picker.
    static getStubConfig(hass) {
        const ids = Object.keys(hass?.states || {}).filter((id) => id.startsWith('input_text.'));
        const entity = ids.find((id) => id.includes('changelog')) || ids[0];
        return entity ? { entity } : {};
    }

    constructor() {
        super();
        this._config = {};
        this._hass = null;
        this._editMode = false;
        this._preview = false;
        this._hasAutoOpened = false;
        this._unread = false;
        this._checkedHash = null;
        this._currentHash = null;
        this._renderedContent = null;
        this._fileContent = null;
        this._fileError = null;
        this._fileRequest = 0;
        this._fileTimer = null;

        // Built once. Config and state changes only update this DOM.
        this.attachShadow({ mode: 'open' });
        this.shadowRoot.innerHTML = `
            <style>${CARD_STYLES}</style>
            <ha-alert alert-type="warning" hidden></ha-alert>
            <div class="placeholder" hidden>
                <ha-icon icon="mdi:text-box-outline"></ha-icon>
                <span></span>
            </div>
            <div class="button-wrapper">
                <ha-button class="open-button"></ha-button>
                <span class="badge" hidden></span>
            </div>
            <ha-dialog>
                <ha-markdown breaks></ha-markdown>
                <div slot="footer" class="footer">
                    <ha-button class="dismiss"></ha-button>
                </div>
            </ha-dialog>
        `;
        const $ = (selector) => this.shadowRoot.querySelector(selector);
        this._alert = $('ha-alert');
        this._placeholder = $('.placeholder');
        this._buttonWrapper = $('.button-wrapper');
        this._button = $('.open-button');
        this._badge = $('.badge');
        this._dialog = $('ha-dialog');
        this._markdown = $('ha-markdown');
        this._dismiss = $('.dismiss');

        this._button.addEventListener('click', () => this._openDialog());
        this._dismiss.addEventListener('click', () => { this._dialog.open = false; });
        // ha-dialog doesn't reset `open` when closed with its X button,
        // Escape or a click outside, which would stop it from reopening.
        this._dialog.addEventListener('closed', () => { this._dialog.open = false; });
        this._onVisibilityChange = () => {
            if (document.visibilityState === 'visible') this._loadFile();
        };

        ensureHaElement('ha-markdown', { type: 'markdown', content: '' });
    }

    connectedCallback() {
        document.addEventListener('visibilitychange', this._onVisibilityChange);
        this._loadFile();
        this._syncFileTimer();
    }

    disconnectedCallback() {
        document.removeEventListener('visibilitychange', this._onVisibilityChange);
        clearInterval(this._fileTimer);
        this._fileTimer = null;
    }

    setConfig(config) {
        if (!config) {
            throw new Error('Invalid configuration');
        }
        const sourceChanged = ['entity', 'attribute', 'url']
            .some((key) => config[key] !== this._config[key]);
        this._config = { ...config };
        if (sourceChanged) {
            this._hasAutoOpened = false;
            this._unread = false;
            this._checkedHash = null;
            this._fileContent = null;
            this._fileError = null;
            this._loadFile();
            this._syncFileTimer();
        }
        this._update();
    }

    set hass(hass) {
        this._hass = hass;
        this._update();
    }

    // Set by Home Assistant while the dashboard is being edited.
    set editMode(value) {
        this._editMode = Boolean(value);
        this._update();
    }

    set preview(value) {
        this._preview = Boolean(value);
        this._update();
    }

    get _isEditing() {
        return this._editMode || this._preview || window.location.search.includes('edit=1');
    }

    // With the button hidden, opening automatically is the only way to see the popup.
    get _autoOpen() {
        return Boolean(this._config.hide_button) || this._config.auto_open !== false;
    }

    getCardSize() {
        return this._config.hide_button ? 0 : 1;
    }

    getGridOptions() {
        return this._config.hide_button
            ? { columns: 'full', rows: 'auto' }
            : { columns: 6, rows: 1, min_rows: 1 };
    }

    _t(key, vars) {
        return localize(this._hass, key, vars);
    }

    _syncFileTimer() {
        clearInterval(this._fileTimer);
        this._fileTimer = this._config.url && this.isConnected
            ? setInterval(() => this._loadFile(), FILE_REFRESH_MS)
            : null;
    }

    async _loadFile() {
        const { url } = this._config;
        if (!url) return;
        const request = ++this._fileRequest;
        try {
            // HA's service worker answers /local/ from its cache first
            // (stale-while-revalidate), and HA sends a 31-day cache header.
            // A unique query parameter gets past both.
            const fresh = new URL(url, window.location.origin);
            fresh.searchParams.set('_changelog', Date.now().toString());
            const response = await fetch(fresh, { cache: 'no-cache', credentials: 'same-origin' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            if (request !== this._fileRequest) return;
            this._fileContent = text;
            this._fileError = null;
        } catch (error) {
            if (request !== this._fileRequest) return;
            this._fileContent = null;
            this._fileError = error.message;
        }
        this._update();
    }

    // Changelog text from the markdown file, the entity's state, or one of its
    // attributes. Attributes aren't capped at 255 characters like states are.
    _getContent(state) {
        if (this._config.url) return this._fileContent || '';
        if (!state) return '';
        let value;
        if (this._config.attribute) {
            value = state.attributes?.[this._config.attribute];
            value = value === undefined || value === null ? '' : String(value);
        } else {
            value = ['unknown', 'unavailable'].includes(state.state) ? '' : (state.state || '');
        }
        // input_text can't hold real newlines, so allow a literal "\n".
        return value.replace(/\\n/g, '\n');
    }

    _getWarning(state) {
        const { entity, attribute, url } = this._config;
        if (url) {
            return this._fileError ? this._t('card.warning.file_error', { url, error: this._fileError }) : '';
        }
        if (!entity) return this._t('card.warning.no_source');
        if (!this._hass) return '';
        if (!state) return this._t('card.warning.entity_not_found', { entity });
        if (attribute && !(attribute in state.attributes)) {
            return this._t('card.warning.attribute_not_found', { attribute, entity });
        }
        return '';
    }

    _update() {
        const { entity, url, hide_button, button_text, title } = this._config;
        const state = !url && entity && this._hass ? this._hass.states[entity] : undefined;
        const content = this._getContent(state);

        const warning = this._getWarning(state);
        this._alert.textContent = warning;
        this._alert.hidden = !warning;

        this._button.textContent = button_text || this._t('card.default_button_text');
        this._button.disabled = !content;
        this._buttonWrapper.hidden = Boolean(hide_button);
        this._badge.hidden = !(this._unread && content);
        this._badge.title = this._t('card.unread');
        if (this._unread && content) {
            this._button.setAttribute('aria-label', `${this._button.textContent} (${this._t('card.unread')})`);
        } else {
            this._button.removeAttribute('aria-label');
        }

        this._placeholder.hidden = !(hide_button && this._isEditing);
        this._placeholder.querySelector('span').textContent = this._t('card.hidden_placeholder');
        this._dialog.headerTitle = title || this._t('card.default_title');
        this._dismiss.textContent = this._t('card.dismiss');

        if (content !== this._renderedContent) {
            this._renderedContent = content;
            this._markdown.content = content;
        }

        this._currentHash = content ? hashContent(content) : null;
        if (this._currentHash && this._hass && this._currentHash !== this._checkedHash) {
            this._checkedHash = this._currentHash;
            this._refreshSeen(state, this._currentHash);
        }
    }

    // One entry per source, so several changelog cards don't share "seen" state.
    get _seenKey() {
        const { entity, attribute, url } = this._config;
        return url ? `url:${url}` : `${entity}|${attribute || ''}`;
    }

    async _loadSeen() {
        try {
            const result = await this._hass.callWS({ type: 'frontend/get_user_data', key: USER_DATA_KEY });
            return result?.value || {};
        } catch (error) {
            console.error('changelog-card: failed to read seen state', error);
            return null;
        }
    }

    async _saveSeen(hash) {
        // Re-read first so we don't overwrite entries saved by other cards.
        const seen = await this._loadSeen();
        if (!seen) return;
        seen[this._seenKey] = hash;
        try {
            await this._hass.callWS({ type: 'frontend/set_user_data', key: USER_DATA_KEY, value: seen });
        } catch (error) {
            console.error('changelog-card: failed to save seen state', error);
        }
    }

    // Versions up to v0.0.4 stored a per-browser "last viewed" timestamp. Treat
    // the current changelog as seen if it hasn't changed since then.
    _seenBeforeUpgrade(state) {
        if (!state) return false;
        const lastViewed = parseInt(localStorage.getItem(LEGACY_LAST_VIEWED_KEY) || '0');
        return lastViewed > 0 && new Date(state.last_updated).getTime() <= lastViewed;
    }

    // Work out whether this user has seen the current content, then show the
    // badge or open the popup.
    async _refreshSeen(state, hash) {
        const seen = await this._loadSeen();
        if (!seen || hash !== this._checkedHash) return;

        let unread = seen[this._seenKey] !== hash;
        if (unread && seen[this._seenKey] === undefined && this._seenBeforeUpgrade(state)) {
            await this._saveSeen(hash);
            unread = false;
        }
        // The content may have changed while we were waiting.
        if (hash !== this._checkedHash) return;

        this._unread = unread;
        if (unread && this._autoOpen && !this._isEditing && !this._hasAutoOpened) {
            this._hasAutoOpened = true;
            this._openDialog();
            return;
        }
        this._update();
    }

    _openDialog() {
        const hash = this._currentHash;
        if (!hash) return;
        this._dialog.open = true;
        this._unread = false;
        this._update();
        this._saveSeen(hash);
    }
}
