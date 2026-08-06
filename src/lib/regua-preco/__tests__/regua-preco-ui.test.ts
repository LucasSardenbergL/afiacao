import { describe, it, expect } from 'vitest';
import { dedupeFetchItens, montarInputRegua, chaveFetch, CAPS_REGUA } from '../regua-preco-ui';
import type { FetchDataRegua, ReguaCartItem } from '../regua-preco-ui';

const item = (over: Partial<ReguaCartItem> = {}): ReguaCartItem => ({
  chave: 'oben:101:', productId: 'p1', qty: 2, precoAtual: 106, ...over,
});

describe('dedupeFetchItens', () => {
  it('colapsa mesmo (productId, qty, preço) numa única busca', () => {
    const r = dedupeFetchItens([item(), item({ chave: 'oben:101:x' }), item({ productId: 'p2' })]);
    expect(r).toHaveLength(2);
    expect(r.map(chaveFetch).sort()).toEqual(['p1:2:106', 'p2:2:106']);
  });
  // O preço entrou na chave em FU4-F fase 2: a comparação preço<piso virou do servidor, então
  // duas linhas do mesmo SKU/qty com preços diferentes são DECISÕES diferentes. Colapsá-las
  // mostraria o sinal de uma linha na outra.
  it('NÃO colapsa mesmo (productId, qty) com preços diferentes', () => {
    const r = dedupeFetchItens([item(), item({ chave: 'oben:101:y', precoAtual: 99 })]);
    expect(r).toHaveLength(2);
    expect(r.map(chaveFetch).sort()).toEqual(['p1:2:106', 'p1:2:99']);
  });
  it('descarta itens sem productId, qty<=0 ou preço<=0', () => {
    expect(dedupeFetchItens([
      item({ productId: '' }), item({ qty: 0 }), item({ precoAtual: 0 }),
    ])).toHaveLength(0);
  });
});

describe('montarInputRegua', () => {
  const fetch: FetchDataRegua = {
    abaixo_piso: true, piso_disponivel: true, cmc_confiavel: true, prazo_aplicado: false,
    piso_mc: 106.29, piso_gap_pct: 0.0027,
    precos_cliente: [112, 110], comparaveis: [{ preco: 120, c: 1 }, { preco: 125, c: 2 }],
  };
  it('mapeia comparaveis {preco,c} → {preco,clienteId}, monta o veredito e injeta CAPS', () => {
    const inp = montarInputRegua(fetch, 106);
    expect(inp.precoAtual).toBe(106);
    expect(inp.piso.abaixoPiso).toBe(true);
    expect(inp.piso.disponivel).toBe(true);
    expect(inp.piso.piso).toBe(106.29);
    expect(inp.piso.cmcConfiavel).toBe(true);
    expect(inp.precosCliente).toEqual([112, 110]);
    expect(inp.comparaveis).toEqual([{ preco: 120, clienteId: '1' }, { preco: 125, clienteId: '2' }]);
    expect(inp.caps).toBe(CAPS_REGUA);
  });
  it('tolera arrays nulos vindos da RPC (degrada p/ vazio)', () => {
    const inp = montarInputRegua({ ...fetch, precos_cliente: null as never, comparaveis: null as never }, 106);
    expect(inp.precosCliente).toEqual([]);
    expect(inp.comparaveis).toEqual([]);
  });
  // Fail-closed campo a campo: RPC velha em cache, campo ausente, undefined — nada disso pode
  // virar "true" nem número. Ausente ≠ zero aplicado à AUTORIZAÇÃO.
  it('payload sem os campos novos degrada fail-closed (nada de sinal nem de número)', () => {
    const inp = montarInputRegua({} as FetchDataRegua, 106);
    expect(inp.piso.abaixoPiso).toBe(false);
    expect(inp.piso.disponivel).toBe(false);
    expect(inp.piso.piso).toBeNull();
    expect(inp.piso.gapPct).toBeNull();
    expect(inp.piso.cmcConfiavel).toBe(false);
    expect(inp.piso.prazoAplicado).toBe(false);
  });
  it('piso mascarado (piso_mc null) preserva o SINAL', () => {
    const inp = montarInputRegua({ ...fetch, piso_mc: null, piso_gap_pct: null }, 106);
    expect(inp.piso.abaixoPiso).toBe(true);
    expect(inp.piso.disponivel).toBe(true);
    expect(inp.piso.piso).toBeNull();
  });
});
