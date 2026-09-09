import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
process.env.KITE_APPROVAL_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "kite-approval-")),
    "pending",
);

export const { placeOrder, cancelOrder, getOrders, APPROVAL_FILE } = await import(
    "../../trade"
);

/** Reads the approval code the server wrote out-of-band, the way a human would. */
export function readApprovalCode(): string {
    const notice = readFileSync(APPROVAL_FILE, "utf8");
    return notice.match(/Code: ([0-9A-F]+)/)![1]!;
}

/**
 * Puts the broker and the environment back to a known state. Every test file
 * calls this in beforeEach: with one shared process, a test that relies on the
 * previous file having tidied up is a test that fails depending on file order.
 */
export function reset() {
    broker.reset();
    process.env.KITE_TRADING_ENABLED = "true";
    delete process.env.KITE_MAX_ORDER_VALUE;
    // Most suites test something other than approval; they opt out explicitly.
    process.env.KITE_REQUIRE_APPROVAL = "false";
}
