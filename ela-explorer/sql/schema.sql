-- ELA Explorer Database Schema
-- All monetary values: BIGINT sela (1 ELA = 1e8 sela)
-- Run: psql -U ela_indexer -d ela_explorer -f schema.sql

-- ============================================================
-- 1.1 Core Block/Transaction Tables (6 tables)
-- ============================================================

CREATE TABLE IF NOT EXISTS blocks (
    height          BIGINT      PRIMARY KEY,
    hash            CHAR(64)    NOT NULL UNIQUE,
    prev_hash       CHAR(64)    NOT NULL,
    merkle_root     CHAR(64)    NOT NULL,
    timestamp       BIGINT      NOT NULL,
    median_time     BIGINT      NOT NULL DEFAULT 0,
    nonce           BIGINT      NOT NULL DEFAULT 0,
    bits            BIGINT      NOT NULL DEFAULT 0,
    difficulty      TEXT        NOT NULL DEFAULT '0',
    chainwork       TEXT        NOT NULL DEFAULT '',
    version         INT         NOT NULL DEFAULT 0,
    version_hex     VARCHAR(16) NOT NULL DEFAULT '',
    size            INT         NOT NULL DEFAULT 0,
    stripped_size   INT         NOT NULL DEFAULT 0,
    weight          INT         NOT NULL DEFAULT 0,
    tx_count        INT         NOT NULL DEFAULT 0,
    miner_info      TEXT        NOT NULL DEFAULT '',
    auxpow          TEXT        NOT NULL DEFAULT '',
    total_fees_sela BIGINT      NOT NULL DEFAULT 0,
    total_value_sela BIGINT     NOT NULL DEFAULT 0,
    reward_sela     BIGINT      NOT NULL DEFAULT 0,
    reward_miner_sela BIGINT    NOT NULL DEFAULT 0,
    reward_cr_sela  BIGINT      NOT NULL DEFAULT 0,
    reward_dpos_sela BIGINT     NOT NULL DEFAULT 0,
    miner_address   VARCHAR(34) NOT NULL DEFAULT '',
    era             TEXT        NOT NULL DEFAULT 'auxpow',
    consensus_mode  TEXT        NOT NULL DEFAULT 'POW'
);
CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks (hash);
CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks (timestamp DESC);

CREATE TABLE IF NOT EXISTS transactions (
    txid            CHAR(64)    PRIMARY KEY,
    block_height    BIGINT      NOT NULL REFERENCES blocks(height) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    tx_index        INT         NOT NULL DEFAULT 0,
    hash            CHAR(64)    NOT NULL,
    version         INT         NOT NULL DEFAULT 0,
    type            INT         NOT NULL DEFAULT 0,
    payload_version INT         NOT NULL DEFAULT 0,
    payload_json    TEXT        NOT NULL DEFAULT '{}',
    lock_time       BIGINT      NOT NULL DEFAULT 0,
    size            INT         NOT NULL DEFAULT 0,
    vsize           INT         NOT NULL DEFAULT 0,
    fee_sela        BIGINT      NOT NULL DEFAULT 0,
    timestamp       BIGINT      NOT NULL DEFAULT 0,
    vin_count       INT         NOT NULL DEFAULT 0,
    vout_count      INT         NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tx_block ON transactions (block_height, tx_index);
CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions (type);
CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions (timestamp DESC);

CREATE TABLE IF NOT EXISTS tx_vins (
    txid            CHAR(64)    NOT NULL REFERENCES transactions(txid) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    n               INT         NOT NULL,
    prev_txid       CHAR(64)    NOT NULL DEFAULT '',
    prev_vout       INT         NOT NULL DEFAULT 0,
    sequence        BIGINT      NOT NULL DEFAULT 0,
    address         VARCHAR(34) NOT NULL DEFAULT '',
    value_sela      BIGINT      NOT NULL DEFAULT 0,
    PRIMARY KEY (txid, n)
);
CREATE INDEX IF NOT EXISTS idx_vins_prev ON tx_vins (prev_txid, prev_vout);
CREATE INDEX IF NOT EXISTS idx_vins_address ON tx_vins (address);

CREATE TABLE IF NOT EXISTS tx_vouts (
    txid            CHAR(64)    NOT NULL REFERENCES transactions(txid) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    n               INT         NOT NULL,
    address         VARCHAR(34) NOT NULL DEFAULT '',
    value_sela      BIGINT      NOT NULL DEFAULT 0,
    value_text      TEXT        NOT NULL DEFAULT '0',
    asset_id        CHAR(64)    NOT NULL DEFAULT '',
    output_lock     BIGINT      NOT NULL DEFAULT 0,
    output_type     INT         NOT NULL DEFAULT 0,
    output_payload  TEXT        NOT NULL DEFAULT '{}',
    spent_txid      CHAR(64)    DEFAULT NULL,
    spent_vin_n     INT         DEFAULT NULL,
    PRIMARY KEY (txid, n)
);
CREATE INDEX IF NOT EXISTS idx_vouts_address ON tx_vouts (address);
CREATE INDEX IF NOT EXISTS idx_vouts_unspent ON tx_vouts (address) WHERE spent_txid IS NULL;
CREATE INDEX IF NOT EXISTS idx_vouts_type ON tx_vouts (output_type) WHERE output_type > 0;

CREATE TABLE IF NOT EXISTS tx_attributes (
    txid            CHAR(64)    NOT NULL REFERENCES transactions(txid) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    idx             INT         NOT NULL,
    usage           INT         NOT NULL DEFAULT 0,
    data            TEXT        NOT NULL DEFAULT '',
    PRIMARY KEY (txid, idx)
);

CREATE TABLE IF NOT EXISTS tx_programs (
    txid            CHAR(64)    NOT NULL REFERENCES transactions(txid) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    idx             INT         NOT NULL,
    code            TEXT        NOT NULL DEFAULT '',
    parameter       TEXT        NOT NULL DEFAULT '',
    PRIMARY KEY (txid, idx)
);

-- ============================================================
-- 1.2 Address Tables (4 tables)
-- ============================================================

CREATE TABLE IF NOT EXISTS address_balances (
    address         VARCHAR(34) PRIMARY KEY,
    balance_sela    BIGINT      NOT NULL DEFAULT 0,
    total_received  BIGINT      NOT NULL DEFAULT 0,
    total_sent      BIGINT      NOT NULL DEFAULT 0,
    first_seen      BIGINT      NOT NULL DEFAULT 0,
    last_seen       BIGINT      NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_balance_rank ON address_balances (balance_sela DESC);
CREATE INDEX IF NOT EXISTS idx_balance_last_seen ON address_balances (last_seen DESC);

CREATE TABLE IF NOT EXISTS address_labels (
    address         VARCHAR(34) PRIMARY KEY,
    label           TEXT        NOT NULL,
    category        TEXT        NOT NULL DEFAULT 'custom',
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS address_transactions (
    address         VARCHAR(34) NOT NULL,
    txid            CHAR(64)    NOT NULL,
    height          BIGINT      NOT NULL,
    direction       VARCHAR(8)  NOT NULL,
    value_sela      BIGINT      NOT NULL DEFAULT 0,
    fee_sela        BIGINT      NOT NULL DEFAULT 0,
    timestamp       BIGINT      NOT NULL DEFAULT 0,
    tx_type         INT         NOT NULL DEFAULT 0,
    memo            TEXT        NOT NULL DEFAULT '',
    counterparties  TEXT        NOT NULL DEFAULT '[]',
    PRIMARY KEY (address, txid, direction)
);
CREATE INDEX IF NOT EXISTS idx_addrtx_addr_height ON address_transactions (address, height DESC);
CREATE INDEX IF NOT EXISTS idx_addrtx_height ON address_transactions (height);
-- The address page sums value_sela GROUP BY direction to compute the
-- displayed Total Received / Total Sent (the gross numbers stored in
-- address_balances are inflated by change-output / self-transfer
-- volume). Without this index the SUM full-scans every tx row for the
-- address — fine for new wallets but expensive for high-activity ones.
CREATE INDEX IF NOT EXISTS idx_addrtx_addr_direction ON address_transactions (address, direction);

CREATE TABLE IF NOT EXISTS address_tx_counts (
    address         VARCHAR(34) PRIMARY KEY,
    tx_count        BIGINT      NOT NULL DEFAULT 0
);

-- ============================================================
-- 1.3 Governance Tables (9 tables)
-- ============================================================

CREATE TABLE IF NOT EXISTS producers (
    owner_pubkey    VARCHAR(66) PRIMARY KEY,
    node_pubkey     VARCHAR(66) NOT NULL DEFAULT '',
    nickname        VARCHAR(128) NOT NULL DEFAULT '',
    url             VARCHAR(512) NOT NULL DEFAULT '',
    location        BIGINT      NOT NULL DEFAULT 0,
    net_address     VARCHAR(256) NOT NULL DEFAULT '',
    state           VARCHAR(16) NOT NULL DEFAULT '',
    dposv1_votes_sela BIGINT    NOT NULL DEFAULT 0,
    dposv2_votes_sela BIGINT    NOT NULL DEFAULT 0,
    dposv1_votes_text TEXT      NOT NULL DEFAULT '0',
    dposv2_votes_text TEXT      NOT NULL DEFAULT '0',
    register_height BIGINT      NOT NULL DEFAULT 0,
    cancel_height   BIGINT      NOT NULL DEFAULT 0,
    inactive_height BIGINT      NOT NULL DEFAULT 0,
    illegal_height  BIGINT      NOT NULL DEFAULT 0,
    stake_until     BIGINT      NOT NULL DEFAULT 0,
    deposit_sela    BIGINT      NOT NULL DEFAULT 0,
    penalty_sela    BIGINT      NOT NULL DEFAULT 0,
    payload_version INT         NOT NULL DEFAULT 0,
    total_slashes   INT         NOT NULL DEFAULT 0,
    is_arbiter      BOOLEAN     NOT NULL DEFAULT FALSE,
    is_on_duty      BOOLEAN     NOT NULL DEFAULT FALSE,
    image_url       TEXT        DEFAULT NULL,
    index           INT         NOT NULL DEFAULT 0,
    identity        TEXT        NOT NULL DEFAULT '',
    last_updated    BIGINT      NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_producers_state ON producers (state);
CREATE INDEX IF NOT EXISTS idx_producers_v2votes ON producers (dposv2_votes_sela DESC);
CREATE INDEX IF NOT EXISTS idx_producers_v1votes ON producers (dposv1_votes_sela DESC);

CREATE TABLE IF NOT EXISTS producer_snapshots (
    owner_pubkey    VARCHAR(66) NOT NULL,
    date            DATE        NOT NULL,
    dposv2_votes_sela BIGINT    NOT NULL DEFAULT 0,
    staker_count    INT         NOT NULL DEFAULT 0,
    state           VARCHAR(16) NOT NULL DEFAULT '',
    PRIMARY KEY (owner_pubkey, date)
);

CREATE TABLE IF NOT EXISTS votes (
    id              BIGSERIAL   PRIMARY KEY,
    txid            CHAR(64)    NOT NULL,
    vout_n          INT         NOT NULL DEFAULT -1,
    address         VARCHAR(34) NOT NULL,
    producer_pubkey VARCHAR(66) NOT NULL DEFAULT '',
    candidate       TEXT        NOT NULL DEFAULT '',
    vote_type       INT         NOT NULL DEFAULT 0,
    amount_sela     BIGINT      NOT NULL DEFAULT 0,
    lock_time       BIGINT      NOT NULL DEFAULT 0,
    stake_height    BIGINT      NOT NULL DEFAULT 0,
    expiry_height   BIGINT      NOT NULL DEFAULT 0,
    staking_rights  TEXT        NOT NULL DEFAULT '0',
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    spent_txid      CHAR(64)    DEFAULT NULL,
    spent_height    BIGINT      DEFAULT NULL,
    renewal_ref     CHAR(64)    DEFAULT NULL,
    UNIQUE (txid, vout_n, candidate, vote_type)
);
CREATE INDEX IF NOT EXISTS idx_votes_producer ON votes (producer_pubkey, is_active);
CREATE INDEX IF NOT EXISTS idx_votes_candidate ON votes (candidate, is_active);
CREATE INDEX IF NOT EXISTS idx_votes_address ON votes (address, is_active);
CREATE INDEX IF NOT EXISTS idx_votes_height ON votes (stake_height DESC);
CREATE INDEX IF NOT EXISTS idx_votes_expiry ON votes (expiry_height) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_votes_type ON votes (vote_type);

CREATE TABLE IF NOT EXISTS nfts (
    nft_id          VARCHAR(66) PRIMARY KEY,
    refer_key       CHAR(64)    NOT NULL DEFAULT '',
    stake_address   VARCHAR(34) NOT NULL DEFAULT '',
    genesis_hash    CHAR(64)    NOT NULL DEFAULT '',
    owner_pubkey    VARCHAR(66) NOT NULL DEFAULT '',
    start_height    BIGINT      NOT NULL DEFAULT 0,
    end_height      BIGINT      NOT NULL DEFAULT 0,
    votes           TEXT        NOT NULL DEFAULT '0',
    vote_rights     TEXT        NOT NULL DEFAULT '0',
    create_txid     CHAR(64)    NOT NULL,
    create_height   BIGINT      NOT NULL DEFAULT 0,
    is_destroyed    BOOLEAN     NOT NULL DEFAULT FALSE,
    destroy_txid    CHAR(64)    DEFAULT NULL,
    destroy_height  BIGINT      DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_nfts_stake ON nfts (stake_address);
CREATE INDEX IF NOT EXISTS idx_nfts_producer ON nfts (owner_pubkey);

CREATE TABLE IF NOT EXISTS cr_members (
    cid             VARCHAR(34) PRIMARY KEY,
    did             VARCHAR(34) NOT NULL DEFAULT '',
    code            TEXT        NOT NULL DEFAULT '',
    dpos_pubkey     VARCHAR(66) NOT NULL DEFAULT '',
    nickname        VARCHAR(128) NOT NULL DEFAULT '',
    url             VARCHAR(512) NOT NULL DEFAULT '',
    location        BIGINT      NOT NULL DEFAULT 0,
    state           VARCHAR(16) NOT NULL DEFAULT '',
    votes_sela      BIGINT      NOT NULL DEFAULT 0,
    impeachment_votes BIGINT    NOT NULL DEFAULT 0,
    deposit_amount  BIGINT      NOT NULL DEFAULT 0,
    deposit_address VARCHAR(34) NOT NULL DEFAULT '',
    penalty         BIGINT      NOT NULL DEFAULT 0,
    claimed_node    VARCHAR(66) DEFAULT NULL,
    index           INT         NOT NULL DEFAULT 0,
    register_height BIGINT      NOT NULL DEFAULT 0,
    last_updated    BIGINT      NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cr_members_did ON cr_members (did) WHERE did != '';
-- deposit_address lookup is hit on every /address/{addr}/cr-votes call
-- to determine whether the address belongs to a council member (and
-- therefore whether to surface their proposal-review record). Without
-- this index, the lookup full-scans cr_members on every page load.
CREATE INDEX IF NOT EXISTS idx_cr_members_deposit_address ON cr_members (deposit_address) WHERE deposit_address != '';

CREATE TABLE IF NOT EXISTS cr_proposals (
    proposal_hash   CHAR(64)    PRIMARY KEY,
    tx_hash         CHAR(64)    NOT NULL DEFAULT '',
    proposal_type   INT         NOT NULL DEFAULT 0,
    status          VARCHAR(16) NOT NULL DEFAULT '',
    category_data   TEXT        NOT NULL DEFAULT '',
    owner_pubkey    VARCHAR(66) NOT NULL DEFAULT '',
    draft_hash      CHAR(64)    NOT NULL DEFAULT '',
    recipient       VARCHAR(34) NOT NULL DEFAULT '',
    budget_total    TEXT        NOT NULL DEFAULT '0',
    budgets_json    TEXT        NOT NULL DEFAULT '[]',
    cr_votes_json   TEXT        NOT NULL DEFAULT '{}',
    voter_reject    TEXT        NOT NULL DEFAULT '0',
    vote_count      INT         NOT NULL DEFAULT 0,
    reject_count    INT         NOT NULL DEFAULT 0,
    abstain_count   INT         NOT NULL DEFAULT 0,
    register_height BIGINT      NOT NULL DEFAULT 0,
    terminated_height BIGINT    NOT NULL DEFAULT 0,
    tracking_count  INT         NOT NULL DEFAULT 0,
    current_stage   INT         NOT NULL DEFAULT 0,
    cr_member_did   VARCHAR(34) NOT NULL DEFAULT '',
    title           TEXT        NOT NULL DEFAULT '',
    abstract        TEXT        NOT NULL DEFAULT '',
    motivation      TEXT        NOT NULL DEFAULT '',
    goal            TEXT        NOT NULL DEFAULT '',
    plan_statement  TEXT        NOT NULL DEFAULT '',
    implementation_team TEXT    NOT NULL DEFAULT '',
    budget_statement TEXT       NOT NULL DEFAULT '',
    milestone       TEXT        NOT NULL DEFAULT '',
    relevance       TEXT        NOT NULL DEFAULT '',
    available_amount TEXT       NOT NULL DEFAULT '0',
    draft_data_synced BOOLEAN   NOT NULL DEFAULT FALSE,
    draft_sync_attempts INT     NOT NULL DEFAULT 0,
    last_updated    BIGINT      NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON cr_proposals (status);
CREATE INDEX IF NOT EXISTS idx_proposals_owner ON cr_proposals (owner_pubkey);

CREATE TABLE IF NOT EXISTS cr_proposal_reviews (
    did             VARCHAR(64) NOT NULL,
    proposal_hash   CHAR(64)    NOT NULL,
    opinion         VARCHAR(16) NOT NULL DEFAULT '',
    opinion_hash    CHAR(64)    NOT NULL DEFAULT '',
    opinion_message TEXT        NOT NULL DEFAULT '',
    review_height   BIGINT      NOT NULL DEFAULT 0,
    review_timestamp BIGINT     NOT NULL DEFAULT 0,
    txid            CHAR(64)    NOT NULL DEFAULT '',
    title           TEXT        NOT NULL DEFAULT '',
    proposal_state  VARCHAR(32) NOT NULL DEFAULT '',
    PRIMARY KEY (did, proposal_hash)
);

CREATE TABLE IF NOT EXISTS arbiter_turns (
    height          BIGINT      PRIMARY KEY,
    cr_pubkeys      TEXT        NOT NULL DEFAULT '[]',
    dpos_pubkeys    TEXT        NOT NULL DEFAULT '[]',
    on_duty_index   INT         NOT NULL DEFAULT 0,
    timestamp       BIGINT      NOT NULL DEFAULT 0
);

-- ============================================================
-- 1.4 Analytics Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS chain_stats (
    id              INT         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    total_blocks    BIGINT      NOT NULL DEFAULT 0,
    total_txs       BIGINT      NOT NULL DEFAULT 0,
    total_addresses BIGINT      NOT NULL DEFAULT 0,
    total_vote_sela BIGINT      NOT NULL DEFAULT 0,
    total_voters    INT         NOT NULL DEFAULT 0,
    total_supply_sela BIGINT    NOT NULL DEFAULT 0,
    circ_supply_sela BIGINT     NOT NULL DEFAULT 0,
    consensus_mode  TEXT        NOT NULL DEFAULT 'POW',
    current_era     TEXT        NOT NULL DEFAULT 'auxpow',
    last_updated    BIGINT      NOT NULL DEFAULT 0
);
INSERT INTO chain_stats (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS consensus_transitions (
    height          BIGINT      PRIMARY KEY,
    from_mode       TEXT        NOT NULL,
    to_mode         TEXT        NOT NULL,
    trigger_txid    CHAR(64),
    timestamp       BIGINT      NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_stats (
    date            DATE        PRIMARY KEY,
    block_count     INT         NOT NULL DEFAULT 0,
    tx_count        INT         NOT NULL DEFAULT 0,
    active_addresses INT        NOT NULL DEFAULT 0,
    new_addresses   INT         NOT NULL DEFAULT 0,
    total_fees_sela BIGINT      NOT NULL DEFAULT 0,
    total_volume_sela BIGINT    NOT NULL DEFAULT 0,
    avg_block_size  INT         NOT NULL DEFAULT 0,
    avg_block_time  REAL        NOT NULL DEFAULT 0,
    hashrate        TEXT        NOT NULL DEFAULT '0',
    difficulty      TEXT        NOT NULL DEFAULT '0',
    ela_price_usd   REAL        NOT NULL DEFAULT 0,
    total_staked    TEXT        NOT NULL DEFAULT '0',
    voter_count     INT         NOT NULL DEFAULT 0,
    cross_chain_txs INT         NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hourly_tx_counts (
    date            DATE        NOT NULL,
    hour            INT         NOT NULL,
    tx_count        INT         NOT NULL DEFAULT 0,
    PRIMARY KEY (date, hour)
);

-- ============================================================
-- 1.5 Cross-chain Tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS cross_chain_txs (
    txid            CHAR(64)    PRIMARY KEY,
    tx_type         INT         NOT NULL,
    direction       VARCHAR(16) NOT NULL,
    sidechain_hash  CHAR(64)    NOT NULL DEFAULT '',
    amount_sela     BIGINT      NOT NULL DEFAULT 0,
    height          BIGINT      NOT NULL,
    timestamp       BIGINT      NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crosschain_height ON cross_chain_txs (height DESC);
CREATE INDEX IF NOT EXISTS idx_crosschain_sidechain ON cross_chain_txs (sidechain_hash);

-- ============================================================
-- 1.6 System Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS sync_state (
    key             VARCHAR(32) PRIMARY KEY,
    value           TEXT        NOT NULL
);
INSERT INTO sync_state (key, value) VALUES
    ('last_height', '0'),
    ('last_hash', ''),
    ('last_sync_time', '0'),
    ('is_initial_sync', 'true')
ON CONFLICT DO NOTHING;

-- ============================================================
-- Pre-seed system address labels
-- These are well-known Elastos system addresses (see mind.md)
-- ============================================================

INSERT INTO chain_stats (id) VALUES (1) ON CONFLICT DO NOTHING;

INSERT INTO address_balances (address, balance_sela, total_received, total_sent, first_seen, last_seen)
VALUES
    ('8VYXVxKKSAxkmRrfmGpQR2Kc66XhG6m3ta', 0, 0, 0, 0, 0),
    ('CRASSETSXXXXXXXXXXXXXXXXXXXX2qDX5J', 0, 0, 0, 0, 0),
    ('CREXPENSESXXXXXXXXXXXXXXXXXX4UdT6b', 0, 0, 0, 0, 0),
    ('ELANULLXXXXXXXXXXXXXXXXXXXXXYvs3rr', 0, 0, 0, 0, 0),
    ('STAKEPooLXXXXXXXXXXXXXXXXXXXpP1PQ2', 0, 0, 0, 0, 0),
    ('STAKEREWARDXXXXXXXXXXXXXXXXXFD5SHU', 0, 0, 0, 0, 0)
ON CONFLICT DO NOTHING;

INSERT INTO address_labels (address, label, category) VALUES
    ('8VYXVxKKSAxkmRrfmGpQR2Kc66XhG6m3ta', 'Elastos Foundation (Legacy)', 'foundation'),
    ('CRASSETSXXXXXXXXXXXXXXXXXXXX2qDX5J', 'Elastos DAO Assets (Locked)', 'dao'),
    ('CREXPENSESXXXXXXXXXXXXXXXXXX4UdT6b', 'Elastos DAO Expenses', 'dao'),
    ('ELANULLXXXXXXXXXXXXXXXXXXXXXYvs3rr', 'Burn Address', 'system'),
    ('STAKEPooLXXXXXXXXXXXXXXXXXXXpP1PQ2', 'Staking Pool', 'system'),
    ('STAKEREWARDXXXXXXXXXXXXXXXXXFD5SHU', 'Staking Rewards Pool', 'system'),
    -- Sidechains
    ('XVbCTM7vqM1qHKsABSFH4xKN1qbp7ijpWf', 'ESC Sidechain', 'sidechain'),
    ('XNQWEZ7aqNyJHvav8j8tNo2ZQypuTsWQk6', 'PGP Sidechain', 'sidechain'),
    ('XV5cSp1y1PU4xXSQs5oaaLExgHA2xHYjp5', 'ECO Sidechain', 'sidechain'),
    -- Exchanges
    ('EeKGjcERsZvmRYuJSFbrdvyb8MPzKpL3v6', 'KuCoin Exchange', 'exchange'),
    ('EJyiZrRDhdUtUpkxoLgKmdk8JxKoi1tvHG', 'KuCoin Exchange', 'exchange'),
    ('EHpQRE4K4e2UhD55ingFc7TETuve13aWbZ', 'KuCoin Exchange', 'exchange'),
    ('EKk4HeHnLvMpxFiSbjVizcrCB1nVt39Bwe', 'Gate.io Exchange', 'exchange'),
    ('ETsfuQEcNJbmeT5iPXJxJLc7CtipgaEWZQ', 'CoinEX Exchange', 'exchange'),
    ('EfpBYgTZxsrS3qtAApMTuSwW1M2N5ieH7k', 'MEXC Exchange', 'exchange'),
    -- Mining Pools
    ('Eeguj3LmsTnTSyFuvM8DXLmjYNBqa6XK4c', 'ViaBTC', 'mining_pool'),
    ('EMWsru8XhpQxJ7CvDzgAea1WroJqskPmqd', 'BTC.com', 'mining_pool'),
    ('EVXNSmx1KzT6Pxzcup3QGh1vCKZckz8XDD', 'BTC.com', 'mining_pool'),
    ('EbEQ1o4fkbqSg5Q4mR1SwHFWTR4WYFUz8P', 'BTC.com', 'mining_pool'),
    ('EfZ6oNo4oKgefbuX3t2dVrH9ME2mR4ZZka', 'Antpool', 'mining_pool'),
    ('EMRKTXN183vwcGbCetvKuUPHMyQScRjx6F', 'Antpool', 'mining_pool'),
    ('ETAXSN3kc3N3npEeUzMn4bipwUS3ejooiy', 'Antpool', 'mining_pool'),
    ('EdaNsdRChz1pmwHRvSCcTvGhZKaEuimToL', 'Antpool', 'mining_pool'),
    ('EQ34WaW2RmpZhqSUs4DEmVR1RB3zMiJEWe', 'Antpool', 'mining_pool'),
    ('EPEzY8RqLoHiKB5sXsRLNmMcE6ESqvY6Zq', 'F2Pool', 'mining_pool'),
    ('EexDsiXag2rH4f7VTPNziYdGJdcxCnvGW6', 'Braiins', 'mining_pool'),
    ('EJERhHYJHx3w87TZ6jVbF5vtF1JQ3yMDPh', 'BTC.TOP', 'mining_pool'),
    ('EMzsK7X3MhwG5WeCJFCqBwPtgMtJpBeFKL', 'OKPool', 'mining_pool'),
    ('Eb1Vbp9KNJxNjNRWADjXYyL3pRRHvRdpuV', 'Binance Pool', 'mining_pool'),
    ('ER6iCws5hqmVoSeVugnWLNo28rv4iMVy17', 'Poolin', 'mining_pool')
ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label, category = EXCLUDED.category;
