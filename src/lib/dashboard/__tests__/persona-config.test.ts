import { describe, it, expect } from 'vitest';
import { PERSONAS, PERSONA_CONFIG, ZONES } from '../persona-config';

describe('persona-config', () => {
  it('every persona has zoneOrder covering all 6 zones', () => {
    for (const persona of PERSONAS) {
      const config = PERSONA_CONFIG[persona];
      expect(config.zoneOrder).toHaveLength(ZONES.length);
      expect(new Set(config.zoneOrder)).toEqual(new Set(ZONES));
    }
  });

  it('every persona has at least 1 priorityZone', () => {
    for (const persona of PERSONAS) {
      expect(PERSONA_CONFIG[persona].priorityZones.length).toBeGreaterThan(0);
    }
  });

  it('priorityZones are subsets of zoneOrder', () => {
    for (const persona of PERSONAS) {
      const config = PERSONA_CONFIG[persona];
      const set = new Set(config.zoneOrder);
      for (const z of config.priorityZones) expect(set.has(z)).toBe(true);
    }
  });
});
