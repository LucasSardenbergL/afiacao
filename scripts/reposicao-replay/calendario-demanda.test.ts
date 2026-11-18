import { describe, expect, it } from 'vitest';
import { fatorCalendario, lerCalendario, type StatusCalendario } from './calendario-demanda';
import { addDias } from '../../src/lib/reposicao/orcamento-compra/datas';

// Paridade com a função SQL calendario_fator_demanda (db/test-calendario-demanda.sh F01–F08): mesmos cenários,
// mesmos números. Janela de 91 dias = 13 semanas = 65 dias úteis.
const uteis = (ini: string, fim: string): string[] => {
  const r: string[] = [];
  for (let d = ini; d <= fim; d = addDias(d, 1)) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) r.push(d);
  }
  return r;
};
const fechar = (fim: string, k: number, st: StatusCalendario): Map<string, StatusCalendario> =>
  new Map(uteis(addDias(fim, -90), fim).slice(0, k).map((d) => [d, st]));
const f = (cal: Map<string, StatusCalendario>, fim: string) => fatorCalendario(cal, addDias(fim, -90), fim);

describe('fatorCalendario (espelho da SQL)', () => {
  it('janela sem exceção: fator 1 exato', () => {
    expect(f(new Map(), '2026-09-04')).toEqual({ diasBase: 65, diasEfetivos: 65, diasPendentes: 0, fator: 1, baixaConfianca: false });
  });
  it('recesso 11/65 e sábado aberto fora de U e W', () => {
    const cal = new Map<string, StatusCalendario>(uteis('2026-12-18', '2027-01-01').map((d) => [d, 'fechado']));
    cal.set('2027-01-09', 'aberto');
    const r = f(cal, '2027-01-20');
    expect([r.diasBase, r.diasEfetivos, r.fator.toFixed(4), r.baixaConfianca]).toEqual([65, 54, '1.2037', false]);
  });
  it('teto 1,35 e borda W/U = 0,6 (não é guarda)', () => {
    expect(f(fechar('2024-03-29', 20, 'fechado'), '2024-03-29').fator).toBe(1.35);
    expect(f(fechar('2024-11-29', 26, 'fechado'), '2024-11-29')).toMatchObject({ diasEfetivos: 39, fator: 1.35, baixaConfianca: false });
  });
  it('guarda W/U < 0,6 ⇒ fator 1 + baixa confiança', () => {
    expect(f(fechar('2024-07-31', 27, 'fechado'), '2024-07-31')).toMatchObject({ diasEfetivos: 38, fator: 1, baixaConfianca: true });
  });
  it('janela toda fechada: nem zero nem explode', () => {
    expect(f(fechar('2025-03-31', 65, 'fechado'), '2025-03-31')).toMatchObject({ diasEfetivos: 0, fator: 1, baixaConfianca: true });
  });
  it('pendente_dado sai de U e W; meia_equipe pesa 1', () => {
    const cal = fechar('2025-07-31', 5, 'pendente_dado');
    for (const d of uteis('2025-07-01', '2025-07-31').slice(0, 5)) cal.set(d, 'fechado');
    expect(f(cal, '2025-07-31')).toMatchObject({ diasBase: 60, diasEfetivos: 55, diasPendentes: 5 });
    expect(f(fechar('2025-11-28', 5, 'meia_equipe'), '2025-11-28').fator).toBe(1);
  });
  it('calendário ilegível ou vazio LANÇA (não vira fator 1)', () => {
    expect(() => lerCalendario('2026-12-18|fechadx\n')).toThrow(/calendário ilegível/);
    expect(() => lerCalendario('\n')).toThrow(/calendário vazio/);
    expect(lerCalendario('2026-12-18|fechado\n').get('2026-12-18')).toBe('fechado');
  });
});
