-- Snapshot of circulating ELA supply at the moment a proposal exited
-- the community-veto window (status transitioned out of CRAgreed /
-- Notification). NULL for proposals already past-veto when this
-- column was added — they fall back to current circulation in the UI
-- with a caveat that the historical denominator is approximate.
--
-- Per Elastos `cr/state/proposalmanager.go:457-460`, the veto check
-- uses circulation at the block where it fires; this snapshot is our
-- closest reconstruction of that value.
ALTER TABLE cr_proposals
    ADD COLUMN IF NOT EXISTS veto_window_circulation_sela BIGINT;
