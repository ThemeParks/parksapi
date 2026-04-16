/**
 * Migration review server.
 *
 * Serves the review UI and provides API endpoints for viewing/editing
 * mappings and committing ID changes to the ThemeParks.wiki API.
 */

import express from 'express';
import {readFileSync} from 'fs';
import {join} from 'path';
import type {Mapping, NewEntity} from './matcher.js';

interface ServerConfig {
  mappings: Mapping[];
  unmatchedNew: NewEntity[];
  allNewEntities: NewEntity[];
  parkName: string;
  wikiApiUrl: string;
  wikiUsername: string;
  wikiApiKey: string;
  wikiToken: string;
  port: number;
}

export function startMigrationServer(config: ServerConfig): void {
  const app = express();
  app.use(express.json());

  // State
  let mappings = config.mappings;
  let commitInProgress = false;
  let commitResults: Array<{wikiId: string; oldId: string; newId: string; success: boolean; error?: string}> = [];
  let commitListeners: Array<(event: string, data: any) => void> = [];

  // ── Static UI ────────────────────────────────────────────────

  app.get('/', (_req, res) => {
    const htmlPath = join(import.meta.dirname, 'ui', 'index.html');
    const html = readFileSync(htmlPath, 'utf-8');
    res.type('html').send(html);
  });

  // ── API: Mappings ────────────────────────────────────────────

  const isNoop = (m: Mapping) =>
    m.newExternalId != null && m.oldExternalId === m.newExternalId;

  app.get('/api/mappings', (_req, res) => {
    const enriched = mappings.map(m => ({...m, noop: isNoop(m)}));
    res.json({
      parkName: config.parkName,
      mappings: enriched,
      unmatchedNew: config.unmatchedNew,
      allNewEntities: config.allNewEntities,
      summary: {
        exact: mappings.filter(m => m.confidence === 'exact').length,
        fuzzy: mappings.filter(m => m.confidence === 'fuzzy').length,
        unmatched: mappings.filter(m => m.confidence === 'unmatched').length,
        noop: mappings.filter(isNoop).length,
        confirmed: mappings.filter(m => m.status === 'confirmed' && m.newExternalId && !isNoop(m)).length,
        skipped: mappings.filter(m => m.status === 'skip').length,
      },
    });
  });

  app.post('/api/mappings/:index', (req, res) => {
    const idx = parseInt(req.params.index, 10);
    if (isNaN(idx) || idx < 0 || idx >= mappings.length) {
      return res.status(400).json({error: 'Invalid index'});
    }

    const {action, newExternalId, newName} = req.body;

    if (action === 'skip') {
      mappings[idx].status = 'skip';
    } else if (action === 'confirm') {
      mappings[idx].status = 'confirmed';
    } else if (action === 'pair' && newExternalId) {
      // If another mapping already claims this newExternalId, unpair it
      mappings.forEach((other, otherIdx) => {
        if (otherIdx !== idx && other.newExternalId === newExternalId && other.status === 'confirmed') {
          other.newExternalId = null;
          other.newName = null;
          other.confidence = 'unmatched';
          other.confidenceScore = 0;
          other.status = 'skip';
        }
      });
      mappings[idx].newExternalId = newExternalId;
      mappings[idx].newName = newName || newExternalId;
      mappings[idx].confidence = 'fuzzy';
      mappings[idx].confidenceScore = 0; // manual
      mappings[idx].status = 'confirmed';
    } else if (action === 'unpair') {
      mappings[idx].newExternalId = null;
      mappings[idx].newName = null;
      mappings[idx].confidence = 'unmatched';
      mappings[idx].confidenceScore = 0;
      mappings[idx].status = 'skip';
    }

    res.json({ok: true, mapping: mappings[idx]});
  });

  // ── API: Commit ──────────────────────────────────────────────

  app.post('/api/commit', async (_req, res) => {
    if (commitInProgress) {
      return res.status(409).json({error: 'Commit already in progress'});
    }
    if (!config.wikiApiUrl || (!config.wikiToken && (!config.wikiUsername || !config.wikiApiKey))) {
      return res.status(400).json({error: 'WIKI_API_URL and either WIKI_TOKEN or WIKI_USERNAME+WIKI_API_KEY must be configured in .env'});
    }

    const toCommit = mappings.filter(
      m => m.status === 'confirmed' && m.newExternalId && !isNoop(m),
    );
    if (toCommit.length === 0) {
      return res.status(400).json({error: 'No confirmed mappings to commit (IDs already match are skipped)'});
    }

    commitInProgress = true;
    commitResults = [];
    res.json({ok: true, count: toCommit.length});

    // Run commit in background
    try {
      // Authenticate
      broadcast('status', {message: 'Authenticating...', progress: 0, total: toCommit.length});

      let token = config.wikiToken;
      if (!token) {
        const authResp = await fetch(`${config.wikiApiUrl}/auth/login`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({username: config.wikiUsername, apiKey: config.wikiApiKey}),
        });

        if (!authResp.ok) {
          const err = await authResp.text();
          broadcast('error', {message: `Authentication failed: ${authResp.status} ${err}`});
          commitInProgress = false;
          return;
        }

        token = (await authResp.json() as {token: string}).token;
      }
      broadcast('status', {message: 'Authenticated', progress: 0, total: toCommit.length});

      // Commit each mapping
      for (let i = 0; i < toCommit.length; i++) {
        const mapping = toCommit[i];

        try {
          const putResp = await fetch(`${config.wikiApiUrl}/v1/entity/${mapping.wikiId}/_id`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({_id: mapping.newExternalId}),
          });

          if (putResp.ok) {
            commitResults.push({
              wikiId: mapping.wikiId,
              oldId: mapping.oldExternalId,
              newId: mapping.newExternalId!,
              success: true,
            });
            broadcast('progress', {
              index: i + 1,
              total: toCommit.length,
              name: mapping.oldName,
              oldId: mapping.oldExternalId,
              newId: mapping.newExternalId,
              success: true,
            });
          } else {
            const errText = await putResp.text();
            commitResults.push({
              wikiId: mapping.wikiId,
              oldId: mapping.oldExternalId,
              newId: mapping.newExternalId!,
              success: false,
              error: `${putResp.status}: ${errText}`,
            });
            broadcast('progress', {
              index: i + 1,
              total: toCommit.length,
              name: mapping.oldName,
              oldId: mapping.oldExternalId,
              newId: mapping.newExternalId,
              success: false,
              error: `${putResp.status}: ${errText}`,
            });
          }
        } catch (err: any) {
          commitResults.push({
            wikiId: mapping.wikiId,
            oldId: mapping.oldExternalId,
            newId: mapping.newExternalId!,
            success: false,
            error: err.message,
          });
          broadcast('progress', {
            index: i + 1,
            total: toCommit.length,
            name: mapping.oldName,
            success: false,
            error: err.message,
          });
        }
      }

      const succeeded = commitResults.filter(r => r.success).length;
      const failed = commitResults.filter(r => !r.success).length;
      broadcast('complete', {succeeded, failed, results: commitResults});
    } catch (err: any) {
      broadcast('error', {message: err.message});
    } finally {
      commitInProgress = false;
    }
  });

  // ── SSE: Commit progress ─────────────────────────────────────

  app.get('/api/commit/status', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const listener = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    commitListeners.push(listener);

    req.on('close', () => {
      commitListeners = commitListeners.filter(l => l !== listener);
    });
  });

  function broadcast(event: string, data: any) {
    for (const listener of commitListeners) {
      listener(event, data);
    }
  }

  // ── Start ────────────────────────────────────────────────────

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`\nMigration review server running at http://localhost:${config.port}`);
    console.log(`Park: ${config.parkName}`);
    console.log(`Mappings: ${mappings.length} (${mappings.filter(m => m.confidence === 'exact').length} exact, ${mappings.filter(m => m.confidence === 'fuzzy').length} fuzzy, ${mappings.filter(m => m.confidence === 'unmatched').length} unmatched)`);
    console.log(`\nOpen http://localhost:${config.port} in your browser to review.\n`);
  });
}
