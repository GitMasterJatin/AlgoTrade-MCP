import { createServer, type Server } from "node:http";

export type Order = {
    order_id: string;
    variety: string;
    status: string;
    tradingsymbol: string;
    quantity: number;
    filled_quantity: number;
    pending_quantity: number;
    tag?: string | null;
};

export type PlaceMode =
    | "ok" // accepted, order created
    | "fail_after_accept" // order created, but the response never got back
    | "fail_clean"; // rejected outright, nothing created

/**
 * A stand-in for Zerodha's API, so the interesting paths (a placement whose
 * response is lost, an unreadable order book) can be exercised without a real
 * account. Only the three endpoints this server actually calls exist.
 */
export class FakeKite {
    book: Order[] = [];
    placeMode: PlaceMode = "ok";
    bookReadable = true;
    /** Last traded price returned by /quote/ltp. */
    lastPrice: number | null = 100;
    /** Every cancel the broker received, in order. */
    cancels: { variety: string; order_id: string }[] = [];
    /** Every tag the broker was asked to place, in order. */
    placedTags: (string | null)[] = [];

    private server?: Server;
    port = 0;

    /**
     * `bun test` shares one process, so files inherit whatever the previous one
     * left behind. Every file resets in beforeEach rather than tidying up after
     * itself, so a test never depends on another file being well behaved.
     */
    reset() {
        this.book = [];
        this.cancels = [];
        this.placedTags = [];
        this.placeMode = "ok";
        this.bookReadable = true;
        this.lastPrice = 100;
        return this;
    }

    async start() {
        this.server = createServer(async (req, res) => {
            const { pathname } = new URL(req.url ?? "/", "http://fake");
            res.setHeader("content-type", "application/json");

            const fail = (code: number, error_type: string, message: string) => {
                res.statusCode = code;
                res.end(JSON.stringify({ status: "error", error_type, message }));
            };

            if (req.method === "GET" && pathname === "/quote/ltp") {
                if (this.lastPrice === null) {
                    return fail(503, "NetworkException", "quotes unavailable");
                }
                const instrument = new URL(req.url ?? "/", "http://fake").searchParams.get("i")!;
                return res.end(
                    JSON.stringify({
                        status: "success",
                        data: {
                            [instrument]: { instrument_token: 1, last_price: this.lastPrice },
                        },
                    }),
                );
            }

            if (req.method === "GET" && pathname === "/orders") {
                if (!this.bookReadable) {
                    return fail(503, "NetworkException", "order book unavailable");
                }
                return res.end(JSON.stringify({ status: "success", data: this.book }));
            }

            if (req.method === "POST" && /^\/orders\/[^/]+$/.test(pathname)) {
                let body = "";
                for await (const chunk of req) body += chunk;
                const tag = new URLSearchParams(body).get("tag");
                this.placedTags.push(tag);

                if (this.placeMode === "fail_clean") {
                    return fail(400, "InputException", "Invalid tradingsymbol");
                }

                const order_id =
                    this.placeMode === "ok" ? "OID_PLACED" : "OID_LOST_RESPONSE";
                this.book.push({
                    order_id,
                    tag,
                    variety: "regular",
                    status: "OPEN",
                    tradingsymbol: "INFY",
                    quantity: 1,
                    filled_quantity: 0,
                    pending_quantity: 1,
                });

                if (this.placeMode === "fail_after_accept") {
                    return fail(502, "NetworkException", "gateway timeout");
                }
                return res.end(JSON.stringify({ status: "success", data: { order_id } }));
            }

            const cancel = pathname.match(/^\/orders\/([^/]+)\/([^/]+)$/);
            if (req.method === "DELETE" && cancel) {
                this.cancels.push({ variety: cancel[1]!, order_id: cancel[2]! });
                return res.end(
                    JSON.stringify({ status: "success", data: { order_id: cancel[2] } }),
                );
            }

            fail(404, "GeneralException", `no route for ${req.method} ${pathname}`);
        });

        await new Promise<void>((resolve) =>
            this.server!.listen(0, "127.0.0.1", resolve),
        );
        this.port = (this.server!.address() as { port: number }).port;
        this.server.unref();
        return this;
    }

    get root() {
        return `http://127.0.0.1:${this.port}`;
    }

    async stop() {
        await new Promise((resolve) => this.server?.close(resolve));
    }
}
