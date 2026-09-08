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

/** Where the access token lives. Override to keep it outside the repo. */
export const SESSION_FILE =
    process.env.KITE_SESSION_FILE ?? path.join(import.meta.dir, ".kite-session.json");

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

/**
 * kiteconnect rejects with a plain `{message, error_type}` object rather than
 * an Error. The MCP SDK stringifies non-Errors, so without this every broker
 * failure reaches the model as "[object Object]".
 */
function toError(err: unknown): Error {
    if (err instanceof Error) return err;
    if (err && typeof err === "object") {
        const { message, error_type } = err as { message?: string; error_type?: string };
        if (message) return new Error(error_type ? `${error_type}: ${message}` : message);
    }
    return new Error(String(err));
}

/** Kite tags are alphanumeric, max 20 chars. This yields 17. */
function newTag(): string {
    return `mcp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a broker call, rethrowing its rejection as a real Error. */
async function broker<T>(call: Promise<T>): Promise<T> {
    try {
        return await call;
    } catch (err) {
        throw toError(err);
    }
}

/**
 * Looks for an order carrying `tag`, retrying because the order book can lag a
 * placement by a moment. Reports whether the book was read at all: "not in the
 * book" and "could not read the book" are very different answers.
 */
async function findByTag(kc: Connect, tag: string, attempts = 3) {
    let bookRead = false;

    for (let i = 0; i < attempts; i++) {
        if (i > 0) await sleep(500);
        try {
            const orders = await kc.getOrders();
            bookRead = true;
            const hit = orders.find((o) => o.tag === tag);
            if (hit) return { hit, bookRead };
        } catch {
            // Keep trying: this lookup is the only way to resolve the ambiguity.
        }
    }

    return { hit: undefined, bookRead };
}

/**
 * Orders are refused unless KITE_TRADING_ENABLED is set to "true".
 *
 * Reads and cancels are deliberately unaffected: the switch exists to stop new
 * exposure, and being unable to close a position you already hold is the wrong
 * failure. Off by default, so an accidental run cannot spend anything.
 */
function assertTradingEnabled() {
    if (process.env.KITE_TRADING_ENABLED !== "true") {
        throw new Error(
            "Trading is disabled. No order was placed. " +
                "Set KITE_TRADING_ENABLED=true to allow orders.",
        );
    }
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
    assertTradingEnabled();

    const kc = getClient();

    // Stamped so a failed placement can be resolved against the order book.
    const tag = newTag();

    const payload: Parameters<Connect["placeOrder"]>[1] = {
        tag,
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

    try {
        return { ...(await kc.placeOrder("regular", payload)), tag };
    } catch (err) {
        // The request failed, but it may still have reached the exchange. Never
        // hand that ambiguity to the caller - resolve it against the tag.
        const { hit, bookRead } = await findByTag(kc, tag);

        if (hit) {
            return {
                order_id: hit.order_id,
                tag,
                status: hit.status,
                note:
                    "The placement request failed but the order DID reach Zerodha. " +
                    "Do not retry.",
            };
        }

        if (!bookRead) {
            throw new Error(
                `Order status UNKNOWN: placement failed (${toError(err).message}) and ` +
                    `the order book could not be read to confirm. Check Zerodha for ` +
                    `tag ${tag} before retrying.`,
            );
        }

        throw new Error(
            `Order was NOT placed (${toError(err).message}). Safe to retry.`,
        );
    }
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
    return broker(getClient().getOrders());
}

export async function cancelOrder(orderId: string) {
    const kc = getClient();

    // Look the order up rather than trusting a caller-supplied variety: the
    // book also holds amo/co/iceberg orders placed outside this server, and
    // cancelling those with the wrong variety fails.
    const order = (await broker(kc.getOrders())).find((o) => o.order_id === orderId);
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

    await broker(kc.cancelOrder(order.variety as Variety, orderId));

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
    return broker(getClient().getHoldings());
}

export async function getPositions() {
    return broker(getClient().getPositions());
}
