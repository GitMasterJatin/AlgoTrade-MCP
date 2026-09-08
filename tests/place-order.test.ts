import { beforeEach, describe, expect, test } from "bun:test";

import { broker, placeOrder, reset } from "./helpers/setup";

const buy = { tradingsymbol: "INFY", quantity: 1, transaction_type: "BUY" } as const;

beforeEach(reset);

describe("placing an order", () => {

    test("returns the order id and the tag it was placed under", async () => {
        broker.placeMode = "ok";
        const result = await placeOrder(buy);

        expect(result.order_id).toBe("OID_PLACED");
        expect(result.tag).toMatch(/^[a-z0-9]{1,20}$/i);
        expect(broker.placedTags.at(-1)).toBe(result.tag);
    });

    test("gives every attempt its own tag", async () => {
        broker.placeMode = "ok";
        await placeOrder(buy);
        await placeOrder(buy);

        expect(new Set(broker.placedTags).size).toBe(broker.placedTags.length);
    });
});

// The case this whole mechanism exists for: Zerodha took the order, but the
// response never made it back. Retrying blindly here buys the stock twice.
describe("when the placement request fails", () => {
    test("finds the order by its tag and says not to retry", async () => {
        broker.placeMode = "fail_after_accept";
        const result = await placeOrder(buy);

        expect(result.order_id).toBe("OID_LOST_RESPONSE");
        expect(result.note).toMatch(/DID reach Zerodha/);
        expect(result.note).toMatch(/Do not retry/);
    });

    test("reports a clean rejection as safe to retry, with the real reason", async () => {
        broker.placeMode = "fail_clean";

        expect(placeOrder(buy)).rejects.toThrow(/was NOT placed.*Safe to retry/s);
        expect(placeOrder(buy)).rejects.toThrow(/InputException: Invalid tradingsymbol/);
    });

    test("never reports a Kite error as [object Object]", async () => {
        broker.placeMode = "fail_clean";
        expect(placeOrder(buy)).rejects.not.toThrow(/\[object Object\]/);
    });

    // "Not in the book" and "couldn't read the book" are different answers.
    // Confusing them would call a live order unplaced, which is the direction
    // that costs money.
    test("says UNKNOWN, not 'safe to retry', when the book can't be read", async () => {
        broker.placeMode = "fail_after_accept";
        broker.bookReadable = false;

        try {
            await placeOrder(buy);
            throw new Error("expected placeOrder to throw");
        } catch (err) {
            const message = (err as Error).message;
            expect(message).toMatch(/UNKNOWN/);
            expect(message).not.toMatch(/Safe to retry/);
            expect(message).toMatch(/Check Zerodha for tag \w+/);
        } finally {
            broker.bookReadable = true;
        }
    });
});
