import { describe, it, expect } from 'vitest';
import { parseMetaResposta, agregarMeta, type LinhaMeta } from '@/lib/dashboard/meta-potencial';

function linha(p: Partial<LinhaMeta>): LinhaMeta {
  return {
    account: 'oben', owner_user_id: 'r', owner_nome: 'Regina', owner_ativo: true,
    base: 1000, esp_c: 100, esp_d: 50, novos: 0, inc_c: 10, inc_d: 5, inc_b: 20, inc_cross: 2,
    taxa_c: 0.2, taxa_d: 0.07, indice_sazonal: 1, meta: 1187, n_a: 1, n_b: 2, n_c: 3, n_d: 4, realizado: 400,
    ...p,
  };
}
const resp = (linhas: LinhaMeta[], extra: Record<string, unknown> = {}) =>
  parseMetaResposta({
    mes: '2026-11-01', versao: 1, status: 'congelada', linhas,
    dias_uteis: { oben: { total: 19, restantes: 5 }, colacor: { total: 21, restantes: 6 } },
    dias_uteis_grupo: { total: 21, restantes: 6 },
    ...extra,
  });

describe('parseMetaResposta', () => {
  it('lança em resposta malformada (não vira meta zero)', () => {
    expect(() => parseMetaResposta(null)).toThrow('meta_potencial_mes: resposta malformada');
    expect(() => parseMetaResposta({ status: 'congelada' })).toThrow('meta_potencial_mes: resposta malformada');
  });
});

describe('agregarMeta', () => {
  it('single: soma só a conta e usa os dias úteis dela', () => {
    const a = agregarMeta(resp([linha({}), linha({ account: 'colacor', meta: 500, realizado: 100 })]), 'oben');
    expect(a.meta).toBe(1187);
    expect(a.realizado).toBe(400);
    expect(a.pct).toBeCloseTo(400 / 1187);
    expect(a.diasRestantes).toBe(5);
    expect(a.ritmo).toBeCloseTo((1187 - 400) / 5);
    expect(a.previsao).toBe(1150);
    expect(a.incremento).toBe(37);
  });

  it("'all': soma as contas e usa os dias do grupo", () => {
    const a = agregarMeta(resp([linha({}), linha({ account: 'colacor', meta: 500, realizado: 100 })]), 'all');
    expect(a.meta).toBe(1687);
    expect(a.realizado).toBe(500);
    expect(a.diasRestantes).toBe(6);
  });

  it("'all' com uma conta sem meta → meta do grupo indisponível (nunca soma parcial)", () => {
    const a = agregarMeta(resp([linha({}), linha({ account: 'colacor', meta: null })]), 'all');
    expect(a.meta).toBeNull();
    expect(a.pct).toBeNull();
    expect(a.ritmo).toBeNull();
    expect(a.contasSemMeta).toEqual(['colacor']);
  });

  it('conta sem linhas (Colacor SC) → indisponível, não R$ 0', () => {
    const a = agregarMeta(resp([linha({})]), 'colacor_sc');
    expect(a.meta).toBeNull();
    expect(a.semLinhas).toBe(true);
  });

  it('meta batida → ritmo 0 e batida=true; sem dias restantes → ritmo null', () => {
    const b = agregarMeta(resp([linha({ realizado: 2000 })]), 'oben');
    expect(b.batida).toBe(true);
    expect(b.ritmo).toBe(0);
    const s = agregarMeta(resp([linha({})], { dias_uteis: { oben: { total: 19, restantes: 0 } } }), 'oben');
    expect(s.ritmo).toBeNull();
  });

  it('vendedoras: agrega por dono entre contas, marca inativa e "sem dono"', () => {
    const a = agregarMeta(
      resp([
        linha({}),
        linha({ account: 'colacor', meta: 500, realizado: 100 }),
        linha({ owner_user_id: 't', owner_nome: 'Tatyana', owner_ativo: false, meta: 300, realizado: 0 }),
        linha({ owner_user_id: null, owner_nome: null, owner_ativo: false, meta: 80, realizado: 20 }),
      ]),
      'all',
    );
    expect(a.vendedoras.map((v) => [v.nome, v.meta, v.realizado, v.ativo])).toEqual([
      ['Regina', 1687, 500, true],
      ['Tatyana', 300, 0, false],
      ['Sem dono / clientes novos', 80, 20, false],
    ]);
  });
});
