import { beforeEach, describe, expect, test } from "bun:test";

import type { Order } from "./helpers/fake-kite";
import { broker, cancelOrder, getOrders, reset } from "./helpers/setup";

const order = (o: Partial<Order> & { order_id: string }): Order => ({
    variety: "regular",
    status: "OPEN",
    tradingsymbol: "INFY",
    quantity: 10,
    filled_quantity: 0,
    pending_quantity: 10,
    ...o,
});

beforeEach(() => {
    reset();
    broker.book = [
        order({ order_id: "OPEN1" }),
        order({ order_id: "AMO1", variety: "amo" }),
        order({ order_id: "TRIG1", variety: "co", status: "TRIGGER PENDING" }),
        order({
            order_id: "PARTIAL1",
            tradingsymbol: "TCS",
            quantity: 100,
            filled_quantity: 40,
            pending_quantity: 60,
        }),
        order({
            order_id: "FILLED1",
            tradingsymbol: "RELIANCE",
            status: "COMPLETE",
            quantity: 5,
            filled_quantity: 5,
            pending_quantity: 0,
        }),
        order({ order_id: "GONE1", status: "CANCELLED", pending_quantity: 0 }),
    ];
});

test("get_orders returns the day's order book", async () => {
    expect(await getOrders()).toHaveLength(6);
});

describe("cancelling", () => {
    test("cancels an open order", async () => {
        const result = await cancelOrder("OPEN1");

        expect(result.cancelled_quantity).toBe(10);
        expect(result.warning).toBeUndefined();
    });

    // Kite cancels at /orders/{variety}/{order_id}, and the book holds orders
    // placed from Kite web too. Hardcoding "regular" would fail to cancel them,
    // and asking the model for the variety would be asking it to guess.
    test.each([
        ["OPEN1", "regular"],
        ["AMO1", "amo"],
        ["TRIG1", "co"],
    ])("sends %s under its own variety (%s)", async (id, variety) => {
        await cancelOrder(id);

        expect(broker.cancels.at(-1)).toEqual({ variety, order_id: id });
    });

    // Cancelling a partly filled order only cancels the rest. Without this the
    // caller reads "cancelled" and believes the position is flat.
    test("warns that a partial fill survives the cancel", async () => {
        const result = await cancelOrder("PARTIAL1");

        expect(result.cancelled_quantity).toBe(60);
        expect(result.filled_quantity).toBe(40);
        expect(result.warning).toMatch(/NOT cancelled/);
    });
});

describe("orders that cannot be cancelled", () => {
    test("a filled order explains that it needs an opposing order instead", async () => {
        expect(cancelOrder("FILLED1")).rejects.toThrow(
            /already filled 5 RELIANCE.*opposing order/s,
        );
    });

    test("an already-cancelled order is refused", async () => {
        expect(cancelOrder("GONE1")).rejects.toThrow(/is CANCELLED; nothing to cancel/);
    });

    test("an unknown order id is refused", async () => {
        expect(cancelOrder("NOSUCH")).rejects.toThrow(/No order NOSUCH/);
    });

    test("none of them reach the broker", async () => {
        for (const id of ["FILLED1", "GONE1", "NOSUCH"]) {
            await cancelOrder(id).catch(() => {});
        }

        expect(broker.cancels).toBeEmpty();
    });

    // Kite says its status vocabulary is open-ended, so we refuse the three
    // terminal states rather than allow-listing the pending ones -- an
    // allowlist would grow stale and start refusing real cancels.
    test("an unfamiliar pending status is still cancellable", async () => {
        await cancelOrder("TRIG1");

        expect(broker.cancels.at(-1)?.order_id).toBe("TRIG1");
    });
});
