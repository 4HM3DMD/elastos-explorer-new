-- Reverse dependency order: children of transactions, then transactions, then blocks;
-- remaining tables have no FKs (reverse schema section order).

DROP TABLE IF EXISTS tx_vins;
DROP TABLE IF EXISTS tx_vouts;
DROP TABLE IF EXISTS tx_attributes;
DROP TABLE IF EXISTS tx_programs;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS blocks;

DROP TABLE IF EXISTS sync_state;
DROP TABLE IF EXISTS cross_chain_txs;
DROP TABLE IF EXISTS hourly_tx_counts;
DROP TABLE IF EXISTS daily_stats;
DROP TABLE IF EXISTS consensus_transitions;
DROP TABLE IF EXISTS chain_stats;
DROP TABLE IF EXISTS arbiter_turns;
DROP TABLE IF EXISTS cr_proposal_reviews;
DROP TABLE IF EXISTS cr_proposals;
DROP TABLE IF EXISTS cr_members;
DROP TABLE IF EXISTS nfts;
DROP TABLE IF EXISTS votes;
DROP TABLE IF EXISTS producer_snapshots;
DROP TABLE IF EXISTS producers;
DROP TABLE IF EXISTS address_tx_counts;
DROP TABLE IF EXISTS address_transactions;
DROP TABLE IF EXISTS address_labels;
DROP TABLE IF EXISTS address_balances;
