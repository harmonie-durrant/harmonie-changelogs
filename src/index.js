import { ChangeLogCard } from './changelog-card.js';
import { ChangelogCardEditor } from './changelog-card-editor.js';
import pkg from '../package.json';

// Guard against the resource being loaded twice.
if (!customElements.get('changelog-card')) {
	customElements.define('changelog-card', ChangeLogCard);
	customElements.define('changelog-card-editor', ChangelogCardEditor);

	window.customCards = window.customCards || [];
	window.customCards.push({
		type: 'changelog-card',
		name: "Harmonie's Changelog",
		description: 'Shows your changelog in a popup the first time each user opens the dashboard after it changes.',
		documentationURL: 'https://github.com/harmonie-durrant/harmonie-changelogs',
	});

	console.info(
		`%c HARMONIE-CHANGELOGS %c v${pkg.version} `,
		'color: white; background: #03a9f4; font-weight: 700;',
		'color: #03a9f4; background: white; font-weight: 700;',
	);
}
