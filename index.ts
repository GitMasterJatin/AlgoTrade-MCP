import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { cancelOrder, getHoldings, getOrders, getPositions, placeOrder } from './trade';

const server = new McpServer({ name: 'zerodha-trade', version: '1.0.0' });

server.registerTool(
    'buy_stock',
    {
        description: 'Buy a stock on Zerodha',
        inputSchema: z.object({
            tradingsymbol: z.string(),
            quantity: z.number().int().positive(),
            exchange: z.string().default('NSE'),
            product: z.enum(['CNC', 'MIS', 'NRML']).default('CNC'),
            order_type: z.enum(['MARKET', 'LIMIT', 'SL', 'SL-M']).default('MARKET'),
            price: z.number().optional(),
        }),
        annotations: { destructiveHint: true },
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
            product: z.enum(['CNC', 'MIS', 'NRML']).default('CNC'),
            order_type: z.enum(['MARKET', 'LIMIT', 'SL', 'SL-M']).default('MARKET'),
            price: z.number().optional(),
        }),
        annotations: { destructiveHint: true },
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
        annotations: { readOnlyHint: true },
    },
    async () => {
        const [holdings, positions] = await Promise.all([getHoldings(), getPositions()]);

        return {
            content: [{ type: 'text', text: JSON.stringify({ holdings, positions }) }],
        };
    },
);

server.registerTool(
    'get_orders',
    {
        description:
            "Lists today's orders on Zerodha with their status and fill quantity. " +
            'Use this to find the order_id needed by cancel_order.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
    },
    async () => {
        const orders = await getOrders();

        return {
            content: [{ type: 'text', text: JSON.stringify(orders) }],
        };
    },
);

server.registerTool(
    'cancel_order',
    {
        description:
            'Cancels a pending order on Zerodha. Only works on orders that have not ' +
            'filled yet - a filled order can only be reversed by an opposing order. ' +
            'Use get_orders to find the order_id.',
        inputSchema: z.object({
            order_id: z.string(),
        }),
        annotations: { destructiveHint: true },
    },
    async ({ order_id }) => {
        const result = await cancelOrder(order_id);

        return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
        };
    },
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main();