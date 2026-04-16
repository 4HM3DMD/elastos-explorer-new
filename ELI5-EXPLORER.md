# ELA Explorer -- ELI5 (Explain Like I'm 5)

This document explains every piece of the explorer in plain language.
When you read the code and don't understand something, come back here.

---

## What is this project?

A **block explorer** for the Elastos main chain. Think of it like a search engine
for the blockchain. Every transaction, every address, every block -- you can look it
up and see exactly what happened, when, and how much money moved.

We're building it from scratch because the old one was limited: it couldn't show
you where money came from, who's staking to which validator, or what proposals
the DAO is voting on.

---

## The Big Picture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  ELA Node    │────>│  ela-explorer │────>│  PostgreSQL   │
│  (blockchain)│     │  (Go binary)  │     │  (database)   │
└──────────────┘     └──────┬───────┘     └──────────────┘
                            │
                     ┌──────┴───────┐
                     │  React App   │
                     │  (frontend)  │
                     └──────────────┘
```

1. The **ELA Node** is a program that has a copy of the entire blockchain
2. Our **Go binary** asks the node "what's in block 1? block 2? block 3?" and so on
3. It stores everything in **PostgreSQL** (a database) in a way that's fast to search
4. The **React frontend** asks our Go binary for data and shows it to users

---

## Project Structure

```
ela-explorer/                   # The Go backend (this is the new thing we're building)
├── cmd/explorer/main.go        # THE starting point -- runs everything
├── sql/schema.sql              # Database table definitions
├── internal/
│   ├── config/config.go        # Reads settings from environment variables
│   ├── db/                     # Talks to PostgreSQL
│   │   ├── schema.go           # Creates/updates database tables
│   │   ├── queries.go          # All the SQL queries (read/write data)
│   │   └── bulk.go             # Fast bulk insert for initial sync
│   ├── node/                   # Talks to the ELA blockchain node
│   │   ├── client.go           # Makes RPC calls to the node
│   │   └── types.go            # Go structs that match the node's JSON responses
│   ├── sync/                   # The "brain" -- processes blockchain data
│   │   ├── syncer.go           # Main loop: "is there a new block? process it!"
│   │   ├── block_processor.go  # Takes a raw block and breaks it down
│   │   ├── tx_processor.go     # Takes a raw transaction and understands it
│   │   ├── tx_types.go         # Knows all 46 transaction types
│   │   ├── output_processor.go # Understands output types (votes, stakes, etc.)
│   │   ├── vote_tracker.go     # Tracks who is staking to which validator
│   │   ├── balance_tracker.go  # Keeps address balances up to date
│   │   └── reorg.go            # Handles chain reorganizations (rare but critical)
│   ├── api/                    # REST API -- the frontend talks to this
│   │   ├── server.go           # Sets up all the URL routes
│   │   ├── blocks.go           # /api/v1/blocks, /api/v1/block/{height}
│   │   ├── transactions.go     # /api/v1/tx/{txid}
│   │   ├── addresses.go        # /api/v1/address/{address}
│   │   ├── producers.go        # /api/v1/producers (validators list)
│   │   └── ...more endpoints
│   ├── ws/                     # WebSocket -- pushes live updates to browsers
│   │   └── hub.go              # Manages connected browsers, broadcasts new blocks
│   ├── aggregator/             # Background jobs
│   │   ├── coingecko.go        # Fetches ELA price from CoinGecko
│   │   └── node_stats.go       # Fetches validator info, hashrate, etc.
│   └── cache/cache.go          # In-memory cache for speed
└── data/
    ├── producer_images.json    # Validator profile pictures
    └── known_addresses.json    # Labels: "Foundation", "DAO Treasury", etc.
```

---

## Key Concepts (ELI5)

### What is a "sela"?

The smallest unit of ELA. Like cents to dollars, but smaller.
**1 ELA = 100,000,000 sela** (one hundred million).

In the database, we ALWAYS store money as sela (a whole number).
We only convert to ELA (with decimals) when showing it to users.

Why? Because computers are bad at decimal math. `0.1 + 0.2 = 0.30000000000000004`
in most programming languages. With whole numbers: `10000000 + 20000000 = 30000000`. Perfect.

### What is a UTXO?

Stands for "Unspent Transaction Output." Elastos uses the same model as Bitcoin.

Imagine you have a $10 bill. To pay someone $3, you hand them the $10 bill, they
give you a new $7 bill as change. The old $10 bill is now "spent." The new $7 bill
and the $3 the other person got are "unspent outputs."

Every transaction in Elastos works this way:
- **Inputs (vins)**: Which previous outputs are being spent
- **Outputs (vouts)**: Where the money is going

To know someone's balance, you add up all their unspent outputs.

### What are the "eras"?

The Elastos chain has changed over time. The rules at block 100,000 are different
from block 2,000,000. Our explorer must know which rules apply at which height:

| Era | Heights | What's Different |
|-----|---------|------------------|
| Pure AuxPoW | 0 - 343,399 | Just mining, no voting |
| DPoS v1 | 343,400 - ~1,405,000 | Validators elected by votes (5000 ELA deposit) |
| CR Governance | 658,930+ | DAO council, treasury, proposals |
| BPoS | 1,405,000+ | Time-locked staking with log10 weight (2000 ELA deposit) |

### What is "staking rights"?

When you lock ELA to vote for a validator, your vote gets a weight multiplier:

```
Staking Rights = ELA_amount × log10(lock_days)
```

- Lock for 10 days: 1x multiplier (minimum)
- Lock for 100 days: 2x multiplier
- Lock for 1000 days: 3x multiplier (maximum)

This is calculated ONCE when you create the vote. It doesn't change over time.
When the lock expires, the vote disappears completely.

### What is a "coinbase transaction"?

The FIRST transaction in every block. It's special: it creates new ELA out of thin
air as the block reward. The reward is split:
- **~35% to the miner** (the person who found the block)
- **30% to the DAO Treasury** (community fund)
- **~35% to staking rewards** (shared among validators and their stakers)

The exact split depends on the era (see mind.md for details).

### What is "reorg handling"?

Sometimes two miners find a block at almost the same time. The network picks one
and throws away the other. When this happens, we need to "undo" the thrown-away
block -- reverse its balance changes, un-spend its inputs, etc.

This is rare (maybe once a month) but we MUST handle it correctly or balances
will be wrong.

---

## How the Syncer Works (Step by Step)

### First Time (Initial Sync)

When the explorer starts for the first time, it needs to catch up with ~2.2 million blocks:

1. **Ask the node**: "What's the latest block number?" → "2,200,000"
2. **Our database is at**: block 0
3. **Gap**: 2.2 million blocks to process!
4. **Speed mode**: Drop database indexes, use bulk insert (PostgreSQL COPY)
5. **Process in order**: Block 1, then 2, then 3... (order matters for balance tracking)
6. **Parallel fetching**: 8 workers fetch blocks from the node simultaneously
7. **Takes about**: 2-4 hours depending on server speed
8. **When done**: Rebuild indexes, verify data, switch to live mode

### Live Mode (Normal Operation)

Once caught up, the explorer stays in sync:

1. **Every 500ms**: Ask the node "what's the latest block?"
2. **New block detected**: Fetch it, process every transaction
3. **Within one database transaction** (all-or-nothing):
   - Store the block
   - Store every transaction
   - Resolve where each input came from (address + amount)
   - Update address balances
   - Track votes, staking positions, governance actions
   - Update statistics
4. **Broadcast**: Tell all connected browsers "new block!" via WebSocket
5. **Takes about**: 50-200ms per block

---

## How the API Works

The frontend asks our Go server for data using HTTP requests. Examples:

| What the user does | Frontend calls | Backend does |
|---------------------|---------------|--------------|
| Opens the home page | `GET /api/v1/stats` | Returns cached stats from memory |
| Clicks a block | `GET /api/v1/block/1234` | Queries `blocks` + `transactions` tables |
| Searches an address | `GET /api/v1/address/ELAxxxx` | Queries `address_balances` + history |
| Views validators | `GET /api/v1/producers` | Queries `producers` table |
| Clicks a validator | `GET /api/v1/producer/{key}/stakers` | Queries `votes` table |

Every response is JSON. Monetary values are always strings (e.g. `"1.50000000"`)
to avoid floating-point precision issues.

---

## How WebSocket Works

Instead of the browser asking "anything new?" every second, we push updates:

1. Browser connects to our WebSocket endpoint
2. We keep the connection open
3. When a new block arrives, we send a message to ALL connected browsers
4. The browser updates the page without refreshing

Events:
- `newBlock` -- A new block was mined (includes block summary)
- `newStats` -- Updated dashboard statistics
- `mempoolUpdate` -- New pending transaction in the mempool

---

## Database Tables (Plain English)

| Table | What it stores | Why |
|-------|---------------|-----|
| `blocks` | Every block header (height, hash, time, reward breakdown) | Block list, block detail pages |
| `transactions` | Every transaction (type, fee, payload) | Transaction detail page |
| `tx_vins` | Transaction inputs (where money came from) | "This tx spent from address X" |
| `tx_vouts` | Transaction outputs (where money went) | "This tx sent to address Y" |
| `address_balances` | Current balance of every address | Rich list, address pages |
| `address_transactions` | Which txs involve which address | Address history page |
| `address_labels` | Human names for addresses | "Foundation", "Binance", etc. |
| `producers` | All validators (nickname, votes, state) | Validators page |
| `producer_snapshots` | Daily vote totals per validator | Vote history charts |
| `votes` | Every staking position (who, to whom, how much, when) | Stakers list per validator |
| `nfts` | Staking position NFTs | NFT tracking |
| `cr_members` | DAO council members | CR Council page |
| `cr_proposals` | DAO proposals (budgets, votes, status) | Proposals page |
| `chain_stats` | Global counters (total blocks, txs, staked amount) | Dashboard |
| `daily_stats` | Per-day metrics (tx count, active addresses, price) | Charts page |
| `sync_state` | Where the syncer left off | Resume after restart |

---

## File-by-File Guide

As we build each file, this section will be updated with what each file does
and why decisions were made.

### `ela-explorer/internal/config/config.go`
Reads configuration from environment variables. No hardcoded secrets.
Every setting has a sensible default so the explorer works out of the box
in development. In production, you set env vars or use a `.env` file.

### `ela-explorer/sql/schema.sql`
The complete database schema. Run this once to create all tables.
The Go code also runs this on startup (idempotent -- safe to run multiple times).

### `ela-explorer/internal/node/types.go`
Go structs that exactly match the JSON the ELA node returns.
Field names use `json:"..."` tags that match the node's JSON keys EXACTLY,
including known typos in the node source (e.g., `"depositamout"` not `"depositamount"`).

### `ela-explorer/internal/node/client.go`
Makes HTTP requests to the ELA node's JSON-RPC interface.
Has automatic retry (3 attempts) and circuit breaker (stops hammering
the node if it's down). All methods return typed Go structs.
