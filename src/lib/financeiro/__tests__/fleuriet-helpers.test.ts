import { describe, it, expect } from 'vitest';
import {
  calcularCDG,
  materialidade,
  sinalComBanda,
  tipoPorSinais,
  classificarFleuriet,
  escolherSnapshotNaData,
  classificarFleurietEmpresa,
} from '../fleuriet-helpers';

// ───────────────────────── Task 1: calcularCDG ─────────────────────────
describe('calcularCDG', () => {
  it('CDG = (PL + PNC) − ANC', () => {
    expect(calcularCDG({ anc: 100, pnc: 40, pl: 90 })).toBe(30);
  });
  it('negativo é real (não vira 0)', () => {
    expect(calcularCDG({ anc: 200, pnc: 10, pl: 50 })).toBe(-140);
  });
  it('qualquer componente ausente → null (ausente ≠ 0)', () => {
    expect(calcularCDG({ anc: null, pnc: 40, pl: 90 })).toBeNull();
    expect(calcularCDG({ anc: 100, pnc: null, pl: 90 })).toBeNull();
    expect(calcularCDG({ anc: 100, pnc: 40, pl: null })).toBeNull();
  });
  it('não-finito → null', () => {
    expect(calcularCDG({ anc: Infinity, pnc: 40, pl: 90 })).toBeNull();
  });
});

// ─────────────────── Task 2: materialidade + sinalComBanda ───────────────────
describe('materialidade', () => {
  it('max(1% da receita mensal, R$500)', () => {
    expect(materialidade({ receita_liquida_mensal: 100000 })).toBe(1000);
    expect(materialidade({ receita_liquida_mensal: 20000 })).toBe(500);
  });
  it('receita ausente/inválida → piso R$500', () => {
    expect(materialidade({ receita_liquida_mensal: null })).toBe(500);
    expect(materialidade({ receita_liquida_mensal: 0 })).toBe(500);
    expect(materialidade({ receita_liquida_mensal: -5 })).toBe(500);
  });
});

describe('sinalComBanda', () => {
  it('acima da banda → +, abaixo → −, dentro → ~0', () => {
    expect(sinalComBanda(1000, 500)).toBe('+');
    expect(sinalComBanda(-1000, 500)).toBe('-');
    expect(sinalComBanda(300, 500)).toBe('~0');
    expect(sinalComBanda(-500, 500)).toBe('~0');
    expect(sinalComBanda(500, 500)).toBe('~0');
  });
  it('null/não-finito → null', () => {
    expect(sinalComBanda(null, 500)).toBeNull();
    expect(sinalComBanda(Infinity, 500)).toBeNull();
  });
});

// ─────────────────── Task 3: tipoPorSinais (matriz de Braga) ───────────────────
describe('tipoPorSinais (matriz de Braga)', () => {
  it('os 6 tipos válidos', () => {
    expect(tipoPorSinais({ cdg: '+', ncg: '-', t: '+' })).toEqual({ tipo: 'I', rotulo: 'Excelente', inconsistente: false });
    expect(tipoPorSinais({ cdg: '+', ncg: '+', t: '+' })).toEqual({ tipo: 'II', rotulo: 'Sólida', inconsistente: false });
    expect(tipoPorSinais({ cdg: '+', ncg: '+', t: '-' })).toEqual({ tipo: 'III', rotulo: 'Insatisfatória', inconsistente: false });
    expect(tipoPorSinais({ cdg: '-', ncg: '+', t: '-' })).toEqual({ tipo: 'IV', rotulo: 'Péssima', inconsistente: false });
    expect(tipoPorSinais({ cdg: '-', ncg: '-', t: '-' })).toEqual({ tipo: 'V', rotulo: 'Muito ruim', inconsistente: false });
    expect(tipoPorSinais({ cdg: '-', ncg: '-', t: '+' })).toEqual({ tipo: 'VI', rotulo: 'Alto risco', inconsistente: false });
  });
  it('as 2 combinações impossíveis por identidade', () => {
    expect(tipoPorSinais({ cdg: '+', ncg: '-', t: '-' })).toEqual({ tipo: null, rotulo: null, inconsistente: true });
    expect(tipoPorSinais({ cdg: '-', ncg: '+', t: '+' })).toEqual({ tipo: null, rotulo: null, inconsistente: true });
  });
  it('sinal ~0/null → sem tipo, sem inconsistência', () => {
    expect(tipoPorSinais({ cdg: '~0', ncg: '+', t: '-' })).toEqual({ tipo: null, rotulo: null, inconsistente: false });
    expect(tipoPorSinais({ cdg: null, ncg: null, t: null })).toEqual({ tipo: null, rotulo: null, inconsistente: false });
  });
});

// ─────────────────── Task 4: classificarFleuriet ───────────────────
describe('classificarFleuriet', () => {
  const m = 500;
  it('Tipo II Sólida + coberta (CDG cobre NCG positiva)', () => {
    const r = classificarFleuriet({ cdg: 3000, ncg: 2000, materialidade: m });
    expect(r.status).toBe('coberta');
    expect(r.tipo).toBe('II'); expect(r.rotulo).toBe('Sólida');
    expect(r.gap).toBe(1000); expect(r.cobertura).toBe(1.5);
  });
  it('Tipo III Insatisfatória → descoberta (CDG < NCG positiva)', () => {
    const r = classificarFleuriet({ cdg: 2000, ncg: 3000, materialidade: m });
    expect(r.status).toBe('descoberta'); expect(r.tipo).toBe('III'); expect(r.gap).toBe(-1000);
  });
  it('NCG negativa → operacao_financia_giro (Tipo I)', () => {
    const r = classificarFleuriet({ cdg: 2000, ncg: -1000, materialidade: m });
    expect(r.status).toBe('operacao_financia_giro'); expect(r.tipo).toBe('I');
    expect(r.cobertura).toBeNull();
  });
  it('componente dentro da banda → fronteira, sem tipo', () => {
    const r = classificarFleuriet({ cdg: 300, ncg: 3000, materialidade: m });
    expect(r.status).toBe('fronteira'); expect(r.tipo).toBeNull();
    expect(r.sinais.cdg).toBe('~0');
  });
  it('CDG ≈ NCG (T na banda) → fronteira mesmo com CDG e NCG fora da banda', () => {
    // Alerta do Codex: perto de zero o Tipo vira com ruído. gap = 200 ≤ 500 → não crava Tipo.
    const r = classificarFleuriet({ cdg: 5000, ncg: 4800, materialidade: m });
    expect(r.status).toBe('fronteira'); expect(r.tipo).toBeNull(); expect(r.sinais.t).toBe('~0');
  });
  it('Tipo V (CDG-,NCG-,T-) NÃO é operacao_financia_giro — falso conforto (Codex P1)', () => {
    const r = classificarFleuriet({ cdg: -3000, ncg: -1000, materialidade: 500 });
    // gap = -3000-(-1000) = -2000 → sinais (-,-,-) = Tipo V. NCG<0 não pode pintar de saudável.
    expect(r.tipo).toBe('V');
    expect(r.status).toBe('descoberta');
  });
  it('Tipo VI (CDG-,NCG-,T+) → alto_risco (vive da folga do ciclo)', () => {
    const r = classificarFleuriet({ cdg: -1000, ncg: -3000, materialidade: 500 });
    // gap = -1000-(-3000) = 2000 → sinais (-,-,+) = Tipo VI.
    expect(r.tipo).toBe('VI');
    expect(r.status).toBe('alto_risco');
  });
  it('Tipo I (CDG+,NCG-,T+) segue operacao_financia_giro (folga real)', () => {
    const r = classificarFleuriet({ cdg: 5000, ncg: -1000, materialidade: 500 });
    expect(r.tipo).toBe('I');
    expect(r.status).toBe('operacao_financia_giro');
  });
  it('cdg null → indisponivel com motivo', () => {
    const r = classificarFleuriet({ cdg: null, ncg: 2000, materialidade: m });
    expect(r.status).toBe('indisponivel'); expect(r.tipo).toBeNull();
    expect(r.motivos.some(x => /Balanço/.test(x))).toBe(true);
  });
  it('ncg null → indisponivel com motivo', () => {
    const r = classificarFleuriet({ cdg: 2000, ncg: null, materialidade: m });
    expect(r.status).toBe('indisponivel');
    expect(r.motivos.some(x => /NCG/.test(x))).toBe(true);
  });
});

// ─────────────────── Task 5: casamento temporal + montagem ───────────────────
describe('escolherSnapshotNaData (±7d)', () => {
  const snaps = [
    { ncg: 2000, snapshot_at: '2026-03-28T03:00:00Z' },
    { ncg: 2500, snapshot_at: '2026-04-10T03:00:00Z' },
  ];
  it('escolhe o mais próximo dentro da janela', () => {
    const r = escolherSnapshotNaData({ snapshots: snaps, dataRef: '2026-03-31' });
    expect(r.ncg).toBe(2000); expect(r.fora_janela).toBe(false); expect(r.dias_delta).toBe(-3);
  });
  it('fora de ±7d → ncg null + fora_janela', () => {
    const r = escolherSnapshotNaData({ snapshots: [{ ncg: 2500, snapshot_at: '2026-04-10T03:00:00Z' }], dataRef: '2026-03-31' });
    expect(r.ncg).toBeNull(); expect(r.fora_janela).toBe(true); expect(r.dias_delta).toBe(10);
  });
  it('sem snapshots com ncg → fora_janela', () => {
    const r = escolherSnapshotNaData({ snapshots: [{ ncg: null, snapshot_at: '2026-03-31T03:00:00Z' }], dataRef: '2026-03-31' });
    expect(r.ncg).toBeNull(); expect(r.fora_janela).toBe(true);
  });
  it('janela por DATA de calendário, não por horas/fuso (Codex P1)', () => {
    // 23/03 → 31/03 = 8 dias de calendário: fora, mesmo o snapshot tendo horário (7d11h absolutos).
    const fora = escolherSnapshotNaData({ snapshots: [{ ncg: 100000, snapshot_at: '2026-03-23T13:00:00Z' }], dataRef: '2026-03-31' });
    expect(fora.fora_janela).toBe(true); expect(fora.dias_delta).toBe(-8);
    // 24/03 → 31/03 = exatamente 7 dias: dentro, independente do horário do snapshot.
    const dentro = escolherSnapshotNaData({ snapshots: [{ ncg: 100000, snapshot_at: '2026-03-24T23:59:00Z' }], dataRef: '2026-03-31' });
    expect(dentro.fora_janela).toBe(false); expect(dentro.dias_delta).toBe(-7);
  });
});

describe('classificarFleurietEmpresa', () => {
  const hoje = Date.parse('2026-07-01T00:00:00Z');
  const snaps = [{ ncg: 2000, snapshot_at: '2026-03-31T03:00:00Z' }];
  it('balanço null → indisponivel + confianca null', () => {
    const r = classificarFleurietEmpresa({ balanco: null, snapshots: snaps, receita_liquida_mensal: 100000, hojeMs: hoje });
    expect(r.status).toBe('indisponivel'); expect(r.confianca).toBeNull(); expect(r.data_balanco).toBeNull();
  });
  it('balanço + NCG na data → classifica, expõe as duas datas', () => {
    const r = classificarFleurietEmpresa({
      balanco: { anc: 1000, pnc: 500, pl: 4000, data_ref: '2026-03-31' }, // CDG = 3500
      snapshots: snaps, receita_liquida_mensal: 100000, hojeMs: hoje,
    });
    expect(r.cdg).toBe(3500); expect(r.ncg).toBe(2000); expect(r.status).toBe('coberta');
    expect(r.tipo).toBe('II'); expect(r.cobertura).toBe(1.75);
    expect(r.data_balanco).toBe('2026-03-31'); expect(r.data_ncg).toBe('2026-03-31T03:00:00Z');
    expect(r.confianca).toBe('alta');
  });
  it('balanço antigo (> 180d) → confianca media', () => {
    const r = classificarFleurietEmpresa({
      balanco: { anc: 1000, pnc: 500, pl: 2500, data_ref: '2025-06-30' },
      snapshots: [{ ncg: 2000, snapshot_at: '2025-06-30T03:00:00Z' }], receita_liquida_mensal: 100000, hojeMs: hoje,
    });
    expect(r.confianca).toBe('media');
  });
});
