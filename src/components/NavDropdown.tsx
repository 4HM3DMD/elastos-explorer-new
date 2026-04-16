import { useState, useRef, useEffect, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/cn';

interface NavItem {
  path: string;
  label: string;
  description?: string;
}

interface NavDropdownProps {
  label: string;
  items: NavItem[];
}

const NavDropdown = ({ label, items }: NavDropdownProps) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const timeoutRef = useRef<number | null>(null);

  const isGroupActive = items.some(item =>
    item.path === '/' ? location.pathname === '/' : location.pathname.startsWith(item.path)
  );

  const handleClose = useCallback(() => setOpen(false), []);

  const handleMouseEnter = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOpen(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    timeoutRef.current = window.setTimeout(() => setOpen(false), 150);
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') handleClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, handleClose]);

  useEffect(() => {
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all duration-200',
          isGroupActive
            ? 'text-brand'
            : 'text-secondary hover:text-primary'
        )}
      >
        {label}
        <ChevronDown size={12} className={cn('transition-transform duration-200', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-1 w-52 rounded-xl border border-[var(--color-border)] shadow-md z-50 py-1.5 animate-fade-in"
          style={{ background: 'var(--color-surface-secondary)' }}
        >
          {items.map(({ path, label: itemLabel, description }) => {
            const active = path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);
            return (
              <Link
                key={path}
                to={path}
                onClick={handleClose}
                className={cn(
                  'flex flex-col px-3.5 py-2 mx-1.5 rounded-lg transition-all duration-150',
                  active
                    ? 'bg-brand/10 text-brand'
                    : 'text-secondary hover:text-primary hover:bg-hover'
                )}
              >
                <span className="text-xs font-medium">{itemLabel}</span>
                {description && <span className="text-[10px] text-muted mt-0.5">{description}</span>}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default NavDropdown;
