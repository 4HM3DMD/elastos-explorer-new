import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import TopInfoBar from './TopInfoBar';
import Header from './Header';
import Footer from './Footer';
import InlineSearch from './InlineSearch';
import SyncGuard from './SyncGuard';

interface LayoutProps {
  children: ReactNode;
}

const Layout = ({ children }: LayoutProps) => {
  const location = useLocation();
  const isHome = location.pathname === '/';

  return (
    <SyncGuard>
      <div className="min-h-screen flex flex-col bg-base">
        {/* Skip link — visible only when keyboard-focused (sr-only +
            focus:not-sr-only). Lets screen-reader / Tab users jump
            past the TopInfoBar / Header / sticky-search chrome
            straight to the page body. Standard a11y pattern; no
            visual change for mouse users. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:px-3 focus:py-2 focus:rounded-md focus:bg-brand focus:text-white focus:font-medium"
        >
          Skip to main content
        </a>
        <TopInfoBar />
        <Header />
        {!isHome && (
          <div className="lg:hidden sticky top-14 z-40 px-4 py-2 surface-bar">
            <InlineSearch compact />
          </div>
        )}
        <main id="main-content" className="flex-1 w-full max-w-container mx-auto">
          {children}
        </main>
        <Footer />
      </div>
    </SyncGuard>
  );
};

export default Layout;
