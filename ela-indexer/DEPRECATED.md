# DEPRECATED

This directory contains the **legacy indexer** and is no longer in use.

The active codebase lives in `../ela-explorer/` which uses:
- Schema: `../ela-explorer/sql/schema.sql`
- Binary: `../ela-explorer/cmd/explorer/main.go`

**Do NOT deploy this code.** It uses a different schema (e.g., `tx_outputs` vs `tx_vouts`, TEXT values vs BIGINT sela)
and will silently corrupt data if run against the production database.

This directory is retained for reference only. Consider moving it to a separate repository or deleting it entirely.
