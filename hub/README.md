# sim-eyes hub

The small server SimEyes Studio talks to. It stores **no tester data** (projects, tests, builds, runs and videos stay on each tester's Mac). It does three things, all behind an invite token:

| Endpoint | What |
| --- | --- |
| `GET /v1/manifest`, `GET /v1/bundles/<version>` | The latest signed Studio bundle (UI + logic). The app verifies the signature before it installs anything. |
| `POST /typesafe/v1/systemone` | Relays TypeSafe calls with the real key, which never leaves this server. Only this call is allowed. Limited per token. |
| `GET /`, `GET /downloads/SimEyesStudio-<version>.zip` | **Public** home page with the app download (no token: the app holds no secrets). Only the published zip named in `data/downloads/latest.json` is served. |
| `GET /healthz` | Liveness, no token. |

Request and response bodies are never logged: they contain screen text from the tester's app. The access log has token name, path, status, time and size only.

## Deploy (149.28.137.49, Docker + Traefik)

DNS first: an `A` record `sim-eyes.unitvn.com` → `149.28.137.49` (Route 53). Traefik gets the certificate by itself.

```bash
# from this repo, on your Mac
rsync -a --exclude '*test*' hub/ root@149.28.137.49:/opt/apps/sim-eyes-hub/

# on the VPS
cd /opt/apps/sim-eyes-hub
cp .env.example .env && chmod 600 .env     # set TYPESAFE_API_KEY (and HUB_DOMAIN if different)
mkdir -p data/releases && chown -R 1000:1000 data
docker compose up -d --build
curl -sS https://sim-eyes.unitvn.com/healthz
```

## Invite tokens

```bash
docker compose exec sim-eyes-hub node tokens.mjs add anna --file /data/tokens.json    # prints the token once
docker compose exec sim-eyes-hub node tokens.mjs list --file /data/tokens.json
docker compose exec sim-eyes-hub node tokens.mjs revoke anna --file /data/tokens.json
```

Send the token to the tester privately. They paste it once into SimEyes Studio (menu: Invite Token…).

## Publish a Studio release

On your Mac (the signing key never goes to the VPS):

```bash
node scripts/release-bundle.mjs --keygen        # one time; back up ~/.sim-eyes-release/private.pem
npm run build-app                               # one time per app release: embeds app/release-public.pem
# bump "version" in package.json, then:
node scripts/release-bundle.mjs --publish root@149.28.137.49:/opt/apps/sim-eyes-hub/data/releases
```

Testers get it at their next launch (or "Check for Updates"), and it starts on the launch after that. A release that changes dependencies in `package.json` or `simEyes.agentDevice` needs a new app build: the app refuses it with "needs a newer app".

## Publish the Mac app (home page download)

After `npm run build-app` (it writes `dist/SimEyesStudio.zip`):

```bash
node scripts/publish-app.mjs --publish root@149.28.137.49:/opt/apps/sim-eyes-hub/data/downloads
```

The version and architecture come from inside the zip, so the page always describes the file it offers. The zip goes up first, then `latest.json`. Older zips stay in `data/downloads/` (delete them by hand when you like); only the one in `latest.json` is linked. The logo is the eye from `promo/launch.html` (`app/icon.svg` is the app icon source; `bash app/make-icon.sh` rebuilds `app/AppIcon.icns`).

## Rotate the TypeSafe key

Edit `.env`, then `docker compose up -d`. Testers change nothing.

## Local run (no Docker)

```bash
HUB_DATA_DIR=./data TYPESAFE_API_KEY=... node hub/hub.mjs
```
