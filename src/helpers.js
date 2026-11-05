// cyrb53: small, fast, non-cryptographic string hash. crypto.subtle is not
// an option: it's unavailable when HA is served over plain http on a LAN.
export function hashContent(str) {
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

export function fireEvent(node, type, detail) {
    node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

// Home Assistant lazy-loads most of its elements (ha-form, ha-markdown, ...).
// Creating the built-in card that uses one makes HA load it.
// `withEditor` also loads that card's editor, for editor-only elements.
export async function ensureHaElement(tag, cardConfig, withEditor = false) {
    if (customElements.get(tag)) return;
    try {
        const helpers = await window.loadCardHelpers();
        const card = await helpers.createCardElement(cardConfig);
        if (withEditor) await card.constructor.getConfigElement();
    } catch (error) {
        console.warn(`changelog-card: could not preload ${tag}`, error);
    }
    await customElements.whenDefined(tag);
}
