/**
 * Live demo: runs the real MCP server against a fake Zerodha on localhost and
 * drives it over stdio exactly like an MCP client (Claude Desktop) would.
 *
 *   bun run demo
 *
 * No Zerodha account, API key or money needed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FakeKite } from "./tests/helpers/fake-kite";

const broker = await new FakeKite().start();

const dir = mkdtempSync(path.join(tmpdir(), "algotrade-demo-"));
const sessionFile = path.join(dir, "session.json");
const approvalFile = path.join(dir, "pending-approval");
writeFileSync(sessionFile, JSON.stringify({ access_token: "demo-token" }));

type Client = {
    callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;
    listTools: () => Promise<any[]>;
    close: () => void;
};

/** Starts index.ts as a child process and speaks MCP JSON-RPC to it. */
async function startServer(extraEnv: Record<string, string>): Promise<Client> {
    const child: ChildProcess = spawn(process.execPath, ["index.ts"], {
        cwd: import.meta.dir,
        stdio: ["pipe", "pipe", "ignore"], // stderr hidden; the human reads the approval file
        env: {
            ...process.env,
            KITE_API_KEY: "demo-key",
            KITE_SESSION_FILE: sessionFile,
            KITE_API_ROOT: broker.root,
            KITE_APPROVAL_FILE: approvalFile,
            ...extraEnv,
        },
    });

    const waiting = new Map<number, (msg: any) => void>();
    let buffer = "";

    child.stdout!.on("data", (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
                const msg = JSON.parse(line);
                waiting.get(msg.id)?.(msg);
                waiting.delete(msg.id);
            }
            newline = buffer.indexOf("\n");
        }
    });

    let nextId = 0;
    const request = (method: string, params: unknown) =>
        new Promise<any>((resolve) => {
            const id = ++nextId;
            waiting.set(id, resolve);
            child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });

    await request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "demo", version: "1" },
    });
    child.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );

    return {
        callTool: async (name, args = {}) => {
            const msg = await request("tools/call", { name, arguments: args });
            return msg.result;
        },
        listTools: async () => (await request("tools/list", {})).result.tools,
        close: () => child.kill(),
    };
}

function heading(title: string) {
    console.log(`\n\x1b[1;36m━━ ${title} ━━\x1b[0m`);
}

function show(result: any) {
    const text = result.content?.[0]?.text ?? JSON.stringify(result);
    const label = result.isError ? "\x1b[31m✗ isError\x1b[0m" : "\x1b[32m✓ ok\x1b[0m";
    console.log(`${label}  ${text}`);
}

/** What the human does: read the code from the file the model cannot see. */
function readApprovalCode(): string {
    return readFileSync(approvalFile, "utf8").match(/Code: ([0-9A-F]+)/)![1]!;
}

const buyInfy = { tradingsymbol: "INFY", quantity: 10 };

// ---------------------------------------------------------------------------
heading("1. Kill switch: KITE_TRADING_ENABLED not set");
{
    const off = await startServer({});
    show(await off.callTool("buy_stock", buyInfy));
    off.close();
}

const server = await startServer({ KITE_TRADING_ENABLED: "true" });

heading("2. Tools exposed to the LLM");
for (const tool of await server.listTools()) {
    console.log(`  - ${tool.name}`);
}

heading("3. Order-value cap: 1000 x INFY at ~₹100 (cap ₹10,000)");
show(await server.callTool("buy_stock", { tradingsymbol: "INFY", quantity: 1000 }));

heading("4. Human approval: first call places nothing");
show(await server.callTool("buy_stock", buyInfy));
console.log("\n  Approval file (only the human sees this):");
console.log(readFileSync(approvalFile, "utf8").replace(/^/gm, "    "));

heading("5. Fake code made up by the model");
show(await server.callTool("buy_stock", { ...buyInfy, confirm: "DEADBEEF00" }));

heading("6. Real code, but for a DIFFERENT order (50 shares instead of 10)");
const code = readApprovalCode();
show(await server.callTool("buy_stock", { tradingsymbol: "INFY", quantity: 50, confirm: code }));

heading("7. Real code, same order -> placed");
show(await server.callTool("buy_stock", { ...buyInfy, confirm: readApprovalCode() }));

heading("8. Lost response: Zerodha accepted, but the reply never came back");
await server.callTool("buy_stock", buyInfy); // request approval
const code8 = readApprovalCode();
broker.placeMode = "fail_after_accept";
show(await server.callTool("buy_stock", { ...buyInfy, confirm: code8 }));

heading("9. Lost response AND order book unreadable -> UNKNOWN, never a guess");
await server.callTool("buy_stock", buyInfy);
const code9 = readApprovalCode();
broker.bookReadable = false;
show(await server.callTool("buy_stock", { ...buyInfy, confirm: code9 }));
broker.bookReadable = true;

heading("10. Clean rejection -> safe to retry, with the real reason");
await server.callTool("buy_stock", buyInfy);
const code10 = readApprovalCode();
broker.placeMode = "fail_clean";
show(await server.callTool("buy_stock", { ...buyInfy, confirm: code10 }));
broker.placeMode = "ok";

heading("11. get_orders");
show(await server.callTool("get_orders"));

heading("12. cancel_order on a partly filled order");
broker.book.push({
    order_id: "OID_PARTIAL",
    variety: "regular",
    status: "OPEN",
    tradingsymbol: "TCS",
    quantity: 100,
    filled_quantity: 40,
    pending_quantity: 60,
});
show(await server.callTool("cancel_order", { order_id: "OID_PARTIAL" }));

heading("13. cancel_order on a filled order");
broker.book.push({
    order_id: "OID_DONE",
    variety: "regular",
    status: "COMPLETE",
    tradingsymbol: "HDFCBANK",
    quantity: 5,
    filled_quantity: 5,
    pending_quantity: 0,
});
show(await server.callTool("cancel_order", { order_id: "OID_DONE" }));

server.close();
await broker.stop();
console.log("\nDemo finished.\n");
process.exit(0);
