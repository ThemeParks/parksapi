import React, { useState, useEffect, useRef } from 'react';
import type { HttpTraceEvent, TraceInfo } from '../types';
import './TraceDrawer.css';

type TraceSession = {
  traceId: string;
  destination: string;
  method: string;
  timestamp: number;
  status: 'active' | 'completed' | 'error';
  events: HttpTraceEvent[];
  traceInfo?: TraceInfo;
};

type GroupedRequest = {
  id: string;
  method: string;
  url: string;
  startEvent: HttpTraceEvent;
  completeEvent?: HttpTraceEvent;
  status: 'pending' | 'complete' | 'error' | 'cached';
};

type Props = {
  currentTraceId?: string;
  onClose?: () => void;
};

export default function TraceDrawer({ currentTraceId, onClose }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [sessions, setSessions] = useState<TraceSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [eventSources, setEventSources] = useState<Map<string, EventSource>>(new Map());
  const [drawerHeight, setDrawerHeight] = useState<number>(() => {
    const saved = localStorage.getItem('traceDrawerHeight');
    return saved ? parseInt(saved, 10) : 400;
  });
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const resizeStartY = useRef<number>(0);
  const resizeStartHeight = useRef<number>(0);

  // Load sessions from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('traceSessions');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setSessions(parsed);
      } catch (err) {
        console.error('Failed to load trace sessions:', err);
      }
    }
  }, []);

  // Save sessions to localStorage whenever they change
  useEffect(() => {
    if (sessions.length > 0) {
      try {
        // Keep only the last 10 sessions to avoid quota issues
        const sessionsToStore = sessions.slice(0, 10).map(session => ({
          ...session,
          // Truncate event bodies to reduce storage size
          events: session.events.map(event => ({
            ...event,
            body: event.body ?
              (typeof event.body === 'string' ? event.body.substring(0, 1000) : JSON.stringify(event.body).substring(0, 1000))
              : undefined
          }))
        }));
        localStorage.setItem('traceSessions', JSON.stringify(sessionsToStore));
      } catch (error) {
        console.error('Failed to save trace sessions (quota exceeded):', error);
        // Clear old sessions and try again with just the latest
        try {
          localStorage.setItem('traceSessions', JSON.stringify(sessions.slice(0, 1)));
        } catch {
          localStorage.removeItem('traceSessions');
        }
      }
    }
  }, [sessions]);

  // Handle new trace ID
  useEffect(() => {
    if (currentTraceId && !sessions.find(s => s.traceId === currentTraceId)) {
      // Open drawer and add new session
      setIsOpen(true);
      setIsMinimized(false);

      const newSession: TraceSession = {
        traceId: currentTraceId,
        destination: 'Unknown',
        method: 'Unknown',
        timestamp: Date.now(),
        status: 'active',
        events: [],
      };

      setSessions(prev => [newSession, ...prev]);
      setSelectedSessionId(currentTraceId);

      // Connect to SSE
      connectToTrace(currentTraceId);
    } else if (currentTraceId) {
      // Existing trace, just select it and open
      setIsOpen(true);
      setSelectedSessionId(currentTraceId);
    }
  }, [currentTraceId]);

  // Update CSS variable for drawer height
  useEffect(() => {
    if (isOpen && !isMinimized) {
      document.documentElement.style.setProperty('--trace-drawer-height', `${drawerHeight}px`);
    } else {
      document.documentElement.style.setProperty('--trace-drawer-height', '20px');
    }
  }, [isOpen, isMinimized, drawerHeight]);

  // Save drawer height to localStorage
  useEffect(() => {
    localStorage.setItem('traceDrawerHeight', String(drawerHeight));
  }, [drawerHeight]);

  // Handle resize events
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const deltaY = resizeStartY.current - e.clientY;
      const newHeight = Math.min(Math.max(200, resizeStartHeight.current + deltaY), window.innerHeight * 0.8);
      setDrawerHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartY.current = e.clientY;
    resizeStartHeight.current = drawerHeight;
  };

  const groupRequests = (events: HttpTraceEvent[]): GroupedRequest[] => {
    const grouped = new Map<string, GroupedRequest>();

    events.forEach(event => {
      // Create a unique key for matching requests (url + method + approximate time)
      const key = `${event.method}-${event.url}`;

      if (event.eventType === 'http.request.start') {
        grouped.set(key, {
          id: key,
          method: event.method,
          url: event.url,
          startEvent: event,
          status: 'pending',
        });
      } else if (event.eventType === 'http.request.complete') {
        const existing = grouped.get(key);
        if (existing) {
          existing.completeEvent = event;
          existing.status = event.cacheHit ? 'cached' : 'complete';
        } else {
          // Orphaned complete event (shouldn't happen, but handle it)
          grouped.set(key, {
            id: key,
            method: event.method,
            url: event.url,
            startEvent: event,
            completeEvent: event,
            status: event.cacheHit ? 'cached' : 'complete',
          });
        }
      } else if (event.eventType === 'http.request.error') {
        const existing = grouped.get(key);
        if (existing) {
          existing.completeEvent = event;
          existing.status = 'error';
        } else {
          grouped.set(key, {
            id: key,
            method: event.method,
            url: event.url,
            startEvent: event,
            completeEvent: event,
            status: 'error',
          });
        }
      }
    });

    return Array.from(grouped.values());
  };

  const connectToTrace = (traceId: string) => {
    if (eventSources.has(traceId)) return;

    const eventSource = new EventSource(`/api/trace/${traceId}/events`);

    eventSource.onmessage = (event) => {
      const message = JSON.parse(event.data);

      if (message.type === 'event') {
        setSessions(prev => prev.map(session => {
          if (session.traceId === traceId) {
            // Extract metadata from first event if available
            const evt = message.event as HttpTraceEvent;
            return {
              ...session,
              events: [...session.events, evt],
              destination: session.destination === 'Unknown' ? extractDestination(evt.url) : session.destination,
            };
          }
          return session;
        }));
      } else if (message.type === 'complete') {
        const trace = message.trace as TraceInfo;
        setSessions(prev => prev.map(session => {
          if (session.traceId === traceId) {
            return {
              ...session,
              status: 'completed' as const,
              traceInfo: trace,
              destination: trace.metadata?.destination || session.destination,
              method: trace.metadata?.method || session.method,
            };
          }
          return session;
        }));

        // Close event source
        eventSource.close();
        setEventSources(prev => {
          const next = new Map(prev);
          next.delete(traceId);
          return next;
        });
      }
    };

    eventSource.onerror = () => {
      setSessions(prev => prev.map(session =>
        session.traceId === traceId ? { ...session, status: 'error' as const } : session
      ));
      eventSource.close();
      setEventSources(prev => {
        const next = new Map(prev);
        next.delete(traceId);
        return next;
      });
    };

    setEventSources(prev => new Map(prev).set(traceId, eventSource));
  };

  const extractDestination = (url: string): string => {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      return hostname.split('.')[0] || 'Unknown';
    } catch {
      return 'Unknown';
    }
  };

  const selectedSession = sessions.find(s => s.traceId === selectedSessionId);
  const groupedRequests = selectedSession ? groupRequests(selectedSession.events) : [];
  const selectedRequest = groupedRequests.find(r => r.id === selectedRequestId);

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
  };

  const formatSessionTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const getRequestIcon = (request: GroupedRequest) => {
    switch (request.status) {
      case 'pending':
        return '🔄';
      case 'cached':
        return '💾';
      case 'complete':
        return '✅';
      case 'error':
        return '❌';
      default:
        return '📡';
    }
  };

  const getRequestClass = (request: GroupedRequest) => {
    switch (request.status) {
      case 'pending':
        return 'event-pending';
      case 'cached':
        return 'event-cached';
      case 'complete':
        return 'event-success';
      case 'error':
        return 'event-error';
      default:
        return '';
    }
  };

  const clearAllSessions = () => {
    if (confirm('Clear all trace sessions?')) {
      // Close all active connections
      eventSources.forEach(es => es.close());
      setEventSources(new Map());
      setSessions([]);
      setSelectedSessionId(null);
      localStorage.removeItem('traceSessions');
    }
  };

  const deleteSession = (traceId: string) => {
    // Close connection if active
    const es = eventSources.get(traceId);
    if (es) {
      es.close();
      setEventSources(prev => {
        const next = new Map(prev);
        next.delete(traceId);
        return next;
      });
    }

    setSessions(prev => prev.filter(s => s.traceId !== traceId));

    if (selectedSessionId === traceId) {
      setSelectedSessionId(sessions.length > 1 ? sessions[0].traceId : null);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      // Could add a toast notification here
      console.log(`${label} copied to clipboard`);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  if (!isOpen) {
    return (
      <button className="trace-drawer-toggle" onClick={() => setIsOpen(true)}>
        📊 Traces ({sessions.length})
      </button>
    );
  }

  return (
    <div
      ref={drawerRef}
      className={`trace-drawer ${isMinimized ? 'minimized' : ''}`}
      style={{ height: isMinimized ? '60px' : `${drawerHeight}px` }}
    >
      <div className="resize-handle" onMouseDown={startResize}>
        <div className="resize-handle-line" />
      </div>
      <div className="trace-drawer-header">
        <div className="trace-drawer-title">
          <span>📊 HTTP Traces</span>
          <span className="trace-count">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="trace-drawer-controls">
          {sessions.length > 0 && (
            <button onClick={clearAllSessions} className="clear-button" title="Clear all">
              🗑️
            </button>
          )}
          <button onClick={() => setIsMinimized(!isMinimized)} className="minimize-button">
            {isMinimized ? '▲' : '▼'}
          </button>
          <button onClick={() => setIsOpen(false)} className="close-button">
            ✕
          </button>
        </div>
      </div>

      {!isMinimized && (
        <>
          <div className="trace-sessions-list">
            {sessions.length === 0 ? (
              <div className="no-sessions">No trace sessions yet. Execute a method to start tracing.</div>
            ) : (
              sessions.map(session => (
                <div
                  key={session.traceId}
                  className={`trace-session-item ${selectedSessionId === session.traceId ? 'active' : ''}`}
                  onClick={() => setSelectedSessionId(session.traceId)}
                >
                  <div className="session-header">
                    <div className="session-info">
                      <span className={`session-status status-${session.status}`}>
                        {session.status === 'active' && '⚡'}
                        {session.status === 'completed' && '✓'}
                        {session.status === 'error' && '✗'}
                      </span>
                      <span className="session-method">{session.method}</span>
                      <span className="session-destination">{session.destination}</span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSession(session.traceId);
                      }}
                      className="delete-session"
                      title="Delete session"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="session-meta">
                    <span>{formatSessionTime(session.timestamp)}</span>
                    <span>{session.events.length} events</span>
                    {session.traceInfo && <span>{session.traceInfo.duration}ms</span>}
                  </div>
                </div>
              ))
            )}
          </div>

          {selectedSession && (
            <div className="trace-details">
              <div className="trace-details-header">
                <h4>{selectedSession.method} - {selectedSession.destination}</h4>
                <code className="trace-id">{selectedSession.traceId}</code>
              </div>

              {selectedSession.traceInfo && (
                <div className="trace-summary">
                  <span>Duration: {selectedSession.traceInfo.duration}ms</span>
                  <span>Requests: {selectedSession.events.length}</span>
                  <span>Status: {selectedSession.status}</span>
                </div>
              )}

              <div className="trace-events">
                {groupedRequests.length === 0 ? (
                  <div className="no-events">Waiting for events...</div>
                ) : (
                  <div className="events-container">
                    <div className="events-list">
                      {groupedRequests.map((request) => (
                        <div
                          key={request.id}
                          className={`trace-event ${getRequestClass(request)} ${selectedRequestId === request.id ? 'selected' : ''}`}
                          onClick={() => setSelectedRequestId(selectedRequestId === request.id ? null : request.id)}
                        >
                          <span className="event-icon">{getRequestIcon(request)}</span>
                          <div className="event-details">
                            <div className="event-main">
                              <span className="event-method">{request.method}</span>
                              <span className="event-url">{request.url}</span>
                              {request.completeEvent?.status && (
                                <span className="event-status">{request.completeEvent.status}</span>
                              )}
                              {request.status === 'pending' && (
                                <span className="event-status pending">PENDING</span>
                              )}
                            </div>
                            <div className="event-meta">
                              <span className="event-time">{formatTimestamp(request.startEvent.timestamp)}</span>
                              {request.completeEvent?.duration !== undefined && (
                                <span className="event-duration">{request.completeEvent.duration}ms</span>
                              )}
                              {request.status === 'cached' && <span className="event-badge">CACHED</span>}
                              {request.startEvent.retryCount && request.startEvent.retryCount > 0 && (
                                <span className="event-badge">RETRY {request.startEvent.retryCount}</span>
                              )}
                            </div>
                            {request.completeEvent?.error && (
                              <div className="event-error-msg">{request.completeEvent.error.message}</div>
                            )}
                            {request.completeEvent?.body && (
                              <div className="event-body-preview">
                                <span className="body-preview-label">Response:</span>
                                <code className="body-preview-text">
                                  {typeof request.completeEvent.body === 'string'
                                    ? request.completeEvent.body.substring(0, 100) + (request.completeEvent.body.length > 100 ? '...' : '')
                                    : JSON.stringify(request.completeEvent.body).substring(0, 100) + '...'}
                                </code>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {selectedRequest && (
                      <div className="request-details-panel">
                        <div className="details-header">
                          <h5>Request Details</h5>
                          <button onClick={() => setSelectedRequestId(null)} className="close-details">✕</button>
                        </div>

                        <div className="details-section">
                          <h6>Request</h6>
                          <div className="details-item">
                            <span className="details-label">Method:</span>
                            <span className="details-value">{selectedRequest.method}</span>
                          </div>
                          <div className="details-item">
                            <span className="details-label">URL:</span>
                            <span className="details-value url">{selectedRequest.url}</span>
                          </div>
                          <div className="details-item">
                            <span className="details-label">Started:</span>
                            <span className="details-value">{formatTimestamp(selectedRequest.startEvent.timestamp)}</span>
                          </div>
                          {selectedRequest.startEvent.headers && (
                            <div className="details-item">
                              <div className="details-label-with-action">
                                <span className="details-label">Headers:</span>
                                <button
                                  className="copy-button"
                                  onClick={() => copyToClipboard(JSON.stringify(selectedRequest.startEvent.headers, null, 2), 'Request headers')}
                                  title="Copy to clipboard"
                                >
                                  📋
                                </button>
                              </div>
                              <pre className="details-json">{JSON.stringify(selectedRequest.startEvent.headers, null, 2)}</pre>
                            </div>
                          )}
                        </div>

                        {selectedRequest.completeEvent && (
                          <div className="details-section">
                            <h6>Response</h6>
                            <div className="details-item">
                              <span className="details-label">Status:</span>
                              <span className="details-value">{selectedRequest.completeEvent.status || 'N/A'}</span>
                            </div>
                            <div className="details-item">
                              <span className="details-label">Duration:</span>
                              <span className="details-value">{selectedRequest.completeEvent.duration}ms</span>
                            </div>
                            {selectedRequest.completeEvent.headers && (
                              <div className="details-item">
                                <div className="details-label-with-action">
                                  <span className="details-label">Headers:</span>
                                  <button
                                    className="copy-button"
                                    onClick={() => copyToClipboard(JSON.stringify(selectedRequest.completeEvent!.headers, null, 2), 'Response headers')}
                                    title="Copy to clipboard"
                                  >
                                    📋
                                  </button>
                                </div>
                                <pre className="details-json">{JSON.stringify(selectedRequest.completeEvent.headers, null, 2)}</pre>
                              </div>
                            )}
                            {selectedRequest.completeEvent.body && (
                              <div className="details-item">
                                <div className="details-label-with-action">
                                  <span className="details-label">Body:</span>
                                  <button
                                    className="copy-button"
                                    onClick={() => {
                                      const bodyText = typeof selectedRequest.completeEvent!.body === 'string'
                                        ? selectedRequest.completeEvent!.body
                                        : JSON.stringify(selectedRequest.completeEvent!.body, null, 2);
                                      copyToClipboard(bodyText, 'Response body');
                                    }}
                                    title="Copy to clipboard"
                                  >
                                    📋
                                  </button>
                                </div>
                                <pre className="details-json">{typeof selectedRequest.completeEvent.body === 'string' ? selectedRequest.completeEvent.body : JSON.stringify(selectedRequest.completeEvent.body, null, 2)}</pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
