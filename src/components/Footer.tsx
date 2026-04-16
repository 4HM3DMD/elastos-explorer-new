import { Link } from 'react-router-dom';

const exploreLinks = [
  { to: '/blocks', label: 'Blocks' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/validators', label: 'Validators' },
  { to: '/ranking', label: 'Top Accounts' },
  { to: '/staking', label: 'Staking' },
];

const governanceLinks = [
  { to: '/governance', label: 'Elastos DAO Council' },
  { to: '/governance/proposals', label: 'Proposals' },
  { to: '/mempool', label: 'Mempool' },
];

const internalLinks = [
  { to: '/api-docs', label: 'API Documentation' },
];

const resources = [
  { href: 'https://elastos.net/', label: 'Elastos.net' },
  { href: 'https://elastos.dev/', label: 'Developer Docs' },
  { href: 'https://github.com/elastos/', label: 'GitHub' },
  { href: 'https://staking.elastos.net/', label: 'Staking Portal' },
  { href: 'https://download.elastos.io/app/elastos-essentials/', label: 'Essentials Wallet' },
];

const Footer = () => {
  return (
    <footer className="mt-auto border-t border-[rgba(255,255,255,0.06)]" style={{ background: '#0f0f0f' }}>
      <div className="max-w-container mx-auto px-4 lg:px-6 py-10">
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="col-span-2 sm:col-span-2 lg:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <img src="/logo.svg" alt="Elastos" className="h-5 w-auto" />
              <span className="font-semibold text-sm text-gradient-brand">Explorer</span>
            </div>
            <p className="text-xs text-secondary leading-relaxed max-w-xs">
              Real-time blockchain explorer for the Elastos network. Bitcoin-secured Web3 infrastructure.
            </p>
          </div>

          {/* Explore */}
          <nav aria-label="Explore">
            <h3 className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-3">Explore</h3>
            <ul className="space-y-2">
              {exploreLinks.map(({ to, label }) => (
                <li key={to}>
                  <Link to={to} className="text-xs text-secondary hover:text-primary transition-colors">{label}</Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* Network */}
          <nav aria-label="Network">
            <h3 className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-3">Network</h3>
            <ul className="space-y-2">
              {governanceLinks.map(({ to, label }) => (
                <li key={to}>
                  <Link to={to} className="text-xs text-secondary hover:text-primary transition-colors">{label}</Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* Resources */}
          <nav aria-label="Resources">
            <h3 className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-3">Resources</h3>
            <ul className="space-y-2">
              {internalLinks.map(({ to, label }) => (
                <li key={to}>
                  <Link to={to} className="text-xs text-secondary hover:text-primary transition-colors">{label}</Link>
                </li>
              ))}
              {resources.map(({ href, label }) => (
                <li key={href}>
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-xs text-secondary hover:text-primary transition-colors">{label}</a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="mt-8 pt-6 border-t border-[var(--color-border)] flex flex-col sm:flex-row justify-between items-center gap-3">
          <p className="text-[11px] text-muted">
            Built by <a href="https://elacitylabs.com/" target="_blank" rel="noopener noreferrer" className="text-secondary hover:text-primary transition-colors">ElacityLabs</a> &middot; Powered by Elastos
          </p>
          <p className="text-[11px] text-muted">
            Secured by Bitcoin &middot; &copy; {new Date().getFullYear()}
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
