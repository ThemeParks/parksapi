import React, { createContext, useContext, useState, ReactNode } from 'react';

type TraceContextType = {
  currentTraceId: string | null;
  setCurrentTraceId: (traceId: string | null) => void;
  openTraceDrawer: () => void;
  isDrawerOpen: boolean;
  setIsDrawerOpen: (open: boolean) => void;
};

const TraceContext = createContext<TraceContextType | undefined>(undefined);

export function TraceProvider({ children }: { children: ReactNode }) {
  const [currentTraceId, setCurrentTraceId] = useState<string | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  const openTraceDrawer = () => {
    setIsDrawerOpen(true);
  };

  return (
    <TraceContext.Provider
      value={{
        currentTraceId,
        setCurrentTraceId,
        openTraceDrawer,
        isDrawerOpen,
        setIsDrawerOpen,
      }}
    >
      {children}
    </TraceContext.Provider>
  );
}

export function useTrace() {
  const context = useContext(TraceContext);
  if (context === undefined) {
    throw new Error('useTrace must be used within a TraceProvider');
  }
  return context;
}
