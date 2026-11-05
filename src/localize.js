import en from './translations/en.json';
import fr from './translations/fr.json';

const LANGUAGES = { en, fr };

// The user's HA language ("fr", "fr-CA", ...) if we have it, otherwise English.
function getLanguage(hass) {
    const language = (hass?.locale?.language || hass?.language || 'en').toLowerCase();
    if (LANGUAGES[language]) return language;
    const base = language.split('-')[0];
    return LANGUAGES[base] ? base : 'en';
}

function lookup(language, key) {
    return key.split('.').reduce((node, part) => node?.[part], LANGUAGES[language]);
}

// localize(hass, 'card.warning.entity_not_found', { entity: 'input_text.x' })
export function localize(hass, key, vars = {}) {
    let text = lookup(getLanguage(hass), key) ?? lookup('en', key) ?? key;
    for (const [name, value] of Object.entries(vars)) {
        text = text.replace(`{${name}}`, value);
    }
    return text;
}
