import http from 'http';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import AdmZip from 'adm-zip';
import config from './config.js';
import parksapi from '../lib/index.js';
const { ChessingtonWorldOfAdventures } = parksapi.destinations;

const __dirname = dirname(fileURLToPath(import.meta.url));

const park = new ChessingtonWorldOfAdventures({
  apiKey: config.apiKey,
  baseURL: config.baseURL,
  calendarURL: config.calendarURL,
  deviceIdentifier: config.deviceIdentifier,
});

// If a local ZIP is present, use it instead of downloading from S3.
// Place the file at chessington-queue/chessington.zip.
// Once successfully parsed the result is cached for 2 years, so this
// only runs once per cache lifetime.
const localZipPath = join(__dirname, 'chessington.zip');
if (existsSync(localZipPath)) {
  park.downloadAssetPack = async (_url) => {
    console.log(`[Local ZIP] Reading ${localZipPath}`);
    const buffer = await readFile(localZipPath);
    const zip = new AdmZip(buffer);

    const manifestEntry = zip.getEntry('manifest.json');
    const recordsEntry = zip.getEntry('records.json');

    if (!manifestEntry) throw new Error('No manifest.json found in local zip');
    if (!recordsEntry) throw new Error('No records.json found in local zip');

    return {
      manifestData: JSON.parse(zip.readAsText(manifestEntry)),
      recordsData: JSON.parse(zip.readAsText(recordsEntry)),
    };
  };
  console.log(`[Local ZIP] Found chessington.zip — will use instead of downloading from S3`);
}

async function getQueueData() {
  const [attractions, liveData] = await Promise.all([
    park.getAttractionEntities(),
    park.buildEntityLiveData(),
  ]);

  const nameById = Object.fromEntries(attractions.map((a) => [a._id, a.name]));

  return liveData
    .filter((entry) => nameById[entry._id])
    .map((entry) => ({
      id: entry._id,
      name: nameById[entry._id],
      status: entry.status,
      waitTime: entry.queue?.STANDBY?.waitTime ?? null,
    }))
    .sort((a, b) => {
      // Operating first, then by wait time descending, then alphabetically
      if (a.status === 'OPERATING' && b.status !== 'OPERATING') return -1;
      if (a.status !== 'OPERATING' && b.status === 'OPERATING') return 1;
      if (a.waitTime !== null && b.waitTime !== null) return b.waitTime - a.waitTime;
      if (a.waitTime !== null) return -1;
      if (b.waitTime !== null) return 1;
      return a.name.localeCompare(b.name);
    });
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chessington Queue Times</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f1f14;
      color: #e8f5e9;
      min-height: 100vh;
    }

    header {
      background: linear-gradient(135deg, #1b5e20 0%, #2e7d32 60%, #388e3c 100%);
      padding: 24px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 3px solid #66bb6a;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    }

    .header-left h1 {
      font-size: 1.8rem;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: #fff;
    }

    .header-left p {
      font-size: 0.85rem;
      color: #a5d6a7;
      margin-top: 2px;
    }

    .header-right {
      text-align: right;
    }

    .last-updated {
      font-size: 0.8rem;
      color: #a5d6a7;
    }

    .refresh-countdown {
      font-size: 0.75rem;
      color: #81c784;
      margin-top: 4px;
    }

    .refresh-btn {
      margin-top: 8px;
      padding: 6px 14px;
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.3);
      color: #fff;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.8rem;
      transition: background 0.2s;
    }

    .refresh-btn:hover { background: rgba(255,255,255,0.25); }
    .refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    main {
      max-width: 1400px;
      margin: 0 auto;
      padding: 28px 24px;
    }

    .section-label {
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #66bb6a;
      margin-bottom: 12px;
      padding-left: 4px;
    }

    .rides-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 14px;
      margin-bottom: 32px;
    }

    .ride-card {
      background: #1a2e1e;
      border-radius: 12px;
      padding: 18px;
      border: 2px solid transparent;
      transition: transform 0.15s, box-shadow 0.15s;
      position: relative;
      overflow: hidden;
    }

    .ride-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }

    .ride-card.wait-low    { border-color: #43a047; }
    .ride-card.wait-medium { border-color: #f9a825; }
    .ride-card.wait-high   { border-color: #ef6c00; }
    .ride-card.wait-very-high { border-color: #c62828; }
    .ride-card.closed      { border-color: #37474f; opacity: 0.65; }
    .ride-card.down        { border-color: #b71c1c; }
    .ride-card.refurb      { border-color: #4a148c; opacity: 0.65; }

    .ride-name {
      font-size: 0.95rem;
      font-weight: 600;
      color: #e8f5e9;
      line-height: 1.3;
      margin-bottom: 14px;
      min-height: 2.5em;
      display: flex;
      align-items: flex-start;
    }

    .wait-display {
      display: flex;
      align-items: baseline;
      gap: 4px;
    }

    .wait-number {
      font-size: 3rem;
      font-weight: 800;
      line-height: 1;
    }

    .wait-unit {
      font-size: 0.85rem;
      font-weight: 600;
      color: #a5d6a7;
      padding-bottom: 4px;
    }

    .wait-low    .wait-number { color: #69f0ae; }
    .wait-medium .wait-number { color: #ffee58; }
    .wait-high   .wait-number { color: #ffa726; }
    .wait-very-high .wait-number { color: #ef5350; }
    .closed .wait-number, .refurb .wait-number { color: #607d8b; }
    .down .wait-number { color: #ef5350; }

    .status-badge {
      display: inline-block;
      font-size: 0.65rem;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 4px;
      margin-top: 8px;
    }

    .badge-operating { background: #1b5e20; color: #69f0ae; }
    .badge-closed    { background: #263238; color: #90a4ae; }
    .badge-down      { background: #b71c1c; color: #ffcdd2; }
    .badge-refurbishment { background: #4a148c; color: #e1bee7; }

    .no-data-text {
      font-size: 1.1rem;
      font-weight: 600;
      color: #546e7a;
    }

    .error-box {
      background: #1a0000;
      border: 2px solid #c62828;
      border-radius: 10px;
      padding: 20px 24px;
      color: #ef9a9a;
      font-size: 0.9rem;
    }

    .error-box strong { color: #ef5350; display: block; margin-bottom: 8px; font-size: 1rem; }
    .error-box pre { margin-top: 10px; font-size: 0.75rem; opacity: 0.7; white-space: pre-wrap; }

    .loading {
      text-align: center;
      padding: 60px;
      color: #66bb6a;
      font-size: 1.1rem;
    }

    .spinner {
      display: inline-block;
      width: 28px;
      height: 28px;
      border: 3px solid #2e7d32;
      border-top-color: #69f0ae;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 14px;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .stats-bar {
      display: flex;
      gap: 20px;
      margin-bottom: 24px;
      font-size: 0.85rem;
      color: #81c784;
    }

    .stat { }
    .stat strong { color: #e8f5e9; }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <h1>Chessington World of Adventures</h1>
      <p>Live Queue Times</p>
    </div>
    <div class="header-right">
      <div class="last-updated" id="lastUpdated">—</div>
      <div class="refresh-countdown" id="countdown"></div>
      <button class="refresh-btn" id="refreshBtn" onclick="triggerRefresh()">Refresh Now</button>
    </div>
  </header>

  <main>
    <div id="content">
      <div class="loading">
        <div class="spinner"></div><br>
        Loading queue times&hellip;
      </div>
    </div>
  </main>

  <script>
    let countdownInterval = null;
    let secondsUntilRefresh = 60;

    function waitClass(ride) {
      if (ride.status === 'CLOSED') return 'closed';
      if (ride.status === 'DOWN') return 'down';
      if (ride.status === 'REFURBISHMENT') return 'refurb';
      if (ride.waitTime === null) return 'wait-low';
      if (ride.waitTime < 15) return 'wait-low';
      if (ride.waitTime < 30) return 'wait-medium';
      if (ride.waitTime < 45) return 'wait-high';
      return 'wait-very-high';
    }

    function badgeClass(status) {
      return {
        OPERATING: 'badge-operating',
        CLOSED: 'badge-closed',
        DOWN: 'badge-down',
        REFURBISHMENT: 'badge-refurbishment',
      }[status] || 'badge-closed';
    }

    function badgeLabel(status) {
      return {
        OPERATING: 'Open',
        CLOSED: 'Closed',
        DOWN: 'Down',
        REFURBISHMENT: 'Refurbishment',
      }[status] || status;
    }

    function waitDisplay(ride) {
      if (ride.status !== 'OPERATING') {
        return \`<span class="no-data-text">\${badgeLabel(ride.status)}</span>\`;
      }
      if (ride.waitTime === null) {
        return \`<span class="no-data-text">No data</span>\`;
      }
      if (ride.waitTime === 0) {
        return \`<div class="wait-display"><span class="wait-number">0</span><span class="wait-unit">mins</span></div>\`;
      }
      return \`<div class="wait-display"><span class="wait-number">\${ride.waitTime}</span><span class="wait-unit">min\${ride.waitTime !== 1 ? 's' : ''}</span></div>\`;
    }

    function renderRides(rides) {
      if (!rides.length) return '<p style="color:#607d8b">No ride data available.</p>';
      const open = rides.filter(r => r.status === 'OPERATING');
      const closed = rides.filter(r => r.status !== 'OPERATING');

      let html = '';

      if (open.length) {
        const avgWait = open.filter(r => r.waitTime !== null).map(r => r.waitTime);
        const avg = avgWait.length ? Math.round(avgWait.reduce((a,b) => a+b,0) / avgWait.length) : null;

        html += \`<div class="stats-bar">
          <div class="stat"><strong>\${open.length}</strong> rides open</div>
          \${avg !== null ? \`<div class="stat">avg wait <strong>\${avg} min</strong></div>\` : ''}
          <div class="stat"><strong>\${closed.length}</strong> rides closed</div>
        </div>\`;

        html += '<div class="section-label">Open Rides</div><div class="rides-grid">';
        for (const ride of open) {
          html += \`<div class="ride-card \${waitClass(ride)}">
            <div class="ride-name">\${escapeHtml(ride.name)}</div>
            \${waitDisplay(ride)}
            <span class="status-badge \${badgeClass(ride.status)}">\${badgeLabel(ride.status)}</span>
          </div>\`;
        }
        html += '</div>';
      }

      if (closed.length) {
        html += '<div class="section-label">Closed / Unavailable</div><div class="rides-grid">';
        for (const ride of closed) {
          html += \`<div class="ride-card \${waitClass(ride)}">
            <div class="ride-name">\${escapeHtml(ride.name)}</div>
            \${waitDisplay(ride)}
            <span class="status-badge \${badgeClass(ride.status)}">\${badgeLabel(ride.status)}</span>
          </div>\`;
        }
        html += '</div>';
      }

      return html;
    }

    function escapeHtml(str) {
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    async function fetchAndRender() {
      const btn = document.getElementById('refreshBtn');
      btn.disabled = true;

      try {
        const res = await fetch('/api/queue');
        const data = await res.json();

        if (data.error) {
          document.getElementById('content').innerHTML =
            \`<div class="error-box"><strong>Error fetching queue times</strong>\${escapeHtml(data.error)}<pre>\${escapeHtml(data.detail || '')}</pre></div>\`;
        } else {
          document.getElementById('content').innerHTML = renderRides(data.rides);
          document.getElementById('lastUpdated').textContent =
            'Updated ' + new Date(data.updatedAt).toLocaleTimeString();
        }
      } catch (err) {
        document.getElementById('content').innerHTML =
          \`<div class="error-box"><strong>Could not connect to server</strong>\${escapeHtml(err.message)}</div>\`;
      }

      btn.disabled = false;
      resetCountdown();
    }

    function resetCountdown() {
      secondsUntilRefresh = 60;
      clearInterval(countdownInterval);
      countdownInterval = setInterval(() => {
        secondsUntilRefresh--;
        document.getElementById('countdown').textContent =
          \`Auto-refresh in \${secondsUntilRefresh}s\`;
        if (secondsUntilRefresh <= 0) {
          clearInterval(countdownInterval);
          fetchAndRender();
        }
      }, 1000);
    }

    function triggerRefresh() {
      clearInterval(countdownInterval);
      fetchAndRender();
    }

    fetchAndRender();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/queue') {
    res.setHeader('Content-Type', 'application/json');
    try {
      const rides = await getQueueData();
      res.end(JSON.stringify({ rides, updatedAt: new Date().toISOString() }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message, detail: err.stack }));
    }
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
    return;
  }

  res.statusCode = 404;
  res.end('Not found');
});

server.listen(config.port, () => {
  console.log(`Chessington queue times running at http://localhost:${config.port}`);
});
