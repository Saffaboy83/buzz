"""Keep the Buzz desktop app's managed agents fast on a RAM-constrained box.

Run this with the Buzz desktop app CLOSED:

    python fork\\tune-desktop-agents.py

Why it exists
-------------
The app re-seeds the builtin personas (fizz/honey/bumble) as brand-new *active*
agent records on every launch, at the hardcoded DEFAULT_AGENT_PARALLELISM = 10.
Parallelism spawns real Node child processes -- one `claude-agent-acp` per unit,
per agent -- so a few launches quietly turn into dozens of processes and the
machine starts swapping. That swap is what makes a one-word message take a
minute to answer.

The durable half of the fix lives in global-agent-config.json (BUZZ_ACP_AGENTS),
which runtime.rs writes last so it beats the per-record value and survives every
re-seed. This script handles the other half: collapse duplicates, keep one
responder active, and stop agents talking over each other.

Safe to run repeatedly. The first run snapshots the original file next to it.
"""

import json
import os
import shutil
import sys

AGENTS_DIR = os.path.join(os.environ["APPDATA"], "xyz.block.buzz.app", "agents")
STORE = os.path.join(AGENTS_DIR, "managed-agents.json")
GLOBAL = os.path.join(AGENTS_DIR, "global-agent-config.json")

# The agent left running. Override with: python tune-desktop-agents.py <Name>
KEEP_ACTIVE = sys.argv[1] if len(sys.argv) > 1 else "Fabey"

PARALLELISM = 2
TURN_TIMEOUT = 90

GLOBAL_ENV = {
    # Caps every agent's ACP pool regardless of what the app writes per record.
    "BUZZ_ACP_AGENTS": "2",
    # fable-5 is adaptive and xhigh-capable; a greeting needs no thinking budget.
    "CLAUDE_CODE_EFFORT_LEVEL": "low",
    "BUZZ_AGENT_THINKING_EFFORT": "low",
}


def richness(agent):
    """A provisioned pubkey outranks everything -- it is the agent's identity.

    Dropping the entry that owns the key orphans that agent and forces
    re-provisioning before it can ever be re-enabled.
    """
    score = 0
    if (agent.get("pubkey") or "").strip():
        score += 100
    if agent.get("runtime"):
        score += 4
    if agent.get("model"):
        score += 2
    return score


def snapshot(path):
    backup = path + ".bak-before-tuning"
    if os.path.exists(path) and not os.path.exists(backup):
        shutil.copy2(path, backup)
        print("snapshot -> %s" % os.path.basename(backup))


def main():
    if not os.path.exists(STORE):
        sys.exit("not found: %s" % STORE)
    snapshot(STORE)
    snapshot(GLOBAL)

    agents = json.load(open(STORE, encoding="utf-8"))
    before = sum((a.get("parallelism") or 0) + 1 for a in agents if a.get("is_active"))

    best = {}
    for a in agents:
        name = a.get("name")
        if name not in best or richness(a) > richness(best[name]):
            best[name] = a
    deduped = list(best.values())

    if not any(a.get("name") == KEEP_ACTIVE for a in deduped):
        sys.exit("no agent named %r -- have: %s"
                 % (KEEP_ACTIVE, ", ".join(sorted(best))))

    for a in deduped:
        a["parallelism"] = PARALLELISM
        a["definition_parallelism"] = PARALLELISM
        a["turn_timeout_seconds"] = TURN_TIMEOUT
        keep = a.get("name") == KEEP_ACTIVE
        a["is_active"] = keep
        # Pre-start the kept agent so pool spawn is paid at launch rather than
        # charged to the first message you send.
        a["start_on_app_launch"] = keep

    json.dump(deduped, open(STORE, "w", encoding="utf-8"), indent=2)

    g = json.load(open(GLOBAL, encoding="utf-8")) if os.path.exists(GLOBAL) else {}
    g.setdefault("env_vars", {}).update(GLOBAL_ENV)
    json.dump(g, open(GLOBAL, "w", encoding="utf-8"), indent=2)

    after = sum(PARALLELISM + 1 for a in deduped if a["is_active"])
    print("entries %d -> %d, worst-case processes %d -> %d"
          % (len(agents), len(deduped), before, after))
    print()
    print("%-8s %-9s %-16s %-4s %-7s %s"
          % ("name", "runtime", "model", "par", "active", "identity"))
    for a in sorted(deduped, key=lambda x: (not x["is_active"], x["name"])):
        pk = (a.get("pubkey") or "").strip()
        print("%-8s %-9s %-16s %-4s %-7s %s"
              % (a["name"], a.get("runtime") or "(global)", str(a.get("model")),
                 a["parallelism"], a["is_active"],
                 (pk[:16] + "...") if pk else "** none **"))
    print()
    print("global env: %s" % ", ".join("%s=%s" % kv for kv in sorted(GLOBAL_ENV.items())))


if __name__ == "__main__":
    main()
