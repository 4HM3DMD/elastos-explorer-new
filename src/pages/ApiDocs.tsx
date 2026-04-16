import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Check, Shield, Database, Globe, Activity, Users, Landmark, BarChart3, Coins } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import { cn } from '../lib/cn';
import SEO from '../components/SEO';
import { copyToClipboard } from '../utils/clipboard';

const BASE_URL = '/api/v1';

interface Param {
  name: string;
  type: string;
  required: boolean;
  description: string;
  default?: string;
}

interface Endpoint {
  method: 'GET' | 'POST';
  path: string;
  description: string;
  params?: Param[];
  response: string;
}

interface EndpointGroup {
  id: string;
  label: string;
  icon: typeof Globe;
  endpoints: Endpoint[];
}

const API_GROUPS: EndpointGroup[] = [
  {
    id: 'supply',
    label: 'Supply',
    icon: Coins,
    endpoints: [
      {
        method: 'GET',
        path: '/supply',
        description: 'Comprehensive ELA supply breakdown: max supply, total minted, circulating, staked, locked (BPoS pledges), burned, DAO treasury, and staking rewards pool. Includes calculated percentages for issued and staked ratios.',
        response: `{
  "data": {
    "maxSupply": "28219999",
    "totalSupply": "23551231.98390915",
    "circulatingSupply": "18080746.68029115",
    "totalStaked": "5420280.96662028",
    "totalLocked": "2921694.48000000",
    "totalBurned": "13455469.21450890",
    "daoTreasury": "2681257.17087889",
    "stakingRewardsPool": "0.00000000",
    "issuedPercentage": 83.46,
    "stakedPercentage": 23.01
  }
}`,
      },
      {
        method: 'GET',
        path: '/supply/circulating',
        description: 'Returns only the circulating supply as a plain number string. Useful for CoinGecko, CoinMarketCap, and other aggregator integrations that expect a single value.',
        response: `18080746.68029115`,
      },
      {
        method: 'GET',
        path: '/supply/total',
        description: 'Returns only the total minted supply as a plain number string. Useful for aggregator integrations.',
        response: `23551231.98390915`,
      },
      {
        method: 'GET',
        path: '/supply/max',
        description: 'Returns the hard-capped maximum supply as a plain number string.',
        response: `28219999`,
      },
    ],
  },
  {
    id: 'blocks',
    label: 'Blocks',
    icon: Database,
    endpoints: [
      {
        method: 'GET',
        path: '/blocks/latest',
        description: 'Returns the most recent blocks.',
        params: [
          { name: 'limit', type: 'integer', required: false, description: 'Number of blocks to return', default: '10' },
        ],
        response: `{
  "data": [
    {
      "height": 2100500,
      "hash": "abc123...",
      "timestamp": 1713000000,
      "txCount": 5,
      "size": 1024,
      "minerInfo": "ViaBTC",
      "minerAddress": "Eeguj3..."
    }
  ]
}`,
      },
      {
        method: 'GET',
        path: '/blocks',
        description: 'Paginated list of all blocks, newest first.',
        params: [
          { name: 'page', type: 'integer', required: false, description: 'Page number', default: '1' },
          { name: 'pageSize', type: 'integer', required: false, description: 'Items per page (max 100)', default: '20' },
        ],
        response: `{
  "data": [...],
  "total": 2100500,
  "page": 1,
  "pageSize": 20
}`,
      },
      {
        method: 'GET',
        path: '/block/{heightOrHash}',
        description: 'Full block details by height (integer) or hash (64-char hex).',
        params: [
          { name: 'heightOrHash', type: 'string', required: true, description: 'Block height or block hash' },
        ],
        response: `{
  "data": {
    "height": 2100500,
    "hash": "abc123...",
    "previousBlockHash": "def456...",
    "timestamp": 1713000000,
    "txCount": 5,
    "size": 1024,
    "weight": 4096,
    "nonce": "00000000",
    "difficulty": "...",
    "minerInfo": "ViaBTC",
    "transactions": [...]
  }
}`,
      },
      {
        method: 'GET',
        path: '/block/{heightOrHash}/txs',
        description: 'Paginated transactions within a block.',
        params: [
          { name: 'heightOrHash', type: 'string', required: true, description: 'Block height or hash' },
          { name: 'page', type: 'integer', required: false, description: 'Page number', default: '1' },
          { name: 'pageSize', type: 'integer', required: false, description: 'Items per page (max 500)', default: '100' },
        ],
        response: `{
  "data": [
    {
      "txid": "abc123...",
      "type": 0,
      "size": 512,
      "fee": 10000,
      "blockHeight": 2100500,
      "timestamp": 1713000000
    }
  ],
  "total": 5,
  "page": 1,
  "pageSize": 100
}`,
      },
    ],
  },
  {
    id: 'transactions',
    label: 'Transactions',
    icon: Activity,
    endpoints: [
      {
        method: 'GET',
        path: '/tx/{txid}',
        description: 'Full transaction details including inputs, outputs, and transfer summary.',
        params: [
          { name: 'txid', type: 'string', required: true, description: '64-character hex transaction ID' },
        ],
        response: `{
  "data": {
    "txid": "abc123...",
    "type": 0,
    "blockHeight": 2100500,
    "blockHash": "def456...",
    "timestamp": 1713000000,
    "size": 512,
    "fee": 10000,
    "confirmations": 100,
    "vins": [...],
    "vouts": [...]
  }
}`,
      },
      {
        method: 'GET',
        path: '/transactions',
        description: 'Paginated list of recent transactions with optional type filtering.',
        params: [
          { name: 'page', type: 'integer', required: false, description: 'Page number', default: '1' },
          { name: 'pageSize', type: 'integer', required: false, description: 'Items per page (max 100)', default: '20' },
          { name: 'type', type: 'integer', required: false, description: 'Filter by transaction type number' },
          { name: 'hideSystem', type: 'string', required: false, description: 'Set to "true" to hide internal network transactions (e.g. staking, governance)' },
          { name: 'systemOnly', type: 'string', required: false, description: 'Set to "true" to show only system txs' },
        ],
        response: `{
  "data": [...],
  "total": 15000000,
  "page": 1,
  "pageSize": 20
}`,
      },
      {
        method: 'GET',
        path: '/tx/{txid}/trace',
        description: 'Recursively traces a transaction\'s input chain, building a tree of source transactions up to a configurable depth.',
        params: [
          { name: 'txid', type: 'string', required: true, description: '64-character hex transaction ID' },
          { name: 'depth', type: 'integer', required: false, description: 'Max recursion depth (1-5)', default: '3' },
        ],
        response: `{
  "data": {
    "txid": "abc123...",
    "inputs": [
      {
        "txid": "def456...",
        "inputs": [...],
        "truncated": false
      }
    ],
    "truncated": false
  }
}`,
      },
    ],
  },
  {
    id: 'addresses',
    label: 'Addresses',
    icon: Users,
    endpoints: [
      {
        method: 'GET',
        path: '/address/{address}',
        description: 'Address details: balance, transaction history, and UTXOs.',
        params: [
          { name: 'address', type: 'string', required: true, description: 'Elastos address (E/8/S/D/X prefix, 20-34 chars)' },
          { name: 'page', type: 'integer', required: false, description: 'Transaction history page', default: '1' },
          { name: 'pageSize', type: 'integer', required: false, description: 'Transactions per page', default: '20' },
        ],
        response: `{
  "data": {
    "address": "EeKGjcERs...",
    "balance": 150000000000,
    "totalReceived": 500000000000,
    "totalSent": 350000000000,
    "txCount": 42,
    "transactions": [...],
    "utxos": [...]
  }
}`,
      },
      {
        method: 'GET',
        path: '/address/{address}/staking',
        description: 'Staking information for an address: locked amount, voting rights, voted producers.',
        params: [
          { name: 'address', type: 'string', required: true, description: 'Elastos address' },
        ],
        response: `{
  "data": {
    "address": "EeKGjcERs...",
    "totalLocked": 10000000000,
    "votingRights": 10000000000,
    "producers": [...]
  }
}`,
      },
      {
        method: 'GET',
        path: '/address/{address}/balance-history',
        description: 'Daily balance history for an address, reconstructed from transaction deltas.',
        params: [
          { name: 'address', type: 'string', required: true, description: 'Elastos address' },
          { name: 'days', type: 'integer', required: false, description: 'Number of days of history (max 3650)', default: '90' },
        ],
        response: `{
  "data": [
    {
      "date": "2025-04-01",
      "balance": "150.5",
      "delta": "+2.3"
    }
  ]
}`,
      },
      {
        method: 'GET',
        path: '/address/{address}/vote-history',
        description: 'Paginated vote history for an address (BPoS staking and DAO governance votes).',
        params: [
          { name: 'address', type: 'string', required: true, description: 'Elastos address' },
          { name: 'page', type: 'integer', required: false, description: 'Page number', default: '1' },
          { name: 'pageSize', type: 'integer', required: false, description: 'Items per page (max 100)', default: '20' },
          { name: 'category', type: 'string', required: false, description: 'Filter: "staking" (BPoS types 0,4), "governance" (DAO types 1,2,3), or omit for all' },
        ],
        response: `{
  "data": [
    {
      "txid": "abc123...",
      "voteType": 0,
      "candidate": "def456...",
      "amount": "1500.0",
      "stakeHeight": 2100000,
      "isActive": true
    }
  ],
  "total": 15,
  "page": 1,
  "pageSize": 20
}`,
      },
      {
        method: 'GET',
        path: '/address/{address}/governance',
        description: 'Unified governance activity timeline for an address: DAO election votes, proposal votes, and impeachment votes.',
        params: [
          { name: 'address', type: 'string', required: true, description: 'Elastos address' },
          { name: 'page', type: 'integer', required: false, description: 'Page number', default: '1' },
          { name: 'pageSize', type: 'integer', required: false, description: 'Items per page (max 100)', default: '20' },
        ],
        response: `{
  "data": [
    {
      "eventType": "election_vote",
      "txid": "abc123...",
      "candidate": "def456...",
      "candidateName": "Council Member",
      "amount": "500.0",
      "blockHeight": 2100000,
      "timestamp": 1713000000
    }
  ],
  "total": 8,
  "page": 1,
  "pageSize": 20
}`,
      },
      {
        method: 'GET',
        path: '/richlist',
        description: 'Top addresses ranked by ELA balance.',
        params: [
          { name: 'page', type: 'integer', required: false, description: 'Page number', default: '1' },
          { name: 'pageSize', type: 'integer', required: false, description: 'Items per page (max 100)', default: '50' },
        ],
        response: `{
  "data": [
    {
      "rank": 1,
      "address": "CRASSETSXXX...",
      "balance": 16000000000000,
      "txCount": 500,
      "label": "Elastos DAO Assets"
    }
  ],
  "total": 800000,
  "page": 1,
  "pageSize": 50
}`,
      },
    ],
  },
  {
    id: 'staking',
    label: 'Staking & Validators',
    icon: Shield,
    endpoints: [
      {
        method: 'GET',
        path: '/stakers',
        description: 'Top BPoS stakers ranked by voting rights, with network-wide staking summary.',
        params: [
          { name: 'page', type: 'integer', required: false, description: 'Page number', default: '1' },
          { name: 'pageSize', type: 'integer', required: false, description: 'Items per page', default: '50' },
        ],
        response: `{
  "data": [...],
  "total": 5000,
  "page": 1,
  "pageSize": 50,
  "summary": {
    "totalLocked": "25000000",
    "totalVotingRights": "25000000",
    "totalUnclaimed": "1500"
  }
}`,
      },
      {
        method: 'GET',
        path: '/producers',
        description: 'List BPoS validators/producers filtered by state.',
        params: [
          { name: 'state', type: 'string', required: false, description: 'Filter: Active, Inactive, Canceled, Illegal, Returned, or all', default: 'Active' },
        ],
        response: `{
  "data": [
    {
      "ownerPublicKey": "abc123...",
      "nickname": "Elastos Foundation",
      "rank": 1,
      "state": "Active",
      "dposV2Votes": "1500000",
      "registrationType": "BPoS",
      "location": 86
    }
  ]
}`,
      },
      {
        method: 'GET',
        path: '/producer/{ownerPubKey}',
        description: 'Detailed information about a specific validator.',
        params: [
          { name: 'ownerPubKey', type: 'string', required: true, description: '66 or 130 character hex public key' },
        ],
        response: `{
  "data": {
    "ownerPublicKey": "abc123...",
    "nickname": "Elastos Foundation",
    "rank": 1,
    "state": "Active",
    "dposV2Votes": "1500000",
    "totalStakers": 250,
    "url": "https://...",
    "location": 86
  }
}`,
      },
      {
        method: 'GET',
        path: '/producer/{ownerPubKey}/stakers',
        description: 'Paginated list of addresses staking to a specific producer.',
        params: [
          { name: 'ownerPubKey', type: 'string', required: true, description: 'Producer public key' },
          { name: 'page', type: 'integer', required: false, description: 'Page number', default: '1' },
          { name: 'pageSize', type: 'integer', required: false, description: 'Items per page (max 500)', default: '50' },
        ],
        response: `{
  "data": [...],
  "total": 250,
  "page": 1,
  "pageSize": 50
}`,
      },
    ],
  },
  {
    id: 'governance',
    label: 'Governance (DAO)',
    icon: Landmark,
    endpoints: [
      {
        method: 'GET',
        path: '/cr/members',
        description: 'Current Elastos DAO council members with their status and votes.',
        response: `{
  "data": [
    {
      "cid": "abc123...",
      "did": "def456...",
      "nickname": "Council Member",
      "state": "Elected",
      "votes": "500000",
      "location": 86
    }
  ]
}`,
      },
      {
        method: 'GET',
        path: '/cr/elections',
        description: 'Summary of all DAO election terms.',
        response: `[
  {
    "term": 3,
    "candidates": 25,
    "electedCount": 12,
    "totalVotes": "5000000",
    "votingStartHeight": 2000000,
    "votingEndHeight": 2050000
  }
]`,
      },
      {
        method: 'GET',
        path: '/cr/elections/{term}',
        description: 'Detailed election results for a specific term including all candidates.',
        params: [
          { name: 'term', type: 'integer', required: true, description: 'Election term number (>= 1)' },
        ],
        response: `{
  "term": 3,
  "votingStartHeight": 2000000,
  "votingEndHeight": 2050000,
  "candidates": [
    {
      "rank": 1,
      "cid": "abc123...",
      "nickname": "Candidate",
      "votes": "500000",
      "voterCount": 100,
      "elected": true
    }
  ]
}`,
      },
      {
        method: 'GET',
        path: '/cr/proposals',
        description: 'Paginated list of DAO proposals with optional status filter.',
        params: [
          { name: 'page', type: 'integer', required: false, description: 'Page number', default: '1' },
          { name: 'pageSize', type: 'integer', required: false, description: 'Items per page', default: '20' },
          { name: 'status', type: 'string', required: false, description: 'Filter by proposal status' },
        ],
        response: `{
  "data": [
    {
      "proposalHash": "abc123...",
      "title": "Proposal Title",
      "status": "Active",
      "type": 0,
      "budgetAmount": "50000",
      "proposer": "def456..."
    }
  ],
  "total": 150,
  "page": 1,
  "pageSize": 20
}`,
      },
      {
        method: 'GET',
        path: '/cr/proposal/{hash}',
        description: 'Full proposal details including budget stages, opinions, and voting status.',
        params: [
          { name: 'hash', type: 'string', required: true, description: '64-character hex proposal hash' },
        ],
        response: `{
  "data": {
    "proposalHash": "abc123...",
    "title": "Proposal Title",
    "status": "Active",
    "abstract": "...",
    "budgets": [...],
    "crVotes": [...]
  }
}`,
      },
      {
        method: 'GET',
        path: '/cr/proposal-image/{draftHash}/{filename}',
        description: 'Serves embedded images from DAO proposal draft ZIP files.',
        params: [
          { name: 'draftHash', type: 'string', required: true, description: 'Proposal draft hash' },
          { name: 'filename', type: 'string', required: true, description: 'Image filename within the ZIP' },
        ],
        response: 'Binary image data (image/png, image/jpeg, etc.)',
      },
    ],
  },
  {
    id: 'network',
    label: 'Network & Stats',
    icon: BarChart3,
    endpoints: [
      {
        method: 'GET',
        path: '/stats',
        description: 'Network-wide blockchain statistics: height, transactions, supply, difficulty.',
        response: `{
  "data": {
    "height": 2100500,
    "totalTransactions": 15000000,
    "totalAddresses": 800000,
    "circulatingSupply": 26000000,
    "difficulty": "...",
    "blockTime": 120
  }
}`,
      },
      {
        method: 'GET',
        path: '/widgets',
        description: 'Pre-computed dashboard widget data (24h volume, active addresses, etc.).',
        response: `{
  "data": {
    "txCount24h": 500,
    "volume24h": "150000",
    "activeAddresses24h": 200,
    "avgBlockTime": 120
  }
}`,
      },
      {
        method: 'GET',
        path: '/hashrate',
        description: 'Current Bitcoin merge-mining hashrate estimate for the Elastos network.',
        response: `{
  "data": {
    "hashrate": "450.5 EH/s",
    "difficulty": "...",
    "source": "btc"
  }
}`,
      },
      {
        method: 'GET',
        path: '/search',
        description: 'Universal search across blocks, transactions, addresses, and producer nicknames.',
        params: [
          { name: 'q', type: 'string', required: true, description: 'Search query (max 128 chars): block height, tx hash, address, or nickname' },
        ],
        response: `{
  "data": {
    "type": "address",
    "value": "EeKGjcERs..."
  }
}`,
      },
      {
        method: 'GET',
        path: '/mempool',
        description: 'Current mempool state: pending transaction count and IDs (max 500).',
        response: `{
  "data": {
    "size": 12,
    "txids": ["abc123...", "def456..."]
  }
}`,
      },
      {
        method: 'GET',
        path: '/ela-price',
        description: 'Current ELA token price in USD with 24h change percentage. Sourced from CoinGecko.',
        response: `{
  "data": {
    "price": 2.45,
    "change24h": -1.23
  }
}`,
      },
      {
        method: 'GET',
        path: '/charts/{metric}',
        description: 'Historical chart data for a given metric over a time period.',
        params: [
          { name: 'metric', type: 'string', required: true, description: 'One of: daily-transactions, daily-volume, daily-fees, daily-addresses, block-size' },
          { name: 'days', type: 'integer', required: false, description: 'Number of days of history (max 365)', default: '30' },
        ],
        response: `{
  "data": [
    { "date": "2025-04-01", "value": 500 },
    { "date": "2025-04-02", "value": 520 }
  ]
}`,
      },
    ],
  },
  {
    id: 'health',
    label: 'Health',
    icon: Activity,
    endpoints: [
      {
        method: 'GET',
        path: '/health',
        description: 'Basic health check. Returns 200 if the API server is running and responsive.',
        response: `{ "status": "ok" }`,
      },
    ],
  },
  {
    id: 'rpc',
    label: 'RPC Proxy',
    icon: Globe,
    endpoints: [
      {
        method: 'POST',
        path: '/ela',
        description: 'Proxies whitelisted JSON-RPC methods to the ELA mainchain node. Rate limited to 10 req/s per IP. Only the following methods are allowed: getblockcount, getbestblockhash, getblockhash, getblock, getrawtransaction, getreceivedbyaddress, getamountbyinputs, getutxosbyamount, getexistdeposittransactions.',
        params: [
          { name: 'method', type: 'string', required: true, description: 'JSON-RPC method name (must be whitelisted)' },
          { name: 'params', type: 'array', required: false, description: 'Method parameters as JSON array' },
          { name: 'id', type: 'any', required: false, description: 'JSON-RPC request ID' },
        ],
        response: `{
  "id": 1,
  "jsonrpc": "2.0",
  "result": "..."
}

// Error (method not allowed):
{
  "id": 1,
  "error": {
    "code": -32601,
    "message": "method not allowed"
  }
}`,
      },
    ],
  },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <button onClick={handleCopy} className="p-1.5 rounded hover:bg-hover transition-colors text-muted hover:text-primary" title="Copy">
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function EndpointCard({ endpoint }: { endpoint: Endpoint }) {
  const [open, setOpen] = useState(false);
  const isRootPath = ['/ws', '/health', '/metrics', '/ela'].some(p => endpoint.path.startsWith(p));
  const fullPath = isRootPath ? endpoint.path : `${BASE_URL}${endpoint.path}`;

  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-hover transition-colors"
      >
        <span className={cn(
          'shrink-0 px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider',
          endpoint.method === 'GET' ? 'bg-blue-500/10 text-blue-400' : 'bg-amber-500/10 text-amber-400'
        )}>
          {endpoint.method}
        </span>
        <code className="text-sm font-mono text-primary flex-1 truncate">{fullPath}</code>
        {open ? <ChevronDown size={14} className="text-muted shrink-0" /> : <ChevronRight size={14} className="text-muted shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-[var(--color-border)] px-4 py-4 space-y-4">
          <p className="text-sm text-secondary">{endpoint.description}</p>

          {endpoint.params && endpoint.params.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">Parameters</h4>
              <div className="overflow-x-auto">
                <table className="table-clean">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Required</th>
                      <th>Default</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {endpoint.params.map((p) => (
                      <tr key={p.name}>
                        <td className="py-2 px-3"><code className="text-xs font-mono text-blue-400">{p.name}</code></td>
                        <td className="py-2 px-3"><span className="text-xs text-muted">{p.type}</span></td>
                        <td className="py-2 px-3"><span className={cn('text-xs', p.required ? 'text-amber-400' : 'text-muted')}>{p.required ? 'Yes' : 'No'}</span></td>
                        <td className="py-2 px-3"><span className="text-xs text-muted font-mono">{p.default || '—'}</span></td>
                        <td className="py-2 px-3"><span className="text-xs text-secondary">{p.description}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-muted uppercase tracking-wider">Response</h4>
              <CopyButton text={endpoint.response} />
            </div>
            <pre className="bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-lg p-3 overflow-x-auto text-xs font-mono text-secondary leading-relaxed">
              {endpoint.response}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function GroupSection({ group }: { group: EndpointGroup }) {
  const Icon = group.icon;
  return (
    <section id={group.id} className="scroll-mt-20">
      <div className="flex items-center gap-2 mb-3">
        <Icon size={18} className="text-brand" />
        <h2 className="text-lg font-semibold text-primary">{group.label}</h2>
        <span className="text-xs text-muted">({group.endpoints.length})</span>
      </div>
      <div className="space-y-2">
        {group.endpoints.map((ep) => (
          <EndpointCard key={`${ep.method}-${ep.path}`} endpoint={ep} />
        ))}
      </div>
    </section>
  );
}

const ApiDocs = () => {
  const totalEndpoints = API_GROUPS.reduce((sum, g) => sum + g.endpoints.length, 0);

  return (
    <div>
      <SEO title="API Documentation" description="REST API documentation for the Elastos main chain explorer. Access blocks, transactions, addresses, supply, and governance data." path="/api-docs" />
      <PageHeader
        title="API Documentation"
        subtitle={`${totalEndpoints} RESTful endpoints for the Elastos blockchain`}
        breadcrumbs={[{ label: 'API Docs' }]}
      />

      <div className="px-4 lg:px-6 py-6 max-w-5xl">
        <div className="space-y-6">

          {/* Overview cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="card px-4 py-3">
              <div className="text-xs text-muted uppercase tracking-wider mb-1">Base URL</div>
              <code className="text-sm font-mono text-primary break-all">/api/v1</code>
            </div>
            <div className="card px-4 py-3">
              <div className="text-xs text-muted uppercase tracking-wider mb-1">Rate Limit</div>
              <span className="text-sm text-primary">60 req/s per IP</span>
              <span className="text-xs text-muted ml-1">(burst 120)</span>
            </div>
            <div className="card px-4 py-3">
              <div className="text-xs text-muted uppercase tracking-wider mb-1">Format</div>
              <span className="text-sm text-primary">JSON</span>
              <span className="text-xs text-muted ml-1">(UTF-8)</span>
            </div>
          </div>

          {/* Response format */}
          <div className="card px-5 py-4">
            <h3 className="text-sm font-semibold text-primary mb-2">Response Format</h3>
            <p className="text-xs text-secondary mb-3">
              All endpoints return a standard JSON envelope. Paginated endpoints include <code className="text-xs bg-[var(--color-surface-secondary)] px-1 rounded">total</code>, <code className="text-xs bg-[var(--color-surface-secondary)] px-1 rounded">page</code>, and <code className="text-xs bg-[var(--color-surface-secondary)] px-1 rounded">pageSize</code> fields.
            </p>
            <pre className="bg-[var(--color-surface-secondary)] border border-[var(--color-border)] rounded-lg p-3 overflow-x-auto text-xs font-mono text-secondary leading-relaxed">{`{
  "data": { ... },        // Response payload
  "total": 1000,          // Total items (paginated only)
  "page": 1,              // Current page (paginated only)
  "pageSize": 20,         // Items per page (paginated only)
  "error": "message"      // Present only on error
}`}</pre>
          </div>

          {/* Rate limiting info */}
          <div className="card px-5 py-4">
            <h3 className="text-sm font-semibold text-primary mb-2">Rate Limiting</h3>
            <p className="text-xs text-secondary mb-2">
              Rate limits are enforced <strong>per client IP address</strong>, not globally. Each IP gets an independent token bucket.
            </p>
            <div className="overflow-x-auto">
              <table className="table-clean">
                <thead>
                  <tr>
                    <th>Scope</th>
                    <th>Rate</th>
                    <th>Burst</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="py-2 px-3"><span className="text-xs text-primary">API endpoints</span></td>
                    <td className="py-2 px-3"><span className="text-xs font-mono text-secondary">60/s</span></td>
                    <td className="py-2 px-3"><span className="text-xs font-mono text-secondary">120</span></td>
                  </tr>
                  <tr>
                    <td className="py-2 px-3"><span className="text-xs text-primary">RPC proxy (/ela)</span></td>
                    <td className="py-2 px-3"><span className="text-xs font-mono text-secondary">10/s</span></td>
                    <td className="py-2 px-3"><span className="text-xs font-mono text-secondary">20</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted mt-2">
              Exceeding the limit returns <code className="text-xs bg-[var(--color-surface-secondary)] px-1 rounded">429 Too Many Requests</code>.
            </p>
          </div>

          {/* Quick navigation */}
          <div className="card px-5 py-4">
            <h3 className="text-sm font-semibold text-primary mb-3">Endpoints</h3>
            <div className="flex flex-wrap gap-2">
              {API_GROUPS.map((g) => {
                const Icon = g.icon;
                return (
                  <a
                    key={g.id}
                    href={`#${g.id}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-secondary hover:text-primary bg-[var(--color-surface-secondary)] hover:bg-[var(--color-surface-tertiary)] border border-[var(--color-border)] transition-colors"
                  >
                    <Icon size={13} />
                    {g.label}
                    <span className="text-muted">({g.endpoints.length})</span>
                  </a>
                );
              })}
            </div>
          </div>

          {/* Endpoint groups */}
          {API_GROUPS.map((group) => (
            <GroupSection key={group.id} group={group} />
          ))}

        </div>
      </div>
    </div>
  );
};

export default ApiDocs;
