import { ChangeLogCard, ChangelogCardEditor } from './changelog-card.js';

customElements.define('changelog-card', ChangeLogCard);
customElements.define('changelog-card-editor', ChangelogCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
	type: 'changelog-card',
	name: "Harmonie's Changelog",
	description: 'Shows your changelog in a popup the first time each user opens the dashboard after it changes.',
	documentationURL: 'https://github.com/harmonie-durrant/harmonie-changelogs',
});
