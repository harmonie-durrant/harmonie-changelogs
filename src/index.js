import { ChangeLogCard } from './changelog-card.js';
import { ChangelogCardEditor } from './changelog-card.js';

customElements.define('changelog-card', ChangeLogCard);

customElements.define('changelog-card-editor', ChangelogCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
	type: 'changelog-card',
	name: 'Changelog Card',
	description: 'A card that displays changelog information from an input_text entity'
});
