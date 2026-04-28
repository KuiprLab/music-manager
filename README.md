# music-manager

Discord bot that searches Soulseek for music and downloads it locally. Uses MusicBrainz for metadata resolution and cover art.

## Commands

| Command           | Description                         |
| ----------------- | ----------------------------------- |
| `/single <query>` | Search and download a single track  |
| `/album <query>`  | Search and download a full album    |
| `/settings`       | View or change download preferences |
| `/ping`           | Health check                        |

### `/single`

Resolves the query against MusicBrainz, searches Soulseek, and presents a scored result with Download and Select File options. Downloads to `DOWNLOAD_DIR/<filename>`.

### `/album`

Resolves album metadata (tracklist + cover art) from MusicBrainz, finds the best-matching Soulseek folder (≥50% track coverage required), and downloads all matched tracks. Downloads to `DOWNLOAD_DIR/<Artist>/<Album>/`.

### `/settings`

Opens a modal to configure download preferences. Changes are saved immediately to `settings.yaml`.

## Configuration

### Environment variables

| Variable        | Required | Default       | Description                               |
| --------------- | -------- | ------------- | ----------------------------------------- |
| `DISCORD_TOKEN` | Yes      | —             | Bot token from Discord Developer Portal   |
| `CLIENT_ID`     | Yes      | —             | Application ID (for command registration) |
| `SLSK_USERNAME` | Yes      | —             | Soulseek account username                 |
| `SLSK_PASSWORD` | Yes      | —             | Soulseek account password                 |
| `DOWNLOAD_DIR`  | No       | `./downloads` | Download destination path                 |

Copy `example.env` to `.env` and fill in values.

### settings.yaml

```yaml
formats:
  - flac
  - mp3
minBitrate: 192 # hard filter: 128 | 192 | 256 | 320 | any
preferredBitrate: 320 # ranking preference: same values
```

Valid formats: `mp3`, `flac`, `ogg`, `aac`, `m4a`, `wav`, `opus`, or `any`.

If no results pass the hard filters, both commands automatically retry with filters relaxed.

`settings.yaml` is written at runtime when `/settings` is used — the file must be writable.

## Running

### Docker

```sh
docker run \
  -e DISCORD_TOKEN=... \
  -e CLIENT_ID=... \
  -e SLSK_USERNAME=... \
  -e SLSK_PASSWORD=... \
  -e DOWNLOAD_DIR=/downloads \
  -v ./settings.yaml:/app/settings.yaml \
  -v ./downloads:/downloads \
  ghcr.io/kuiprlab/music-manager:main
```

### Docker Compose

```yaml
services:
  music-manager:
    image: ghcr.io/kuiprlab/music-manager:main
    restart: unless-stopped
    env_file: .env
    environment:
      DOWNLOAD_DIR: /downloads
    volumes:
      - ./settings.yaml:/app/settings.yaml
      - ./downloads:/downloads
```

Create `settings.yaml` before first run (see [settings.yaml](#settingsyaml) above). Env vars are loaded from `.env` via `env_file`.

### Local

```sh
cp example.env .env
# fill in .env values

yarn install
yarn dev       # development (no compile step)

# or build and run
yarn build
yarn start
```

### Registering slash commands

Run once after first deploy or when commands change:

```sh
yarn deploy
```

## Development

Requires Node 22 and Yarn.

```sh
yarn install
yarn dev
```
