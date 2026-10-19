// scripts/orcamento-compra/r59-exclusoes-aprovadas.test.ts — a lista é DADO revisado; o guard impede a entrada que
// a aprovação não conseguiria casar (sem identificadores) ou que não diz por que foi aprovada.
import { describe, expect, it } from 'vitest';
import { EXCLUSOES_R59_APROVADAS } from './r59-exclusoes-aprovadas';

describe('R59 v2 — lista aprovada de exclusões do caixa', () => {
  it('toda entrada tem identidade completa, identificadores revisados e evidência', () => {
    for (const e of EXCLUSOES_R59_APROVADAS) {
      expect(Number.isSafeInteger(e.disparado_id) && e.disparado_id > 0, `disparado_id ${e.disparado_id}`).toBe(true);
      expect(e.omie_pedido, `omie_pedido de ${e.numero}`).toMatch(/^\d+$/);
      expect(e.identificadores.length, `identificadores de ${e.numero}`).toBeGreaterThan(0);
      expect(e.identificadores.every((x) => x.trim() === x && x.length > 0), `identificador com espaço/vazio em ${e.numero}`).toBe(true);
      expect(e.evidencia.length, `evidência de ${e.numero}`).toBeGreaterThan(10);
      expect(e.aprovado_em, `aprovado_em de ${e.numero}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it('sem duplicata de disparado nem de pedido Omie', () => {
    const ids = EXCLUSOES_R59_APROVADAS.map((e) => e.disparado_id);
    const omie = EXCLUSOES_R59_APROVADAS.map((e) => e.omie_pedido);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(omie).size).toBe(omie.length);
  });
  it('o 1230 (atendido total na Sayerlack, 2026-10-19) NÃO está aprovado', () => {
    expect(EXCLUSOES_R59_APROVADAS.some((e) => e.disparado_id === 2790 || e.omie_pedido === '12184846749')).toBe(false);
  });
});
