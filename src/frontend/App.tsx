import React, { useEffect, useState } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { Sidebar } from './components/sidebar/Sidebar';
import { FormatWorkspace } from './components/workspace/FormatWorkspace';
import { TemplateLibraryPage } from './components/pages/TemplateLibraryPage';
import { HistoryPage } from './components/pages/HistoryPage';
import { SettingsPage } from './components/pages/SettingsPage';
import { useWorkspaceStore } from './store/useWorkspaceStore';

const validRoutes = new Set(['/', '/templates', '/history', '/settings']);

function normalizePathname(pathname: string): string {
  return validRoutes.has(pathname) ? pathname : '/';
}

const App: React.FC = () => {
  const [pathname, setPathname] = useState(normalizePathname(window.location.pathname));
  const resetTask = useWorkspaceStore((state) => state.resetTask);

  useEffect(() => {
    const handlePopState = () => setPathname(normalizePathname(window.location.pathname));
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigateTo = (nextPathname: string) => {
    const normalized = normalizePathname(nextPathname);
    if (window.location.pathname !== normalized) {
      window.history.pushState({}, '', normalized);
    }
    setPathname(normalized);
  };

  const renderPage = () => {
    if (pathname === '/templates') return <TemplateLibraryPage />;
    if (pathname === '/history') return <HistoryPage />;
    if (pathname === '/settings') return <SettingsPage />;
    return <FormatWorkspace />;
  };

  return (
    <AppLayout>
      <Sidebar currentPath={pathname} onNavigate={navigateTo} onCreateTask={resetTask} />
      {renderPage()}
    </AppLayout>
  );
};

export default App;
