// ApiDocs — renders the REST API reference page from a single data
// source at src/data/api-docs.ts. No endpoint docs live in this file;
// to add/change/remove an endpoint, edit the data file only.
//
// Rendering pipeline:
//   ApiDocs (layout, overview cards, quick-nav)
//     └─ GroupSection (per group heading + icon)
//           └─ EndpointCard (collapsible row with method badge, params, response)
//                 └─ CopyButton (response copy-to-clipboard)

import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import SEO from '../components/SEO';
import { cn } from '../lib/cn';
import { copyToClipboard } from '../utils/clipboard';
import {
  API_GROUPS, BASE_URL,
  type Endpoint, type EndpointGroup,
} from '../data/api-docs';

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
  // A few routes live above /api/v1 (ws upgrade, health probes, RPC
  // proxy). Show the real path in those cases so docs match what
  // clients actually call.
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
