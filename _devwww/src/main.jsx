import React from 'react'
import { createRoot } from 'react-dom/client';

import LiveFeed from './livefeed';

const root = createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <h1>parksapi debug view</h1>
    <LiveFeed />
  </React.StrictMode>
);
