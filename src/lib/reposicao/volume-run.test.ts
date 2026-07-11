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
  it('mediana de histórico PAR → média dos 2 centrais (branch ord.length par)', () => {
    // ord=[400,410,420,430] par; mediana = round((410+420)/2) = 415; 415 >= 0.9*415=373.5 → true
    expect(computeVolumeOk(415, [400, 410, 420, 430])).toEqual({ baseline: 415, volumeOk: true });
  });
  it('boundary exato: idsDistintos === k*baseline → volumeOk true (threshold inclusivo, >=)', () => {
    // mediana([400,410,420]) = 410; 0.9*410 = 369 exato; 369 >= 369 → true (não > estrito)
    expect(computeVolumeOk(369, [400, 410, 420])).toEqual({ baseline: 410, volumeOk: true });
  });
  it('filtra entradas inválidas do histórico ANTES do check de minHistorico (não conta lixo)', () => {
    // -5 (negativo) e NaN são descartados pelo filtro; sobram só 2 válidas (400,410) < minHistorico=3
    expect(computeVolumeOk(100, [400, 410, -5, NaN])).toEqual({ baseline: null, volumeOk: null });
  });
});
