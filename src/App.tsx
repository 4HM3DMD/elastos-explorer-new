import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { lazy, Suspense, Component, useEffect, useState } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { HelmetProvider } from 'react-helmet-async';
import { Toaster } from 'sonner';
import Layout from './components/Layout.js';
import ScrollToTop from './components/ScrollToTop.js';
import DegradedBanner from './components/DegradedBanner.js';
import { ElectionStatusProvider } from './contexts/ElectionStatusContext.js';

// lazyWithReload — wrap React.lazy() so an atomic deploy doesn't strand
// open browser sessions. Vite emits asset filenames with a content hash
// (e.g. TransactionsList-5458b216.js); on rebuild those hashes change
// and the old files disappear from /assets. A session that loaded the
// previous manifest then tries to lazy-load a route, hits a 404 on the
// stale chunk, and React surfaces "Failed to fetch dynamically imported
// module" as a fatal page error.
//
// Standard fix: catch that specific failure and reload the page once,
// so the user picks up the fresh manifest. A session-storage marker
// prevents an infinite reload loop if the chunk is genuinely broken
// (not just stale) — the marker auto-expires after 30s so subsequent
// real deploys still recover automatically.
function lazyWithReload<T extends { default: React.ComponentType<unknown> }>(
  loader: () => Promise<T>,
): React.LazyExoticComponent<T['default']> {
  return lazy(() =>
    loader().catch((err) => {
      const isChunkLoadError =
        /Failed to fetch dynamically imported module|Loading chunk \d+ failed/i.test(String(err));
      if (!isChunkLoadError) throw err;

      const STALE_KEY = 'staleChunkReloadAt';
      const previousReloadAt = Number(sessionStorage.getItem(STALE_KEY) || 0);
      const now = Date.now();
      // 30s window: if we already reloaded in the last 30 seconds and
      // the chunk STILL failed, the chunk is genuinely broken — don't
      // loop. Throw and let the ErrorBoundary surface a real error.
      if (previousReloadAt && now - previousReloadAt < 30_000) throw err;

      sessionStorage.setItem(STALE_KEY, String(now));
      window.location.reload();
      // Return a never-resolving promise so React doesn't continue
      // rendering while the page is mid-reload.
      return new Promise<T>(() => {});
    }),
  );
}

const Home = lazyWithReload(() => import('./pages/Home.js'));
const BlocksList = lazyWithReload(() => import('./pages/BlocksList.js'));
const BlockDetails = lazyWithReload(() => import('./pages/BlockDetails.js'));
const TransactionsList = lazyWithReload(() => import('./pages/TransactionsList.js'));
const TransactionDetails = lazyWithReload(() => import('./pages/TransactionDetails.js'));
const AddressDetails = lazyWithReload(() => import('./pages/AddressDetails.js'));
const Validators = lazyWithReload(() => import('./pages/Validators.js'));
const ValidatorDetail = lazyWithReload(() => import('./pages/ValidatorDetail.js'));
const CRProposals = lazyWithReload(() => import('./pages/CRProposals.js'));
const ProposalDetail = lazyWithReload(() => import('./pages/ProposalDetail.js'));
const Elections = lazyWithReload(() => import('./pages/Elections.js'));
const ElectionsArchive = lazyWithReload(() => import('./pages/ElectionsArchive.js'));
const ElectionDetail = lazyWithReload(() => import('./pages/ElectionDetail.js'));
const ElectionVoters = lazyWithReload(() => import('./pages/ElectionVoters.js'));
const CandidateDetail = lazyWithReload(() => import('./pages/CandidateDetail.js'));
const DevElectionReplay = lazyWithReload(() => import('./pages/DevElectionReplay.js'));
const Charts = lazyWithReload(() => import('./pages/Charts.js'));
const Mempool = lazyWithReload(() => import('./pages/Mempool.js'));
const Ranking = lazyWithReload(() => import('./pages/Ranking.js'));
const Staking = lazyWithReload(() => import('./pages/Staking.js'));
const StakerDetail = lazyWithReload(() => import('./pages/StakerDetail.js'));
const NotFound = lazyWithReload(() => import('./pages/NotFound.js'));
const ApiDocs = lazyWithReload(() => import('./pages/ApiDocs.js'));

const TOAST_OPTIONS = {
  className: 'card',
  duration: 3000,
} as const;

// One-shot redirect from the old /voters/:cid URL shape (which used to
// serve a candidate-scoped voters table) to the canonical
// /candidate/:cid rich-profile page. `replace` keeps the old URL out
// of browser history so back-button doesn't bounce.
function LegacyCandidateRedirect() {
  const { term, cid } = useParams<{ term: string; cid: string }>();
  return <Navigate to={`/governance/candidate/${cid}?term=${term}`} replace />;
}

// Redirect from the old per-term-nested candidate URL to the new flat
// canonical URL. Term context is preserved as `?term=` so the page
// lands on the right multi-term pill. `replace` keeps the old URL
// out of browser history.
function LegacyTermCandidateRedirect() {
  const { term, cid } = useParams<{ term: string; cid: string }>();
  return <Navigate to={`/governance/candidate/${cid}?term=${term}`} replace />;
}

const PageLoader = () => (
  <div className="flex justify-center items-center h-64">
    <div className="animate-spin rounded-full h-10 w-10 border-2 border-[var(--color-border)] border-t-brand" />
  </div>
);

interface EBState { hasError: boolean; error: Error | null }
class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary]', error, info.componentStack);
    }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center">
          <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-accent-red" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-primary mb-2">Something went wrong</h2>
          <p className="text-secondary mb-1 text-sm max-w-md">
            An unexpected error occurred while rendering this page.
          </p>
          {import.meta.env.DEV && this.state.error?.message && (
            <p className="text-muted text-xs mb-6 font-mono max-w-lg break-all">
              {this.state.error.message}
            </p>
          )}
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="btn-primary"
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function AnimatedRoutes() {
  const location = useLocation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(false);
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, [location.pathname]);

  return (
    <div
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(4px)',
        transition: 'opacity 0.2s ease-out, transform 0.2s ease-out',
      }}
    >
      <Suspense fallback={<PageLoader />}>
        <Routes location={location}>
          <Route path="/" element={<Home />} />

          <Route path="/blocks" element={<BlocksList />} />
          <Route path="/block/:heightOrHash" element={<BlockDetails />} />

          <Route path="/transactions" element={<TransactionsList />} />
          <Route path="/tx/:txid" element={<TransactionDetails />} />

          <Route path="/address/:address" element={<AddressDetails />} />
          <Route path="/staking" element={<Staking />} />
          <Route path="/staking/:address" element={<StakerDetail />} />
          <Route path="/ranking" element={<Ranking />} />
          <Route path="/richlist" element={<Navigate to="/ranking" replace />} />

          <Route path="/validators" element={<Validators />} />
          <Route path="/validator/:ownerPubKey" element={<ValidatorDetail />} />

          <Route path="/governance" element={<Elections />} />
          <Route path="/governance/proposals" element={<CRProposals />} />
          <Route path="/governance/proposal/:hash" element={<ProposalDetail />} />
          {/* Standalone, bookmarkable election archive — replaces the
              earlier blanket redirect that pushed every /elections
              request back to /governance and made the archive
              non-shareable. */}
          <Route path="/governance/elections" element={<ElectionsArchive />} />
          <Route path="/governance/elections/:term" element={<ElectionDetail />} />
          <Route path="/governance/elections/:term/voters" element={<ElectionVoters />} />
          {/* Canonical flat candidate URL — candidates often span
              multiple terms (Sash served T2-T6); the old per-term URL
              tied them artificially to one term. New URL uses an
              optional ?term= query param to highlight a specific term
              in the multi-term pills. */}
          <Route path="/governance/candidate/:cid" element={<CandidateDetail />} />
          {/* Legacy URL — redirect to canonical, preserving the term
              context as a query param so the page lands on the right
              term. */}
          <Route
            path="/governance/elections/:term/candidate/:cid"
            element={<LegacyTermCandidateRedirect />}
          />
          {/* Earlier builds routed per-candidate detail under
              /voters/:cid; the rich /candidate/:cid page is now the
              canonical surface. Redirect old links so external
              references don't 404. */}
          <Route
            path="/governance/elections/:term/voters/:cid"
            element={<LegacyCandidateRedirect />}
          />
          <Route path="/dev/elections-replay" element={<DevElectionReplay />} />

          <Route path="/charts" element={<Charts />} />
          <Route path="/mempool" element={<Mempool />} />
          <Route path="/api-docs" element={<ApiDocs />} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </div>
  );
}

function App() {
  return (
    <HelmetProvider>
      <Router>
        <ElectionStatusProvider>
          <ScrollToTop />
          <DegradedBanner />
          <Layout>
            <ErrorBoundary>
              <AnimatedRoutes />
            </ErrorBoundary>
          </Layout>
          <Toaster
            position="bottom-right"
            theme="dark"
            toastOptions={TOAST_OPTIONS}
          />
        </ElectionStatusProvider>
      </Router>
    </HelmetProvider>
  );
}

export default App;
