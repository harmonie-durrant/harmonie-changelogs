# Harmonie's Changelogs

![harmonie-changelogs](docs/title.png)

Harmonie's Changelogs is a custom Lovelace card for Home Assistant that allows you to display a changelog for your Home Assistant instance. It is designed to be simple and easy to use, and it can be customized to fit your needs. The changelog is stored in an `input_text` entity, which can be updated manually or through automation, and it supports markdown formatting. The changelog popup auto shows the first time after an update, and can be configured to show a button to open it manually... or not.

## Table of Contents

- [Installation](#installation)
- [How To Use](#how-to-use)
- [Card](#card)
- [Contributing](#contributing)
- [Donate](#donate)

## Installation

### Marketplace (Recommended)

Go to Settings > marketplace and search for "Harmonie's Changelogs"

or

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=harmonie-durrant&repository=harmonie-changelogs&category=frontend)

## How to use

The Changelog card allows you to display a changelog for your Home Assistant instance. To use the card, add the following configuration to your Lovelace dashboard:

```yaml
type: custom:changelog-card
entity: input_text.changelog
hide_button: true
```

![Changelog card](docs/title.png)

| Option | Required | Description |
| --- | --- | --- |
| `entity` | Yes | Entity holding the changelog (markdown). |
| `attribute` | No | Read the changelog from this attribute instead of the entity's state. |
| `title` | No | Popup title. Defaults to "Changelog". |
| `hide_button` | No | Hide the "Show changelog" button. The popup still opens when the changelog changes. |
| `button_text` | No | Custom text for the button. |

Every option can also be set from the visual card editor.

The popup opens once for each Home Assistant user, the first time they load the dashboard after the changelog text changes. "Seen" is stored per user in Home Assistant, so it syncs across their devices, and restarting Home Assistant doesn't show it again.

### Changelogs longer than 255 characters

Entity states are limited to 255 characters, but attributes aren't. Put the changelog in an attribute, for example with a template sensor:

```yaml
# configuration.yaml
template:
  - sensor:
      - name: Changelog
        state: "v2.0"
        attributes:
          content: |
            ## v2.0
            - A changelog as long as you like
```

```yaml
type: custom:changelog-card
entity: sensor.changelog
attribute: content
```

## Contributing

Feel free to fork this repo and submit your changes through pull requests, or to suggest a feature/report a bug, make an issue in the issues tab of this repository.

### Development environment

Requirements: [Node.js](https://nodejs.org/) and [Docker](https://www.docker.com/).

```sh
npm ci           # install dependencies
npm run watch    # rebuild dist/index.js on every change in src/
npm run ha:up    # start a local Home Assistant on http://localhost:8123
```

The first time, finish Home Assistant's onboarding (create a local user). Then add the card to a dashboard, using `input_text.changelog` as the entity.

- `dist/` is mounted into Home Assistant as `/local/harmonie-changelogs/` and loaded as a Lovelace resource. After a rebuild, hard-refresh the browser (Ctrl+Shift+R), or keep DevTools open with "Disable cache" ticked.
- To trigger the popup, change the value of `input_text.changelog` (Settings > Entities).
- For a changelog longer than 255 characters, use `entity: sensor.long_changelog` with `attribute: content`.
- "Seen" state is saved in Home Assistant's per-user frontend storage under the key `harmonie_changelogs_seen`. To see the popup again, change the changelog text, or log in as a different user.
- Home Assistant config lives in [dev/config/configuration.yaml](dev/config/configuration.yaml). Run `npm run ha:logs` to view logs and `npm run ha:down` to stop.
- **Before committing, run `npm run build`**. `watch` produces an unminified dev build, and HACS ships whatever is committed in `dist/`.

When developing run `npm install` to setup the project, and `npm run build` or `npm run watch` to build the project. (The watch command will automatically rebuild the project when you save a file)

## Links

[Discord Server for support and discussion](https://discord.gg/Cjakvt9XJH)

[Buy me a coffee.](https://buymeacoffee.com/harmonie)
