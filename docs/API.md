# Elastos Main Chain Explorer API Documentation

## Base URL
```
http://localhost:3001/api
```

## Authentication
No authentication required for public endpoints.

## Response Format
All API responses follow a consistent JSON format:

```json
{
  "data": "response_data",
  "error": null
}
```

In case of errors:
```json
{
  "data": null,
  "error": {
    "code": "ERROR_CODE",
    "message": "Error description"
  }
}
```

---

## Endpoints

### 1. Get Latest Blocks

**GET** `/blocks/latest`

Retrieves the most recent blocks from the blockchain.

#### Query Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 10 | Number of blocks to retrieve (max: 100) |

#### Example Request
```bash
GET /api/blocks/latest?limit=10
```

#### Example Response
```json
[
  {
    "hash": "a1b2c3d4e5f6789012345678901234567890123456789012345678901234567890",
    "confirmations": 5,
    "size": 1024,
    "strippedsize": 1000,
    "weight": 4000,
    "height": 123456,
    "version": 1,
    "versionHex": "00000001",
    "merkleroot": "b2c3d4e5f6789012345678901234567890123456789012345678901234567890a1",
    "time": 1704067200,
    "medianTime": 1704067100,
    "nonce": 987654321,
    "bits": 404472624,
    "difficulty": "1234567.89",
    "chainwork": "000000000000000000000000000000000000000000000000abcdef1234567890",
    "previousblockhash": "c3d4e5f6789012345678901234567890123456789012345678901234567890a1b2",
    "nextblockhash": "d4e5f6789012345678901234567890123456789012345678901234567890a1b2c3",
    "auxpow": "",
    "minerinfo": "",
    "tx": [
      {
        "txid": "e5f6789012345678901234567890123456789012345678901234567890a1b2c3d4",
        "hash": "e5f6789012345678901234567890123456789012345678901234567890a1b2c3d4",
        "size": 250,
        "vsize": 250,
        "version": 2,
        "locktime": 0,
        "vin": [],
        "vout": [],
        "blockhash": "a1b2c3d4e5f6789012345678901234567890123456789012345678901234567890",
        "confirmations": 5,
        "time": 1704067200,
        "blocktime": 1704067200,
        "type": 0,
        "payloadversion": 0,
        "attributes": [],
        "programs": []
      }
    ]
  }
]
```

---

### 2. Get Block Details

**GET** `/block/:heightOrHash`

Retrieves detailed information about a specific block.

#### Path Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| `heightOrHash` | string | Block height (number) or block hash (64-char hex) |

#### Example Requests
```bash
GET /api/block/123456
GET /api/block/a1b2c3d4e5f6789012345678901234567890123456789012345678901234567890
```

#### Example Response
```json
{
  "hash": "a1b2c3d4e5f6789012345678901234567890123456789012345678901234567890",
  "confirmations": 5,
  "size": 1024,
  "strippedsize": 1000,
  "weight": 4000,
  "height": 123456,
  "version": 1,
  "versionHex": "00000001",
  "merkleroot": "b2c3d4e5f6789012345678901234567890123456789012345678901234567890a1",
  "time": 1704067200,
  "medianTime": 1704067100,
  "nonce": 987654321,
  "bits": 404472624,
  "difficulty": "1234567.89",
  "chainwork": "000000000000000000000000000000000000000000000000abcdef1234567890",
  "previousblockhash": "c3d4e5f6789012345678901234567890123456789012345678901234567890a1b2",
  "nextblockhash": "d4e5f6789012345678901234567890123456789012345678901234567890a1b2c3",
  "auxpow": "",
  "minerinfo": "",
  "tx": [
    {
      "txid": "e5f6789012345678901234567890123456789012345678901234567890a1b2c3d4",
      "hash": "e5f6789012345678901234567890123456789012345678901234567890a1b2c3d4",
      "size": 250,
      "vsize": 250,
      "version": 2,
      "locktime": 0,
      "vin": [
        {
          "txid": "f6789012345678901234567890123456789012345678901234567890a1b2c3d4e5",
          "vout": 0,
          "sequence": 4294967295
        }
      ],
      "vout": [
        {
          "value": "10.00000000",
          "n": 0,
          "address": "ELANULLXXXXXXXXXXXXXXXXXXXXXXXYvs3rr",
          "assetid": "a3d0eaa466df74983b5d7c543de6904f4c9418ead5ffd6d25814234a96db37b0",
          "outputlock": 0,
          "type": 0,
          "payload": {}
        }
      ],
      "blockhash": "a1b2c3d4e5f6789012345678901234567890123456789012345678901234567890",
      "confirmations": 5,
      "time": 1704067200,
      "blocktime": 1704067200,
      "type": 0,
      "payloadversion": 0,
      "attributes": [],
      "programs": []
    }
  ]
}
```

---

### 3. Get Transaction Details

**GET** `/tx/:txid`

Retrieves detailed information about a specific transaction.

#### Path Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| `txid` | string | Transaction ID (64-character hex string) |

#### Example Request
```bash
GET /api/tx/e5f6789012345678901234567890123456789012345678901234567890a1b2c3d4
```

#### Example Response
```json
{
  "txid": "e5f6789012345678901234567890123456789012345678901234567890a1b2c3d4",
  "hash": "e5f6789012345678901234567890123456789012345678901234567890a1b2c3d4",
  "size": 250,
  "vsize": 250,
  "version": 2,
  "locktime": 0,
  "vin": [
    {
      "txid": "f6789012345678901234567890123456789012345678901234567890a1b2c3d4e5",
      "vout": 0,
      "sequence": 4294967295
    }
  ],
  "vout": [
    {
      "value": "10.00000000",
      "n": 0,
      "address": "ELANULLXXXXXXXXXXXXXXXXXXXXXXXYvs3rr",
      "assetid": "a3d0eaa466df74983b5d7c543de6904f4c9418ead5ffd6d25814234a96db37b0",
      "outputlock": 0,
      "type": 0,
      "payload": {}
    },
    {
      "value": "5.00000000",
      "n": 1,
      "address": "EQSpUzE4XYJhBSx5j7Tf2cteaKdFdixfVB",
      "assetid": "a3d0eaa466df74983b5d7c543de6904f4c9418ead5ffd6d25814234a96db37b0",
      "outputlock": 0,
      "type": 0,
      "payload": {}
    }
  ],
  "blockhash": "a1b2c3d4e5f6789012345678901234567890123456789012345678901234567890",
  "confirmations": 5,
  "time": 1704067200,
  "blocktime": 1704067200,
  "type": 0,
  "payloadversion": 0,
  "payload": {
    "coinbasedata": "03e0040e062f503253482f"
  },
  "attributes": [
    {
      "usage": 0,
      "data": "31323334"
    }
  ],
  "programs": [
    {
      "code": "21036db5984e709d2e0ec62fd974283e9a18e7b61b5e0b54bd407baa7b2e5a9845be5dac",
      "parameter": "404142434445464748494a4b4c4d4e4f505152535455565758595a"
    }
  ]
}
```

---

### 4. Get Address Information

**GET** `/address/:address`

Retrieves information about a specific address including balance and transaction history.

#### Path Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| `address` | string | Wallet address (25-34 character string) |

#### Example Request
```bash
GET /api/address/EQSpUzE4XYJhBSx5j7Tf2cteaKdFdixfVB
```

#### Example Response
```json
{
  "address": "EQSpUzE4XYJhBSx5j7Tf2cteaKdFdixfVB",
  "balance": "100.50000000",
  "totalReceived": "250.75000000",
  "totalSent": "150.25000000",
  "txCount": 15,
  "transactions": [
    {
      "txid": "e5f6789012345678901234567890123456789012345678901234567890a1b2c3d4",
      "hash": "e5f6789012345678901234567890123456789012345678901234567890a1b2c3d4",
      "size": 250,
      "vsize": 250,
      "version": 2,
      "locktime": 0,
      "vin": [],
      "vout": [
        {
          "value": "10.00000000",
          "n": 0,
          "address": "EQSpUzE4XYJhBSx5j7Tf2cteaKdFdixfVB",
          "assetid": "a3d0eaa466df74983b5d7c543de6904f4c9418ead5ffd6d25814234a96db37b0",
          "outputlock": 0,
          "type": 0,
          "payload": {}
        }
      ],
      "blockhash": "a1b2c3d4e5f6789012345678901234567890123456789012345678901234567890",
      "confirmations": 5,
      "time": 1704067200,
      "blocktime": 1704067200,
      "type": 0,
      "payloadversion": 0,
      "attributes": [],
      "programs": []
    }
  ]
}
```

---

## Data Types

### Block
```typescript
interface Block {
  hash: string;                    // Block hash
  confirmations: number;           // Number of confirmations
  size: number;                    // Block size in bytes
  strippedsize: number;           // Block size without witness data
  weight: number;                 // Block weight
  height: number;                 // Block height
  version: number;                // Block version
  versionHex: string;             // Block version in hex
  merkleroot: string;             // Merkle root hash
  time: number;                   // Block timestamp (Unix)
  medianTime: number;             // Median time of previous blocks
  nonce: number;                  // Block nonce
  bits: number;                   // Difficulty bits
  difficulty: string;             // Difficulty value
  chainwork: string;              // Total chain work
  previousblockhash: string;      // Previous block hash
  nextblockhash: string;          // Next block hash
  auxpow: string;                 // Auxiliary proof of work
  minerinfo: string;              // Miner information
  tx: Transaction[];              // Array of transactions
}
```

### Transaction
```typescript
interface Transaction {
  txid: string;                   // Transaction ID
  hash: string;                   // Transaction hash
  size: number;                   // Transaction size in bytes
  vsize: number;                  // Virtual transaction size
  version: number;                // Transaction version
  locktime: number;               // Lock time
  vin: Vin[];                     // Transaction inputs
  vout: Vout[];                   // Transaction outputs
  blockhash: string;              // Block hash containing this tx
  confirmations: number;          // Number of confirmations
  time: number;                   // Transaction timestamp
  blocktime: number;              // Block timestamp
  type: number;                   // Transaction type
  payloadversion: number;         // Payload version
  payload?: Payload;              // Transaction payload
  attributes: Attribute[];        // Transaction attributes
  programs: Program[];            // Transaction programs
}
```

### Transaction Input (Vin)
```typescript
interface Vin {
  txid: string;                   // Previous transaction ID
  vout: number;                   // Previous output index
  sequence: number;               // Sequence number
}
```

### Transaction Output (Vout)
```typescript
interface Vout {
  value: string;                  // Output value in ELA
  n: number;                      // Output index
  address: string;                // Recipient address
  assetid: string;                // Asset ID
  outputlock: number;             // Output lock
  type: number;                   // Output type
  payload: VoutPayload;           // Output payload
}
```

### Address Information
```typescript
interface AddressInfo {
  address: string;                // Wallet address
  balance: string;                // Current balance in ELA
  totalReceived: string;          // Total ELA received
  totalSent: string;              // Total ELA sent
  txCount: number;                // Total transaction count
  transactions: Transaction[];     // Recent transactions
}
```

---

## Error Codes

| Code | Description |
|------|-------------|
| `BLOCK_NOT_FOUND` | Block with specified height or hash not found |
| `TRANSACTION_NOT_FOUND` | Transaction with specified ID not found |
| `ADDRESS_NOT_FOUND` | Address not found or has no transactions |
| `INVALID_PARAMETER` | Invalid parameter format |
| `RATE_LIMIT_EXCEEDED` | Too many requests |
| `INTERNAL_ERROR` | Internal server error |

---

## Rate Limiting

- **Rate Limit**: 100 requests per minute per IP
- **Headers**: 
  - `X-RateLimit-Limit`: Request limit
  - `X-RateLimit-Remaining`: Remaining requests
  - `X-RateLimit-Reset`: Reset timestamp

---

## Examples

### JavaScript/TypeScript Usage

```typescript
import axios from 'axios';

const API_BASE = 'http://localhost:3001/api';

// Get latest blocks
const getLatestBlocks = async (limit = 10) => {
  const response = await axios.get(`${API_BASE}/blocks/latest?limit=${limit}`);
  return response.data;
};

// Get block details
const getBlock = async (heightOrHash: string) => {
  const response = await axios.get(`${API_BASE}/block/${heightOrHash}`);
  return response.data;
};

// Get transaction details
const getTransaction = async (txid: string) => {
  const response = await axios.get(`${API_BASE}/tx/${txid}`);
  return response.data;
};

// Get address information
const getAddress = async (address: string) => {
  const response = await axios.get(`${API_BASE}/address/${address}`);
  return response.data;
};
```

### cURL Examples

```bash
# Get latest 5 blocks
curl "http://localhost:3001/api/blocks/latest?limit=5"

# Get block by height
curl "http://localhost:3001/api/block/123456"

# Get block by hash
curl "http://localhost:3001/api/block/a1b2c3d4e5f6789012345678901234567890123456789012345678901234567890"

# Get transaction details
curl "http://localhost:3001/api/tx/e5f6789012345678901234567890123456789012345678901234567890a1b2c3d4"

# Get address information
curl "http://localhost:3001/api/address/EQSpUzE4XYJhBSx5j7Tf2cteaKdFdixfVB"
```

---

## Notes

1. All timestamps are in Unix format (seconds since epoch)
2. All monetary values are returned as strings to preserve precision
3. Hashes are returned as lowercase hexadecimal strings
4. The API supports both block height (number) and block hash for block queries
5. Transaction arrays in blocks may be truncated for large blocks - use individual transaction endpoints for complete data
