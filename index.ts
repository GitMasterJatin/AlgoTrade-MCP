import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { getHoldings, getPositions, placeOrder } from './trade';

const server = new McpServer({ name: 'zerodha-trade', version: '1.0.0' });

server.registerTool(
    'buy_stock',
    {
        description: 'Buy a stock on Zerodha',
        inputSchema: z.object({
            tradingsymbol: z.string(),
            quantity: z.number().int().positive(),
            exchange: z.string().default('NSE'),
            product: z.enum(['CNC', 'MIS', 'NRML', 'BO', 'CO']).default('CNC'),
            order_type: z.enum(['MARKET', 'LIMIT', 'SL', 'SL-M']).default('MARKET'),
            price: z.number().optional(),
        }),
    },
    async ({ tradingsymbol, quantity, exchange, product, order_type, price }) => {
        const result = await placeOrder({
            tradingsymbol,
            quantity,
            transaction_type: 'BUY',
            exchange,
            product,
            order_type,
            price,
        });

        return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
        };
    },
);

server.registerTool(
    'sell_stock',
    {
        description: 'Sell a stock on Zerodha',
        inputSchema: z.object({
            tradingsymbol: z.string(),
            quantity: z.number().int().positive(),
            exchange: z.string().default('NSE'),
            product: z.enum(['CNC', 'MIS', 'NRML', 'BO', 'CO']).default('CNC'),
            order_type: z.enum(['MARKET', 'LIMIT', 'SL', 'SL-M']).default('MARKET'),
            price: z.number().optional(),
        }),
    },
    async ({ tradingsymbol, quantity, exchange, product, order_type, price }) => {
        const result = await placeOrder({
            tradingsymbol,
            quantity,
            transaction_type: 'SELL',
            exchange,
            product,
            order_type,
            price,
        });

        return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
        };
    },
);

server.registerTool(
    'show_portfolio',
    {
        description: 'Shows my complete portfolio and positions in Zerodha',
        inputSchema: z.object({}),
    },
    async () => {
        const [holdings, positions] = await Promise.all([getHoldings(), getPositions()]);

        return {
            content: [{ type: 'text', text: JSON.stringify({ holdings, positions }) }],
        };
    },
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main();