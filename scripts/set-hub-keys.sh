#!/usr/bin/env bash
# Set or replace the hub's API keys on the VPS, then restart the hub.
#   scripts/set-hub-keys.sh                 prompt for both keys (Enter keeps the current value)
#   scripts/set-hub-keys.sh --host user@ip  another host
# Keys are typed hidden and sent over ssh stdin (never in argv, history or logs). They are written to
# /opt/apps/sim-eyes-hub/.env (mode 600); other lines in .env are kept.
set -euo pipefail

HOST="root@149.28.137.49"
DIR="/opt/apps/sim-eyes-hub"
[ "${1:-}" = "--host" ] && HOST="${2:?--host needs user@ip}"

ask() { # $1 = name, $2 = what it is
  local value
  read -r -s -p "$1 ($2; Enter keeps current): " value </dev/tty
  echo >&2
  printf '%s' "$value"
}

TYPESAFE_API_KEY="$(ask TYPESAFE_API_KEY "TypeSafe relay")"
JUDGE_KEY="$(ask JUDGE_KEY "OpenRouter, screenshot judge")"

if [ -z "$TYPESAFE_API_KEY" ] && [ -z "$JUDGE_KEY" ]; then
  echo "Nothing entered, nothing changed." >&2
  exit 0
fi

# Runs on the VPS. Reads NAME=value lines from stdin and replaces those lines in .env.
REMOTE='
set -euo pipefail
cd "$DIR"
umask 077
tmp=$(mktemp .env.XXXXXX)
cp .env "$tmp"
while IFS= read -r line; do
  [ -z "$line" ] && continue
  name=${line%%=*}
  { grep -v "^${name}=" "$tmp" || true; printf "%s\n" "$line"; } > "$tmp.new"
  mv "$tmp.new" "$tmp"
done
mv "$tmp" .env
chmod 600 .env
docker compose up -d >/dev/null 2>&1
for _ in $(seq 1 30); do
  [ "$(docker inspect -f "{{.State.Health.Status}}" sim-eyes-hub)" = healthy ] && break
  sleep 2
done
echo "container: $(docker inspect -f "{{.State.Health.Status}}" sim-eyes-hub)"
for k in TYPESAFE_API_KEY JUDGE_KEY; do
  if docker exec sim-eyes-hub sh -c "[ -n \"\$$k\" ]"; then echo "$k: set"; else echo "$k: EMPTY"; fi
done
'
ENCODED="$(printf '%s' "$REMOTE" | base64 | tr -d '\n')"

{
  [ -z "$TYPESAFE_API_KEY" ] || printf 'TYPESAFE_API_KEY=%s\n' "$TYPESAFE_API_KEY"
  [ -z "$JUDGE_KEY" ] || printf 'JUDGE_KEY=%s\n' "$JUDGE_KEY"
} | ssh "$HOST" "DIR='$DIR' bash -c \"\$(echo $ENCODED | base64 -d)\"" 2> >(grep -v 'invalid format' >&2)

echo "healthz: $(curl -sS https://sim-eyes.unitvn.com/healthz)"
