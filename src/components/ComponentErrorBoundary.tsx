import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * Inline error boundary for a single component (chart, markdown body,
 * tab pane). Falls back to a compact one-card error state instead of
 * blowing up the entire route via the App-level ErrorBoundary.
 *
 * Use to wrap high-risk components — anything that processes
 * untrusted data (markdown bodies), heavy third-party libraries
 * (recharts, react-pdf), or long lazy chains where one chunk failing
 * shouldn't take the whole page down.
 *
 * Pairs with `<Suspense>` for lazy-loaded children — wrap the
 * boundary OUTSIDE Suspense so chunk-load failures fall through here
 * instead of crashing the closest ancestor boundary.
 */
interface Props {
  children: ReactNode;
  /** Short label for the fallback card. e.g. "Chart unavailable". */
  label?: string;
  /** Optional custom fallback. Overrides the default card if provided. */
  fallback?: (reset: () => void, error: Error | null) => ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ComponentErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error(
        `[ComponentErrorBoundary${this.props.label ? ` · ${this.props.label}` : ''}]`,
        error,
        info.componentStack,
      );
    }
  }

  reset = () => this.setState({ hasError: false, error: null });

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) {
      return this.props.fallback(this.reset, this.state.error);
    }
    return (
      <div className="card p-5 text-center space-y-3">
        <div className="flex items-center justify-center gap-2 text-amber-400">
          <AlertTriangle size={16} />
          <p className="text-sm font-medium">{this.props.label || 'Section unavailable'}</p>
        </div>
        <p className="text-xs text-muted">
          Something went wrong rendering this section. The rest of the page is unaffected.
        </p>
        {import.meta.env.DEV && this.state.error?.message && (
          <p className="text-[10px] text-muted font-mono max-w-md mx-auto break-all">
            {this.state.error.message}
          </p>
        )}
        <button
          onClick={this.reset}
          className="inline-flex items-center gap-1.5 text-xs text-brand hover:text-brand-200 transition-colors"
        >
          <RefreshCw size={12} /> Try again
        </button>
      </div>
    );
  }
}

export default ComponentErrorBoundary;
