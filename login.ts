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
writeFileSync(SESSION_FILE, JSON.stringify({ access_token }, null, 2), { mode: 0o600 });
console.log(`Session saved to ${SESSION_FILE}`);
