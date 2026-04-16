import { Link } from 'react-router-dom';
import { Home, Search } from 'lucide-react';
import SEO from '../components/SEO';

const NotFound = () => (
  <>
  <SEO title="Page Not Found" description="The page you're looking for doesn't exist." path="/404" noindex />
  <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center">
    <div className="text-7xl font-bold text-[var(--color-border-strong)] mb-3 select-none">404</div>
    <h1 className="text-2xl font-semibold text-primary mb-2">Page Not Found</h1>
    <p className="text-sm text-muted mb-8 max-w-md">
      The page you&apos;re looking for doesn&apos;t exist or may have been moved.
    </p>
    <div className="flex items-center gap-3">
      <Link to="/" className="btn-primary inline-flex items-center gap-2">
        <Home size={16} /> Go Home
      </Link>
      <Link
        to="/blocks"
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200 border border-brand/40 text-brand bg-[var(--color-surface-secondary)] hover:bg-brand/10 hover:border-brand/60 hover:text-brand"
      >
        <Search size={16} /> Browse Blocks
      </Link>
    </div>
  </div>
  </>
);

export default NotFound;
