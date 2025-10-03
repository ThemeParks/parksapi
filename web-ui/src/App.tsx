import React from 'react';
import {Routes, Route, useNavigate, useParams} from 'react-router-dom';
import DestinationList from './components/DestinationList';
import DestinationViewer from './components/DestinationViewer';
import TraceDrawer from './components/TraceDrawer';
import {TraceProvider, useTrace} from './contexts/TraceContext';
import './App.css';

function HomePage() {
  const navigate = useNavigate();

  return (
    <DestinationList onSelect={(dest) => navigate(`/destination/${dest.id}`)} />
  );
}

function DestinationPage() {
  const {destinationId} = useParams<{destinationId: string}>();
  const navigate = useNavigate();

  if (!destinationId) {
    return <div className="error">No destination ID provided</div>;
  }

  return (
    <DestinationViewer
      destinationId={destinationId}
      onBack={() => navigate('/')}
    />
  );
}

function AppContent() {
  const { currentTraceId } = useTrace();

  return (
    <div className="app">
      <header className="app-header">
        <h1>🎢 ParksAPI Web Admin</h1>
        <p>Test and explore theme park data APIs</p>
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/destination/:destinationId/*" element={<DestinationPage />} />
        </Routes>
      </main>

      <footer className="app-footer">
        <p>ParksAPI v2.0.0 - TypeScript Edition</p>
      </footer>

      <TraceDrawer currentTraceId={currentTraceId || undefined} />
    </div>
  );
}

export default function App() {
  return (
    <TraceProvider>
      <AppContent />
    </TraceProvider>
  );
}
