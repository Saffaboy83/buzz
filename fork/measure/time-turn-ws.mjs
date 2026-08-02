/**
 * Time one agent turn the way the desktop client sees it: replies arrive pushed
 * over the WebSocket, not by polling /query.
 *
 * This produced the headline numbers. Polling conflates agent latency with the
 * relay's read-path indexing lag; both were measured and agreed, but this is the
 * one that matches the user's actual experience.
 *
 * Every prompt carries a unique token the reply MUST echo. Without that, a late
 * reply from the previous turn matches and reports an impossible ~1.6s.
 *
 * Usage:
 *   NODE_EXTRA_CA_CERTS=~/.hermes/win-ca-bundle.pem node time-turn-ws.mjs Fabey TOKEN01
 *
 * Buzz must be running (agent connected) or this times out.
 */
import { post, CHANNEL, sk } from "./relay-probe.mjs";

const NT =
  "file:///C:/Users/arno_/Buzz/node_modules/.pnpm/nostr-tools@2.23.12_typescript@6.0.3/node_modules/nostr-tools/lib/esm";
const { finalizeEvent } = await import(`${NT}/pure.js`);

const WS_URL = "wss://relay-production-61de.up.railway.app";
const AGENTS = {
  Fabey: "ea8a3d301c872211a3d5d0b4d0c42d5e7191d3aba006e070b294abda1bbc237d",
  Fizz: "22341e992f899ff7da7319c08c6d34b6915aa152b1606929d3456468f1726b38",
};

const name = process.argv[2] || "Fabey";
const marker = process.argv[3] || "PING01";
const agentPubkey = AGENTS[name];

const ws = new WebSocket(WS_URL);
const subId = `t${Math.floor(Date.now() % 100000)}`;
let authed = false;
let t0 = 0;
let done = false;

const finish = (out) => {
  if (done) return;
  done = true;
  console.log(JSON.stringify(out));
  try {
    ws.close();
  } catch {}
  process.exit(0);
};

setTimeout(() => finish({ agent: name, result: "TIMEOUT" }), 180000);

ws.onmessage = async (e) => {
  let m;
  try {
    m = JSON.parse(e.data);
  } catch {
    return;
  }

  if (m[0] === "AUTH" && !authed) {
    // NIP-42. The relay tag must be the bare WS origin — the relay derives the
    // expected value from the tenant host, so a proxy URL will not match.
    const ev = finalizeEvent(
      {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["relay", WS_URL],
          ["challenge", m[1]],
        ],
        content: "",
      },
      sk,
    );
    ws.send(JSON.stringify(["AUTH", ev]));
    authed = true;
    return;
  }

  if (m[0] === "OK" && authed && !t0) {
    ws.send(
      JSON.stringify([
        "REQ",
        subId,
        {
          kinds: [9],
          "#h": [CHANNEL],
          authors: [agentPubkey],
          since: Math.floor(Date.now() / 1000) - 1,
        },
      ]),
    );

    const prompt = finalizeEvent(
      {
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["h", CHANNEL],
          ["p", agentPubkey],
        ],
        content: `@${name} reply with exactly this word and nothing else: ${marker}`,
      },
      sk,
    );
    t0 = Date.now();
    const r = await post("/events", prompt);
    if (r.status >= 300) finish({ error: "publish failed", status: r.status });
    return;
  }

  if (m[0] === "EVENT" && m[1] === subId && t0) {
    const ev = m[2];
    if (ev.pubkey !== agentPubkey) return;
    if (!String(ev.content).includes(marker)) return;
    const ms = Date.now() - t0;
    finish({
      agent: name,
      transport: "websocket push",
      latency_ms: ms,
      latency_s: +(ms / 1000).toFixed(1),
      reply: String(ev.content).slice(0, 60),
    });
  }
};

ws.onerror = () => finish({ error: "websocket error" });
