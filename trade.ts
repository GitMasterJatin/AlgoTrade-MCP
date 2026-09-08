import { KiteConnect } from "kiteconnect";

type OrderType = "BUY" | "SELL";
type ProductType = "CNC" | "MIS" | "NRML" | "BO" | "CO";
type OrderMode = "MARKET" | "LIMIT" | "SL" | "SL-M";

type PlaceOrderInput = {
    tradingsymbol: string;
    quantity: number;
    transaction_type: OrderType;
    exchange?: string;
    product?: ProductType;
    order_type?: OrderMode;
    price?: number;
};

const apiKey = process.env.KITE_API_KEY ?? "";
const apiSecret = process.env.KITE_API_SECRET ?? "";
const requestToken = process.env.KITE_REQUEST_TOKEN ?? "";

const kc = new KiteConnect({ api_key: apiKey });

async function generateSession() {
    if (!apiKey || !apiSecret || !requestToken) {
        throw new Error("Set KITE_API_KEY, KITE_API_SECRET, and KITE_REQUEST_TOKEN");
    }

    const response = await kc.generateSession(requestToken, apiSecret);
    kc.setAccessToken(response.access_token);
    return response;
}

export async function placeOrder({
    tradingsymbol,
    quantity,
    transaction_type,
    exchange = "NSE",
    product = "CNC",
    order_type = "MARKET",
    price,
}: PlaceOrderInput) {
    if (!apiKey || !apiSecret || !requestToken) {
        return {
            status: "missing_credentials",
            message: "Set KITE_API_KEY, KITE_API_SECRET, and KITE_REQUEST_TOKEN",
        };
    }

    try {
        await generateSession();

        const payload: any = {
            exchange,
            tradingsymbol,
            transaction_type,
            quantity,
            product,
            order_type,
            ...(order_type === "LIMIT" || order_type === "SL" || order_type === "SL-M"
                ? { price: price ?? 0 }
                : {}),
        };

        return await kc.placeOrder("regular", payload);
    } catch (err) {
        return {
            status: "error",
            message: err instanceof Error ? err.message : String(err),
        };
    }
}

export async function getHoldings() {
    if (!apiKey || !apiSecret || !requestToken) {
        return {
            status: "missing_credentials",
            message: "Set KITE_API_KEY, KITE_API_SECRET, and KITE_REQUEST_TOKEN",
        };
    }

    try {
        await generateSession();
        return await kc.getHoldings();
    } catch (err) {
        return {
            status: "error",
            message: err instanceof Error ? err.message : String(err),
        };
    }
}

export async function getPositions() {
    if (!apiKey || !apiSecret || !requestToken) {
        return {
            status: "missing_credentials",
            message: "Set KITE_API_KEY, KITE_API_SECRET, and KITE_REQUEST_TOKEN",
        };
    }

    try {
        await generateSession();
        return await kc.getPositions();
    } catch (err) {
        return {
            status: "error",
            message: err instanceof Error ? err.message : String(err),
        };
    }
}