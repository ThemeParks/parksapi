import React, { useState, useEffect } from 'react';
import type { CacheEntry, CacheStats } from '../types';
import './CacheBrowser.css';

export default function CacheBrowser() {
  const [entries, setEntries] = useState<CacheEntry[]>([]);
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedValue, setSelectedValue] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'expired'>('all');

  const fetchCacheEntries = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/cache');
      const data = await response.json();

      if (data.success) {
        setEntries(data.entries);
        setStats(data.stats);
      } else {
        setError(data.error || 'Failed to fetch cache entries');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const clearAllCache = async () => {
    if (!confirm('Are you sure you want to clear all cache entries?')) {
      return;
    }

    try {
      const response = await fetch('/api/cache', { method: 'DELETE' });
      const data = await response.json();

      if (data.success) {
        await fetchCacheEntries();
        setSelectedKey(null);
        setSelectedValue(null);
      } else {
        setError(data.error || 'Failed to clear cache');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const deleteEntry = async (key: string) => {
    try {
      const response = await fetch(`/api/cache/${encodeURIComponent(key)}`, { method: 'DELETE' });
      const data = await response.json();

      if (data.success) {
        await fetchCacheEntries();
        if (selectedKey === key) {
          setSelectedKey(null);
          setSelectedValue(null);
        }
      } else {
        setError(data.error || 'Failed to delete entry');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const cleanupExpired = async () => {
    try {
      const response = await fetch('/api/cache/cleanup', { method: 'POST' });
      const data = await response.json();

      if (data.success) {
        await fetchCacheEntries();
        alert(`Removed ${data.removed} expired cache entries`);
      } else {
        setError(data.error || 'Failed to cleanup cache');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const viewFullValue = async (key: string) => {
    try {
      const response = await fetch(`/api/cache/${encodeURIComponent(key)}`);
      const data = await response.json();

      if (data.success) {
        setSelectedKey(key);
        setSelectedValue(data.entry.value);
      } else {
        setError(data.error || 'Failed to fetch full value');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      console.log('Copied to clipboard');
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatTTL = (ttl: number): string => {
    if (ttl <= 0) return 'Expired';
    if (ttl < 60) return `${ttl}s`;
    if (ttl < 3600) return `${Math.floor(ttl / 60)}m`;
    if (ttl < 86400) return `${Math.floor(ttl / 3600)}h`;
    return `${Math.floor(ttl / 86400)}d`;
  };

  // Filter entries based on search query and status
  const filteredEntries = entries.filter(entry => {
    // Status filter
    if (statusFilter === 'active' && entry.isExpired) return false;
    if (statusFilter === 'expired' && !entry.isExpired) return false;

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const matchesKey = entry.key.toLowerCase().includes(query);
      const matchesValue = entry.valuePreview.toLowerCase().includes(query);
      return matchesKey || matchesValue;
    }

    return true;
  });

  useEffect(() => {
    fetchCacheEntries();
  }, []);

  return (
    <div className="cache-browser">
      <div className="cache-header">
        <div className="cache-title">
          <h2>🗄️ Cache Browser</h2>
          {stats && (
            <div className="cache-stats">
              <span className="stat-item">
                <strong>{stats.totalEntries}</strong> entries
              </span>
              <span className="stat-item">
                <strong>{formatBytes(stats.totalSize)}</strong> total
              </span>
              {stats.expiredCount > 0 && (
                <span className="stat-item expired">
                  <strong>{stats.expiredCount}</strong> expired
                </span>
              )}
            </div>
          )}
        </div>

        <div className="cache-actions">
          <button onClick={fetchCacheEntries} className="action-button refresh">
            🔄 Refresh
          </button>
          <button onClick={cleanupExpired} className="action-button cleanup">
            🧹 Cleanup Expired
          </button>
          <button onClick={clearAllCache} className="action-button clear-all">
            🗑️ Clear All
          </button>
        </div>
      </div>

      <div className="cache-filters">
        <div className="filter-group">
          <input
            type="text"
            placeholder="🔍 Search keys or values..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
        </div>
        <div className="filter-group">
          <label htmlFor="status-filter">Status:</label>
          <select
            id="status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'expired')}
            className="status-filter"
          >
            <option value="all">All ({entries.length})</option>
            <option value="active">Active ({entries.filter(e => !e.isExpired).length})</option>
            <option value="expired">Expired ({entries.filter(e => e.isExpired).length})</option>
          </select>
        </div>
        {(searchQuery || statusFilter !== 'all') && (
          <div className="filter-results">
            Showing {filteredEntries.length} of {entries.length} entries
          </div>
        )}
      </div>

      {error && (
        <div className="cache-error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {loading ? (
        <div className="cache-loading">Loading cache entries...</div>
      ) : (
        <div className="cache-content">
          <div className="cache-list">
            <table className="cache-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Preview</th>
                  <th>Size</th>
                  <th>TTL</th>
                  <th>Last Access</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredEntries.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="no-entries">
                      {entries.length === 0 ? 'No cache entries found' : 'No matching entries found'}
                    </td>
                  </tr>
                ) : (
                  filteredEntries.map((entry) => (
                    <tr
                      key={entry.key}
                      className={`${entry.isExpired ? 'expired' : ''} ${selectedKey === entry.key ? 'selected' : ''}`}
                    >
                      <td className="key-cell" title={entry.key}>
                        {entry.key}
                      </td>
                      <td className="preview-cell">{entry.valuePreview}</td>
                      <td className="size-cell">{formatBytes(entry.size)}</td>
                      <td className={`ttl-cell ${entry.isExpired ? 'expired' : ''}`}>
                        {formatTTL(entry.ttl)}
                      </td>
                      <td className="time-cell">{formatTime(entry.lastAccess)}</td>
                      <td className="actions-cell">
                        <button
                          onClick={() => viewFullValue(entry.key)}
                          className="view-button"
                          title="View full value"
                        >
                          👁️
                        </button>
                        <button
                          onClick={() => deleteEntry(entry.key)}
                          className="delete-button"
                          title="Delete entry"
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {selectedKey && selectedValue && (
            <div className="value-viewer">
              <div className="viewer-header">
                <h3>Full Value</h3>
                <div className="viewer-actions">
                  <button
                    onClick={() => copyToClipboard(typeof selectedValue === 'string' ? selectedValue : JSON.stringify(selectedValue, null, 2))}
                    className="copy-button"
                    title="Copy to clipboard"
                  >
                    📋 Copy
                  </button>
                  <button onClick={() => { setSelectedKey(null); setSelectedValue(null); }} className="close-button">
                    ✕
                  </button>
                </div>
              </div>
              <div className="viewer-key">
                <strong>Key:</strong> <code>{selectedKey}</code>
              </div>
              <pre className="viewer-content">
                {typeof selectedValue === 'string' ? selectedValue : JSON.stringify(selectedValue, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
