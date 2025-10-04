export class ChangeLogCard extends HTMLElement {
    static getStubConfig() {
        return { type: 'custom:changelog-card' };
    }

    static async getConfigElement() {
        return document.createElement('changelog-card-editor');
    }

    static get properties() {
        return {
            hass: {},
            _config: {},
            _dialog: {}
        };
    }

    constructor() {
        super();
        this._config = {};
        this._dialog = null;
        this._hass = null;
        this._lastViewedKey = 'changelog_last_viewed';
        this._hasAutoOpened = false;
        this._defaultButtonText = 'Show Changelog';
    }

    setConfig(config) {
        if (!config || !config.entity) {
            throw new Error('Please define an input_text entity');
        }
        // Verify entity exists and is the correct type
        if (this._hass && (!this._hass.states[config.entity] ||
            !this._hass.states[config.entity].entity_id.startsWith('input_text.'))) {
            throw new Error('Entity must be an input_text entity');
        }

        const configChanged = JSON.stringify(this._config) !== JSON.stringify(config);
        this._config = config;

        if (configChanged) {
            this._createCard();
        }
    }

    _checkShouldAutoOpen() {
        if (window.location.search.includes('edit=1')) return false;

        if (this._hasAutoOpened || !this._hass || !this._config.entity) return false;

        const state = this._hass.states[this._config.entity];
        if (!state || !state.last_updated) return false;

        const lastUpdated = new Date(state.last_updated).getTime();
        const lastViewed = parseInt(localStorage.getItem(this._lastViewedKey) || '0');

        return lastUpdated > lastViewed;
    }

    _updateLastViewed() {
        localStorage.setItem(this._lastViewedKey, Date.now().toString());
    }

    set hass(hass) {
        this._hass = hass;
        if (this._config && this._config.entity) {
            this.render();
        }
    }

    async firstUpdated() {
        await this._createCard();
    }

    async _createCard() {
        if (!localStorage.getItem(this._lastViewedKey)) {
            this._updateLastViewed();
        }

        const shadow = this.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
            ha-dialog {
                --mdc-dialog-min-width: 400px;
                --mdc-dialog-max-width: 600px;
                --mdc-dialog-heading-ink-color: var(--primary-text-color);
                --mdc-dialog-content-ink-color: var(--primary-text-color);
                --justify-action-buttons: flex-end;
                --ha-dialog-border-radius: var(--ha-card-border-radius, 12px);
            }

            .heading {
                border-bottom: 1px solid var(--divider-color);
                padding: 16px;
                display: flex;
                align-items: center;
                background: var(--ha-card-header-background, var(--card-background-color, var(--primary-background-color)));
                border-top-left-radius: var(--ha-dialog-border-radius);
                border-top-right-radius: var(--ha-dialog-border-radius);
            }

            .title {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 1.2em;
                font-weight: 500;
                color: var(--ha-card-header-color, var(--primary-text-color));
            }

            .title-icon {
                color: var(--ha-card-header-color, var(--primary-text-color));
                --mdc-icon-size: 24px;
            }

            .content {
                padding: 16px;
            }

            .changelog-content {
                color: var(--primary-text-color);
            }

            .footer {
                padding: 8px;
                border-top: 1px solid var(--divider-color);
                display: flex;
                justify-content: flex-end;
            }
        `;
        const content = document.createElement('div');
        content.innerHTML = `
            <ha-dialog>
                <div class="heading">
                    <ha-icon icon="mdi:text-box-plus-outline" class="title-icon"></ha-icon>
                    <div class="title">Changelog</div>
                </div>

                <div class="content">
                    <div class="changelog-content"></div>
                </div>

                <div slot="primaryAction" class="footer">
                    <ha-button dialogAction="close">Dismiss</ha-button>
                </div>
            </ha-dialog>
        `;

        shadow.appendChild(style);
        shadow.appendChild(content);

        this._dialog = shadow.querySelector('ha-dialog');
        const button = document.createElement('ha-button');
        button.className = 'dash-button';
        button.innerText = this._config.button_text || this._defaultButtonText;
        button.addEventListener('click', () => this._openDialog());
        button.style.display = this._config.hide_button ? 'none' : '';

        shadow.appendChild(button);
    }

    render() {
        if (!this._hass || !this._config || !this._config.entity) {
            console.warn('Incomplete initialization');
            return;
        }

        const entityId = this._config.entity;
        const state = this._hass.states[entityId];

        if (!state) {
            console.error(`Entity ${entityId} not found`);
            const alert = this.shadowRoot?.querySelector('ha-alert');
            if (alert) {
                alert.innerText = `Entity ${entityId} not found`;
                alert.style.display = 'block';
            }
            return;
        }

        const alert = this.shadowRoot?.querySelector('ha-alert');
        if (alert) {
            alert.style.display = 'none';
        }

        const changelogContent = this.shadowRoot?.querySelector('.changelog-content');
        if (changelogContent) {
            changelogContent.innerHTML = state.state ? state.state.replace(/\n/g, '<br>') : '';
        }

        const button = this.shadowRoot?.querySelector('.dash-button');
        if (button) {
            button.disabled = !state.state;
            button.innerText = this._config.button_text || this._defaultButtonText;
            button.style.display = this._config.hide_button ? 'none' : '';
        }
        if (!this._hasAutoOpened && this._checkShouldAutoOpen()) {
            this._hasAutoOpened = true;
            this._openDialog();
        }
    }

    _openDialog() {
        if (!this._dialog) {
            this._dialog = this.shadowRoot.querySelector('ha-dialog');
        }
        if (this._dialog) {
            this._dialog.open = true;
            this._updateLastViewed();
        }
    }
}


export class ChangelogCardEditor extends HTMLElement {
    constructor() {
        super();
        this._config = {};
        this._hass = null;
        this._overridableElements = {};
        this._rendered = false;
        this._currentLanguage = 'en';
        this._card_fields = [
            {
                name: 'entity',
                label: 'Changelog Text Entity',
                type: 'entity',
                required: true,
                description: 'Select an input_text entity that contains your changelog content.',
                selector: { entity: { domain: 'input_text' } }
            },
            {
                name: 'button_text',
                label: 'Button Text',
                type: 'text',
                required: false,
                description: 'Custom text for the changelog button. Leave empty to use the default text.',
            },
            {
                name: 'hide_button',
                label: 'Hide Button',
                type: 'boolean',
                required: false,
                description: 'Hide the changelog button on the dashboard, the changelog will still show up when there are new entries.',
            },
        ];
    }

    set hass(hass) {
        if (!hass) {
            return;
        }
        this._currentLanguage = 'en';
        if (!this._hass || this._hass.entities !== hass.entities) {
            this._hass = hass;
            if (this._rendered) {
                this.render();
            }
        }
    }

    get hass() {
        return this._hass;
    }

    setConfig(config) {
        if (!this._hass) {
            return;
        }
        this._config = config;
        this.loadEntityPicker();
        if (!this._rendered) {
            this._rendered = true;
            this.render();
        }
    }

    _reorderConfig(config) {
        const { grid_options, ...rest } = config;
        return grid_options ? { ...rest, grid_options } : { ...rest };
    }

    _updateConfigProperty(key, value) {
        const newConfig = { ...this._config };
        if (value === '') {
            delete newConfig[key];
        } else {
            newConfig[key] = value;
        }
        this._config = this._reorderConfig(newConfig);

        this.dispatchEvent(new CustomEvent('config-changed', {
            detail: { config: { ...this._config } },
            bubbles: true,
            composed: true
        }));
    }

    _createField({ name, label, type, required = false, description }) {
        let inputElement;
        const value = this._config[name] || '';

        switch (type) {
            case 'entity':
                inputElement = document.createElement('ha-entity-picker');
                inputElement.hass = this._hass;
                break;
            case 'boolean':
                inputElement = document.createElement('ha-switch');
                inputElement.checked = value === true;
                break;
            default:
                inputElement = document.createElement('ha-textfield');
                inputElement.type = 'text';
        }

        inputElement.style.display = 'flex';
        inputElement.required = required;
        inputElement.label = label;
        inputElement.value = value;

        if (type === 'boolean') {
            inputElement.addEventListener('change', (event) => {
                this._updateConfigProperty(name, event.target.checked);
            });
        } else {
            inputElement.addEventListener('value-changed', (event) => {
                const newValue = event.detail?.value || event.target.value;
                this._updateConfigProperty(name, newValue);
            });
        }

        const fieldContainer = document.createElement('div');
        fieldContainer.style.marginBottom = '12px';
        const fieldDescription = document.createElement('span');
        fieldDescription.style.width = '90%';
        fieldDescription.innerText = description;
        fieldDescription.style.fontSize = '12px';
        fieldDescription.style.color = '#888';

        fieldContainer.appendChild(inputElement);
        fieldContainer.appendChild(fieldDescription);

        return fieldContainer;
    }

    async loadEntityPicker() {
        if (!window.customElements.get("ha-entity-picker")) {
            const ch = await window.loadCardHelpers();
            const c = await ch.createCardElement({ type: "entities", entities: [] });
            await c.constructor.getConfigElement();
            const haEntityPicker = window.customElements.get("ha-entity-picker");
        }
    }

    render() {
        this.innerHTML = '';
        const fragment = document.createDocumentFragment();

        const container = document.createElement('div');
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.flexWrap = 'wrap';
        container.style.overflow = 'auto';
        container.style.overflowX = 'hidden';
        container.style.maxHeight = '100vh';

        this._card_fields.forEach((field) => {
            container.appendChild(this._createField({
                name: field.name,
                label: field.label,
                type: field.type,
                required: field.required,
                description: field.description
            }));
        });

        fragment.appendChild(container);
        this.appendChild(fragment);
    }
}