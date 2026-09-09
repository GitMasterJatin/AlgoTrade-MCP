import { beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { APPROVAL_FILE, broker, placeOrder, readApprovalCode, reset } from "./helpers/setup";

const buy = (over: Record<string, unknown> = {}) =>
    ({
        tradingsymbol: "INFY",
        quantity: 10,
        transaction_type: "BUY",
        ...over,
    }) as Parameters<typeof placeOrder>[0];

beforeEach(() => {
    reset();
    process.env.KITE_REQUIRE_APPROVAL = "true";
});

test("a first call places nothing and asks for approval", async () => {
    broker.placedTags = [];

    expect(placeOrder(buy())).rejects.toThrow(/Approval required.*No order was placed/s);
    expect(broker.placedTags).toBeEmpty();
});

// The model is the only thing talking to this server, so a code in the response
// could just be echoed back. It has to travel out of band.
test("the code never appears in what the model is told", async () => {
    let message = "";
    await placeOrder(buy()).catch((e) => (message = e.message));

    expect(existsSync(APPROVAL_FILE)).toBe(true);
    expect(message).not.toContain(readApprovalCode());
});

test("the approval notice says what is being approved", async () => {
    await placeOrder(buy({ quantity: 3 })).catch(() => {});

    const notice = readFileSync(APPROVAL_FILE, "utf8");
    expect(notice).toContain("BUY 3 INFY on NSE");
    expect(notice).toMatch(/Estimated value: \d+/);
});

test("the order goes through once the code comes back", async () => {
    await placeOrder(buy()).catch(() => {});

    const result = await placeOrder(buy({ confirm: readApprovalCode() }));
    expect(result.order_id).toBe("OID_PLACED");
});

test("a code works only once", async () => {
    await placeOrder(buy()).catch(() => {});
    const code = readApprovalCode();
    await placeOrder(buy({ confirm: code }));

    expect(placeOrder(buy({ confirm: code }))).rejects.toThrow(/not valid/);
});

// The property that matters: approval is bound to one exact order, so a code
// obtained for one buy cannot be spent on another. Quantities here stay under
// the value cap, so it is the fingerprint doing the refusing and not the cap.
test.each([
    ["a bigger quantity", { quantity: 50 }],
    ["a different symbol", { tradingsymbol: "TCS" }],
    ["the opposite side", { transaction_type: "SELL" }],
    ["a different product", { product: "MIS" }],
])("a code cannot be spent on %s", async (_label, changed) => {
    await placeOrder(buy({ quantity: 1 })).catch(() => {});
    const code = readApprovalCode();

    expect(placeOrder(buy({ ...changed, confirm: code }))).rejects.toThrow(
        /issued for a different order/,
    );
});

test("a made-up code is refused", async () => {
    expect(placeOrder(buy({ confirm: "DEADBEEF01" }))).rejects.toThrow(/not valid/);
});

// An approval given at one price should not execute at another.
test("a code is void if the market moved past the band", async () => {
    broker.lastPrice = 100;
    await placeOrder(buy()).catch(() => {});
    const code = readApprovalCode();

    broker.lastPrice = 110; // +10%, outside the 2% band

    expect(placeOrder(buy({ confirm: code }))).rejects.toThrow(/moved 10.0% since approval/);
});

test("a small move stays inside the band", async () => {
    broker.lastPrice = 100;
    await placeOrder(buy()).catch(() => {});
    const code = readApprovalCode();

    broker.lastPrice = 101; // +1%

    expect((await placeOrder(buy({ confirm: code }))).order_id).toBe("OID_PLACED");
});

test("approval can be turned off for automated use", async () => {
    process.env.KITE_REQUIRE_APPROVAL = "false";

    expect((await placeOrder(buy())).order_id).toBe("OID_PLACED");
});
