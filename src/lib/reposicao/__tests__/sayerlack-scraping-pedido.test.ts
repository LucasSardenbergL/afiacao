import { describe, it, expect } from 'vitest';
import {
  parseBRL, parseDiasPrzEnt, casarLinhasComItens, validarGrupoLeadtime, derivarCustos,
  type ItemPedido, type LinhaPortal,
} from '../sayerlack-scraping-pedido';

const item = (o: Partial<ItemPedido> = {}): ItemPedido => ({
  item_id: 1, sku_codigo_omie: 'OMIE1', sku_descricao: 'd', sku_portal: 'P1', qtde_final: 2, preco_atual: 10, ...o,
});
const linha = (o: Partial<LinhaPortal> = {}): LinhaPortal => ({ sku_portal: 'P1', prz_ent_raw: '8', total_raw: '20,00', ...o });

describe('parseBRL', () => {
  it('parseia formato pt-BR (ponto=milhar, vírgula=decimal)', () => {
    expect(parseBRL('1.234,56')).toBe(1234.56);
    expect(parseBRL('R$ 90,21')).toBe(90.21);
    expect(parseBRL('408,36')).toBe(408.36);
    expect(parseBRL('0,00')).toBe(0);
  });
  it('retorna null pra lixo', () => {
    expect(parseBRL('')).toBeNull();
    expect(parseBRL('abc')).toBeNull();
    expect(parseBRL(null as unknown as string)).toBeNull();
  });
});

describe('parseDiasPrzEnt', () => {
  it('extrai o inteiro de dias', () => {
    expect(parseDiasPrzEnt('8')).toBe(8);
    expect(parseDiasPrzEnt('8 dias')).toBe(8);
    expect(parseDiasPrzEnt('12')).toBe(12);
  });
  it('retorna null pra vazio/sem número', () => {
    expect(parseDiasPrzEnt('')).toBeNull();
    expect(parseDiasPrzEnt('—')).toBeNull();
  });
});

describe('casarLinhasComItens', () => {
  it('casa por sku_portal e parseia prz/total', () => {
    const r = casarLinhasComItens([linha()], [item()]);
    expect(r.casados).toHaveLength(1);
    expect(r.casados[0].prz_ent).toBe(8);
    expect(r.casados[0].total_linha).toBe(20);
    expect(r.naoCasados).toHaveLength(0);
    expect(r.ambiguos).toHaveLength(0);
  });
  it('item sem linha no portal vira naoCasado', () => {
    const r = casarLinhasComItens([], [item()]);
    expect(r.naoCasados).toHaveLength(1);
    expect(r.casados).toHaveLength(0);
  });
  it('sku_portal em 2 itens vira ambíguo (de-para não é único por sku_portal)', () => {
    const r = casarLinhasComItens([linha()], [item({ item_id: 1 }), item({ item_id: 2, sku_codigo_omie: 'OMIE2' })]);
    expect(r.ambiguos).toHaveLength(2);
    expect(r.casados).toHaveLength(0);
  });
  it('sku_portal em 2 linhas vira ambíguo', () => {
    const r = casarLinhasComItens([linha(), linha({ total_raw: '99,00' })], [item()]);
    expect(r.ambiguos).toHaveLength(1);
    expect(r.casados).toHaveLength(0);
  });
  it('item com sku_portal nulo vira naoCasado', () => {
    const r = casarLinhasComItens([linha()], [item({ sku_portal: null })]);
    expect(r.naoCasados).toHaveLength(1);
  });
});

describe('validarGrupoLeadtime', () => {
  const matchDe = (arr: Array<{ sku?: string; prz: number | null }>) => ({
    casados: arr.map((a, i) => ({ item: item({ item_id: i, sku_codigo_omie: a.sku ?? 'O' + i }), prz_ent: a.prz, total_linha: 1 })),
    naoCasados: [], ambiguos: [],
  });
  it('ok quando todos os prz batem o esperado', () => {
    const r = validarGrupoLeadtime(matchDe([{ prz: 8 }, { prz: 8 }]), 8);
    expect(r.status).toBe('ok');
    expect(r.mismatches).toHaveLength(0);
  });
  it('mismatch quando ≥1 prz difere', () => {
    const r = validarGrupoLeadtime(matchDe([{ prz: 8 }, { sku: 'X', prz: 12 }]), 8);
    expect(r.status).toBe('mismatch');
    expect(r.mismatches).toEqual([{ sku_codigo_omie: 'X', prz_ent: 12, lt_esperado: 8 }]);
  });
  it('indisponivel quando ltEsperado é null (sem config de grupo)', () => {
    expect(validarGrupoLeadtime(matchDe([{ prz: 8 }]), null).status).toBe('indisponivel');
  });
  it('indisponivel quando nada parseável (prz null)', () => {
    expect(validarGrupoLeadtime(matchDe([{ prz: null }]), 8).status).toBe('indisponivel');
  });
  it('prz null não conta como mismatch — só pulado', () => {
    const r = validarGrupoLeadtime(matchDe([{ prz: 8 }, { sku: 'N', prz: null }]), 8);
    expect(r.status).toBe('ok');
    expect(r.pulados).toContain('N');
  });
});

describe('derivarCustos', () => {
  const matchCusto = (o: { qtde: number; preco_atual: number; total: number | null }) => ({
    casados: [{ item: item({ item_id: 7, qtde_final: o.qtde, preco_atual: o.preco_atual }), prz_ent: 8, total_linha: o.total }],
    naoCasados: [], ambiguos: [],
  });
  it('deriva unitário = total/qtde e sobrescreve quando difere', () => {
    const r = derivarCustos(matchCusto({ qtde: 4, preco_atual: 100, total: 1633.45 }));
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0].item_id).toBe(7);
    expect(r.updates[0].valor_linha).toBe(1633.45);
    expect(r.updates[0].preco_unitario).toBeCloseTo(408.3625, 4);
  });
  it('mantém (não sobrescreve) quando o total da linha bate ao centavo', () => {
    const r = derivarCustos(matchCusto({ qtde: 4, preco_atual: 408.36, total: 1633.44 })); // 4*408.36=1633.44
    expect(r.updates).toHaveLength(0);
    expect(r.pulados[0]).toMatchObject({ motivo: 'sem_mudanca' });
  });
  it('pula total inválido (<=0 ou null) sem fabricar custo', () => {
    expect(derivarCustos(matchCusto({ qtde: 4, preco_atual: 1, total: 0 })).updates).toHaveLength(0);
    expect(derivarCustos(matchCusto({ qtde: 4, preco_atual: 1, total: null })).updates).toHaveLength(0);
  });
  it('pula qtde inválida', () => {
    expect(derivarCustos(matchCusto({ qtde: 0, preco_atual: 1, total: 10 })).updates).toHaveLength(0);
  });
});
