import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FakeKite } from "./fake-kite";

/**
 * `bun test` shares one process across files, and trade.ts builds its Kite
 * client once and keeps it. So the fake broker and the session have to be set
 * up once, here, and shared -- a broker per test file would leave whichever
 * file ran second talking to a closed server.
 */
export const broker = await new FakeKite().start();

const session = path.join(mkdtempSync(path.join(tmpdir(), "kite-test-")), "session.json");
writeFileSync(session, JSON.stringify({ access_token: "fake-token" }));

process.env.KITE_API_KEY = "fake-key";
process.env.KITE_SESSION_FILE = session;
process.env.KITE_API_ROOT = broker.root;
process.env.KITE_TRADING_ENABLED = "true";

export const { placeOrder, cancelOrder, getOrders } = await import("../../trade");
