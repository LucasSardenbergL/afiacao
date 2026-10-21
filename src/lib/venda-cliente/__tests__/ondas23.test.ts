import { describe, it, expect } from 'vitest';
import { lerMinhasSugestoes, sugestoesDeComplemento, sugestoesDePreco, sugestoesDeRecompra } from '../sugestoes';
import { lerComplementoComprador } from '../complemento';
import { lerPrecoAlvoComprador } from '../preco';

const base = {
  dia: '2026-10-21',
  compradores: [{
    comprador_id: 'c1', nome: 'A', telefone: null, motivo_entrada: 'maior atraso da carteira', valor_ref_total: 100,
    sugestoes: [
      { id: 'r1', tipo: 'recompra', empresa: 'oben', omie_codigo_produto: 1, cadencia_dias: 30, valor_ref: 100 },
      { id: 'k1', tipo: 'complemento', empresa: 'oben', familia: 'SELADORES' },
      { id: 'p1', tipo: 'preco', empresa: 'oben', omie_codigo_produto: 1, preco_alvo: 11 },
    ],
  }],
};

describe('lerMinhasSugestoes — ondas e tipos (Task 9)', () => {
  it('lê as ondas do servidor e a cadência da recompra', () => {
    const r = lerMinhasSugestoes({ ...base, ondas: { recompra: true, complemento: true, preco: false } });
    expect(r.ondas).toEqual({ complemento: true, preco: false });
    expect(sugestoesDeRecompra(r.compradores[0]).map((s) => s.cadenciaDias)).toEqual([30]);
  });

  it('ondas ausentes (servidor anterior à migration) → seções desligadas, a lista segue', () => {
    const r = lerMinhasSugestoes(base);
    expect(r.ondas).toEqual({ complemento: false, preco: false });
    expect(r.compradores).toHaveLength(1);
  });

  it('ondas com forma errada → lança (fail-closed, não liga seção por engano)', () => {
    expect(() => lerMinhasSugestoes({ ...base, ondas: { complemento: 'sim', preco: true } }))
      .toThrow('venda_minhas_sugestoes: ondas malformadas');
  });

  it('separa recompra, complemento e preço sem misturar (sem score comum)', () => {
    const c = lerMinhasSugestoes(base).compradores[0];
    expect(sugestoesDeRecompra(c).map((s) => s.id)).toEqual(['r1']);
    expect(sugestoesDeComplemento(c).map((s) => s.id)).toEqual(['k1']);
    expect(sugestoesDePreco(c).map((s) => s.id)).toEqual(['p1']);
  });
});

describe('lerComplementoComprador', () => {
  it('lê famílias e SKUs; skus [] fica []', () => {
    expect(lerComplementoComprador({ familias: [
      { familia: 'F', empresa: 'oben', confidence: 0.5, lift: 2, skus: [{ omie_codigo_produto: 7, descricao: 'X' }] },
      { familia: 'G', empresa: 'colacor', skus: [] },
    ] })).toEqual([
      { familia: 'F', empresa: 'oben', skus: [{ omieCodigoProduto: 7, descricao: 'X' }] },
      { familia: 'G', empresa: 'colacor', skus: [] },
    ]);
  });

  it('forma inesperada → lança com a marca do ramo', () => {
    expect(() => lerComplementoComprador(null)).toThrow('venda_complemento_comprador: resposta sem familias');
    expect(() => lerComplementoComprador({ familias: [{ familia: '', empresa: 'oben', skus: [] }] }))
      .toThrow('venda_complemento_comprador: família malformada');
    expect(() => lerComplementoComprador({ familias: [{ familia: 'F', empresa: 'oben', skus: [{ descricao: 'X' }] }] }))
      .toThrow('venda_complemento_comprador: SKU malformado');
  });
});

describe('lerPrecoAlvoComprador', () => {
  const ok = { empresa: 'oben', omie_codigo_produto: 10, ultimo_preco: 200, preco_alvo: 230, faixa_margem: 'amarelo', valido_ate: '2026-12-31' };

  it('guarda só o exibível; campo extra (ex.: custo) é descartado', () => {
    const [a] = lerPrecoAlvoComprador([{ ...ok, cmc: 150, markup: 1.5 }]);
    expect(a).toEqual({ empresa: 'oben', omieCodigoProduto: 10, ultimoPreco: 200, precoAlvo: 230, faixaMargem: 'amarelo', validoAte: '2026-12-31' });
    expect(Object.keys(a)).not.toContain('cmc');
  });

  it('último preço ausente/zero vira null (ausente ≠ zero)', () => {
    expect(lerPrecoAlvoComprador([{ ...ok, ultimo_preco: null }])[0].ultimoPreco).toBeNull();
    expect(lerPrecoAlvoComprador([{ ...ok, ultimo_preco: 0 }])[0].ultimoPreco).toBeNull();
  });

  it('alvo ausente/zero ou faixa desconhecida → lança (nunca exibe alvo que não leu)', () => {
    expect(() => lerPrecoAlvoComprador({})).toThrow('venda_preco_alvo_comprador: resposta não é lista');
    expect(() => lerPrecoAlvoComprador([{ ...ok, preco_alvo: null }])).toThrow('venda_preco_alvo_comprador: item malformado');
    expect(() => lerPrecoAlvoComprador([{ ...ok, preco_alvo: 0 }])).toThrow('venda_preco_alvo_comprador: item malformado');
    expect(() => lerPrecoAlvoComprador([{ ...ok, faixa_margem: 'roxo' }])).toThrow('venda_preco_alvo_comprador: item malformado');
  });
});
