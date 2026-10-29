#!/usr/bin/env bash
# Starts, drives and stops one `nyorori serve` instance owned by a run.
# Usage: .claude/skills/verify-nyorori/scripts/serve.sh <run-dir> <subcommand> ...
#   start                                  start on a free 127.0.0.1 port with a generated App key (file signer),
#                                          a fresh work dir and policy.json; ready when stderr shows {"msg":"listening"}
#   status                                 is the instance this run started still alive? (exit 1 when not)
#   payload pull_request                   write <run-dir>/serve/payload-pull_request.json (PR #7 opened, head = pass)
#   get <path>                             GET http://127.0.0.1:<port><path>, for example /healthz
#   post <event> <delivery-id> <payload.json> [--unsigned | --secret <value>]
#                                          POST a webhook delivery; signed with the instance secret unless told otherwise
#   snapshot                               copy the service's work dir state (jobs/, deliveries.log) into <run-dir>/serve/state/
#   stop                                   snapshot, then SIGTERM the pid this run started (never any other process)
# Evidence: <run-dir>/serve/{serve.env,stdout.txt,stderr.txt,requests.log,state/,payload-*.json}
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_run "${1:-}"; shift
cmd="${1:-}"; [ -n "$cmd" ] || die "subcommand required: start|status|payload|get|post|snapshot|stop"; shift
S="$RUN_DIR/serve"; ENVF="$S/serve.env"
load_serve() { [ -f "$ENVF" ] || die "no $ENVF; run: scripts/serve.sh $RUN_DIR start"; . "$ENVF"; }
alive() { [ "${SERVE_PID:-0}" != 0 ] && [ -r "/proc/$SERVE_PID/cmdline" ] && tr '\0' ' ' < "/proc/$SERVE_PID/cmdline" | grep -q "dist/cli.js serve --port $SERVE_PORT"; }
http() { # <method> <path> [event] [delivery] [payload-file] [secret]
  node - "$SERVE_URL" "$@" <<'EOF'
const { createHmac } = require("node:crypto");
const fs = require("node:fs");
const [base, method, path, event = "", delivery = "", file = "", secret = ""] = process.argv.slice(2);
const body = file ? fs.readFileSync(file, "utf8") : undefined;
const headers = { "content-type": "application/json" };
if (event) headers["x-github-event"] = event;
if (delivery) headers["x-github-delivery"] = delivery;
if (secret && body !== undefined) headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
fetch(base + path, { method, headers, ...(body !== undefined ? { body } : {}) })
  .then(async (r) => console.log(`${r.status} ${await r.text()}`))
  .catch((e) => { console.log(`ERROR ${e.cause?.code ?? e.message}`); process.exitCode = 1; });
EOF
}

case "$cmd" in
  start)
    if [ -f "$ENVF" ]; then . "$ENVF"; alive && die "serve is already running for this run (pid $SERVE_PID, $SERVE_URL); stop it first"; fi
    work="$SCRATCH/serve/work"
    # mirrors/ is created up front: with an empty work dir `serve` refuses its own default
    # ledger path as "inside" <work>/mirrors (both resolve to the same existing ancestor). See SKILL.md, Known traps.
    mkdir -p "$S" "$work/mirrors"
    key="$SCRATCH/serve/app-key.pem"
    [ -f "$key" ] || node -e 'const {generateKeyPairSync}=require("node:crypto");require("node:fs").writeFileSync(process.argv[1],generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}),{mode:0o600})' "$key"
    port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
    secret="verify-$(node -e 'console.log(require("node:crypto").randomBytes(12).toString("hex"))')"
    : > "$S/stdout.txt"; : > "$S/stderr.txt"
    (
      cd "$REPO_ROOT" && env -i PATH="$PATH" HOME="$SCRATCH/home" \
        NYORORI_APP_ID=77 NYORORI_WEBHOOK_SECRET="$secret" NYORORI_POLICY="$POLICY" NYORORI_CCCC="$CCCC" \
        NYORORI_WORKDIR="$work" NYORORI_SIGNER=file NYORORI_PRIVATE_KEY_PATH="$key" NYORORI_RUNNER_COMMIT="verify-$RUN_ID" \
        setsid node "$CLI" serve --port "$port" > "$S/stdout.txt" 2> "$S/stderr.txt" < /dev/null &
      echo $! > "$S/pid.tmp"
    )
    pid="$(cat "$S/pid.tmp")"; rm -f "$S/pid.tmp"
    for _ in $(seq 1 75); do grep -q '"msg":"listening"' "$S/stderr.txt" 2>/dev/null && break; sleep 0.2; done
    # setsid may have forked: identify the listener by its unique port, never by name alone.
    found="$(pgrep -f -- "dist/cli.js serve --port $port\$" 2>/dev/null | head -1 || true)"; [ -n "$found" ] && pid="$found"
    cat > "$ENVF" <<EOF
SERVE_PID=$pid
SERVE_PORT=$port
SERVE_URL=http://127.0.0.1:$port
SERVE_SECRET=$secret
SERVE_WORKDIR=$work
SERVE_KEY=$key
SERVE_STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
    if grep -q '"msg":"listening"' "$S/stderr.txt"; then
      echo "serve ready: pid $pid url http://127.0.0.1:$port log $S/stderr.txt"; cat "$S/stderr.txt"
    else
      echo "serve did not reach 'listening' within 15 s; stderr follows"; cat "$S/stderr.txt"; exit 1
    fi;;
  status)
    load_serve; if alive; then echo "running: pid $SERVE_PID $SERVE_URL (since $SERVE_STARTED)"; else echo "not running (last pid $SERVE_PID)"; exit 1; fi;;
  payload)
    kind="${1:-pull_request}"; [ "$kind" = pull_request ] || die "only pull_request payloads are generated; write other payloads by hand"
    mkdir -p "$S"; f="$S/payload-pull_request.json"
    printf '{"action":"opened","repository":{"owner":{"login":"verify"},"name":"fixture"},"pull_request":{"number":7,"head":{"sha":"%s"},"state":"open"}}\n' "$PASS" > "$f"
    printf '%s\n' "$f";;
  get)
    load_serve; path="${1:-}"; [ -n "$path" ] || die "path required, for example /healthz"
    r="$(http GET "$path")"; echo "$(date -u +%H:%M:%S) GET $path -> $r" | tee -a "$S/requests.log";;
  post)
    load_serve; event="${1:-}"; delivery="${2:-}"; payload="${3:-}"
    [ -n "$event" ] && [ -n "$delivery" ] && [ -n "$payload" ] || die "usage: post <event> <delivery-id> <payload.json> [--unsigned | --secret <value>]"
    shift 3; [ -f "$payload" ] || die "$payload not found"
    secret="$SERVE_SECRET"; mode=signed
    while [ $# -gt 0 ]; do case "$1" in --unsigned) secret=""; mode=unsigned; shift;; --secret) secret="${2:-}"; mode="secret=$secret"; shift 2;; *) die "unknown option $1";; esac; done
    r="$(http POST / "$event" "$delivery" "$payload" "$secret")"
    echo "$(date -u +%H:%M:%S) POST / event=$event delivery=$delivery payload=$(basename "$payload") $mode -> $r" | tee -a "$S/requests.log";;
  snapshot)
    load_serve; rm -rf "$S/state"; mkdir -p "$S/state"
    if [ -d "$SERVE_WORKDIR" ]; then cp -r "$SERVE_WORKDIR"/. "$S/state"/; rm -rf "$S/state/mirrors"; fi
    echo "state copied to $S/state:"; (cd "$S/state" && find . -type f | sort | sed 's/^/  /');;
  stop)
    load_serve
    "$0" "$RUN_DIR" snapshot > /dev/null
    if alive; then
      kill -TERM "$SERVE_PID"
      for _ in $(seq 1 50); do [ -d "/proc/$SERVE_PID" ] || break; sleep 0.1; done
      if [ -d "/proc/$SERVE_PID" ]; then kill -KILL "$SERVE_PID"; echo "stopped pid $SERVE_PID (SIGKILL after SIGTERM timeout)"; else echo "stopped pid $SERVE_PID (SIGTERM)"; fi
    else echo "pid $SERVE_PID was not running"; fi
    echo "stopped $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$S/requests.log"
    sed -i 's/^SERVE_PID=.*/SERVE_PID=0/' "$ENVF";;
  *) die "unknown subcommand $cmd";;
esac
