import React, {useState, useEffect} from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
import type {DestinationDetails, ExecutionResult} from '../types';
import HttpMethodForm from './HttpMethodForm';
import ResultsViewer from './ResultsViewer';
import TraceViewer from './TraceViewer';
import './ActionSelector.css';

type Props = {
  destinationId: string;
  details: DestinationDetails;
};

type ActionType = 'main' | 'http';

export default function ActionSelector({destinationId, details}: Props) {
  const navigate = useNavigate();
  const location = useLocation();

  // Determine action type from URL
  const getActionTypeFromPath = (): ActionType => {
    if (location.pathname.includes('/http')) return 'http';
    return 'main';
  };

  const [actionType, setActionType] = useState<ActionType>(getActionTypeFromPath());
  const [selectedMethod, setSelectedMethod] = useState<string>('');
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ExecutionResult | null>(null);

  // Sync actionType with URL
  useEffect(() => {
    setActionType(getActionTypeFromPath());
  }, [location.pathname]);

  const handleMainMethodExecute = async (methodName: string, enableTracing = true) => {
    setExecuting(true);
    setResult(null);

    try {
      const response = await fetch(`/api/destinations/${destinationId}/execute/${methodName}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ async: enableTracing }),
      });

      const data = await response.json();
      setResult(data);

      // If async mode (with tracing), fetch the actual result after trace completes
      if (enableTracing && data.traceId) {
        // Wait a bit for the trace to complete
        const checkComplete = setInterval(async () => {
          try {
            const traceResponse = await fetch(`/api/trace/${data.traceId}`);
            if (traceResponse.ok) {
              const trace = await traceResponse.json();
              if (trace.metadata?.result !== undefined) {
                // Update result with the actual data
                setResult(prev => prev ? {
                  ...prev,
                  data: trace.metadata.result,
                  count: Array.isArray(trace.metadata.result) ? trace.metadata.result.length : undefined,
                  duration: trace.duration,
                  httpRequests: trace.events.length,
                  status: 'completed'
                } : null);
                clearInterval(checkComplete);
                setExecuting(false);
              }
            }
          } catch (err) {
            console.error('Error fetching trace:', err);
          }
        }, 500);

        // Timeout after 30 seconds
        setTimeout(() => {
          clearInterval(checkComplete);
          setExecuting(false);
        }, 30000);
      } else {
        setExecuting(false);
      }
    } catch (error) {
      setResult({
        success: false,
        method: methodName,
        error: error instanceof Error ? error.message : 'Unknown error',
        data: null,
      });
      setExecuting(false);
    }
  };

  const handleHttpMethodExecute = async (methodName: string, parameters: Record<string, any>) => {
    setExecuting(true);
    setResult(null);

    try {
      const response = await fetch(`/api/destinations/${destinationId}/http/${methodName}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({parameters}),
      });

      const data = await response.json();
      setResult(data);
    } catch (error) {
      setResult({
        success: false,
        method: methodName,
        error: error instanceof Error ? error.message : 'Unknown error',
        data: null,
      });
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="action-selector">
      <div className="action-type-selector">
        <button
          className={actionType === 'main' ? 'active' : ''}
          onClick={() => {
            navigate(`/destination/${destinationId}/methods`);
            setSelectedMethod('');
            setResult(null);
          }}
        >
          Main Methods ({details.mainMethods.length})
        </button>
        <button
          className={actionType === 'http' ? 'active' : ''}
          onClick={() => {
            navigate(`/destination/${destinationId}/http`);
            setSelectedMethod('');
            setResult(null);
          }}
        >
          HTTP Methods ({details.httpMethods.length})
        </button>
      </div>

      <div className="action-content">
        {actionType === 'main' ? (
          <div className="method-list">
            <h3>Main Methods</h3>
            <p className="method-description">
              Execute core destination methods to fetch entities, live data, or schedules.
            </p>
            <div className="method-cards">
              {details.mainMethods.map(method => (
                <div key={method.name} className="method-card">
                  <h4>{method.name}</h4>
                  <p>{method.description}</p>
                  <button
                    onClick={() => handleMainMethodExecute(method.name)}
                    disabled={executing}
                    className="execute-button"
                  >
                    {executing ? 'Executing...' : 'Execute'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="method-list">
            <h3>HTTP Methods</h3>
            <p className="method-description">
              Execute HTTP methods decorated with @http. Select a method to customize parameters.
            </p>
            {details.httpMethods.length === 0 ? (
              <div className="no-methods">No HTTP methods available for this destination.</div>
            ) : (
              <div className="http-method-selector">
                <select
                  value={selectedMethod}
                  onChange={e => {
                    setSelectedMethod(e.target.value);
                    setResult(null);
                  }}
                  className="method-dropdown"
                >
                  <option value="">Select an HTTP method...</option>
                  {details.httpMethods.map(method => (
                    <option key={method.name} value={method.name}>
                      {method.name} ({method.parameters.length} params)
                    </option>
                  ))}
                </select>

                {selectedMethod && (
                  <HttpMethodForm
                    method={details.httpMethods.find(m => m.name === selectedMethod)!}
                    onExecute={params => handleHttpMethodExecute(selectedMethod, params)}
                    executing={executing}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {result && result.traceId && <TraceViewer traceId={result.traceId} />}
      {result && <ResultsViewer result={result} destinationId={destinationId} />}
    </div>
  );
}
