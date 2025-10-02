import React, {useEffect, useState} from 'react';
import type {Destination, DestinationDetails} from '../types';
import ActionSelector from './ActionSelector';
import './DestinationViewer.css';

type Props = {
  destination: Destination;
  onBack: () => void;
};

export default function DestinationViewer({destination, onBack}: Props) {
  const [details, setDetails] = useState<DestinationDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/destinations/${destination.id}`)
      .then(res => res.json())
      .then(data => {
        setDetails(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [destination.id]);

  if (loading) {
    return (
      <div className="destination-viewer">
        <button onClick={onBack} className="back-button">← Back</button>
        <div className="loading">Loading destination details...</div>
      </div>
    );
  }

  if (error || !details) {
    return (
      <div className="destination-viewer">
        <button onClick={onBack} className="back-button">← Back</button>
        <div className="error">Error: {error || 'Failed to load details'}</div>
      </div>
    );
  }

  return (
    <div className="destination-viewer">
      <button onClick={onBack} className="back-button">← Back</button>
      <div className="destination-header">
        <h1>{details.name}</h1>
        <p className="destination-id">{details.id}</p>
      </div>

      <ActionSelector destinationId={details.id} details={details} />
    </div>
  );
}
