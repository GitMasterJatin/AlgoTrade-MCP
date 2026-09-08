import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { KiteConnect } from "kiteconnect";
import type { Connect, Exchanges } from "kiteconnect";

type OrderType = "BUY" | "SELL";
type ProductType = "CNC" | "MIS" | "NRML";
type OrderMode = "MARKET" | "LIMIT" | "SL" | "SL-M";

type PlaceOrderInput = {
    tradingsymbol: string;
    quantity: number;
    transaction_type: OrderType;
    exchange?: string;
    product?: ProductType;
    order_type?: OrderMode;
    price?: number;
};

export const SESSION_FILE = path.join(import.meta.dir, ".kite-session.json");

let client: Connect | null = null;

/**
 * Returns the one authenticated client for this process.
 *
 * Deliberately synchronous: the memo assignment cannot be interleaved, so
 * concurrent callers (e.g. show_portfolio's Promise.all) share a single client
 * by construction rather than racing to build their own.
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

export async function placeOrder({
    tradingsymbol,
    quantity,
    transaction_type,
    exchange = "NSE",
    product = "CNC",
    order_type = "MARKET",
    price,
}: PlaceOrderInput) {
    const payload: Parameters<Connect["placeOrder"]>[1] = {
        exchange: exchange as Exchanges,
        tradingsymbol,
        transaction_type,
        quantity,
        product,
        order_type,
        ...(order_type === "LIMIT" || order_type === "SL" || order_type === "SL-M"
            ? { price: price ?? 0 }
            : {}),
    };

    return getClient().placeOrder("regular", payload);
}

export async function getHoldings() {
    return getClient().getHoldings();
}

export async function getPositions() {
    return getClient().getPositions();
}
