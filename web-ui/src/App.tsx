import React, {useState} from 'react';
import DestinationList from './components/DestinationList';
import DestinationViewer from './components/DestinationViewer';
import type {Destination} from './types';
import './App.css';

export default function App() {
  const [selectedDestination, setSelectedDestination] = useState<Destination | null>(null);

  return (
    <div className="app">
      <header className="app-header">
        <h1>🎢 ParksAPI Web Admin</h1>
        <p>Test and explore theme park data APIs</p>
      </header>

      <main className="app-main">
        {selectedDestination ? (
          <DestinationViewer
            destination={selectedDestination}
            onBack={() => setSelectedDestination(null)}
          />
        ) : (
          <DestinationList onSelect={setSelectedDestination} />
        )}
      </main>

      <footer className="app-footer">
        <p>ParksAPI v2.0.0 - TypeScript Edition</p>
      </footer>
    </div>
  );
}
