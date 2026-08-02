#!/bin/bash
# Take ONE cold agent-latency sample, the way the desktop user experiences it.
#
#   ./cold-sample.sh <A|B> <MARKER> [max_respawn_attempts]
#     A = global-agent-config.json WITH    CLAUDE_CODE_EFFORT_LEVEL=low
#     B = global-agent-config.json WITHOUT it (control)
#
# Each run rewrites global-agent-config.json — the mtime bump trips
# `auto_restart_on_config_change` — then waits for a FRESH agent that has
# actually subscribed to the channel before timing exactly one turn. That is
# what makes the sample *cold*: the pool is rebuilt, so the first message pays
# the same cost a user pays after launching Buzz.
#
# Interleave the arms (A B A B A B) rather than running three of each in a row.
# A respawn is required per sample either way, so alternating costs nothing and
# keeps drift in machine load out of the comparison.
#
# THREE SAMPLES MINIMUM per arm. Identical configuration has been measured at
# 7.30 s and 3.87 s on this machine; any conclusion from n=1 is worthless.
#
# Preconditions:
#   - Buzz is running (this script will not start it).
#   - buzz-acp can reach the relay. If Norton's encrypted-connections scanning
#     is on it cannot, and every sample times out — see fork/README.md. This
#     script reports TLS_BLOCKED in that case instead of emitting a latency
#     number, because a timeout is not evidence about a config key.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

AGENT_PUBKEY="ea8a3d301c872211a3d5d0b4d0c42d5e7191d3aba006e070b294abda1bbc237d"
AGENT_DIR="/c/Users/arno_/AppData/Roaming/xyz.block.buzz.app/agents"
CFG="$AGENT_DIR/global-agent-config.json"
LOG="$(ls -1t "$AGENT_DIR/logs/${AGENT_PUBKEY}__"*.log 2>/dev/null | head -1)"

# Norton re-signs TLS on this machine; Node needs its root to reach the relay.
export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-/c/ProgramData/Norton/Antivirus/wscert.pem}"

variant="$1"
marker="$2"
attempts="${3:-1}"

if [ -z "$variant" ] || [ -z "$marker" ]; then
  echo "usage: cold-sample.sh <A|B> <MARKER> [max_respawn_attempts]" >&2
  exit 64
fi
if [ -z "$LOG" ]; then
  echo "no agent log found under $AGENT_DIR/logs" >&2
  exit 66
fi

write_cfg() {
  # Written by hand rather than with jq: this file is parsed by serde_json,
  # which rejects a UTF-8 BOM. printf emits plain bytes; PowerShell 5.1's
  # `Set-Content -Encoding utf8` does not.
  if [ "$variant" = "A" ]; then
    printf '%s\n' \
      '{' \
      '  "env_vars": {' \
      '    "BUZZ_ACP_AGENTS": "2",' \
      '    "BUZZ_ACP_LAZY_POOL": "false",' \
      '    "CLAUDE_CODE_EFFORT_LEVEL": "low"' \
      '  },' \
      '  "provider": null,' \
      '  "model": null,' \
      '  "preferred_runtime": "claude"' \
      '}' > "$CFG"
  else
    printf '%s\n' \
      '{' \
      '  "env_vars": {' \
      '    "BUZZ_ACP_AGENTS": "2",' \
      '    "BUZZ_ACP_LAZY_POOL": "false"' \
      '  },' \
      '  "provider": null,' \
      '  "model": null,' \
      '  "preferred_runtime": "claude"' \
      '}' > "$CFG"
  fi
}

for attempt in $(seq 1 "$attempts"); do
  if ! tasklist //FI "IMAGENAME eq buzz-desktop.exe" 2>/dev/null | grep -qi buzz-desktop; then
    echo "$variant $marker ABORT buzz-desktop is not running"
    exit 2
  fi

  SZ=$(stat -c %s "$LOG")
  write_cfg

  # A config write only restarts a LIVE agent. If buzz-acp already exited there
  # is no process to restart and nothing appears in the log — restart Buzz.
  state="NO_RESPAWN"
  for i in $(seq 1 75); do
    new=$(tail -c +$((SZ + 1)) "$LOG" 2>/dev/null)
    [ -n "$new" ] && [ "$state" = "NO_RESPAWN" ] && state="WAIT"
    case "$new" in *"invalid peer certificate"*) state="TLS_BLOCKED" ;; esac
    case "$new" in *"subscribed to channel"*) state="READY"; break ;; esac
    sleep 1
  done

  if [ "$state" != "READY" ]; then
    echo "$variant $marker attempt=$attempt $state (waited ${i}s)"
    sleep 20
    continue
  fi

  pool=$(tail -c +$((SZ + 1)) "$LOG" | grep -o "agent_pool_ready agents=[0-9]*" | tail -1)
  sleep 3   # identical settle for both arms
  res=$(cd "$HERE" && node time-turn-ws.mjs Fabey "$marker" 2>&1)
  echo "$variant $marker attempt=$attempt respawn=${i}s $pool $res"
  exit 0
done

echo "$variant $marker EXHAUSTED after $attempts attempts"
exit 1
