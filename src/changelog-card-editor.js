import { localize } from './localize.js';
import { ensureHaElement, fireEvent } from './helpers.js';

const OPTIONAL_TEXT_KEYS = ['attribute', 'url', 'title', 'button_text'];
// Order of keys in the saved YAML. Unknown keys (grid_options, ...) go last.
const KEY_ORDER = ['type', 'entity', 'attribute', 'url', 'title', 'hide_button', 'auto_open', 'button_text'];

function orderKeys(config) {
    const ordered = {};
    KEY_ORDER.forEach((key) => {
        if (key in config) ordered[key] = config[key];
    });
    return { ...ordered, ...config };
}

export class ChangelogCardEditor extends HTMLElement {
    constructor() {
        super();
        this._config = {};
        this._hass = null;
        this._form = null;
        this._formLoading = null;
        // "entity" or "file". Kept here because a freshly picked "file" source
        // has no url in the config yet.
        this._source = null;
    }

    set hass(hass) {
        this._hass = hass;
        if (this._form) this._form.hass = hass;
    }

    setConfig(config) {
        this._config = { ...config };
        if (config.url) {
            this._source = 'file';
        } else if (config.entity || !this._source) {
            this._source = 'entity';
        }
        this._render();
    }

    _t(key, vars) {
        return localize(this._hass, key, vars);
    }

    _schema(config) {
        const sourceFields = this._source === 'file'
            ? [{ name: 'url', required: true, selector: { text: {} } }]
            : [
                { name: 'entity', required: true, selector: { entity: {} } },
                { name: 'attribute', selector: { attribute: {} }, context: { filter_entity: 'entity' } },
            ];
        return [
            {
                name: 'source',
                selector: {
                    select: {
                        mode: 'box',
                        options: [
                            { value: 'entity', label: this._t('editor.source.entity') },
                            { value: 'file', label: this._t('editor.source.file') },
                        ],
                    },
                },
            },
            ...sourceFields,
            { name: 'title', selector: { text: {} } },
            {
                name: 'behaviour',
                type: 'expandable',
                flatten: true,
                expanded: true,
                title: this._t('editor.behaviour.title'),
                icon: 'mdi:gesture-tap-button',
                schema: [
                    { name: 'hide_button', selector: { boolean: {} } },
                    ...(config.hide_button ? [] : [
                        { name: 'auto_open', selector: { boolean: {} } },
                        { name: 'button_text', selector: { text: {} } },
                    ]),
                ],
            },
        ];
    }

    _computeLabel(schema) {
        if (schema.type === 'expandable') return schema.title;
        return this._t(`editor.${schema.name}.label`);
    }

    _computeHelper(schema) {
        if (schema.type === 'expandable') return undefined;
        const defaults = {
            title: this._t('card.default_title'),
            button_text: this._t('card.default_button_text'),
        };
        return this._t(`editor.${schema.name}.helper`, { default: defaults[schema.name] });
    }

    async _render() {
        if (!this._form) {
            this._formLoading ??= ensureHaElement('ha-form', { type: 'entity', entity: 'sun.sun' }, true);
            await this._formLoading;
            if (!this._form) {
                this._form = document.createElement('ha-form');
                this._form.computeLabel = (schema) => this._computeLabel(schema);
                this._form.computeHelper = (schema) => this._computeHelper(schema);
                this._form.addEventListener('value-changed', (event) => this._valueChanged(event));
                this.appendChild(this._form);
            }
        }
        this._form.hass = this._hass;
        this._form.data = {
            ...this._config,
            source: this._source,
            auto_open: this._config.auto_open !== false,
        };
        this._form.schema = this._schema(this._config);
    }

    _valueChanged(event) {
        event.stopPropagation();
        const { source, ...config } = event.detail.value;

        if (source !== this._source) {
            this._source = source;
            if (source === 'file') {
                delete config.entity;
                delete config.attribute;
            } else {
                delete config.url;
            }
        }

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
        if (config.auto_open !== false) delete config.auto_open;
        if (config.hide_button) {
            // A hidden button always opens automatically and has no text.
            delete config.auto_open;
            delete config.button_text;
        }

        this._config = orderKeys(config);
        this._render();
        fireEvent(this, 'config-changed', { config: this._config });
    }
}
