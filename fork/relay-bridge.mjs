/**
 * Local TLS bridge for the Buzz relay.
 *
 * Why this exists
 * ---------------
 * Norton Antivirus intercepts HTTPS on this machine and re-signs it with
 * `CN=Norton Web/Mail Shield Root`. `buzz-acp` is compiled against
 * `rustls-tls-webpki-roots`, which pins Mozilla's root list and ignores both the
 * Windows trust store and SSL_CERT_FILE, so it can never validate that
 * certificate. It dies at startup with `invalid peer certificate: UnknownIssuer`
 * and, because relay.rs treats rustls handshake errors as terminal, never
 * retries. Agents crash-loop and never answer.
 *
 * This bridge sidesteps it without touching antivirus settings or rebuilding:
 *
 *   buzz-acp --ws(plain)--> 127.0.0.1:8787 --TLS--> relay-production-...railway.app
 *
 * Loopback is not TLS, so Norton has nothing to intercept. Node performs the
 * outbound TLS and trusts Norton's root via the CA bundle, so traffic on the
 * public wire stays encrypted exactly as before.
 *
 * It is a raw TCP<->TLS pipe, not a WebSocket proxy -- no dependencies, and it
 * never parses or buffers frames. The single piece of HTTP awareness is
 * rewriting the `Host:` header of the opening upgrade request, because Railway's
 * edge routes on Host and the client will have sent `127.0.0.1:8787`.
 *
 * Usage:
 *   node fork/relay-bridge.mjs [--port 8787] [--upstream <host>] [--ca <pem>]
 */

import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg("port", 8787));
const UPSTREAM_HOST = arg("upstream", "relay-production-61de.up.railway.app");
const UPSTREAM_PORT = 443;
const CA_PATH = arg("ca", path.join(os.homedir(), ".hermes", "win-ca-bundle.pem"));

// Trust the interception CA explicitly rather than disabling verification --
// this keeps the upstream leg genuinely verified.
let ca;
try {
  ca = fs.readFileSync(CA_PATH);
  console.log(`[bridge] trusting extra CA bundle: ${CA_PATH}`);
} catch {
  console.log(`[bridge] no CA bundle at ${CA_PATH}; using system defaults`);
}

const HOST_LINE = /^Host:.*$/im;

const server = net.createServer((client) => {
  const tag = `${client.remoteAddress}:${client.remotePort}`;
  let opened = false;

  const upstream = tls.connect(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      servername: UPSTREAM_HOST, // SNI must be the real host for Railway's edge
      ca,
    },
    () => {
      opened = true;
      if (!upstream.authorized) {
        console.error(`[bridge] ${tag} upstream NOT authorized: ${upstream.authorizationError}`);
        client.destroy();
        upstream.destroy();
        return;
      }
      console.log(`[bridge] ${tag} -> ${UPSTREAM_HOST} (TLS ok)`);
    },
  );

  // Railway's edge routes on Host, and the client will have sent
  // `127.0.0.1:8787`. Rewrite it on every request until the connection is
  // upgraded -- the relay also serves plain HTTP (media, git) over keep-alive,
  // where more than one request shares the socket. Once we see `101 Switching
  // Protocols` the stream is opaque WebSocket frames and must not be touched.
  let upgraded = false;
  const REQUEST_LINE = /^[A-Z]{3,7} \S+ HTTP\/1\.[01]\r?\n/;

  client.on("data", (chunk) => {
    if (!upgraded) {
      const head = chunk.toString("latin1");
      if (REQUEST_LINE.test(head) && HOST_LINE.test(head)) {
        upstream.write(Buffer.from(head.replace(HOST_LINE, `Host: ${UPSTREAM_HOST}`), "latin1"));
        return;
      }
    }
    upstream.write(chunk);
  });

  upstream.on("data", (chunk) => {
    if (!upgraded && chunk.toString("latin1", 0, 64).includes("101")) {
      upgraded = true;
    }
    client.write(chunk);
  });

  const close = (who) => (err) => {
    if (err) console.error(`[bridge] ${tag} ${who} error: ${err.message}`);
    client.destroy();
    upstream.destroy();
    if (opened) console.log(`[bridge] ${tag} closed`);
  };
  client.on("error", close("client"));
  client.on("close", close("client"));
  upstream.on("error", close("upstream"));
  upstream.on("close", close("upstream"));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[bridge] listening ws://127.0.0.1:${PORT} -> wss://${UPSTREAM_HOST}`);
});

server.on("error", (err) => {
  console.error(`[bridge] listen failed: ${err.message}`);
  process.exit(1);
});
