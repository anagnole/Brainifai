import { Component, type ReactNode, useSyncExternalStore } from 'react';
import { IngestPage } from './components/IngestPage';
import { SourcesPage } from './components/SourcesPage';
import { EnginePage } from './components/EnginePage';

// Note: Dashboard and GraphExplorer used to render the legacy
// Person/Activity/Topic schema. Since the engine schema is now the source of
// truth, the Dashboard / Graph / Engine routes all render the engine view.
// Keeping the routes as separate nav items for now so the URL surface stays
// stable; we can split them again if EnginePage becomes too cluttered.

/* ── Hash-based router ── */

type Route = '/' | '/graph' | '/engine' | '/ingest' | '/sources';

function getHash(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  if (raw === '/graph' || raw === '/engine' || raw === '/ingest' || raw === '/sources') return raw;
  return '/';
}

function subscribeHash(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

function useRoute(): Route {
  return useSyncExternalStore(subscribeHash, getHash, getHash);
}

function navigate(route: Route) {
  window.location.hash = route;
}

/* ── Nav items ── */

const NAV_ITEMS: Array<{ route: Route; label: string }> = [
  { route: '/', label: 'Dashboard' },
  { route: '/graph', label: 'Graph' },
  { route: '/engine', label: 'Engine' },
  { route: '/ingest', label: 'Ingest' },
  { route: '/sources', label: 'Sources' },
];

/* ── Sidebar ── */

function Sidebar({ current }: { current: Route }) {
  return (
    <nav className="nav-sidebar">
      <div className="nav-brand">Brainifai</div>
      <ul className="nav-links">
        {NAV_ITEMS.map(({ route, label }) => (
          <li key={route}>
            <a
              href={`#${route}`}
              className={`nav-link ${current === route ? 'active' : ''}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(route);
              }}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ── Page renderer ── */

function PageContent({ route }: { route: Route }) {
  switch (route) {
    case '/ingest':
      return <IngestPage />;
    case '/sources':
      return <SourcesPage />;
    case '/':
    case '/graph':
    case '/engine':
    default:
      return <EnginePage />;
  }
}

/* ── Error boundary ── */

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[ErrorBoundary]', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#e4e4e7', fontFamily: 'monospace' }}>
          <h1>Something went wrong</h1>
          <pre style={{ color: '#ff6b6b', whiteSpace: 'pre-wrap' }}>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ── App ── */

export function App() {
  const route = useRoute();

  return (
    <ErrorBoundary>
      <div className="app-shell">
        <Sidebar current={route} />
        <main className={`app-main ${route === '/graph' || route === '/engine' ? 'app-main-graph' : ''}`}>
          <PageContent route={route} />
        </main>
      </div>
    </ErrorBoundary>
  );
}
