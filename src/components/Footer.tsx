import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';

const exploreLinks = [
  { to: '/blocks', label: 'Blocks' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/validators', label: 'Validators' },
  { to: '/ranking', label: 'Top Accounts' },
  { to: '/staking', label: 'Staking' },
];

const governanceLinks = [
  { to: '/governance', label: 'Elastos DAO' },
  { to: '/governance/proposals', label: 'Proposals' },
  { to: '/mempool', label: 'Mempool' },
];

const resourceLinks = [
  { to: '/api-docs', label: 'API Documentation', internal: true },
  { href: 'https://elastos.dev/', label: 'Developer Docs', internal: false },
  { href: 'https://staking.elastos.net/', label: 'Staking Portal', internal: false },
  { href: 'https://download.elastos.io/app/elastos-essentials/', label: 'Essentials Wallet', internal: false },
];

const socialLinks = [
  {
    href: 'https://x.com/ElastosInfo',
    label: 'X (Twitter)',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.91-5.622Zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
  },
  {
    href: 'https://t.me/elastosgroup',
    label: 'Telegram',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
        <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.96 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
      </svg>
    ),
  },
  {
    href: 'https://github.com/elastos',
    label: 'GitHub',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
      </svg>
    ),
  },
  {
    href: 'https://elastos.net/',
    label: 'Elastos.net',
    icon: <img src="/logo.svg" alt="" className="w-[14px] h-[14px] opacity-90" />,
  },
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
              <span className="font-semibold text-sm text-white">Explorer</span>
            </div>
            <p className="text-xs text-secondary leading-relaxed max-w-xs mb-5">
              Real-time blockchain explorer for the Elastos network. Bitcoin-secured Web3 infrastructure.
            </p>
            {/* Social icons */}
            <div className="flex items-center gap-2">
              {socialLinks.map(({ href, label, icon }) => (
                <a
                  key={href}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/[0.06] border border-white/[0.08] text-secondary hover:text-white hover:bg-white/[0.12] hover:border-white/[0.16] transition-all duration-150"
                >
                  {icon}
                </a>
              ))}
            </div>
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
              {resourceLinks.map(({ label, internal, ...rest }) =>
                internal ? (
                  <li key={label}>
                    <Link to={(rest as { to: string }).to} className="text-xs text-secondary hover:text-primary transition-colors">{label}</Link>
                  </li>
                ) : (
                  <li key={label}>
                    <a
                      href={(rest as { href: string }).href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-secondary hover:text-primary transition-colors group"
                    >
                      {label}
                      <ArrowUpRight size={11} className="text-muted group-hover:text-primary transition-colors" />
                    </a>
                  </li>
                )
              )}
            </ul>
          </nav>
        </div>

        <div className="mt-8 pt-6 border-t border-[var(--color-border)] flex flex-col sm:flex-row justify-between items-center gap-3">
          <p className="text-[11px] text-muted">
            Built by <a href="https://elacitylabs.com/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-secondary hover:text-primary transition-colors">ElacityLabs<ArrowUpRight size={10} /></a> &middot; Powered by Elastos
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
