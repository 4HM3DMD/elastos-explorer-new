-- ============================================================
-- Post-Resync Balance Verification Queries
-- ============================================================
-- Run these after a full resync to validate data integrity.
-- All queries should return expected results as noted below.

-- 1. Total indexed supply should approximate total ELA supply (~33.7M ELA = 3.37e15 sela)
SELECT
  SUM(balance_sela) AS total_balance_sela,
  ROUND(SUM(balance_sela) / 1e8, 4) AS total_balance_ela
FROM address_balances;

-- 2. No addresses should have negative balances
SELECT address, balance_sela
FROM address_balances
WHERE balance_sela < 0
LIMIT 20;
-- Expected: 0 rows

-- 3. Verify balance matches unspent UTXO sum (ELA only) for each address
-- Run for specific addresses or as a full scan:
SELECT ab.address,
       ab.balance_sela AS stored_balance,
       COALESCE(u.utxo_balance, 0) AS computed_utxo_balance,
       ab.balance_sela - COALESCE(u.utxo_balance, 0) AS drift
FROM address_balances ab
LEFT JOIN (
  SELECT address, SUM(value_sela) AS utxo_balance
  FROM tx_vouts
  WHERE spent_txid IS NULL
    AND (asset_id = 'a3d0eaa466df74983b5d7c543de6904f4c9418ead5ffd6d25814234a96db37b0' OR asset_id = '')
  GROUP BY address
) u ON ab.address = u.address
WHERE ab.balance_sela != COALESCE(u.utxo_balance, 0)
LIMIT 20;
-- Expected: 0 rows (all balances match UTXO sums)

-- 4. Top 20 rich list (sanity check against known system addresses)
SELECT address, balance_sela, ROUND(balance_sela / 1e8, 4) AS balance_ela
FROM address_balances
ORDER BY balance_sela DESC
LIMIT 20;
-- Expected: top entries include Foundation, DAO, Burn, Stake Pool addresses

-- 5. Check chain_stats accuracy
SELECT
  cs.total_addresses,
  (SELECT COUNT(*) FROM address_balances WHERE balance_sela > 0) AS actual_nonzero_addresses,
  cs.total_blocks,
  (SELECT COALESCE(MAX(height) + 1, 0) FROM blocks) AS actual_block_count,
  cs.total_txs,
  (SELECT COUNT(*) FROM transactions) AS actual_tx_count
FROM chain_stats cs WHERE cs.id = 1;
-- Expected: stored values match actual counts

-- 6. No orphaned address_balances (addresses with balances but no vouts)
SELECT ab.address, ab.balance_sela
FROM address_balances ab
WHERE NOT EXISTS (
  SELECT 1 FROM tx_vouts v
  WHERE v.address = ab.address
    AND (v.asset_id = 'a3d0eaa466df74983b5d7c543de6904f4c9418ead5ffd6d25814234a96db37b0' OR v.asset_id = '')
)
AND ab.balance_sela > 0
LIMIT 20;
-- Expected: 0 rows

-- 7. Verify no fee corruption (no negative fees in blocks)
SELECT height, total_fees_sela
FROM blocks
WHERE total_fees_sela < 0
LIMIT 20;
-- Expected: 0 rows
