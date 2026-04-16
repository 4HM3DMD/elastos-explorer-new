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
        <TopInfoBar />
        <Header />
        {!isHome && (
          <div className="lg:hidden sticky top-14 z-40 px-4 py-2 surface-bar">
            <InlineSearch compact />
          </div>
        )}
        <main className="flex-1 w-full max-w-container mx-auto">
          {children}
        </main>
        <Footer />
      </div>
    </SyncGuard>
  );
};

export default Layout;
