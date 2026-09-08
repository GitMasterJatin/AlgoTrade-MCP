import { beforeEach, expect, test } from "bun:test";

import { broker, cancelOrder, getOrders, placeOrder, reset } from "./helpers/setup";

const buy = { tradingsymbol: "INFY", quantity: 1, transaction_type: "BUY" } as const;

beforeEach(reset);

test("refuses orders while trading is disabled", async () => {
    process.env.KITE_TRADING_ENABLED = "false";

    expect(placeOrder(buy)).rejects.toThrow(/Trading is disabled. No order was placed/);
});

test("refuses orders when the switch is simply unset", async () => {
    delete process.env.KITE_TRADING_ENABLED;

    expect(placeOrder(buy)).rejects.toThrow(/Trading is disabled/);
});

test("does not reach the broker at all", async () => {
    process.env.KITE_TRADING_ENABLED = "false";
    await placeOrder(buy).catch(() => {});

    expect(broker.placedTags).toBeEmpty();
});

// The switch stops new exposure. Being unable to close a position you already
// hold would be the wrong failure, so reads and cancels stay available.
test("still allows reading the order book", async () => {
    process.env.KITE_TRADING_ENABLED = "false";
    expect(await getOrders()).toEqual([]);
});

test("still allows cancelling an open order", async () => {
    process.env.KITE_TRADING_ENABLED = "false";
    broker.book = [
        {
            order_id: "OPEN1",
            variety: "regular",
            status: "OPEN",
            tradingsymbol: "INFY",
            quantity: 1,
            filled_quantity: 0,
            pending_quantity: 1,
        },
    ];

    await cancelOrder("OPEN1");

    expect(broker.cancels.at(-1)?.order_id).toBe("OPEN1");
});
