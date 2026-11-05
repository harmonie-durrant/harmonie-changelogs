import { marked } from 'marked';

// Key in Home Assistant's per-user frontend storage (synced across devices).
// Value shape: { "<entity>|<attribute>": "<hash of the content the user saw>" }
const USER_DATA_KEY = 'harmonie_changelogs_seen';
// Older versions stored a "last viewed" timestamp per browser here.
const LEGACY_LAST_VIEWED_KEY = 'changelog_last_viewed';

const DEFAULT_TITLE = 'Changelog';
const DEFAULT_BUTTON_TEXT = 'Show changelog';

// cyrb53: small, fast, non-cryptographic string hash. crypto.subtle is not
// an option: it's unavailable when HA is served over plain http on a LAN.
function hashContent(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function fireEvent(node, type, detail) {
    node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

const CARD_STYLES = `
    [hidden] {
        display: none !important;
    }

    .open-button {
        width: 100%;
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

    .footer {
        display: flex;
        justify-content: flex-end;
        width: 100%;
    }

    .changelog-content {
        color: var(--primary-text-color);
        line-height: 1.5;
    }

    .changelog-content > :first-child {
        margin-top: 0;
    }

    .changelog-content h1 {
        font-size: 1.5em;
        margin: 0.5em 0;
    }

    .changelog-content h2 {
        font-size: 1.3em;
        margin: 0.5em 0;
    }

    .changelog-content h3 {
        font-size: 1.1em;
        margin: 0.5em 0;
    }

    .changelog-content ul, .changelog-content ol {
        margin: 0.5em 0;
        padding-left: 1.5em;
    }

    .changelog-content p {
        margin: 0.5em 0;
    }

    .changelog-content a {
        color: var(--primary-color);
    }

    .changelog-content code {
        background-color: var(--code-background-color, var(--secondary-background-color));
        padding: 0.2em 0.4em;
        border-radius: 3px;
        font-family: var(--code-font-family, monospace);
    }

    .changelog-content pre {
        background-color: var(--code-background-color, var(--secondary-background-color));
        padding: 1em;
        border-radius: 4px;
        overflow-x: auto;
    }

    .changelog-content blockquote {
        border-left: 4px solid var(--divider-color);
        margin: 0.5em 0;
        padding-left: 1em;
        color: var(--secondary-text-color);
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
        this._checkedHash = null;
        this._currentHash = null;
        this._renderedContent = null;

        // Built once. Config and state changes only update this DOM.
        this.attachShadow({ mode: 'open' });
        this.shadowRoot.innerHTML = `
            <style>${CARD_STYLES}</style>
            <ha-alert alert-type="warning" hidden></ha-alert>
            <div class="placeholder" hidden>
                <ha-icon icon="mdi:text-box-outline"></ha-icon>
                <span>Changelog popup (button hidden on the dashboard)</span>
            </div>
            <ha-button class="open-button"></ha-button>
            <ha-dialog>
                <div class="changelog-content"></div>
                <div slot="footer" class="footer">
                    <ha-button class="dismiss">Dismiss</ha-button>
                </div>
            </ha-dialog>
        `;
        this._alert = this.shadowRoot.querySelector('ha-alert');
        this._placeholder = this.shadowRoot.querySelector('.placeholder');
        this._button = this.shadowRoot.querySelector('.open-button');
        this._dialog = this.shadowRoot.querySelector('ha-dialog');
        this._content = this.shadowRoot.querySelector('.changelog-content');

        this._button.addEventListener('click', () => this._openDialog());
        this.shadowRoot.querySelector('.dismiss')
            .addEventListener('click', () => { this._dialog.open = false; });
        // ha-dialog doesn't reset `open` when closed with its X button,
        // Escape or a click outside, which would stop it from reopening.
        this._dialog.addEventListener('closed', () => { this._dialog.open = false; });
    }

    setConfig(config) {
        if (!config) {
            throw new Error('Invalid configuration');
        }
        const entityChanged = config.entity !== this._config.entity
            || config.attribute !== this._config.attribute;
        this._config = { ...config };
        if (entityChanged) {
            this._hasAutoOpened = false;
            this._checkedHash = null;
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

    getCardSize() {
        return this._config.hide_button ? 0 : 1;
    }

    getGridOptions() {
        return this._config.hide_button
            ? { columns: 'full', rows: 'auto' }
            : { columns: 6, rows: 1, min_rows: 1 };
    }

    // Changelog text: the entity's state, or one of its attributes. Attributes
    // aren't capped at 255 characters like states are.
    _getContent(state) {
        if (this._config.attribute) {
            const value = state.attributes?.[this._config.attribute];
            return value === undefined || value === null ? '' : String(value);
        }
        if (['unknown', 'unavailable'].includes(state.state)) return '';
        return state.state || '';
    }

    _getWarning(state) {
        const { entity, attribute } = this._config;
        if (!entity) return 'Choose the entity that holds your changelog in the card editor.';
        if (!this._hass) return '';
        if (!state) return `Entity not found: ${entity}`;
        if (attribute && !(attribute in state.attributes)) {
            return `Attribute "${attribute}" not found on ${entity}`;
        }
        return '';
    }

    _update() {
        const { entity, hide_button, button_text, title } = this._config;
        const state = entity && this._hass ? this._hass.states[entity] : undefined;
        const content = state ? this._getContent(state) : '';

        const warning = this._getWarning(state);
        this._alert.textContent = warning;
        this._alert.hidden = !warning;

        this._button.textContent = button_text || DEFAULT_BUTTON_TEXT;
        this._button.hidden = Boolean(hide_button);
        this._button.disabled = !content;
        this._placeholder.hidden = !(hide_button && this._isEditing);
        this._dialog.headerTitle = title || DEFAULT_TITLE;

        if (content !== this._renderedContent) {
            this._renderedContent = content;
            this._content.innerHTML = this._renderMarkdown(content);
        }

        this._currentHash = content ? hashContent(content) : null;
        if (this._currentHash && !this._isEditing) {
            this._maybeAutoOpen(state, this._currentHash);
        }
    }

    _renderMarkdown(content) {
        if (!content) return '';
        // input_text can't hold real newlines, so allow a literal "\n".
        const text = content.replace(/\\n/g, '\n');
        try {
            return marked.parse(text, { breaks: true, gfm: true });
        } catch (error) {
            console.error('changelog-card: failed to parse markdown', error);
            const escaped = document.createElement('div');
            escaped.textContent = text;
            return escaped.innerHTML.replace(/\n/g, '<br>');
        }
    }

    // One entry per entity/attribute, so several changelog cards don't share "seen" state.
    get _seenKey() {
        return `${this._config.entity}|${this._config.attribute || ''}`;
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

    // Older versions stored a per-browser "last viewed" timestamp. Treat the
    // current changelog as seen if it hasn't changed since then.
    _seenBeforeUpgrade(state) {
        const lastViewed = parseInt(localStorage.getItem(LEGACY_LAST_VIEWED_KEY) || '0');
        return lastViewed > 0 && new Date(state.last_updated).getTime() <= lastViewed;
    }

    async _maybeAutoOpen(state, hash) {
        if (this._hasAutoOpened) return;
        // Only check each version of the content once, not on every hass update.
        if (hash === this._checkedHash) return;
        this._checkedHash = hash;

        const seen = await this._loadSeen();
        if (!seen || seen[this._seenKey] === hash) return;

        if (seen[this._seenKey] === undefined && this._seenBeforeUpgrade(state)) {
            await this._saveSeen(hash);
            return;
        }

        // Content may have changed, the dialog opened, or editing started while we waited.
        if (this._hasAutoOpened || this._checkedHash !== hash || this._isEditing) return;
        this._hasAutoOpened = true;
        this._openDialog();
    }

    _openDialog() {
        if (!this._currentHash) return;
        this._dialog.open = true;
        this._saveSeen(this._currentHash);
    }
}


const EDITOR_LABELS = {
    entity: 'Entity',
    attribute: 'Attribute (optional)',
    title: 'Popup title (optional)',
    hide_button: 'Hide button',
    button_text: 'Button text (optional)',
};

const EDITOR_HELPERS = {
    entity: 'The entity that holds your changelog. Markdown is supported.',
    attribute: 'Read the changelog from an attribute instead of the state. Attributes aren\'t limited to 255 characters.',
    title: `Defaults to "${DEFAULT_TITLE}".`,
    hide_button: 'The popup still opens automatically when the changelog changes.',
    button_text: `Defaults to "${DEFAULT_BUTTON_TEXT}".`,
};

const OPTIONAL_TEXT_KEYS = ['attribute', 'title', 'button_text'];

export class ChangelogCardEditor extends HTMLElement {
    constructor() {
        super();
        this._config = {};
        this._hass = null;
        this._form = null;
    }

    set hass(hass) {
        this._hass = hass;
        if (this._form) this._form.hass = hass;
    }

    setConfig(config) {
        this._config = { ...config };
        this._render();
    }

    _schema(config) {
        return [
            { name: 'entity', required: true, selector: { entity: {} } },
            {
                name: 'attribute',
                selector: { attribute: {} },
                context: { filter_entity: 'entity' },
            },
            { name: 'title', selector: { text: {} } },
            {
                name: 'button',
                type: 'expandable',
                flatten: true,
                expanded: true,
                title: 'Button',
                icon: 'mdi:gesture-tap-button',
                schema: [
                    { name: 'hide_button', selector: { boolean: {} } },
                    ...(config.hide_button ? [] : [{ name: 'button_text', selector: { text: {} } }]),
                ],
            },
        ];
    }

    async _render() {
        if (!this._form) {
            await this._loadHaForm();
            if (this._form) return this._render();
            this._form = document.createElement('ha-form');
            this._form.computeLabel = (schema) => EDITOR_LABELS[schema.name] ?? schema.title ?? schema.name;
            this._form.computeHelper = (schema) => EDITOR_HELPERS[schema.name];
            this._form.addEventListener('value-changed', (event) => this._valueChanged(event));
            this.appendChild(this._form);
        }
        this._form.hass = this._hass;
        this._form.data = this._config;
        this._form.schema = this._schema(this._config);
    }

    // ha-form is lazy-loaded by Home Assistant. Loading a built-in card's
    // editor guarantees it's defined.
    async _loadHaForm() {
        if (customElements.get('ha-form')) return;
        try {
            const helpers = await window.loadCardHelpers();
            const card = await helpers.createCardElement({ type: 'entity', entity: 'sun.sun' });
            await card.constructor.getConfigElement();
        } catch (error) {
            console.warn('changelog-card: could not preload ha-form', error);
        }
        await customElements.whenDefined('ha-form');
    }

    _valueChanged(event) {
        event.stopPropagation();
        const config = { ...event.detail.value };

        // An attribute picked for the previous entity probably doesn't exist on the new one.
        if (config.entity !== this._config.entity && config.attribute) {
            const state = this._hass?.states[config.entity];
            if (!state || !(config.attribute in state.attributes)) delete config.attribute;
        }
        // Keep the YAML tidy: drop empty and default values.
        OPTIONAL_TEXT_KEYS.forEach((key) => {
            if (!config[key]) delete config[key];
        });
        if (!config.hide_button) delete config.hide_button;
        if (config.hide_button) delete config.button_text;

        this._config = config;
        this._render();
        fireEvent(this, 'config-changed', { config });
    }
}
