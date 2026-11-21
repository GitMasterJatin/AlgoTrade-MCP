/**
 * login.ts - one-time daily login (Kite Connect's OAuth-style flow).
 *
 *   bun run login              -> prints the Zerodha login URL
 *   (user logs in, Zerodha redirects to ...?request_token=XYZ)
 *   bun run login XYZ          -> exchanges it for an access token, saves it
 *
 * TWO TOKENS, DIFFERENT LIFETIMES
 *   request_token : single use, valid for minutes. Proves the user approved our app.
 *   access_token  : reused for every API call until ~6 AM next day.
 * generateSession(request_token, api_secret) does the exchange. The api_secret
 * proves the request comes from OUR registered app, so it only ever lives in
 * env vars - never in code.
 *
 * WHY A SEPARATE SCRIPT: the MCP server (index.ts) never handles the secret or
 * the login. It only reads the saved access token (getClient in trade.ts).
 * Earlier versions re-ran generateSession on every start, which fails because
 * the request token is one-time - this split fixed that.
 *
 * console.log is fine HERE because this is a normal CLI, not the stdio server.
 */
import { writeFileSync } from "node:fs";

import { KiteConnect } from "kiteconnect";

import { SESSION_FILE } from "./trade";

const apiKey = process.env.KITE_API_KEY;
const apiSecret = process.env.KITE_API_SECRET;

if (!apiKey || !apiSecret) {
    console.error("Set KITE_API_KEY and KITE_API_SECRET");
    process.exit(1);
}

const kc = new KiteConnect({ api_key: apiKey });
const requestToken = process.argv[2];

if (!requestToken) {
    console.log("1. Open this URL and log in:\n");
    console.log(`   ${kc.getLoginURL()}\n`);
    console.log("2. Copy the request_token from the redirect URL, then run:\n");
    console.log("   bun run login <request_token>");
    process.exit(0);
}

const { access_token } = await kc.generateSession(requestToken, apiSecret);
// mode 0o600 = only the file owner can read/write it. The file is gitignored.
writeFileSync(SESSION_FILE, JSON.stringify({ access_token }, null, 2), { mode: 0o600 });
console.log(`Session saved to ${SESSION_FILE}`);
