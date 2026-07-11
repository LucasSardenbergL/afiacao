import { describe, it, expect } from 'vitest';
import { computeVolumeOk } from './volume-run';

describe('computeVolumeOk', () => {
  it('sem histórico suficiente → volumeOk null (não fabrica true)', () => {
    expect(computeVolumeOk(404, [])).toEqual({ baseline: null, volumeOk: null });
    expect(computeVolumeOk(404, [400, 410])).toEqual({ baseline: null, volumeOk: null }); // < minHistorico=3
  });
  it('run dentro do baseline → volumeOk true', () => {
    // mediana([400,410,420]) = 410; 404 >= 0.9*410=369 → true
    expect(computeVolumeOk(404, [400, 410, 420])).toEqual({ baseline: 410, volumeOk: true });
  });
  it('run truncado (queda abrupta) → volumeOk false (circuit-breaker)', () => {
    // mediana([400,410,420]) = 410; 12 < 369 → false
    expect(computeVolumeOk(12, [400, 410, 420])).toEqual({ baseline: 410, volumeOk: false });
  });
  it('shape mudou → 0 POs → volumeOk false (o falso-fim-saudável do Codex)', () => {
    expect(computeVolumeOk(0, [400, 410, 420]).volumeOk).toBe(false);
  });
});
