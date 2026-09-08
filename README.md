# AlgoTrade-MCP

[![CI](https://github.com/GitMasterJatin/AlgoTrade-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/GitMasterJatin/AlgoTrade-MCP/actions/workflows/ci.yml)

An MCP server that lets a language model trade on your Zerodha account.

Five tools — buy, sell, cancel, and look at your orders and portfolio — over
stdio, so any MCP client (Claude Desktop, Claude Code, your own) can drive a
real brokerage account.

Wiring a model to a trading API is about fifty lines. The rest of this repo is
about what happens when that goes wrong, because when it does, it costs money.

---

## Setup

You need [Bun](https://bun.com) and a Zerodha Kite Connect app for the API key
and secret.

```bash
bun install
export KITE_API_KEY=your_key
export KITE_API_SECRET=your_secret
```

Kite's login hands you a **request token** that works exactly once and expires
in minutes, which you trade for an access token good until 6am the next day. So
logging in is two steps:

```bash
bun run login
```

That prints a URL. Open it, log in, and Zerodha bounces you to a redirect
carrying `?request_token=...` in the address bar. Copy that value:

```bash
bun run login <request_token>
```

The access token lands in `.kite-session.json` (gitignored, mode 600) and the
server reuses it until Zerodha expires it. Set `KITE_SESSION_FILE` if you'd
rather keep it somewhere outside the repo.

Then point your MCP client at it:

```json
{
  "mcpServers": {
    "zerodha": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/AlgoTrade-MCP/index.ts"],
      "env": { "KITE_API_KEY": "...", "KITE_API_SECRET": "..." }
    }
  }
}
```

## The tools

| Tool | What it does |
|---|---|
| `buy_stock` / `sell_stock` | Place an order. Market by default; CNC, MIS or NRML. |
| `cancel_order` | Cancel a pending order by id. |
| `get_orders` | Today's order book, with status and fill quantity. |
| `show_portfolio` | Holdings and positions. |

Buy, sell and cancel are tagged `destructiveHint` so a client can warn you
before the model spends anything. Reads are tagged `readOnlyHint`.

---

## The parts worth reading

### A request that fails isn't the same as an order that didn't happen

This is the one that actually matters.

You POST an order. The connection dies. Did it go through? You genuinely don't
know — Zerodha may have accepted it and lost the response on the way back. If
you retry, you might just buy the stock twice.

So every order goes out stamped with a unique tag. If the request fails, the
server goes looking for that tag in the order book before it answers you, and
retries the lookup a few times because the book takes a moment to catch up.
You get one of three answers, never a shrug:

- **placed** — here's the order id
- **placed anyway** — the request failed, but the order is live. *Don't retry.*
- **not placed** — with Zerodha's actual reason. Safe to retry.

There's a fourth case, and keeping it separate is the whole point: if the order
book itself can't be read, the server says **UNKNOWN** and hands you the tag to
check by hand. It never guesses "not placed," because a live order reported as
unplaced is the mistake that costs you money.

### Cancelling is not one endpoint

Kite cancels at `/orders/{variety}/{order_id}`, and *variety* isn't always
`regular` — an after-market order is `amo`, a cover order is `co`. Your book
holds orders you placed from the Kite app too.

Hardcoding `regular` silently fails to cancel half of them. Asking the model to
supply the variety is asking it to guess. So `cancel_order` takes only an
order id, looks the order up, and uses whatever variety it actually has.

And if the order was **partly filled**, cancelling only kills the remainder.
Cancel 100 shares that already filled 40 and you still own 40. A bare "success"
here would leave you thinking you were flat, so the result says so plainly.

Orders that are already `COMPLETE`, `CANCELLED` or `REJECTED` are refused
before Zerodha is called at all — and a filled order gets told what it actually
needs, which is an opposing order, not a cancel. Otherwise a model reads
"cancel failed" and tries again forever.

That check is a denylist of those three, not an allowlist of cancellable ones.
Kite's docs say its status vocabulary is open-ended, and an allowlist would
quietly start refusing real cancels the first time they added a state.

### Errors have to look like errors

Two things were quietly swallowing failures.

The MCP SDK already turns a thrown error into a proper `isError` result — so
the try/catch blocks wrapping every call were *downgrading* real failures into
ordinary-looking success. A model can't tell "order rejected" from "order
filled" if both come back the same shape, and it will retry a buy that already
went through. Those blocks are gone rather than patched.

The other one: `kiteconnect` rejects with a plain `{ message, error_type }`
object instead of an `Error`, and the SDK stringifies anything that isn't an
Error. Every broker failure — bad symbol, expired token, rejected order — was
reaching the model as `[object Object]`. They now carry the real reason.

---

## Tests

```bash
bun test
```

26 tests, no live account needed. `KITE_API_ROOT` points the client at a fake
Zerodha (`tests/helpers/fake-kite.ts`) that can be told to fail in specific
ways, so the paths that are otherwise impossible to reach on purpose — a
placement whose response is lost, an unreadable order book, an order that's
half filled — are all covered.

The MCP tests skip the internals and drive the actual server over stdio, the
same way a client would.

---

## What this doesn't do

Worth being straight about, because some of it matters:

- **There's no risk layer.** No kill switch, no order-value cap, no position
  limits. The model can place any order the schema allows. This is the biggest
  gap and I know it.
- **It's never run against a funded account.** Everything here is built against
  Kite Connect's documented v3 contract and verified against a local fake.
- **`SL` and `SL-M` are offered but can't work** — they need a `trigger_price`
  that isn't in the schema yet.
- `LIMIT` orders default to price 0 if you don't pass one, which Zerodha will
  reject.
- One tag per attempt means this survives a dropped connection, not a model
  that decides to call `buy_stock` twice. That needs a confirmation step, which
  is a different problem.

If you want the version of this with the safety architecture taken seriously —
a non-bypassable risk gate, single-use approval tokens, an outbox and a
reconciler — that's [kite-agent](https://github.com/GitMasterJatin/kite-agent).
This repo is the small, sharp version of the same idea.
