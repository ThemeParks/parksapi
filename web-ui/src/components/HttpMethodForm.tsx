import React, {useState} from 'react';
import type {HttpMethod} from '../types';
import './HttpMethodForm.css';

type Props = {
  method: HttpMethod;
  onExecute: (parameters: Record<string, any>) => void;
  executing: boolean;
};

export default function HttpMethodForm({method, onExecute, executing}: Props) {
  const [parameters, setParameters] = useState<Record<string, any>>(() => {
    const initial: Record<string, any> = {};
    method.parameters.forEach(param => {
      initial[param.name] = param.example ?? '';
    });
    return initial;
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onExecute(parameters);
  };

  const handleChange = (name: string, value: any) => {
    setParameters(prev => ({...prev, [name]: value}));
  };

  const parseValue = (type: string, value: string): any => {
    if (value === '') return undefined;

    switch (type.toLowerCase()) {
      case 'number':
      case 'integer':
        return Number(value);
      case 'boolean':
        return value === 'true';
      case 'object':
      case 'array':
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      default:
        return value;
    }
  };

  return (
    <form className="http-method-form" onSubmit={handleSubmit}>
      <div className="form-header">
        <h4>{method.name}</h4>
        <p className="param-count">{method.parameters.length} parameter(s)</p>
      </div>

      {method.parameters.length === 0 ? (
        <div className="no-params">This method has no parameters.</div>
      ) : (
        <div className="form-fields">
          {method.parameters.map(param => (
            <div key={param.name} className="form-field">
              <label>
                <span className="param-name">
                  {param.name}
                  {param.required && <span className="required">*</span>}
                </span>
                <span className="param-type">{param.type}</span>
              </label>
              {param.description && (
                <p className="param-description">{param.description}</p>
              )}
              {param.type.toLowerCase() === 'boolean' ? (
                <select
                  value={String(parameters[param.name])}
                  onChange={e => handleChange(param.name, e.target.value === 'true')}
                  required={param.required}
                >
                  <option value="">Select...</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : param.type.toLowerCase() === 'object' || param.type.toLowerCase() === 'array' ? (
                <textarea
                  value={
                    typeof parameters[param.name] === 'object'
                      ? JSON.stringify(parameters[param.name], null, 2)
                      : parameters[param.name]
                  }
                  onChange={e =>
                    handleChange(param.name, parseValue(param.type, e.target.value))
                  }
                  placeholder={param.example ? JSON.stringify(param.example) : `Enter ${param.type}...`}
                  required={param.required}
                  rows={4}
                />
              ) : (
                <input
                  type={param.type.toLowerCase() === 'number' || param.type.toLowerCase() === 'integer' ? 'number' : 'text'}
                  value={parameters[param.name]}
                  onChange={e =>
                    handleChange(param.name, parseValue(param.type, e.target.value))
                  }
                  placeholder={param.example ? String(param.example) : `Enter ${param.type}...`}
                  required={param.required}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <button type="submit" className="execute-button" disabled={executing}>
        {executing ? 'Executing...' : 'Execute HTTP Request'}
      </button>
    </form>
  );
}
