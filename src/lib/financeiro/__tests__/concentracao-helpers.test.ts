import { describe, it, expect } from 'vitest';
import {
  concentracaoEmpresa,
  c50,
  hhi,
  classificarFonte,
  isOverdueTitleStatus,
  PISO_MODERADO,
  PISO_ALTO,
} from '../concentracao-helpers';
import type { TituloAberto } from '../concentracao-types';

const t = (
  omie_codigo_cliente: number | null,
  saldo: number,
  atrasado = false,
): TituloAberto => ({ omie_codigo_cliente, saldo, atrasado });

describe('concentracaoEmpresa — gates de fonte (P0-1: empty ≠ zero)', () => {
  it('fonte indisponivel + vazio → fonte_indisponivel, NÃO sem_carteira', () => {
    const r = concentracaoEmpresa([], 'indisponivel');
    expect(r.motivo).toBe('fonte_indisponivel');
    expect(r.totalAberto).toBeNull();
    expect(r.topN).toEqual([]);
  });
  it('fonte indisponivel + títulos válidos → NÃO calcula (não fabrica sobre fonte podre)', () => {
    const r = concentracaoEmpresa([t(1, 100), t(2, 50)], 'indisponivel');
    expect(r.motivo).toBe('fonte_indisponivel');
    expect(r.totalAberto).toBeNull();
    expect(r.maiorExposicao).toBeNull();
  });
  it('fonte ok + vazio → sem_carteira (zero PROVADO), total 0', () => {
    const r = concentracaoEmpresa([], 'ok');
    expect(r.motivo).toBe('sem_carteira');
    expect(r.totalAberto).toBe(0);
    expect(r.top1Pct).toBeNull();
    expect(r.topN).toEqual([]);
  });
  it('fonte parcial + vazio → fonte_parcial, NÃO sem_carteira (truncado ≠ zero)', () => {
    const r = concentracaoEmpresa([], 'parcial');
    expect(r.motivo).toBe('fonte_parcial');
    expect(r.totalAberto).toBeNull();
    expect(r.maiorExposicao).toBeNull(); // UI não pode fabricar R$0 (Codex P1)
    expect(r.topN).toEqual([]);
  });
});

describe('concentracaoEmpresa — agregação + primárias', () => {
  it('agrega por código: total/maior/top1/clientes', () => {
    const r = concentracaoEmpresa([t(1, 100), t(2, 60), t(3, 40)], 'ok');
    expect(r.motivo).toBe('ok');
    expect(r.totalAberto).toBe(200);
    expect(r.maiorExposicao).toBe(100);
    expect(r.top1Pct).toBeCloseTo(0.5);
    expect(r.clientes).toBe(3);
  });
  it('mesmo código em 2 títulos soma (1 sacado, não 2)', () => {
    const r = concentracaoEmpresa([t(1, 100), t(1, 50), t(2, 50)], 'ok');
    expect(r.clientes).toBe(2);
    expect(r.maiorExposicao).toBe(150);
    expect(r.totalAberto).toBe(200);
  });
  it('top5 com <5 códigos = soma existente (=1.0)', () => {
    const r = concentracaoEmpresa([t(1, 100), t(2, 60), t(3, 40)], 'ok');
    expect(r.top5Pct).toBeCloseTo(1.0);
  });
});

describe('c50 — menor nº de códigos que somam ≥50%', () => {
  it('um código >50% → 1', () => expect(c50([0.6, 0.3, 0.1])).toBe(1));
  it('4 iguais 25% → 2', () => expect(c50([0.25, 0.25, 0.25, 0.25])).toBe(2));
  it('0.34/0.33/0.33 → 2', () => expect(c50([0.34, 0.33, 0.33])).toBe(2));
  it('via concentracaoEmpresa (maior=60%)', () => {
    const r = concentracaoEmpresa([t(1, 60), t(2, 30), t(3, 10)], 'ok');
    expect(r.c50).toBe(1);
  });
});

describe('hhi / nº efetivo (SECUNDÁRIO)', () => {
  it('hhi([0.5,0.5]) = 0.5', () => expect(hhi([0.5, 0.5])).toBeCloseTo(0.5));
  it('2 códigos iguais → hhi 0.5, nEfetivo 2', () => {
    const r = concentracaoEmpresa([t(1, 50), t(2, 50)], 'ok');
    expect(r.hhi).toBeCloseTo(0.5);
    expect(r.nEfetivo).toBeCloseTo(2);
  });
  it('1 código → hhi 1, nEfetivo 1', () => {
    const r = concentracaoEmpresa([t(1, 100)], 'ok');
    expect(r.hhi).toBeCloseTo(1);
    expect(r.nEfetivo).toBeCloseTo(1);
  });
});

describe('overlay de vencido (ATRASADO)', () => {
  it('código com ATRASADO parcial → vencido + pctVencidoProprio', () => {
    const r = concentracaoEmpresa([t(1, 70, false), t(1, 30, true), t(2, 100, false)], 'ok');
    const c1 = r.topN.find((l) => l.codigo === 1)!;
    expect(c1.saldo).toBe(100);
    expect(c1.vencido).toBe(30);
    expect(c1.pctVencidoProprio).toBeCloseTo(0.3);
  });
  it('código sem ATRASADO → vencido 0, pct 0 (NÃO null)', () => {
    const r = concentracaoEmpresa([t(1, 100, false)], 'ok');
    expect(r.topN[0].vencido).toBe(0);
    expect(r.topN[0].pctVencidoProprio).toBe(0);
  });
});

describe('linha inválida (Codex E) — NÃO some, vira fonte_parcial', () => {
  for (const bad of [NaN, -5, Infinity]) {
    it(`saldo ${bad} → linhasInvalidas + fonte_parcial, fora do total`, () => {
      const r = concentracaoEmpresa([t(1, 100), t(2, bad)], 'ok');
      expect(r.linhasInvalidas).toBe(1);
      expect(r.motivo).toBe('fonte_parcial');
      expect(r.totalAberto).toBe(100);
      expect(r.clientes).toBe(1);
    });
  }
  it('omie_codigo_cliente null → inválida (não atribuível)', () => {
    const r = concentracaoEmpresa([t(1, 100), t(null, 50)], 'ok');
    expect(r.linhasInvalidas).toBe(1);
    expect(r.motivo).toBe('fonte_parcial');
    expect(r.totalAberto).toBe(100);
  });
});

describe('impactoAbsoluto = TOM keyed na maiorExposicao (P1-5, nunca oculta)', () => {
  it('maior 20k → baixo (e topN preenchido)', () => {
    const r = concentracaoEmpresa([t(1, 20000), t(2, 5000)], 'ok');
    expect(r.impactoAbsoluto).toBe('baixo');
    expect(r.topN.length).toBeGreaterThan(0);
  });
  it('maior 54k → moderado', () => {
    const r = concentracaoEmpresa([t(1, 54000)], 'ok');
    expect(r.impactoAbsoluto).toBe('moderado');
  });
  it('maior 80k → alto', () => {
    const r = concentracaoEmpresa([t(1, 80000)], 'ok');
    expect(r.impactoAbsoluto).toBe('alto');
  });
  it('política v1 exposta e tunável', () => {
    expect(PISO_MODERADO).toBe(25000);
    expect(PISO_ALTO).toBe(75000);
  });
});

describe('classificarFonte — leitura incompleta ≠ zero (P0-1 na camada de read)', () => {
  it('error → indisponivel', () =>
    expect(classificarFonte({ error: true, rowsRetornadas: 0, countTotal: null, limit: 5000 })).toBe('indisponivel'));
  it('count total > linhas retornadas → parcial (truncado)', () =>
    expect(classificarFonte({ error: false, rowsRetornadas: 1000, countTotal: 1500, limit: 5000 })).toBe('parcial'));
  it('bateu o limite pedido sem count → parcial (defensivo)', () =>
    expect(classificarFonte({ error: false, rowsRetornadas: 5000, countTotal: null, limit: 5000 })).toBe('parcial'));
  it('sem count + bateu o cap padrão (1000) → parcial (fail-closed, Codex P1)', () =>
    expect(classificarFonte({ error: false, rowsRetornadas: 1000, countTotal: null, limit: 5000 })).toBe('parcial'));
  it('leitura completa → ok', () =>
    expect(classificarFonte({ error: false, rowsRetornadas: 782, countTotal: 782, limit: 5000 })).toBe('ok'));
});

describe('isOverdueTitleStatus — vencido por lista positiva (não complemento, Codex P1)', () => {
  it('ATRASADO / VENCIDO → true', () => {
    expect(isOverdueTitleStatus('ATRASADO')).toBe(true);
    expect(isOverdueTitleStatus('VENCIDO')).toBe(true);
  });
  it('PARCIAL → false (aberto, mas não prova de vencido)', () =>
    expect(isOverdueTitleStatus('PARCIAL')).toBe(false));
  it('A VENCER / VENCE HOJE / ABERTO / null → false', () => {
    expect(isOverdueTitleStatus('A VENCER')).toBe(false);
    expect(isOverdueTitleStatus('VENCE HOJE')).toBe(false);
    expect(isOverdueTitleStatus('ABERTO')).toBe(false);
    expect(isOverdueTitleStatus(null)).toBe(false);
  });
});
