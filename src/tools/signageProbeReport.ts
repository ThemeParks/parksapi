/**
 * @module
 * The verdict of the Phantasialand signage probe (signageProbe.ts), kept apart
 * from the CLI so it can be tested without a network or a destination.
 */

export type ProbeResult = {lat: number; lng: number; status: number};

export type ProbeSummary = {
  total: number;
  accepted: number;
  refused: number;
  /** Neither 200 nor 403: a network error is recorded as status -1. */
  other: number;
  /** True when something was probed and every answer was a 200. */
  ok: boolean;
};

export function summarise(results: ProbeResult[]): ProbeSummary {
  const accepted = results.filter((r) => r.status === 200).length;
  const refused = results.filter((r) => r.status === 403).length;
  const other = results.length - accepted - refused;
  return {total: results.length, accepted, refused, other, ok: results.length > 0 && refused === 0 && other === 0};
}
