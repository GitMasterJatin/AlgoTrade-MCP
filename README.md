# AlgoTrade-MCP

An MCP server that lets Claude trade on your Zerodha account in plain English,
with **human-in-the-loop approval on Telegram** for high-value orders.

```
You:    "Sell everything I own"
Claude: show_portfolio -> sell_stock(INFY, 8) -> sell_stock(ITC, 30)
Phone:  🔔 APPROVAL REQUIRED  SELL 30 ITC ... ₹3150   [✅ Approve] [❌ Reject]
```

## Tools

| Tool | What it does |
|---|---|
| `buy_stock` | Buy `quantity` shares of an NSE symbol (CNC, market order). |
| `sell_stock` | Sell `quantity` shares of an NSE symbol (CNC, market order). |
| `show_portfolio` | Holdings (delivered shares) and positions (today's trades). |

Inputs are validated at runtime with **Zod**. The server talks to the client
over **stdio** (Claude Desktop starts it as a child process).

Claude chains the tools itself. For "sell everything" it reads
`show_portfolio`, then calls `sell_stock` once per holding.

## Human in the loop

Orders worth more than `KITE_APPROVAL_LIMIT` (default ₹2,000, estimated from
the last traded price) don't execute straight away. The server sends you a
Telegram message with **Approve** and **Reject** buttons, and the tool call waits:

- **Approve** -> the order is placed.
- **Reject**, or **no tap within 50s** -> nothing is placed, and the model is
  told not to retry.
- Only your Telegram user id (`TELEGRAM_CHAT_ID`) can approve.
- If Telegram isn't configured or can't be reached, the order is refused.

This is enforced in the server, not the client, so no client setting and no
model can skip it. See `approval.ts`.

## Setup

You need [Bun](https://bun.com), a Zerodha Kite Connect app (API key + secret)
and a Telegram bot from [@BotFather](https://t.me/BotFather).

```bash
bun install
export KITE_API_KEY=your_key
export KITE_API_SECRET=your_secret
export TELEGRAM_BOT_TOKEN=123456:ABC...
export TELEGRAM_CHAT_ID=your_telegram_user_id   # message your bot, then see getUpdates -> from.id
export KITE_APPROVAL_LIMIT=2000                 # optional; 0 = approve every order
```

Log in once a day (Kite access tokens expire around 6 AM):

```bash
bun run login                   # prints the login URL
bun run login <request_token>   # from the redirect URL; saves .kite-session.json
```

Add it to Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "zerodha": {
      "command": "/absolute/path/to/bun",
      "args": ["run", "/absolute/path/to/AlgoTrade-MCP/index.ts"],
      "env": {
        "KITE_API_KEY": "...",
        "TELEGRAM_BOT_TOKEN": "...",
        "TELEGRAM_CHAT_ID": "..."
      }
    }
  }
}
```

## Files

| File | Purpose |
|---|---|
| `index.ts` | MCP server: tool definitions, Zod schemas, stdio transport |
| `trade.ts` | Kite Connect calls: price, approve if high-value, place; portfolio |
| `approval.ts` | Telegram approval: send buttons, long-poll for the tap, timeout |
| `login.ts` | Daily Kite login: request token -> access token |
