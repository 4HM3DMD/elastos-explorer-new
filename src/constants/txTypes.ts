/**
 * Elastos transaction type codes (mirrors `core/types/transaction/txtype.go`
 * in elastos/Elastos.ELA). Values are stable on-chain protocol numbers, so
 * they belong in one shared module rather than scattered across pages.
 *
 * Add new types here as the protocol evolves; do not redefine inline.
 */

// CoinBase / system transactions — first 5 codes used by the node for
// network operation. Filtered out of "human" tx lists by default.
export const TX_TYPE_COINBASE = 0x00;
export const TX_TYPE_REGISTER_ASSET = 0x01;
export const TX_TYPE_TRANSFER_ASSET = 0x02;
export const TX_TYPE_RECORD = 0x03;
export const TX_TYPE_DEPLOY = 0x04;
export const TX_TYPE_SIDECHAIN_POW = 0x05;

// CR / DPoS / governance
export const TX_TYPE_REGISTER_PRODUCER = 0x09;
export const TX_TYPE_CANCEL_PRODUCER = 0x0a;
export const TX_TYPE_UPDATE_PRODUCER = 0x0b;
export const TX_TYPE_RETURN_DEPOSIT_COIN = 0x0c;
export const TX_TYPE_ACTIVATE_PRODUCER = 0x0d;

// CRC voting
export const TX_TYPE_REGISTER_CR = 0x21;
export const TX_TYPE_UNREGISTER_CR = 0x22;
export const TX_TYPE_UPDATE_CR = 0x23;
export const TX_TYPE_RETURN_CR_DEPOSIT_COIN = 0x24;

// BPoSv2 staking
export const TX_TYPE_STAKE = 0x62;
/** BPoS vote transaction — used to detect voting txs in lists & detail
 *  pages. The single source of truth; do not hardcode 0x63 elsewhere. */
export const TX_TYPE_VOTING = 0x63;
export const TX_TYPE_UNSTAKE = 0x64;
