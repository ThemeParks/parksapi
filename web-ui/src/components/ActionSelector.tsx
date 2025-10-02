import React, {useState} from 'react';
import type {DestinationDetails, ExecutionResult} from '../types';
import HttpMethodForm from './HttpMethodForm';
import ResultsViewer from './ResultsViewer';
import './ActionSelector.css';

type Props = {
  destinationId: string;
  details: DestinationDetails;
};

type ActionType = 'main' | 'http';

export default function ActionSelector({destinationId, details}: Props) {
  const [actionType, setActionType] = useState<ActionType>('main');
  const [selectedMethod, setSelectedMethod] = useState<string>('');
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ExecutionResult | null>(null);

  const handleMainMethodExecute = async (methodName: string) => {
    setExecuting(true);
    setResult(null);

    try {
      const response = await fetch(`/api/destinations/${destinationId}/execute/${methodName}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
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
            setActionType('main');
            setSelectedMethod('');
            setResult(null);
          }}
        >
          Main Methods ({details.mainMethods.length})
        </button>
        <button
          className={actionType === 'http' ? 'active' : ''}
          onClick={() => {
            setActionType('http');
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

      {result && <ResultsViewer result={result} />}
    </div>
  );
}
