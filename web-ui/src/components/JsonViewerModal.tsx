import React, {useState} from 'react';
import './JsonViewerModal.css';

type Props = {
  data: any;
  title?: string;
  onClose: () => void;
};

export default function JsonViewerModal({data, title, onClose}: Props) {
  const [copied, setCopied] = useState(false);

  const jsonString = JSON.stringify(data, null, 2);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(jsonString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="json-modal-backdrop" onClick={handleBackdropClick}>
      <div className="json-modal">
        <div className="json-modal-header">
          <h3>{title || 'JSON Data'}</h3>
          <div className="json-modal-actions">
            <button className="copy-button" onClick={handleCopy}>
              {copied ? '✓ Copied!' : '📋 Copy'}
            </button>
            <button className="close-button" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className="json-modal-body">
          <pre className="json-content">{jsonString}</pre>
        </div>
      </div>
    </div>
  );
}
