/**
 * index.ts - the MCP server (entry point).
 *
 * Exposes Zerodha to an LLM (Claude) as three MCP tools:
 *   buy_stock       place a BUY order   (Telegram approval if high-value)
 *   sell_stock      place a SELL order  (Telegram approval if high-value)
 *   show_portfolio  holdings + today's positions
 *
 * HOW A CALL FLOWS
 *   1. Claude Desktop starts this file as a child process (stdio transport).
 *   2. On startup it calls `tools/list`. The SDK answers with each tool's name,
 *      description and a JSON Schema generated from the Zod schema. That is
 *      all the model knows about a tool, so descriptions are written as
 *      instructions to the model.
 *   3. The model sends `tools/call`. Zod validates the arguments at runtime
 *      BEFORE the handler runs.
 *   4. The handler calls trade.ts. If that throws, the SDK turns it into a
 *      result with `isError: true`, so the model sees a real failure.
 *
 * MULTI-STEP FLOWS: the server has no agent loop. Claude plans the steps
 * itself. For "sell everything" it calls show_portfolio, reads the result,
 * then calls sell_stock once per holding. Each tool just does one job.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { getPortfolio, placeOrder } from './trade';

const server = new McpServer({ name: 'zerodha-trade', version: '1.0.0' });

/*
 * Zod schema: runtime validation + the JSON Schema the model sees.
 * TypeScript types disappear at runtime, and arguments from an LLM can't be
 * trusted, so they are checked here. quantity rejects 0, -3, 2.5 and "two".
 */
const orderSchema = z.object({
    tradingsymbol: z.string().describe('NSE trading symbol, e.g. INFY, HDFCBANK'),
    quantity: z.number().int().positive(),
});

/* Tells the model it must expect a wait and must not retry after a "no". */
const ORDER_RULES =
    'This places a REAL order on NSE. Orders above the approval limit wait for ' +
    'the user to tap Approve on Telegram (up to ~50s). If the order was rejected ' +
    'or not approved, do not retry unless the user asks again.';

server.registerTool(
    'buy_stock',
    {
        description: `Buy a stock on Zerodha. ${ORDER_RULES}`,
        inputSchema: orderSchema,
    },
    async ({ tradingsymbol, quantity }) => {
        const result = await placeOrder(tradingsymbol, quantity, 'BUY');

        // MCP results are a list of content blocks; JSON as text is easy for
        // the model to read.
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
);

server.registerTool(
    'sell_stock',
    {
        description:
            `Sell a stock on Zerodha. ${ORDER_RULES} ` +
            'To sell everything, call show_portfolio first and sell each holding.',
        inputSchema: orderSchema,
    },
    async ({ tradingsymbol, quantity }) => {
        const result = await placeOrder(tradingsymbol, quantity, 'SELL');
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
);

server.registerTool(
    'show_portfolio',
    {
        description:
            'Shows my Zerodha portfolio: holdings (delivered shares) and positions ' +
            "(today's trades). Call this before selling so quantities are exact.",
        inputSchema: z.object({}),
    },
    async () => {
        const portfolio = await getPortfolio();
        return { content: [{ type: 'text', text: JSON.stringify(portfolio) }] };
    },
);

/*
 * stdio transport: the client spawns this process and exchanges JSON-RPC 2.0
 * messages over stdin/stdout. STDOUT IS THE PROTOCOL CHANNEL, so nothing in
 * this server may console.log - it would corrupt the messages.
 */
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main();
