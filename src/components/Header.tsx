import { Link, useLocation } from 'react-router-dom';
import { useState, useCallback } from 'react';
import { Menu, X, ChevronDown } from 'lucide-react';
import NavDropdown from './NavDropdown';
import InlineSearch from './InlineSearch';
import { cn } from '../lib/cn';

const NAV_GROUPS: { label: string; items: { path: string; label: string; description: string }[] }[] = [
  {
    label: 'Blockchain',
    items: [
      { path: '/blocks', label: 'Blocks', description: 'Browse all blocks' },
      { path: '/transactions', label: 'Transactions', description: 'View all transactions' },
      { path: '/mempool', label: 'Mempool', description: 'Pending transactions' },
    ],
  },
  {
    label: 'Staking',
    items: [
      { path: '/staking', label: 'Overview', description: 'Staking statistics' },
      { path: '/validators', label: 'Validators', description: 'Block producers' },
    ],
  },
  {
    label: 'Governance',
    items: [
      { path: '/governance', label: 'Council', description: 'Live council members + election history' },
      { path: '/governance/proposals', label: 'Proposals', description: 'Community proposals & council reviews' },
    ],
  },
  {
    label: 'More',
    items: [
      { path: '/ranking', label: 'Top Accounts', description: 'Top balances' },
      { path: '/api-docs', label: 'API Docs', description: 'REST API reference' },
    ],
  },
];

const Header = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [openMobileGroup, setOpenMobileGroup] = useState<string | null>(null);
  const location = useLocation();

  const isActive = useCallback((path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  }, [location.pathname]);

  return (
    <header className="sticky top-0 z-50 border-b border-[rgba(255,255,255,0.06)]" style={{ background: 'var(--color-surface)' }}>
      <div className="max-w-container mx-auto px-4 lg:px-6">
        {/* Main bar: logo + nav + search */}
        <div className="flex items-center justify-between h-14 gap-4">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2 shrink-0 group">
            <img src="/logo.svg" alt="Elastos" className="h-6 w-auto" />
            <span className="font-semibold text-sm text-white">Explorer</span>
          </Link>

          {/* Desktop nav — centered on home (no search bar), left-aligned otherwise */}
          <nav className={cn(
            'hidden lg:flex items-center gap-0.5',
            location.pathname === '/' ? 'flex-1 justify-center' : 'shrink-0'
          )}>
            <Link
              to="/"
              className={cn(
                'relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors duration-150',
                location.pathname === '/'
                  ? 'text-primary after:absolute after:bottom-[-15px] after:left-1/2 after:-translate-x-1/2 after:w-4 after:h-[2px] after:bg-brand after:rounded-full'
                  : 'text-secondary hover:text-primary'
              )}
            >
              Home
            </Link>
            {NAV_GROUPS.map(group => (
              <NavDropdown key={group.label} label={group.label} items={group.items} />
            ))}
          </nav>

          {/* Desktop inline search (hidden on home — hero search used instead) */}
          {location.pathname !== '/' && (
            <div className="hidden lg:block flex-1 max-w-md ml-4">
              <InlineSearch compact />
            </div>
          )}

          {/* Mobile hamburger only */}
          <div className="flex items-center gap-2 lg:hidden">
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="p-2 rounded-lg text-secondary hover:text-primary transition-colors"
              aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={isMenuOpen}
            >
              {isMenuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        {isMenuOpen && (
          <div
            className="lg:hidden py-3 border-t border-[var(--color-border)] space-y-1 animate-slide-down"
            onKeyDown={(e) => { if (e.key === 'Escape') setIsMenuOpen(false); }}
          >
            <Link
              to="/"
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-200',
                isActive('/')
                  ? 'text-brand bg-brand/5'
                  : 'text-secondary hover:text-primary hover:bg-hover'
              )}
              onClick={() => setIsMenuOpen(false)}
            >
              Home
            </Link>

            {NAV_GROUPS.map(group => (
              <div key={group.label}>
                <button
                  onClick={() => setOpenMobileGroup(openMobileGroup === group.label ? null : group.label)}
                  className="w-full flex items-center justify-between px-4 py-2.5 rounded-lg text-sm font-medium text-secondary hover:text-primary transition-colors"
                >
                  <span>{group.label}</span>
                  <ChevronDown size={14} className={cn('transition-transform duration-200', openMobileGroup === group.label && 'rotate-180')} />
                </button>
                {openMobileGroup === group.label && (
                  <div className="ml-4 space-y-0.5 animate-slide-down">
                    {group.items.map(item => (
                      <Link
                        key={item.path}
                        to={item.path}
                        className={cn(
                          'flex items-center px-4 py-2 rounded-lg text-sm transition-all duration-200',
                          isActive(item.path)
                            ? 'text-brand bg-brand/5'
                            : 'text-secondary hover:text-primary hover:bg-hover'
                        )}
                        onClick={() => setIsMenuOpen(false)}
                      >
                        {item.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </header>
  );
};

export default Header;
