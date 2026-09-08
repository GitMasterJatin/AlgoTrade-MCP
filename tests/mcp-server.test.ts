import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";

/**
 * Drives the real server the way a client would: over stdio, speaking JSON-RPC.
 * No session file exists here, so every tool call should fail cleanly.
 */
// process.execPath is the bun running these tests, so this works without
// bun being on PATH.
const child = spawn(process.execPath, ["index.ts"], {
    cwd: import.meta.dir + "/..",
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, KITE_API_KEY: "fake", KITE_SESSION_FILE: "/nonexistent" },
});

const waiting = new Map<number, (msg: any) => void>();
let buffer = "";

child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let nl; (nl = buffer.indexOf("\n")) !== -1; ) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        const msg = JSON.parse(line);
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
    }
});

let id = 0;
const call = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
        const request = { jsonrpc: "2.0", id: ++id, method, params };
        waiting.set(request.id, resolve);
        child.stdin.write(JSON.stringify(request) + "\n");
        setTimeout(() => reject(new Error(`no reply to ${method}`)), 10_000);
    });

await call("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "tests", version: "0" },
});
child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
);

const { result } = await call("tools/list", {});
const tools: any[] = result.tools;
const tool = (name: string) => tools.find((t) => t.name === name);

afterAll(() => child.kill());

test("exposes the five tools", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
        "buy_stock",
        "cancel_order",
        "get_orders",
        "sell_stock",
        "show_portfolio",
    ]);
});

// A client can only warn before a costly call if we say which calls are costly.
test.each(["buy_stock", "sell_stock", "cancel_order"])(
    "%s is marked destructive",
    (name) => {
        expect(tool(name).annotations?.destructiveHint).toBe(true);
    },
);

test.each(["get_orders", "show_portfolio"])("%s is marked read-only", (name) => {
    expect(tool(name).annotations?.readOnlyHint).toBe(true);
});

// BO was withdrawn and CO is a variety, not a product. Offering either just
// produces orders the broker rejects.
test("offers only product types Kite still accepts", () => {
    for (const name of ["buy_stock", "sell_stock"]) {
        expect(tool(name).inputSchema.properties.product.enum).toEqual([
            "CNC",
            "MIS",
            "NRML",
        ]);
    }
});

// A failure dressed up as a normal result is worse than no result at all: the
// model can't tell a rejected order from a filled one.
test.each(["show_portfolio", "get_orders"])(
    "%s reports a missing session as an error, not a result",
    async (name) => {
        const { result } = await call("tools/call", { name, arguments: {} });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/Run: bun run login/);
    },
);
