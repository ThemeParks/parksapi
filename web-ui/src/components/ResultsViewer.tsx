import React, {useState, useMemo} from 'react';
import type {ExecutionResult} from '../types';
import JsonViewerModal from './JsonViewerModal';
import './ResultsViewer.css';

// Helper function to format tag names from camelCase to Title Case
function formatTagName(tagName: string): string {
  // Handle special cases for common abbreviations
  const specialCases: Record<string, string> = {
    'onRidePhoto': 'On-Ride Photo',
    'vipLounge': 'VIP Lounge',
  };

  if (specialCases[tagName]) {
    return specialCases[tagName];
  }

  // Convert camelCase to Title Case
  // e.g., "singleRider" -> "Single Rider", "mayGetWet" -> "May Get Wet"
  return tagName
    .replace(/([A-Z])/g, ' $1') // Add space before capital letters
    .replace(/^./, str => str.toUpperCase()) // Capitalize first letter
    .trim();
}

type Props = {
  result: ExecutionResult;
  destinationId?: string;
};

export default function ResultsViewer({result, destinationId}: Props) {
  const [filter, setFilter] = useState('');
  const [viewMode, setViewMode] = useState<'cards' | 'json'>('cards');
  const [enriching, setEnriching] = useState(false);
  const [enrichedData, setEnrichedData] = useState<any[] | null>(null);

  const isArrayData = Array.isArray(result.data);
  const dataArray = enrichedData || (isArrayData ? result.data : []);

  // Detect if this is entity/live data/schedule based on structure
  const dataType = useMemo(() => {
    if (!isArrayData || dataArray.length === 0) return 'unknown';

    const firstItem = dataArray[0];
    // Live data has 'id' field and a 'status' field
    if (firstItem.id && firstItem.status !== undefined) return 'liveData';
    if (firstItem.entityType !== undefined) return 'entity';
    if (firstItem.schedule !== undefined || firstItem.openingTime !== undefined) return 'schedule';
    return 'unknown';
  }, [isArrayData, dataArray]);

  // Function to enrich live data with entity names
  const handleEnrichLiveData = async () => {
    if (!destinationId || dataType !== 'liveData') return;

    setEnriching(true);
    try {
      // Fetch entities with tracing enabled
      const response = await fetch(`/api/destinations/${destinationId}/execute/getEntities`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ async: false }), // Explicitly request synchronous execution with tracing
      });

      const entitiesResult = await response.json();

      // Log trace information if available
      if (entitiesResult.traceId) {
        console.log(`[Add Names] Trace ID: ${entitiesResult.traceId}, Duration: ${entitiesResult.duration}ms, HTTP Requests: ${entitiesResult.httpRequests}`);
      }

      if (entitiesResult.success && Array.isArray(entitiesResult.data)) {
        // Create mapping of entityId to entity name
        const entityMap = new Map<string, string>();
        entitiesResult.data.forEach((entity: any) => {
          if (entity.id && entity.name) {
            entityMap.set(entity.id, entity.name);
          }
        });

        // Enrich live data with entity names
        const enriched = dataArray.map((item: any) => ({
          ...item,
          entityName: entityMap.get(item.id) || item.id,
        }));

        setEnrichedData(enriched);
      }
    } catch (error) {
      console.error('Failed to enrich live data:', error);
    } finally {
      setEnriching(false);
    }
  };

  // Filter the data array
  const filteredData = useMemo(() => {
    if (!isArrayData || filter === '') return dataArray;

    const lowerFilter = filter.toLowerCase();

    return dataArray.filter(item => {
      // Convert entire object to string for searching
      const itemStr = JSON.stringify(item).toLowerCase();
      return itemStr.includes(lowerFilter);
    });
  }, [dataArray, filter, isArrayData]);

  if (!result.success) {
    return (
      <div className="results-viewer error-result">
        <h3>❌ Execution Failed</h3>
        <p className="error-message">{result.error}</p>
        <div className="metadata">
          <span>Method: <code>{result.method}</code></span>
        </div>
      </div>
    );
  }

  return (
    <div className="results-viewer">
      <div className="results-header">
        <div className="results-title">
          <h3>✅ Results: {result.method}</h3>
          {result.count !== undefined && (
            <span className="result-count">{result.count} items</span>
          )}
        </div>

        {result.response && (
          <div className="response-info">
            <span className={`status-badge ${result.response.ok ? 'success' : 'error'}`}>
              HTTP {result.response.status}
            </span>
          </div>
        )}
      </div>

      {isArrayData && dataArray.length > 0 && (
        <div className="results-controls">
          <input
            type="text"
            placeholder="Filter results (by name, id, wait time, status, etc.)..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="filter-input"
          />

          {dataType === 'liveData' && destinationId && !enrichedData && (
            <button
              className="enrich-button"
              onClick={handleEnrichLiveData}
              disabled={enriching}
            >
              {enriching ? 'Enriching...' : '+ Add Names'}
            </button>
          )}

          {enrichedData && (
            <span className="enriched-badge">✓ Enriched</span>
          )}

          <div className="view-toggle">
            <button
              className={viewMode === 'cards' ? 'active' : ''}
              onClick={() => setViewMode('cards')}
            >
              Cards
            </button>
            <button
              className={viewMode === 'json' ? 'active' : ''}
              onClick={() => setViewMode('json')}
            >
              JSON
            </button>
          </div>
        </div>
      )}

      {viewMode === 'json' || !isArrayData ? (
        <div className="json-viewer">
          <pre>{JSON.stringify(result.data, null, 2)}</pre>
        </div>
      ) : (
        <div className="results-content">
          {filteredData.length === 0 ? (
            <div className="no-results">
              {filter ? 'No results match your filter.' : 'No data returned.'}
            </div>
          ) : dataType === 'entity' ? (
            <EntityCards data={filteredData} />
          ) : dataType === 'liveData' ? (
            <LiveDataCards data={filteredData} />
          ) : dataType === 'schedule' ? (
            <ScheduleCards data={filteredData} />
          ) : (
            <GenericCards data={filteredData} />
          )}

          {filter && filteredData.length > 0 && (
            <div className="filter-info">
              Showing {filteredData.length} of {dataArray.length} items
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Entity cards
function EntityCards({data}: {data: any[]}) {
  const [selectedItem, setSelectedItem] = useState<any>(null);

  return (
    <>
      <div className="data-cards">
        {data.map((entity, idx) => (
          <div key={entity.id || idx} className="data-card entity-card">
            <div className="card-header">
              <h4>{entity.name || 'Unnamed Entity'}</h4>
              <div className="card-header-actions">
                <span className="entity-type">{entity.entityType}</span>
                <button
                  className="json-button"
                  onClick={() => setSelectedItem(entity)}
                  title="View JSON"
                >
                  {}
                </button>
              </div>
            </div>
            <div className="card-body">
              <p className="entity-id">ID: {entity.id}</p>
              {entity.parkId && <p>Park: {entity.parkId}</p>}
              {entity.destinationId && <p>Destination: {entity.destinationId}</p>}
              {entity.location && (
                <p>Location: {entity.location.latitude}, {entity.location.longitude}</p>
              )}
              {entity.tags && entity.tags.length > 0 && (
                <div className="tags">
                  {entity.tags.map((tag: any, i: number) => {
                    // Handle new TagBuilder format {tag, tagName, value?, key?}
                    const displayName = tag.tagName
                      ? formatTagName(tag.tagName)
                      : (tag.type || String(tag));

                    return (
                      <span key={i} className="tag" title={JSON.stringify(tag)}>
                        {displayName}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {selectedItem && (
        <JsonViewerModal
          data={selectedItem}
          title={`Entity: ${selectedItem.name || selectedItem.id}`}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </>
  );
}

// Live data cards
function LiveDataCards({data}: {data: any[]}) {
  const [selectedItem, setSelectedItem] = useState<any>(null);

  return (
    <>
      <div className="data-cards">
        {data.map((liveData, idx) => {
          // Calculate primary wait time for header
          const primaryWaitTime = liveData.queue?.STANDBY?.waitTime ??
                                 liveData.queue?.RETURN_TIME?.waitTime ??
                                 null;

          return (
            <div key={liveData.id || idx} className="data-card live-data-card">
              <div className="card-header">
                <div className="card-title-section">
                  {liveData.entityName && liveData.entityName !== liveData.id ? (
                    <>
                      <h4>{liveData.entityName}</h4>
                      <p className="entity-id">{liveData.id}</p>
                    </>
                  ) : (
                    <h4>{liveData.id}</h4>
                  )}
                </div>
                <div className="card-status-section">
                  {primaryWaitTime !== null && primaryWaitTime !== undefined && (
                    <div className="primary-wait-time">{primaryWaitTime} min</div>
                  )}
                  <span className={`status-badge ${liveData.status?.toLowerCase()}`}>
                    {liveData.status}
                  </span>
                  <button
                    className="json-button"
                    onClick={() => setSelectedItem(liveData)}
                    title="View JSON"
                  >
                    {}
                  </button>
                </div>
              </div>
            <div className="card-body">
              {/* Queue information */}
              {liveData.queue && Object.keys(liveData.queue).length > 0 ? (
                <div className="queue-info">
                  <h5 className="section-title">Queue Times</h5>
                  {Object.entries(liveData.queue).map(([queueType, queueData]: [string, any]) => (
                    <div key={queueType} className="queue-entry">
                      <span className="queue-type">{queueType}</span>
                      <span className="wait-time">
                        {queueData.waitTime !== null && queueData.waitTime !== undefined
                          ? `${queueData.waitTime} min`
                          : 'N/A'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="no-queue-data">No queue data available</div>
              )}

              {/* Operating hours */}
              {liveData.operatingHours && liveData.operatingHours.length > 0 && (
                <div className="operating-hours">
                  <h5 className="section-title">Operating Hours</h5>
                  {liveData.operatingHours.map((hours: any, i: number) => (
                    <div key={i} className="hours-entry">
                      <span className="hours-type">{hours.type}</span>
                      <span className="hours-time">
                        {hours.startTime ? new Date(hours.startTime).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '?'} -
                        {hours.endTime ? new Date(hours.endTime).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : 'TBD'}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Last updated */}
              {liveData.lastUpdated && (
                <p className="last-updated">
                  Updated: {new Date(liveData.lastUpdated).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
      {selectedItem && (
        <JsonViewerModal
          data={selectedItem}
          title={`Live Data: ${selectedItem.entityName || selectedItem.id}`}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </>
  );
}

// Schedule cards
function ScheduleCards({data}: {data: any[]}) {
  const [selectedItem, setSelectedItem] = useState<any>(null);

  return (
    <>
      <div className="data-cards">
        {data.map((schedule, idx) => (
          <div key={schedule.entityId || idx} className="data-card schedule-card">
            <div className="card-header">
              <h4>{schedule.entityId}</h4>
              <div className="card-header-actions">
                <span className="schedule-type">{schedule.scheduleType || 'OPERATING'}</span>
                <button
                  className="json-button"
                  onClick={() => setSelectedItem(schedule)}
                  title="View JSON"
                >
                  {}
                </button>
              </div>
            </div>
          <div className="card-body">
            {schedule.date && <p className="schedule-date">Date: {schedule.date}</p>}
            {schedule.openingTime && <p>Opens: {schedule.openingTime}</p>}
            {schedule.closingTime && <p>Closes: {schedule.closingTime}</p>}
            {schedule.schedule && schedule.schedule.length > 0 && (
              <div className="schedule-entries">
                {schedule.schedule.map((entry: any, i: number) => (
                  <div key={i} className="schedule-entry">
                    <span>{entry.openingTime} - {entry.closingTime}</span>
                    {entry.type && <span className="entry-type">{entry.type}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
      {selectedItem && (
        <JsonViewerModal
          data={selectedItem}
          title={`Schedule: ${selectedItem.entityId}`}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </>
  );
}

// Generic fallback for unknown data structures
function GenericCards({data}: {data: any[]}) {
  const [selectedItem, setSelectedItem] = useState<any>(null);

  return (
    <>
      <div className="data-cards">
        {data.map((item, idx) => (
          <div key={idx} className="data-card generic-card">
            <button
              className="json-button card-json-button"
              onClick={() => setSelectedItem(item)}
              title="View JSON"
            >
              {}
            </button>
            <div className="card-body">
              <pre>{JSON.stringify(item, null, 2)}</pre>
            </div>
          </div>
        ))}
      </div>
      {selectedItem && (
        <JsonViewerModal
          data={selectedItem}
          title="JSON Data"
          onClose={() => setSelectedItem(null)}
        />
      )}
    </>
  );
}
