import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { KiteConnect } from "kiteconnect";
import type { Connect, Exchanges, Variety } from "kiteconnect";

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

    // KITE_API_ROOT points the client at Kite's sandbox or a local mock.
    const root = process.env.KITE_API_ROOT;
    const kc = new KiteConnect({ api_key: apiKey, ...(root && { root }) });
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

/**
 * Order statuses that can never be cancelled.
 *
 * Deliberately a denylist: Kite documents status as open-ended ("There may be
 * other values as well"), so an allowlist of pending states would be
 * incomplete and would refuse legitimate cancels.
 */
const TERMINAL_STATUSES = new Set(["COMPLETE", "CANCELLED", "REJECTED"]);

export async function getOrders() {
    return getClient().getOrders();
}

export async function cancelOrder(orderId: string) {
    const kc = getClient();

    // Look the order up rather than trusting a caller-supplied variety: the
    // book also holds amo/co/iceberg orders placed outside this server, and
    // cancelling those with the wrong variety fails.
    const order = (await kc.getOrders()).find((o) => o.order_id === orderId);
    if (!order) {
        throw new Error(`No order ${orderId} in today's order book.`);
    }

    const status = order.status.toUpperCase();
    if (TERMINAL_STATUSES.has(status)) {
        throw new Error(
            status === "COMPLETE"
                ? `Order ${orderId} already filled ${order.filled_quantity} ` +
                  `${order.tradingsymbol} and cannot be cancelled. ` +
                  `To reverse it, place an opposing order.`
                : `Order ${orderId} is ${order.status}; nothing to cancel.`,
        );
    }

    await kc.cancelOrder(order.variety as Variety, orderId);

    return {
        order_id: orderId,
        tradingsymbol: order.tradingsymbol,
        cancelled_quantity: order.pending_quantity,
        filled_quantity: order.filled_quantity,
        // A partial fill survives the cancel. Without this the caller reads
        // "cancelled" and believes the position is flat.
        ...(order.filled_quantity > 0 && {
            warning:
                `${order.filled_quantity} of ${order.quantity} had already filled. ` +
                `That part is NOT cancelled - you hold it.`,
        }),
    };
}

export async function getHoldings() {
    return getClient().getHoldings();
}

export async function getPositions() {
    return getClient().getPositions();
}
