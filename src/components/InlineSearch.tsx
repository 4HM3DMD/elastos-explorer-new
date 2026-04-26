import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Loader2, XCircle, Blocks, ArrowLeftRight, Wallet, Shield, Landmark, Clock, X, CornerDownLeft } from 'lucide-react';
import { blockchainApi } from '../services/api';
import { detectInputType, getRouteForResult } from '../utils/searchRouting';
import type { SearchResult } from '../types/blockchain';
import { cn } from '../lib/cn';

const RECENT_KEY = 'ela-recent-searches';
const MAX_RECENT = 5;
const DEBOUNCE_MS = 400;

interface RecentSearch {
  query: string;
  type: string;
  value: string;
  timestamp: number;
}

function getRecent(): RecentSearch[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch { return []; }
}

function addRecent(item: Omit<RecentSearch, 'timestamp'>) {
  const recent = getRecent().filter(r => r.value !== item.value);
  recent.unshift({ ...item, timestamp: Date.now() });
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
}

function clearRecentSearches() {
  localStorage.removeItem(RECENT_KEY);
}

const TYPE_ICONS: Record<string, typeof Blocks> = {
  block: Blocks,
  transaction: ArrowLeftRight,
  address: Wallet,
  producer: Shield,
  crMember: Landmark,
};

interface InlineSearchProps {
  className?: string;
  compact?: boolean;
}

const InlineSearch = ({ className, compact }: InlineSearchProps) => {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [searching, setSearching] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);
  const [suggestion, setSuggestion] = useState<SearchResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const navigate = useNavigate();

  const showDropdown = focused && (query.length > 0 || recentSearches.length > 0 || notFound || suggestion);
  const hint = detectInputType(query);

  useEffect(() => {
    if (focused) {
      setRecentSearches(getRecent());
    }
  }, [focused]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape' && focused) {
        setFocused(false);
        inputRef.current?.blur();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focused]);

  useEffect(() => {
    if (!focused) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [focused]);

  useEffect(() => {
    const handler = () => inputRef.current?.focus();
    window.addEventListener('open-search', handler);
    return () => window.removeEventListener('open-search', handler);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q || q.length < 3) {
      setSuggestion(null);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();

    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      setSearching(true);
      setNotFound(false);
      try {
        const result = await blockchainApi.search(q);
        if (controller.signal.aborted) return;
        if (result.type && result.type !== 'none' && result.value != null) {
          setSuggestion(result);
          setNotFound(false);
        } else {
          setSuggestion(null);
          setNotFound(true);
        }
      } catch {
        if (!controller.signal.aborted) {
          setSuggestion(null);
        }
      } finally {
        if (!controller.signal.aborted) {
          setSearching(false);
        }
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [query]);

  const navigateToResult = useCallback((result: SearchResult, q: string) => {
    const route = getRouteForResult(result);
    if (route) {
      addRecent({ query: q, type: result.type, value: String(result.value) });
      setQuery('');
      setFocused(false);
      setNotFound(false);
      setSuggestion(null);
      navigate(route);
    }
  }, [navigate]);

  const handleSearch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;

    if (suggestion && suggestion.type !== 'none' && suggestion.value != null) {
      navigateToResult(suggestion, q);
      setSuggestion(null);
      return;
    }

    if (searching) return;
    setSearching(true);
    setNotFound(false);
    try {
      const result = await blockchainApi.search(q);
      if (result.type && result.type !== 'none' && result.value != null) {
        navigateToResult(result, q);
      } else {
        setNotFound(true);
      }
    } catch {
      setNotFound(true);
    } finally {
      setSearching(false);
    }
  }, [query, searching, navigateToResult, suggestion]);

  const handleRecentClick = useCallback((item: RecentSearch) => {
    const result: SearchResult = { type: item.type as SearchResult['type'], value: item.value };
    navigateToResult(result, item.query);
  }, [navigateToResult]);

  const handleClearRecent = useCallback(() => {
    clearRecentSearches();
    setRecentSearches([]);
  }, []);

  const handleClearInput = useCallback(() => {
    setQuery('');
    setNotFound(false);
    setSuggestion(null);
    inputRef.current?.focus();
  }, []);

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <form onSubmit={handleSearch} className="relative">
        <div className={cn(
          'flex items-center gap-2 border transition-all duration-200',
          focused
            ? 'bg-surface border-brand/40 ring-1 ring-brand/20'
            : 'bg-surface border-[rgba(255,255,255,0.1)] hover:border-[rgba(255,255,255,0.2)]',
          compact ? 'rounded-full px-3 py-2' : 'rounded-full px-4 py-3',
        )}>
          {searching ? (
            <Loader2 size={14} className="text-brand animate-spin shrink-0" />
          ) : notFound ? (
            <XCircle size={14} className="text-accent-red shrink-0" />
          ) : (
            <Search size={14} className="text-muted shrink-0" />
          )}

          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setNotFound(false); }}
            onFocus={() => setFocused(true)}
            placeholder={
              notFound
                ? 'No results — try another query'
                : compact
                  ? 'Search...'
                  : 'Search by block, tx, address, validator...'
            }
            className={cn(
              'flex-1 bg-transparent text-sm text-primary placeholder:text-muted outline-none min-w-0',
              notFound && 'placeholder:text-accent-red/60',
            )}
            disabled={searching}
          />

          {query && (
            <button type="button" onClick={handleClearInput} className="p-0.5 rounded text-muted hover:text-primary transition-colors shrink-0">
              <X size={12} />
            </button>
          )}

          {!compact && !focused && (
            <kbd className="hidden lg:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded bg-[var(--color-surface-tertiary)] text-muted border border-[var(--color-border)] shrink-0">
              {isMac ? <span className="text-[11px]">&#8984;</span> : <span className="text-[11px]">Ctrl</span>}K
            </kbd>
          )}
        </div>
      </form>

      {showDropdown && (
        <div
          className="absolute left-0 right-0 top-full mt-2 rounded-2xl border border-[rgba(255,255,255,0.1)] shadow-lg z-[60] overflow-hidden"
          style={{ background: 'var(--color-surface)' }}
        >
          {/* Type-ahead hint */}
          {query && hint && !suggestion && !notFound && !searching && (
            <div className="px-3 py-2 border-b border-[var(--color-border)]">
              <span className="text-[11px] text-muted">
                Looks like: <span className="text-secondary font-medium">{hint.label}</span>
              </span>
            </div>
          )}

          {/* Live suggestion from API */}
          {suggestion && suggestion.type !== 'none' && suggestion.value != null && (
            <div className="py-1">
              <button
                onClick={() => {
                  navigateToResult(suggestion, query);
                  setSuggestion(null);
                }}
                className="group flex items-center gap-2.5 w-full px-3 py-2 text-left hover:bg-hover transition-colors"
              >
                {(() => {
                  const Icon = TYPE_ICONS[suggestion.type] || Search;
                  return <Icon size={14} className="text-brand shrink-0" />;
                })()}
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium text-primary block truncate">
                    {suggestion.type === 'block' ? `Block #${Number(suggestion.value).toLocaleString()}`
                      : suggestion.type === 'crMember' ? (suggestion.label || String(suggestion.value))
                      : suggestion.type === 'producer' ? String(suggestion.value)
                      : String(suggestion.value)}
                  </span>
                  <span className="text-[10px] text-muted">
                    {suggestion.type === 'producer' ? 'Validator'
                      : suggestion.type === 'crMember' ? `Council member · Term ${suggestion.term}`
                      : suggestion.type.charAt(0).toUpperCase() + suggestion.type.slice(1)}
                  </span>
                </div>
                <CornerDownLeft size={12} className="text-muted shrink-0 group-hover:text-brand" />
              </button>
            </div>
          )}

          {/* Loading indicator for debounced search */}
          {searching && query.length >= 3 && !suggestion && (
            <div className="px-3 py-3 flex items-center justify-center gap-2">
              <Loader2 size={14} className="text-brand animate-spin" />
              <span className="text-xs text-muted">Searching...</span>
            </div>
          )}

          {/* Not found message */}
          {notFound && !searching && (
            <div className="px-3 py-4 text-center">
              <XCircle size={20} className="text-accent-red mx-auto mb-1.5" />
              <p className="text-xs text-muted">No matching block, transaction, address, validator, council member, or proposal found.</p>
            </div>
          )}

          {/* Recent searches */}
          {!query && recentSearches.length > 0 && (
            <div className="py-1">
              <div className="flex items-center justify-between px-3 py-1">
                <span className="text-[10px] font-semibold text-muted uppercase tracking-wider">Recent</span>
                <button
                  onClick={handleClearRecent}
                  className="text-[10px] text-muted hover:text-primary transition-colors"
                >
                  Clear
                </button>
              </div>
              {recentSearches.map((item) => {
                const Icon = TYPE_ICONS[item.type] || Search;
                return (
                  <button
                    key={item.value}
                    onClick={() => handleRecentClick(item)}
                    className="group flex items-center gap-2.5 w-full px-3 py-1.5 text-left hover:bg-hover transition-colors"
                  >
                    <Icon size={13} className="text-muted shrink-0 group-hover:text-primary" />
                    <span className="text-xs text-secondary truncate flex-1 group-hover:text-primary">{item.query}</span>
                    <Clock size={10} className="text-muted shrink-0" />
                  </button>
                );
              })}
            </div>
          )}

          {/* Empty state hints */}
          {!query && recentSearches.length === 0 && (
            <div className="px-3 py-4 text-center">
              <p className="text-xs text-muted">
                Search by block height, transaction hash, address, or validator name
              </p>
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center gap-3 px-3 py-1.5 border-t border-[var(--color-border)]" style={{ background: '#141414' }}>
            <span className="text-[10px] text-muted flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded text-[9px] bg-[var(--color-surface-tertiary)] border border-[var(--color-border)]">Enter</kbd>
              search
            </span>
            <span className="text-[10px] text-muted flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded text-[9px] bg-[var(--color-surface-tertiary)] border border-[var(--color-border)]">Esc</kbd>
              close
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default InlineSearch;
