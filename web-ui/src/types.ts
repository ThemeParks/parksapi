export type Destination = {
  id: string;
  name: string;
  category: string | string[];
};

export type DestinationDetails = {
  id: string;
  name: string;
  category: string | string[];
  mainMethods: MainMethod[];
  httpMethods: HttpMethod[];
};

export type MainMethod = {
  name: string;
  description: string;
};

export type HttpMethod = {
  name: string;
  parameters: HttpParameter[];
};

export type HttpParameter = {
  name: string;
  type: string;
  description: string;
  required?: boolean;
  example?: any;
};

export type ExecutionResult = {
  success: boolean;
  method: string;
  data: any;
  count?: number;
  error?: string;
  response?: {
    status: number;
    ok: boolean;
    url: string;
  };
  traceId?: string;
  duration?: number;
  httpRequests?: number;
  status?: 'started' | 'completed';
};

export type HttpTraceEvent = {
  traceId: string;
  eventType: 'http.request.start' | 'http.request.complete' | 'http.request.error';
  timestamp: number;
  url: string;
  method: string;
  status?: number;
  duration?: number;
  error?: Error;
  headers?: Record<string, string>;
  body?: any;
  cacheHit?: boolean;
  retryCount?: number;
};

export type TraceInfo = {
  traceId: string;
  startTime: number;
  endTime: number;
  duration: number;
  events: HttpTraceEvent[];
  metadata?: Record<string, any>;
};
