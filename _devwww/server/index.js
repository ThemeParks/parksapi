import {app, server} from './server.js';

import themeparks from '../../lib/index.js';
import DebugDestination from './debugDestination.js';

import './livefeed.js';

const destinations = Object.keys(themeparks.destinations);

app.get('/', (req, res) => {
  res.json({
    destinations,
  });
});

// setup endpoints for each destination
for (const destination of destinations) {
  const dest = new DebugDestination({
    destination: themeparks.destinations[destination],
  });
  console.log(`Setting up /${destination}/`);
  app.use(`/${destination}`, dest.getRouter());
}

const port = process.env.PORT || 3001;
server.listen(port, () => {
  console.log(`Debug api server listening on port ${port}`)
});
