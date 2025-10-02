import React, {useEffect, useState} from 'react';
import type {Destination} from '../types';
import './DestinationList.css';

type Props = {
  onSelect: (destination: Destination) => void;
};

export default function DestinationList({onSelect}: Props) {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetch('/api/destinations')
      .then(res => res.json())
      .then(data => {
        setDestinations(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const filteredDestinations = destinations.filter(d =>
    d.name.toLowerCase().includes(filter.toLowerCase()) ||
    d.id.toLowerCase().includes(filter.toLowerCase()) ||
    (Array.isArray(d.category)
      ? d.category.some(c => c.toLowerCase().includes(filter.toLowerCase()))
      : d.category.toLowerCase().includes(filter.toLowerCase()))
  );

  if (loading) {
    return <div className="destination-list loading">Loading destinations...</div>;
  }

  if (error) {
    return <div className="destination-list error">Error: {error}</div>;
  }

  return (
    <div className="destination-list">
      <h2>Destinations</h2>
      <input
        type="text"
        placeholder="Filter destinations..."
        value={filter}
        onChange={e => setFilter(e.target.value)}
        className="filter-input"
      />
      <div className="destination-cards">
        {filteredDestinations.map(dest => (
          <div
            key={dest.id}
            className="destination-card"
            onClick={() => onSelect(dest)}
          >
            <h3>{dest.name}</h3>
            <p className="destination-id">{dest.id}</p>
            <div className="destination-categories">
              {Array.isArray(dest.category)
                ? dest.category.map(c => (
                    <span key={c} className="category-tag">
                      {c}
                    </span>
                  ))
                : <span className="category-tag">{dest.category}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
