/**
 * Declarative status mapping for park implementations.
 *
 * Replaces per-park switch statements with a config-driven approach.
 * Includes unknown-state logging to catch API changes.
 */

export type StatusMapConfig = {
  OPERATING?: string[];
  CLOSED?: string[];
  DOWN?: string[];
  REFURBISHMENT?: string[];
};

export type StatusMapOptions = {
  /** Default status when input doesn't match any mapping (default: 'CLOSED') */
  defaultStatus?: string;
  /** Park name for warning messages */
  parkName?: string;
  /** Whether to log unknown statuses (default: true) */
  logUnknown?: boolean;
};

/**
 * Create a status mapping function from a declarative config.
 *
 * @example
 * ```typescript
 * const mapStatus = createStatusMap({
 *   OPERATING: ['open', 'opened'],
 *   DOWN: ['temp closed', 'temp closed due weather'],
 *   CLOSED: ['closed', 'not scheduled', ''],
 *   REFURBISHMENT: ['maintenance'],
 * }, { parkName: 'SixFlags' });
 *
 * mapStatus('open')         // → 'OPERATING'
 * mapStatus('temp closed')  // → 'DOWN'
 * mapStatus('weird_thing')  // → 'CLOSED' (logs warning)
 * ```
 */
export function createStatusMap(
  config: StatusMapConfig,
  options: StatusMapOptions = {},
): (status: string) => string {
  const { defaultStatus = 'CLOSED', parkName, logUnknown = true } = options;

  // Build reverse lookup: lowercased input string → output status
  const lookup = new Map<string, string>();
  for (const [outputStatus, inputValues] of Object.entries(config)) {
    for (const input of inputValues || []) {
      lookup.set(input.toLowerCase(), outputStatus);
    }
  }

  // Track unknown statuses to avoid repeated warnings
  const warned = new Set<string>();

  return (status: string): string => {
    const key = (status ?? '').toLowerCase();
    const mapped = lookup.get(key);
    if (mapped) return mapped;

    // Unknown status
    if (logUnknown && !warned.has(key)) {
      warned.add(key);
      const prefix = parkName ? `[${parkName}]` : '[StatusMap]';
      console.warn(`${prefix} Unknown status: "${status}" — defaulting to ${defaultStatus}`);
    }

    return defaultStatus;
  };
}
