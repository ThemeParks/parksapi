import {describe, it, expect} from 'vitest';
import {summarise, type ProbeResult} from '../signageProbeReport.js';

const at = (lat: number, lng: number, status: number): ProbeResult => ({lat, lng, status});

describe('summarise', () => {
  it('passes only when something was probed and every answer was 200', () => {
    expect(summarise([at(1, 1, 200), at(2, 2, 200)])).toEqual({total: 2, accepted: 2, refused: 0, other: 0, ok: true});
  });

  it('fails on a single refusal', () => {
    const s = summarise([at(1, 1, 200), at(2, 2, 403), at(3, 3, 200)]);
    expect(s).toMatchObject({total: 3, accepted: 2, refused: 1, other: 0, ok: false});
  });

  it('counts an error or any other status separately, and fails on it', () => {
    const s = summarise([at(1, 1, 200), at(2, 2, -1), at(3, 3, 500)]);
    expect(s).toMatchObject({accepted: 1, refused: 0, other: 2, ok: false});
  });

  it('does not pass an empty probe', () => {
    expect(summarise([])).toMatchObject({total: 0, ok: false});
  });
});
