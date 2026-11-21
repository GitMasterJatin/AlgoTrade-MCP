/**
 * trade.ts - everything that talks to Zerodha (Kite Connect API).
 *
 *   placeOrder()    price the order -> ask the human on Telegram if it is a
 *                   high-value order -> place it
 *   getPortfolio()  holdings + today's positions
 *
 * All orders are NSE, CNC (delivery) and MARKET, so the model only has to
 * choose a symbol and a quantity.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { KiteConnect } from "kiteconnect";
import type { Connect } from "kiteconnect";

import { approvalTimeoutMs, requestApproval } from "./approval";

export type Side = "BUY" | "SELL";

/** Where login.ts saves the access token. Gitignored. */
export const SESSION_FILE =
    process.env.KITE_SESSION_FILE ?? path.join(import.meta.dir, ".kite-session.json");

let client: Connect | null = null;

/**
 * Returns the one authenticated Kite client for this process, built on first
 * use from the access token that login.ts saved.
 */
function getClient(): Connect {
    if (client) return client;

    const apiKey = process.env.KITE_API_KEY;
    if (!apiKey) throw new Error("KITE_API_KEY is not set");

    if (!existsSync(SESSION_FILE)) {
        throw new Error("No Kite session. Run: bun run login");
    }

    const { access_token } = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    if (!access_token) {
        throw new Error("Kite session file has no access_token. Run: bun run login");
    }

    const kc = new KiteConnect({ api_key: apiKey });
    kc.setAccessToken(access_token);
    client = kc;
    return kc;
}

/**
 * kiteconnect rejects with a plain `{ message, error_type }` object, not an
 * Error. The MCP SDK would show that to the model as "[object Object]", so we
 * turn it into a real Error carrying Zerodha's actual reason.
 */
async function broker<T>(call: Promise<T>): Promise<T> {
    try {
        return await call;
    } catch (err) {
        if (err instanceof Error) throw err;
        const { message, error_type } = (err ?? {}) as { message?: string; error_type?: string };
        throw new Error(error_type ? `${error_type}: ${message}` : String(message ?? err));
    }
}

/**
 * Orders worth more than this many rupees are "high-value" and need a human
 * tap on Telegram. Set KITE_APPROVAL_LIMIT=0 to approve every order by hand.
 */
function approvalLimit(): number {
    const raw = process.env.KITE_APPROVAL_LIMIT;
    if (raw === undefined) return 2_000;

    const limit = Number(raw);
    if (!Number.isFinite(limit) || limit < 0) {
        throw new Error(`KITE_APPROVAL_LIMIT must be 0 or more, got "${raw}"`);
    }
    return limit;
}

export async function placeOrder(tradingsymbol: string, quantity: number, side: Side) {
    const kc = getClient();
    const instrument = `NSE:${tradingsymbol}`;

    // STEP 1: estimate the order value from the last traded price.
    // A market order has no price of its own, so LTP x quantity is the estimate.
    const quote = await broker(kc.getLTP(instrument));
    const lastPrice = quote[instrument]?.last_price;
    if (!lastPrice) {
        throw new Error(`No price for ${instrument}. Check the symbol. No order was placed.`);
    }
    const value = lastPrice * quantity;

    // STEP 2: human in the loop. For a high-value order the tool call WAITS
    // here until the human taps Approve / Reject on Telegram, or time runs out.
    // This runs in the server, so no client or model can skip it.
    if (value > approvalLimit()) {
        const decision = await requestApproval(
            `${side} ${quantity} ${tradingsymbol} on NSE at ~₹${lastPrice}\n` +
                `Estimated value: ₹${Math.round(value)}`,
        );

        if (decision !== "approved") {
            const why =
                decision === "rejected"
                    ? "was rejected by the user on Telegram"
                    : `was not approved within ${Math.round(approvalTimeoutMs() / 1000)}s`;

            // Throwing makes the MCP SDK return `isError: true`, so the model
            // knows it failed. "Do not retry" stops it from calling the tool
            // again and sending you a second request.
            throw new Error(
                `Order ${why}. No order was placed. Do not retry unless the user asks again.`,
            );
        }
    }

    // STEP 3: place the order on Zerodha.
    const { order_id } = await broker(
        kc.placeOrder("regular", {
            exchange: "NSE",
            tradingsymbol,
            transaction_type: side,
            quantity,
            product: "CNC", // delivery: shares are held, not squared off intraday
            order_type: "MARKET", // fill now at the best available price
        }),
    );

    return { order_id, side, tradingsymbol, quantity, estimated_value: Math.round(value) };
}

/**
 * Holdings = shares delivered to your demat account (show up from T+1).
 * Positions = today's trades (a stock bought today is here, not in holdings).
 * The model needs both to know everything you own, e.g. to "sell everything".
 */
export async function getPortfolio() {
    const kc = getClient();
    const [holdings, positions] = await Promise.all([
        broker(kc.getHoldings()),
        broker(kc.getPositions()),
    ]);

    return { holdings, positions: positions.net };
}
