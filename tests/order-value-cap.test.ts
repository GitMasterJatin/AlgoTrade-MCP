import { beforeEach, expect, test } from "bun:test";

import { broker, placeOrder, reset } from "./helpers/setup";

const buy = (over: Record<string, unknown> = {}) =>
    ({
        tradingsymbol: "INFY",
        quantity: 10,
        transaction_type: "BUY",
        ...over,
    }) as Parameters<typeof placeOrder>[0];

beforeEach(reset);

test("allows an order inside the cap", async () => {
    process.env.KITE_MAX_ORDER_VALUE = "10000";
    broker.lastPrice = 100; // 10 x 100 x 1.05 = 1050

    expect((await placeOrder(buy())).order_id).toBe("OID_PLACED");
});

test("refuses an order over the cap, and says what it was worth", async () => {
    process.env.KITE_MAX_ORDER_VALUE = "5000";
    broker.lastPrice = 1000; // 10 x 1000 x 1.05 = 10500

    expect(placeOrder(buy())).rejects.toThrow(/about 10500.*over the 5000 cap/s);
    expect(placeOrder(buy())).rejects.toThrow(/No order was placed/);
});

test("nothing reaches the broker when an order is refused", async () => {
    process.env.KITE_MAX_ORDER_VALUE = "100";
    broker.lastPrice = 1000;
    broker.placedTags = [];

    await placeOrder(buy()).catch(() => {});

    expect(broker.placedTags).toBeEmpty();
});

// A market order has no price of its own, so it is valued off the last trade
// with room for slippage -- erring towards refusing rather than allowing.
test("prices a market order above the last trade", async () => {
    process.env.KITE_MAX_ORDER_VALUE = "1000";
    broker.lastPrice = 100; // exactly 1000 unpadded; 1050 once padded

    expect(placeOrder(buy())).rejects.toThrow(/plus 5% for slippage/);
});

test("uses the limit price when there is one, without asking for a quote", async () => {
    process.env.KITE_MAX_ORDER_VALUE = "500";
    broker.lastPrice = null; // quotes are down, and must not be needed

    expect(placeOrder(buy({ order_type: "LIMIT", price: 90 }))).rejects.toThrow(
        /limit price 90/,
    );
});

// A cap that switches itself off when a lookup fails is not a cap.
test("refuses the order when the price cannot be established", async () => {
    process.env.KITE_MAX_ORDER_VALUE = "1000000";
    broker.lastPrice = null;

    expect(placeOrder(buy())).rejects.toThrow(/Cannot price NSE:INFY/);
    expect(placeOrder(buy())).rejects.toThrow(/No order was placed/);
});

test("rejects a nonsense cap rather than ignoring it", async () => {
    process.env.KITE_MAX_ORDER_VALUE = "abc";

    expect(placeOrder(buy())).rejects.toThrow(/must be a positive number/);
});

test("applies a default cap when none is configured", async () => {
    broker.lastPrice = 50_000; // 10 x 50000 far exceeds any sane default

    expect(placeOrder(buy())).rejects.toThrow(/over the 10000 cap/);
});
