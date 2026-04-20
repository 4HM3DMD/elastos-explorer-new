import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { lazy, Suspense, Component, useEffect, useState } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { HelmetProvider } from 'react-helmet-async';
import { Toaster } from 'sonner';
import Layout from './components/Layout.js';
import ScrollToTop from './components/ScrollToTop.js';
import DegradedBanner from './components/DegradedBanner.js';

const Home = lazy(() => import('./pages/Home.js'));
const BlocksList = lazy(() => import('./pages/BlocksList.js'));
const BlockDetails = lazy(() => import('./pages/BlockDetails.js'));
const TransactionsList = lazy(() => import('./pages/TransactionsList.js'));
const TransactionDetails = lazy(() => import('./pages/TransactionDetails.js'));
const AddressDetails = lazy(() => import('./pages/AddressDetails.js'));
const Validators = lazy(() => import('./pages/Validators.js'));
const ValidatorDetail = lazy(() => import('./pages/ValidatorDetail.js'));
const CRCouncil = lazy(() => import('./pages/CRCouncil.js'));
const CRProposals = lazy(() => import('./pages/CRProposals.js'));
const ProposalDetail = lazy(() => import('./pages/ProposalDetail.js'));
const Charts = lazy(() => import('./pages/Charts.js'));
const Mempool = lazy(() => import('./pages/Mempool.js'));
const Ranking = lazy(() => import('./pages/Ranking.js'));
const Staking = lazy(() => import('./pages/Staking.js'));
const StakerDetail = lazy(() => import('./pages/StakerDetail.js'));
const NotFound = lazy(() => import('./pages/NotFound.js'));
const ApiDocs = lazy(() => import('./pages/ApiDocs.js'));

const TOAST_OPTIONS = {
  className: 'card',
  duration: 3000,
} as const;

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

          <Route path="/governance" element={<CRCouncil />} />
          <Route path="/governance/proposals" element={<CRProposals />} />
          <Route path="/governance/proposal/:hash" element={<ProposalDetail />} />

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
      </Router>
    </HelmetProvider>
  );
}

export default App;
