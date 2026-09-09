import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
    /** Approval code, read by the human from the approval file or stderr. */
    confirm?: string;
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

/** Rupees. Deliberately small, so enabling trading without thinking is cheap. */
const DEFAULT_MAX_ORDER_VALUE = 10_000;

/** A market order can fill worse than the last trade, so estimate high. */
const SLIPPAGE_ALLOWANCE = 1.05;

function maxOrderValue(): number {
    const raw = process.env.KITE_MAX_ORDER_VALUE;
    if (raw === undefined) return DEFAULT_MAX_ORDER_VALUE;

    const cap = Number(raw);
    if (!Number.isFinite(cap) || cap <= 0) {
        throw new Error(
            `KITE_MAX_ORDER_VALUE must be a positive number, got "${raw}". ` +
                "No order was placed.",
        );
    }
    return cap;
}

/**
 * Refuses orders worth more than the cap, to catch a misplaced zero or a
 * hallucinated quantity before it reaches the exchange.
 *
 * Fails closed: if the price cannot be established the order is refused, since
 * a limit that switches itself off when a lookup fails is not a limit. Applies
 * to sells too — an oversized sell is the same fat finger, and unlike the kill
 * switch this is a standing config you size to your account, not an emergency
 * lever you reach for mid-incident.
 */
async function assertWithinValueCap(
    kc: Connect,
    order: { exchange: string; tradingsymbol: string; quantity: number },
    orderType: OrderMode,
    price: number | undefined,
): Promise<{ value: number; referencePrice?: number }> {
    const cap = maxOrderValue();
    const instrument = `${order.exchange}:${order.tradingsymbol}`;
    let unitPrice: number;
    let basis: string;
    let referencePrice: number | undefined;

    if (orderType !== "MARKET" && price) {
        // A limit price is the most you would pay per share, so it is exact.
        unitPrice = price;
        basis = `limit price ${price}`;
    } else {
        let lastPrice: number | undefined;
        try {
            lastPrice = (await kc.getLTP(instrument))[instrument]?.last_price;
        } catch (err) {
            throw new Error(
                `Cannot price ${instrument} to check the order value cap ` +
                    `(${toError(err).message}). No order was placed.`,
            );
        }
        if (!lastPrice) {
            throw new Error(
                `No last price for ${instrument}, so the order value cap cannot ` +
                    "be checked. No order was placed.",
            );
        }
        unitPrice = lastPrice * SLIPPAGE_ALLOWANCE;
        basis = `last price ${lastPrice} plus 5% for slippage`;
        referencePrice = lastPrice;
    }

    const value = unitPrice * order.quantity;
    if (value > cap) {
        throw new Error(
            `Order value is about ${Math.round(value)} (${order.quantity} x ` +
                `${basis}), over the ${cap} cap. No order was placed. ` +
                "Raise KITE_MAX_ORDER_VALUE to allow it.",
        );
    }

    return { value, referencePrice };
}

/* ------------------------------------------------------------------------- *
 * Human approval
 *
 * The model is the only thing talking to this server, so an approval code
 * returned to it could simply be echoed back. The code therefore never appears
 * in the tool response: it is written to stderr and to a file that the human
 * reads directly. What the model gets back is "approval required, here is where
 * to look".
 *
 * This defends against the model fabricating an approval. It does NOT defend
 * against a model that can read the filesystem by some other route.
 * ------------------------------------------------------------------------- */

export const APPROVAL_FILE =
    process.env.KITE_APPROVAL_FILE ?? path.join(import.meta.dir, ".pending-approval");

const APPROVAL_TTL_MS = 5 * 60 * 1000;

/** How far the market may move between approval and placement. */
const APPROVAL_PRICE_BAND = 0.02;

type PendingApproval = {
    fingerprint: string;
    expiresAt: number;
    /** Last traded price when approval was asked for, if we looked it up. */
    referencePrice?: number;
};

const pendingApprovals = new Map<string, PendingApproval>();

function approvalRequired() {
    return process.env.KITE_REQUIRE_APPROVAL !== "false";
}

/**
 * Identifies the exact order being approved. Without this a code issued for
 * "buy 1 INFY" could be spent on "buy 1000 RELIANCE".
 */
function orderFingerprint(o: {
    transaction_type: OrderType;
    exchange: string;
    tradingsymbol: string;
    quantity: number;
    product: ProductType;
    order_type: OrderMode;
    price?: number;
}) {
    const canonical = [
        o.transaction_type,
        o.exchange,
        o.tradingsymbol,
        o.quantity,
        o.product,
        o.order_type,
        o.price ?? "",
    ].join("|");
    return createHash("sha256").update(canonical).digest("hex");
}

function issueApproval(
    summary: string,
    fingerprint: string,
    referencePrice: number | undefined,
): void {
    for (const [code, approval] of pendingApprovals) {
        if (approval.expiresAt <= Date.now()) pendingApprovals.delete(code);
    }

    const code = randomBytes(5).toString("hex").toUpperCase();
    const expiresAt = Date.now() + APPROVAL_TTL_MS;
    pendingApprovals.set(code, { fingerprint, expiresAt, referencePrice });

    // Deliberately shows WHAT is being approved, not just a code: an approval
    // you cannot read is not an approval.
    const notice =
        `\n=== APPROVAL REQUIRED ===\n${summary}\n` +
        `Code: ${code}\n` +
        `Expires: ${new Date(expiresAt).toLocaleTimeString()}\n` +
        `=========================\n`;

    process.stderr.write(notice);
    try {
        writeFileSync(APPROVAL_FILE, notice, { mode: 0o600 });
    } catch {
        // stderr already carries it; a read-only directory must not block trading.
    }
}

async function redeemApproval(
    kc: Connect,
    code: string,
    fingerprint: string,
    instrument: string,
) {
    const approval = pendingApprovals.get(code.trim().toUpperCase());

    if (!approval) {
        throw new Error("That approval code is not valid. No order was placed.");
    }
    if (approval.expiresAt <= Date.now()) {
        pendingApprovals.delete(code.trim().toUpperCase());
        throw new Error(
            "That approval code has expired. Request a new one. No order was placed.",
        );
    }
    if (approval.fingerprint !== fingerprint) {
        throw new Error(
            "That approval code was issued for a different order. No order was placed.",
        );
    }

    // Prices move. An approval given on one price should not execute on another.
    if (approval.referencePrice !== undefined) {
        const now = (await broker(kc.getLTP(instrument)))[instrument]?.last_price;
        if (now === undefined) {
            throw new Error(
                `Cannot re-check the price of ${instrument} before placing an ` +
                    "approved order. No order was placed.",
            );
        }
        const drift = Math.abs(now - approval.referencePrice) / approval.referencePrice;
        if (drift > APPROVAL_PRICE_BAND) {
            pendingApprovals.delete(code.trim().toUpperCase());
            throw new Error(
                `${instrument} moved ${(drift * 100).toFixed(1)}% since approval ` +
                    `(${approval.referencePrice} to ${now}). No order was placed. ` +
                    "Request a new approval.",
            );
        }
    }

    // Single use.
    pendingApprovals.delete(code.trim().toUpperCase());
}

export async function placeOrder({
    tradingsymbol,
    quantity,
    transaction_type,
    exchange = "NSE",
    product = "CNC",
    order_type = "MARKET",
    price,
    confirm,
}: PlaceOrderInput) {
    assertTradingEnabled();

    const kc = getClient();

    // Every check runs before a tag exists, so a refused order leaves nothing
    // to reconcile.
    const { value, referencePrice } = await assertWithinValueCap(
        kc,
        { exchange, tradingsymbol, quantity },
        order_type,
        price,
    );

    if (approvalRequired()) {
        const fingerprint = orderFingerprint({
            transaction_type,
            exchange,
            tradingsymbol,
            quantity,
            product,
            order_type,
            price,
        });

        if (!confirm) {
            issueApproval(
                `${transaction_type} ${quantity} ${tradingsymbol} on ${exchange} ` +
                    `(${order_type}, ${product})\nEstimated value: ${Math.round(value)}`,
                fingerprint,
                referencePrice,
            );
            throw new Error(
                "Approval required. No order was placed. A code was written to " +
                    `${APPROVAL_FILE} and to this server's stderr - ask the user to ` +
                    "read it and call again with that code as `confirm`.",
            );
        }

        await redeemApproval(kc, confirm, fingerprint, `${exchange}:${tradingsymbol}`);
    }

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
