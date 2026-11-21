/**
 * approval.ts - human-in-the-loop approval over Telegram.
 *
 * WHAT IT DOES
 *   requestApproval("BUY 10 INFY ...") sends you a Telegram message with
 *   [✅ Approve] [❌ Reject] buttons and WAITS for your tap. It resolves to
 *   "approved", "rejected" or "timeout". Nothing else in the server decides
 *   whether a high-value order goes through.
 *
 * WHY TELEGRAM AND NOT CLAUDE'S "Allow tool" PROMPT
 *   - That prompt lives in the client. After "Allow for this chat" it never asks
 *     again, it shows raw arguments rather than the rupee value, and another
 *     MCP client may not have it at all.
 *   - This check lives in the SERVER, so no client or model can skip it.
 *   - The approval travels on a separate channel (your phone). The model never
 *     sees the buttons or the callback ids, so it cannot approve its own order.
 *
 * HOW THE WAITING WORKS (no blocking)
 *   Each request gets a random id. We store the Promise's `settle` function in
 *   a Map under that id. The id is inside the button's callback_data. When the
 *   button is tapped, the poll loop reads the id back, finds the entry and
 *   settles it. Meanwhile Node's event loop keeps serving other tool calls.
 *
 * WHY LONG POLLING (getUpdates) AND NOT A WEBHOOK
 *   This server runs locally (stdio), so it has no public HTTPS URL for
 *   Telegram to call. Long polling means WE ask Telegram "anything new?" and it
 *   holds the request open until a tap arrives or the poll times out.
 *   In production you would switch to a webhook.
 *
 * Uses the Telegram Bot API directly with fetch - no Telegram library.
 *
 * Setup: create a bot with @BotFather (gives TELEGRAM_BOT_TOKEN), message it
 * once, and put your own Telegram user id in TELEGRAM_CHAT_ID.
 */
import { randomBytes } from "node:crypto";

export type Decision = "approved" | "rejected" | "timeout";

type PendingApproval = {
    /** Resolves the waiting Promise. Safe to call twice: only the first wins. */
    settle: (decision: Decision) => void;
};

/** Approval id -> the order waiting on it. */
const pending = new Map<string, PendingApproval>();

/** True while the poll loop is running. There is only ever one loop. */
let polling = false;

/** Telegram update offset: ask only for updates we have not processed yet. */
let offset = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads Telegram settings from env. Throws when they are missing, so an order
 * that needs approval is REFUSED rather than silently auto-approved
 * (fail closed).
 */
function telegramConfig() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        throw new Error(
            "This order needs human approval, but TELEGRAM_BOT_TOKEN and " +
                "TELEGRAM_CHAT_ID are not set. No order was placed.",
        );
    }

    return { token, chatId: Number(chatId) };
}

/**
 * How long to wait for a tap. Default 50s on purpose: MCP clients usually give
 * up on a tool call after about 60s, so the server must answer first.
 */
export function approvalTimeoutMs(): number {
    return 50_000;
}

/** Calls one Telegram Bot API method. Telegram replies { ok, result | description }. */
async function telegram(method: string, body: Record<string, unknown>): Promise<any> {
    const { token } = telegramConfig();

    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: any; description?: string };

    if (!json.ok) {
        throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
    }
    return json.result;
}

/**
 * Asks the human, waits for the answer, returns it.
 * Never throws for a "no" - only when the question could not be asked at all.
 */
export async function requestApproval(summary: string): Promise<Decision> {
    const { chatId } = telegramConfig();
    const timeoutMs = approvalTimeoutMs();

    // Cryptographically random, so a callback for one order can't be guessed
    // or reused for another. 16 hex chars keeps callback_data under Telegram's
    // 64-byte limit.
    const id = randomBytes(8).toString("hex");
    const text =
        `🔔 APPROVAL REQUIRED\n${summary}\n` +
        `Expires in ${Math.round(timeoutMs / 1000)}s`;

    let message: { message_id: number };
    try {
        message = await telegram("sendMessage", {
            chat_id: chatId,
            text,
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Approve", callback_data: `approve:${id}` },
                        { text: "❌ Reject", callback_data: `reject:${id}` },
                    ],
                ],
            },
        });
    } catch (err) {
        // Could not even ask -> refuse. Never treat "couldn't ask" as "yes".
        throw new Error(
            `Could not reach Telegram to ask for approval ` +
                `(${(err as Error).message}). No order was placed.`,
        );
    }

    const decision = await new Promise<Decision>((resolve) => {
        // Whichever comes first - a tap or the timer - settles the Promise.
        // Both paths go through settle(), which deletes the entry first, so a
        // tap that lands at the same moment as the timeout cannot win twice.
        const timer = setTimeout(() => settle("timeout"), timeoutMs);

        function settle(result: Decision) {
            if (!pending.has(id)) return; // already settled
            pending.delete(id);
            clearTimeout(timer);
            resolve(result);
        }

        pending.set(id, { settle });
        startPolling();
    });

    // Best effort: replace the buttons with the outcome so the chat shows what
    // happened. Not awaited - the order must not wait on a cosmetic edit.
    const outcome = {
        approved: "✅ Approved",
        rejected: "❌ Rejected - not placed",
        timeout: "⌛ Timed out - not placed",
    }[decision];

    telegram("editMessageText", {
        chat_id: chatId,
        message_id: message.message_id,
        text: `${text}\n\n${outcome}`,
    }).catch(() => {});

    return decision;
}

/** Starts the poll loop unless it is already running. */
function startPolling() {
    if (polling) return;
    polling = true;
    void pollLoop();
}

/**
 * Long-polls Telegram for button taps while any approval is pending, then stops.
 *
 * No race when a new request arrives as the loop finishes: the
 * `pending.size > 0` check and the `polling = false` reset happen in the same
 * synchronous step, so a new request either sees the loop still running (it
 * will be picked up) or sees polling === false and starts a fresh loop.
 */
async function pollLoop() {
    try {
        while (pending.size > 0) {
            let updates: any[];
            try {
                updates = await telegram("getUpdates", {
                    offset,
                    timeout: 10, // seconds Telegram may hold the request open
                    allowed_updates: ["callback_query"],
                });
            } catch {
                // Network blip: back off and keep trying. The per-request
                // timeout still fires, so nothing waits forever.
                await sleep(1000);
                continue;
            }

            for (const update of updates) {
                offset = update.update_id + 1; // acknowledge it
                if (update.callback_query) await handleButtonTap(update.callback_query);
            }
        }
    } finally {
        polling = false;
    }
}

/** Handles one button tap. */
async function handleButtonTap(query: any) {
    const { chatId } = telegramConfig();

    // Telegram shows a spinner on the button until we answer the callback.
    const answer = (text?: string) =>
        telegram("answerCallbackQuery", {
            callback_query_id: query.id,
            ...(text && { text }),
        }).catch(() => {});

    // Only the account owner may approve. Anyone who finds the bot and taps a
    // button is ignored, and the order stays pending.
    if (query.from?.id !== chatId) {
        await answer("Not authorised");
        return;
    }

    const [action, id] = String(query.data ?? "").split(":");
    const entry = id ? pending.get(id) : undefined;

    if (!entry) {
        // Tapped after a timeout, or an old message from before a restart.
        await answer("This request has expired");
        return;
    }

    // Only an explicit "approve" approves. Anything else counts as a reject.
    entry.settle(action === "approve" ? "approved" : "rejected");
    await answer();
}
