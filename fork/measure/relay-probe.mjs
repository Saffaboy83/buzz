/**
 * Talk to the Buzz relay over its HTTP bridge as the community owner.
 *
 * POST /query  <- body is a bare array of nostr filters
 * POST /events <- body is a bare event object
 * Both authed with NIP-98 (kind 27235) in `Authorization: Nostr <base64>`.
 * The `payload` tag is optional (the bridge only checks it when present).
 *
 * Reads the owner nsec from disk; no secret is embedded here.
 *
 * Run directly to dump recent channel messages:
 *   NODE_EXTRA_CA_CERTS=~/.hermes/win-ca-bundle.pem node relay-probe.mjs
 */
import fs from "node:fs";

// pnpm store path — re-resolve if the lockfile changes:
//   node -e "console.log(require.resolve('nostr-tools/pure'))"  (from C:/Users/arno_/Buzz/web)
const NT =
  "file:///C:/Users/arno_/Buzz/node_modules/.pnpm/nostr-tools@2.23.12_typescript@6.0.3/node_modules/nostr-tools/lib/esm";
const { finalizeEvent, getPublicKey } = await import(`${NT}/pure.js`);
const nip19 = await import(`${NT}/nip19.js`);

export const RELAY = "https://relay-production-61de.up.railway.app";
export const CHANNEL = "b98f9076-eafc-4ed6-a450-c06757df518b";

const keyFile = "C:\\Users\\arno_\\.buzz-relay-owner-key.txt";
const nsec = (fs.readFileSync(keyFile, "utf8").match(/nsec1[a-z0-9]+/) || [])[0];
if (!nsec) {
  console.error(`no nsec found in ${keyFile}`);
  process.exit(1);
}
export const sk = nip19.decode(nsec).data;
export const OWNER = getPublicKey(sk);

function nip98(method, url) {
  const ev = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", url],
        ["method", method],
      ],
      content: "",
    },
    sk,
  );
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString("base64")}`;
}

export async function post(path, body) {
  const url = RELAY + path;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: nip98("POST", url),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

export function eventsOf(resBody) {
  if (Array.isArray(resBody)) return resBody;
  if (Array.isArray(resBody?.events)) return resBody.events;
  return [];
}

if (process.argv[1] && process.argv[1].includes("relay-probe")) {
  console.log("owner pubkey:", OWNER);
  const r = await post("/query", [{ kinds: [9], "#h": [CHANNEL], limit: 8 }]);
  console.log("query status:", r.status);
  const events = eventsOf(r.body);
  console.log("events returned:", events.length);
  for (const e of events) {
    const who = String(e.pubkey).slice(0, 10);
    const when = new Date(e.created_at * 1000).toISOString().slice(11, 19);
    console.log(`  from=${who}... at=${when} content=${JSON.stringify(String(e.content).slice(0, 70))}`);
  }
}
