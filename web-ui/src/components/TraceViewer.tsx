import React, { useEffect, useState } from 'react';
import type { HttpTraceEvent, TraceInfo } from '../types';
import './TraceViewer.css';

type Props = {
  traceId: string;
};

type SSEMessage =
  | { type: 'connected'; traceId: string }
  | { type: 'event'; event: HttpTraceEvent }
  | { type: 'complete'; trace: TraceInfo };

export default function TraceViewer({ traceId }: Props) {
  const [events, setEvents] = useState<HttpTraceEvent[]>([]);
  const [completed, setCompleted] = useState(false);
  const [traceInfo, setTraceInfo] = useState<TraceInfo | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const eventSource = new EventSource(`/api/trace/${traceId}/events`);

    eventSource.onmessage = (event) => {
      const message: SSEMessage = JSON.parse(event.data);

      if (message.type === 'connected') {
        setConnected(true);
      } else if (message.type === 'event') {
        setEvents(prev => [...prev, message.event]);
      } else if (message.type === 'complete') {
        setTraceInfo(message.trace);
        setCompleted(true);
        eventSource.close();
      }
    };

    eventSource.onerror = () => {
      console.error('SSE connection error');
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [traceId]);

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
  };

  const getEventIcon = (event: HttpTraceEvent) => {
    switch (event.eventType) {
      case 'http.request.start':
        return '🔄';
      case 'http.request.complete':
        return event.cacheHit ? '💾' : '✅';
      case 'http.request.error':
        return '❌';
      default:
        return '📡';
    }
  };

  const getEventClass = (event: HttpTraceEvent) => {
    switch (event.eventType) {
      case 'http.request.start':
        return 'event-start';
      case 'http.request.complete':
        return event.cacheHit ? 'event-cached' : 'event-success';
      case 'http.request.error':
        return 'event-error';
      default:
        return '';
    }
  };

  return (
    <div className="trace-viewer">
      <div className="trace-header">
        <h3>📊 Live Trace</h3>
        <div className="trace-status">
          {!connected && <span className="status-connecting">Connecting...</span>}
          {connected && !completed && <span className="status-active">⚡ Live</span>}
          {completed && <span className="status-complete">✓ Complete</span>}
        </div>
      </div>

      <div className="trace-info">
        <code className="trace-id">Trace ID: {traceId}</code>
        {traceInfo && (
          <div className="trace-summary">
            <span>Duration: {traceInfo.duration}ms</span>
            <span>HTTP Requests: {traceInfo.events.length}</span>
          </div>
        )}
      </div>

      <div className="trace-events">
        {events.length === 0 && !completed && (
          <div className="no-events">Waiting for events...</div>
        )}

        {events.map((event, index) => (
          <div key={index} className={`trace-event ${getEventClass(event)}`}>
            <span className="event-icon">{getEventIcon(event)}</span>
            <div className="event-details">
              <div className="event-main">
                <span className="event-method">{event.method}</span>
                <span className="event-url">{event.url}</span>
                {event.status && <span className="event-status">{event.status}</span>}
              </div>
              <div className="event-meta">
                <span className="event-time">{formatTimestamp(event.timestamp)}</span>
                {event.duration !== undefined && (
                  <span className="event-duration">{event.duration}ms</span>
                )}
                {event.cacheHit && <span className="event-badge">CACHED</span>}
                {event.retryCount && event.retryCount > 0 && (
                  <span className="event-badge">RETRY {event.retryCount}</span>
                )}
              </div>
              {event.error && (
                <div className="event-error-msg">{event.error.message}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
