// End-to-end tests: starts a fresh Home Assistant in Docker with the built card
// (dist/) loaded, then drives Chrome through the card's behaviour.
//
//   npm run build && npm run test:e2e
//
// Environment variables:
//   HA_IMAGE        Home Assistant image (default: ghcr.io/home-assistant/home-assistant:stable)
//   HA_PORT         host port for Home Assistant (default: 8124)
//   CHROME_PATH     Chrome/Chromium executable (auto-detected on Windows, macOS and Linux)
//   SCREENSHOT_DIR  save screenshots here
//   KEEP=1          leave the container running afterwards
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMAGE = process.env.HA_IMAGE || 'ghcr.io/home-assistant/home-assistant:stable';
const PORT = process.env.HA_PORT || '8124';
const HA = `http://localhost:${PORT}`;
const CLIENT_ID = `${HA}/`;
const CONTAINER = `changelog-e2e-${PORT}`;
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;

const results = [];
// On GitHub Actions, also report failures as annotations so they show up on
// the run and on pull requests.
const annotate = (message) => {
    if (process.env.GITHUB_ACTIONS) {
        console.log(`::error title=E2E (${IMAGE})::${String(message).replace(/\r?\n/g, '%0A')}`);
    }
};
const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) annotate(`${name}${detail ? ` (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

function findChrome() {
    const candidates = [
        process.env.CHROME_PATH,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
    ];
    const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
    if (!found) throw new Error('Chrome not found: set CHROME_PATH');
    return found;
}

// ---------- Home Assistant ----------

function startHomeAssistant() {
    const dist = path.join(ROOT, 'dist/index.js');
    if (!fs.existsSync(dist)) throw new Error('dist/index.js missing: run `npm run build` first');

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-e2e-'));
    fs.cpSync(path.join(ROOT, 'tests/e2e/config'), configDir, { recursive: true });

    try { docker('rm', '-f', CONTAINER); } catch { /* not running */ }
    docker('run', '-d', '--name', CONTAINER, '-p', `${PORT}:8123`,
        '-v', `${configDir}:/config`,
        '-v', `${path.join(ROOT, 'dist')}:/config/www/harmonie-changelogs:ro`,
        IMAGE);
    return configDir;
}

async function waitForHomeAssistant() {
    for (let i = 0; i < 180; i++) {
        try {
            const response = await fetch(`${HA}/manifest.json`);
            if (response.ok) return;
        } catch { /* starting */ }
        await sleep(2000);
    }
    throw new Error(`Home Assistant didn't start. Logs:\n${docker('logs', '--tail', '50', CONTAINER)}`);
}

async function onboard() {
    const post = (url, body, headers = {}) => fetch(`${HA}${url}`, { method: 'POST', headers, body });
    const json = { 'content-type': 'application/json' };

    const user = await (await post('/api/onboarding/users', JSON.stringify({
        client_id: CLIENT_ID, name: 'Test', username: 'test', password: 'test-password-123', language: 'en',
    }), json)).json();
    const tokens = await (await post('/auth/token', new URLSearchParams({
        grant_type: 'authorization_code', code: user.auth_code, client_id: CLIENT_ID,
    }))).json();

    const auth = { ...json, authorization: `Bearer ${tokens.access_token}` };
    await post('/api/onboarding/core_config', '{}', auth);
    await post('/api/onboarding/analytics', '{}', auth);
    await post('/api/onboarding/integration', JSON.stringify({ client_id: CLIENT_ID, redirect_uri: `${HA}/?auth_callback=1` }), auth);
    return tokens;
}

// /manifest.json answers before integrations (input_text, template, ...) have
// loaded. Wait until Home Assistant reports it has fully started.
async function waitForRunning(tokens) {
    for (let i = 0; i < 120; i++) {
        try {
            const response = await fetch(`${HA}/api/config`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
            if (response.ok && (await response.json()).state === 'RUNNING') return;
        } catch { /* restarting */ }
        await sleep(1000);
    }
    throw new Error('Home Assistant never reached the RUNNING state');
}

async function refreshTokens(tokens) {
    const fresh = await (await fetch(`${HA}/auth/token`, {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLIENT_ID }),
    })).json();
    return { ...tokens, ...fresh };
}

// ---------- Page helpers (run in the browser) ----------

// Collects every changelog-card on the page (they live deep in shadow roots).
const CARD_STATE = (index) => {
    const find = (root, selector, found = []) => {
        root.querySelectorAll('*').forEach((el) => {
            if (el.matches(selector)) found.push(el);
            if (el.shadowRoot) find(el.shadowRoot, selector, found);
        });
        return found;
    };
    const card = find(document, 'changelog-card')[index];
    if (!card) return null;
    const root = card.shadowRoot;
    const dialog = root.querySelector('ha-dialog');
    const markdown = root.querySelector('ha-markdown');
    const alert = root.querySelector('ha-alert');
    return {
        open: dialog.open,
        visible: Boolean(dialog.shadowRoot?.querySelector('wa-dialog')?.shadowRoot?.querySelector('dialog')?.open),
        title: dialog.headerTitle,
        html: markdown.shadowRoot?.querySelector('ha-markdown-element')?.innerHTML ?? '',
        text: markdown.shadowRoot?.querySelector('ha-markdown-element')?.textContent ?? '',
        alert: alert.hidden ? '' : alert.textContent,
        buttonHidden: root.querySelector('.button-wrapper').hidden,
        buttonText: root.querySelector('.open-button').textContent,
        badge: !root.querySelector('.badge').hidden,
        dismissText: root.querySelector('.dismiss').textContent,
    };
};

const CLICK = (target) => {
    const find = (root, selector) => {
        for (const el of root.querySelectorAll('*')) {
            if (el.matches(selector)) return el;
            if (el.shadowRoot) {
                const found = find(el.shadowRoot, selector);
                if (found) return found;
            }
        }
        return null;
    };
    const root = find(document, 'changelog-card').shadowRoot;
    if (target === 'x') {
        root.querySelector('ha-dialog').shadowRoot.querySelector('ha-icon-button[data-dialog="close"]').click();
    } else {
        root.querySelector(target).click();
    }
};

// ---------- Tests ----------

async function run() {
    const configDir = startHomeAssistant();
    let browser;
    try {
        await waitForHomeAssistant();
        let tokens = await onboard();

        browser = await puppeteer.launch({
            executablePath: findChrome(),
            headless: true,
            args: ['--no-sandbox', '--window-size=1280,900'],
            defaultViewport: { width: 1280, height: 900 },
        });
        const page = await browser.newPage();
        const pageErrors = [];
        const consoleLines = [];
        page.on('pageerror', (error) => pageErrors.push(String(error)));
        page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`));

        // Store the login tokens before any Home Assistant code runs on each
        // page load. Setting them after the first load races with the
        // frontend, which can redirect to the login page and clear them.
        let tokenScript = null;
        const login = async () => {
            tokens = await refreshTokens(tokens);
            await waitForRunning(tokens);
            if (tokenScript) await page.removeScriptToEvaluateOnNewDocument(tokenScript.identifier);
            tokenScript = await page.evaluateOnNewDocument((t, ha, client) => {
                if (location.origin !== ha) return;
                localStorage.setItem('hassTokens', JSON.stringify({
                    ...t, hassUrl: ha, clientId: client, expires: Date.now() + t.expires_in * 1000,
                }));
            }, tokens, HA, CLIENT_ID);
        };
        // Wait until every card on the view has received hass. CI runners
        // can be much slower than a dev machine on the first loads.
        const cardsReady = () => page.waitForFunction(() => {
            const find = (root, found = []) => {
                root.querySelectorAll('*').forEach((el) => {
                    if (el.localName === 'changelog-card') found.push(el);
                    if (el.shadowRoot) find(el.shadowRoot, found);
                });
                return found;
            };
            const cards = find(document);
            return cards.length > 0 && cards.every((card) => card._hass);
        }, { timeout: 45000, polling: 250 });
        const describePage = () => page.evaluate(() => {
            const ha = document.querySelector('home-assistant');
            const count = (root, name) => [...root.querySelectorAll('*')]
                .reduce((n, el) => n + (el.localName === name ? 1 : 0) + (el.shadowRoot ? count(el.shadowRoot, name) : 0), 0);
            return JSON.stringify({
                url: location.href,
                hass: Boolean(ha?.hass),
                connected: ha?.hass?.connected,
                cards: count(document, 'changelog-card'),
                cardDefined: Boolean(customElements.get('changelog-card')),
                text: document.body.innerText.slice(0, 200),
            });
        });
        const open = async (view) => {
            await page.goto(`${HA}/test-dash/${view}`, { waitUntil: 'networkidle2' });
            try {
                await cardsReady();
            } catch {
                // Record what was on screen, then give the page one more chance.
                const before = await describePage();
                console.log(`${process.env.GITHUB_ACTIONS ? '::warning title=E2E::' : ''}Cards on "${view}" not ready, reloading. Page: ${before}`);
                if (SCREENSHOT_DIR) await page.screenshot({ path: path.join(SCREENSHOT_DIR, `timeout-${view}.png`) });
                await page.reload({ waitUntil: 'networkidle2' });
                try {
                    await cardsReady();
                } catch {
                    throw new Error(`Cards on "${view}" never got ready. Before reload: ${before}. After: ${await describePage()}`);
                }
            }
            // Seen state and markdown rendering are asynchronous.
            await sleep(2500);
        };
        const card = (index = 0) => page.evaluate(CARD_STATE, index);
        const click = async (target) => { await page.evaluate(CLICK, target); await sleep(800); };
        const shot = async (name) => {
            if (SCREENSHOT_DIR) await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
        };
        const setText = (entity, value) => page.evaluate(
            (entity_id, value) => document.querySelector('home-assistant').hass
                .callService('input_text', 'set_value', { entity_id, value }),
            entity, value);

        if (SCREENSHOT_DIR) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await login();

        // Auto-open, closing and reopening
        await open('basic');
        let s = await card();
        check('first visit opens the popup', s?.open && s?.visible);
        check('markdown is rendered by ha-markdown', /<h2[^>]*>v1\.1<\/h2>/.test(s?.html) && /<strong>New:<\/strong>/.test(s?.html));
        check('default title', s?.title === 'Changelog', s?.title);
        check('version banner is logged', consoleLines.some((line) => /HARMONIE-CHANGELOGS.*v\d+\.\d+\.\d+/.test(line)));
        await shot('popup');
        await click('x');
        s = await card();
        check('X closes the popup', !s.open && !s.visible);
        await click('.open-button');
        s = await card();
        check('button reopens the popup after X', s.open && s.visible);
        await click('.dismiss');
        s = await card();
        check('Dismiss closes the popup', !s.open && !s.visible);

        // Seen state
        await open('basic');
        s = await card();
        check('reload does not reopen a seen changelog', !s.open);
        await setText('input_text.changelog', '## v1.2\\n- Something new');
        await sleep(1500);
        s = await card();
        check('changed text opens the popup live', s.open && s.visible && /v1\.2/.test(s.text));
        await click('.dismiss');
        await setText('input_text.changelog', '## v1.3\\n- Something newer');
        await open('basic');
        s = await card();
        check('text changed while away opens on the next visit', s.open && s.visible && /v1\.3/.test(s.text));
        await click('.dismiss');
        await setText('input_text.changelog', '## v1.3\\n- Something newer');
        await open('basic');
        s = await card();
        check('saving identical text does not reopen', !s.open);

        // Sanitising
        await setText('input_text.xss', '**safe**<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>');
        await open('xss');
        s = await card();
        const xss = await page.evaluate(() => window.__xss);
        check('HTML in the changelog is sanitised', xss === undefined && !/onerror|<script/i.test(s.html) && /<strong>safe<\/strong>/.test(s.html), `__xss=${xss}`);
        await click('.dismiss');

        // Long changelog from an attribute
        await open('long');
        s = await card();
        check('attribute changelog opens', s.open && s.visible);
        check('attribute changelog is longer than 255 characters', s.text.length > 255, `${s.text.length} chars`);
        check('custom title', s.title === "What's new", s.title);
        await shot('long');
        await click('.dismiss');

        // Markdown file
        await open('file');
        s = await card();
        check('file changelog opens', s.open && s.visible && /Release 3\.0/.test(s.text));
        await click('.dismiss');
        await open('file');
        s = await card();
        check('seen file changelog does not reopen', !s.open);
        fs.appendFileSync(path.join(configDir, 'www/changelog.md'), '\n- Edited after release\n');
        await open('file');
        s = await card();
        check('edited file reopens despite HA caching /local/', s.open && /Edited after release/.test(s.text));
        await click('.dismiss');

        // Manual mode with the unread badge
        await open('manual');
        s = await card();
        check('auto_open: false does not open the popup', !s.open);
        check('unread badge is shown', s.badge);
        await shot('badge');
        await click('.open-button');
        s = await card();
        check('button opens the popup and clears the badge', s.open && !s.badge);
        await click('.dismiss');
        await open('manual');
        s = await card();
        check('badge stays cleared after reload', !s.badge && !s.open);
        await setText('input_text.manual', '## Manual 2\\n- Updated');
        await sleep(1500);
        s = await card();
        check('badge appears live when the changelog changes', s.badge && !s.open);

        // Hidden button
        await open('hidden');
        s = await card();
        check('hide_button hides the button', s.buttonHidden);

        // Warnings
        await open('errors');
        const [missingEntity, missingAttribute, missingFile] = [await card(0), await card(1), await card(2)];
        check('missing entity warning', /Entity not found: input_text\.nope/.test(missingEntity.alert), missingEntity.alert);
        check('missing attribute warning', /Attribute "nope" not found/.test(missingAttribute.alert), missingAttribute.alert);
        check('missing file warning', /Couldn't load \/local\/nope\.md: HTTP 404/.test(missingFile.alert), missingFile.alert);
        await shot('errors');

        // Seen state is per user, in HA
        const seen = await page.evaluate(() => document.querySelector('home-assistant').hass
            .callWS({ type: 'frontend/get_user_data', key: 'harmonie_changelogs_seen' }));
        check('seen state is stored in HA user data', ['input_text.changelog|', 'sensor.long_changelog|content', 'url:/local/changelog.md']
            .every((key) => key in (seen.value || {})), Object.keys(seen.value || {}).join(', '));

        // Editor
        await page.evaluate(() => {
            const editor = document.createElement('changelog-card-editor');
            editor.id = 'test-editor';
            editor.hass = document.querySelector('home-assistant').hass;
            editor.setConfig({ type: 'custom:changelog-card', entity: 'sensor.long_changelog', attribute: 'content' });
            editor.style.cssText = 'position:fixed;inset:0;z-index:9999;padding:24px;overflow:auto;background:var(--card-background-color)';
            window.__configs = [];
            editor.addEventListener('config-changed', (event) => window.__configs.push(event.detail.config));
            // Inside the app, so HA's context (translations) reaches the editor's fields.
            document.querySelector('home-assistant').shadowRoot.appendChild(editor);
        });
        await sleep(3000);
        const editorFields = () => page.evaluate(() => {
            const form = document.querySelector('home-assistant').shadowRoot.querySelector('#test-editor ha-form');
            const names = [];
            const walk = (schema) => schema.forEach((field) => (field.schema ? walk(field.schema) : names.push(field.name)));
            walk(form?.schema || []);
            return { rendered: Boolean(form?.shadowRoot?.children.length), names };
        });
        const emit = (change) => page.evaluate((change) => {
            const form = document.querySelector('home-assistant').shadowRoot.querySelector('#test-editor ha-form');
            form.dispatchEvent(new CustomEvent('value-changed', { detail: { value: { ...form.data, ...change } } }));
        }, change);
        const lastConfig = () => page.evaluate(() => window.__configs.at(-1));

        let fields = await editorFields();
        check('editor renders ha-form', fields.rendered);
        check('editor shows entity fields', ['source', 'entity', 'attribute', 'title', 'hide_button', 'auto_open', 'button_text']
            .every((name) => fields.names.includes(name)), fields.names.join(', '));
        await shot('editor');
        await emit({ source: 'file' });
        await sleep(500);
        fields = await editorFields();
        check('switching to file shows the URL field', fields.names.includes('url') && !fields.names.includes('entity'), fields.names.join(', '));
        check('switching to file drops entity keys', JSON.stringify(await lastConfig()) === JSON.stringify({ type: 'custom:changelog-card' }), JSON.stringify(await lastConfig()));
        await emit({ url: '/local/changelog.md', auto_open: false, title: '' });
        await sleep(300);
        check('editor keeps the config tidy', JSON.stringify(await lastConfig()) === JSON.stringify({ type: 'custom:changelog-card', url: '/local/changelog.md', auto_open: false }), JSON.stringify(await lastConfig()));
        await emit({ hide_button: true, button_text: 'x' });
        await sleep(300);
        check('hiding the button drops auto_open and button_text', JSON.stringify(await lastConfig()) === JSON.stringify({ type: 'custom:changelog-card', url: '/local/changelog.md', hide_button: true }), JSON.stringify(await lastConfig()));

        // French
        await page.evaluate(() => localStorage.setItem('selectedLanguage', JSON.stringify('fr')));
        await open('manual');
        s = await card();
        check('French translation', s.buttonText === 'Voir les nouveautés' && s.dismissText === 'Fermer', `${s.buttonText} / ${s.dismissText}`);
        await page.evaluate(() => localStorage.removeItem('selectedLanguage'));

        // Restart: unchanged changelogs stay seen
        docker('restart', CONTAINER);
        await sleep(5000);
        await waitForHomeAssistant();
        await login();
        await open('long');
        s = await card();
        check('no popup after a Home Assistant restart (attribute)', s && !s.open);
        await open('file');
        s = await card();
        check('no popup after a Home Assistant restart (file)', s && !s.open);

        check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
    } finally {
        await browser?.close();
        if (!process.env.KEEP) {
            try { docker('rm', '-f', CONTAINER); } catch { /* already gone */ }
            try { fs.rmSync(configDir, { recursive: true, force: true }); } catch { /* files owned by the container */ }
        }
    }

    const failed = results.filter((result) => !result.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed (${IMAGE})`);
    process.exit(failed.length ? 1 : 0);
}

run().catch((error) => {
    console.error(error);
    annotate(error.stack || error);
    process.exit(1);
});
