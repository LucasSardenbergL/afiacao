import { describe, it, expect } from 'vitest';
import { adaptarRecompra } from '../adapters/recompra';
import { lerMinhasSugestoes } from '@/lib/venda-cliente/sugestoes';

const cru = {
  dia: '2026-10-21',
  compradores: [
    {
      comprador_id: 'c1', nome: 'Marcenaria A', telefone: '(37) 99999-0000',
      motivo_entrada: 'entrega amanhã em Divinopolis', valor_ref_total: 1200.5,
      sugestoes: [
        { id: 's1', tipo: 'recompra', empresa: 'oben', omie_codigo_produto: 10, descricao: 'Verniz', familia: null, qtd_ref: 2, valor_ref: 800, preco_alvo: null },
        { id: 's2', tipo: 'recompra', empresa: 'colacor', omie_codigo_produto: 20, descricao: 'Lixa', familia: null, qtd_ref: 5, valor_ref: 400.5, preco_alvo: null },
      ],
    },
    {
      comprador_id: 'c2', nome: null, telefone: null,
      motivo_entrada: 'maior atraso da carteira', valor_ref_total: null,
      sugestoes: [
        { id: 's3', tipo: 'recompra', empresa: 'oben', omie_codigo_produto: 30, descricao: null, familia: null, qtd_ref: null, valor_ref: null, preco_alvo: null },
      ],
    },
  ],
};

describe('adaptarRecompra', () => {
  const acoes = adaptarRecompra(lerMinhasSugestoes(cru));

  it('1 ação por comprador, cta ligar, categoria esperado', () => {
    expect(acoes).toHaveLength(2);
    const a = acoes.find((x) => x.clienteUserId === 'c1')!;
    expect(a.fonte).toBe('recompra');
    expect(a.cta).toBe('ligar');
    expect(a.categoria).toBe('esperado');
    expect(a.telefone).toBe('(37) 99999-0000');
    expect(a.motivo).toBe('entrega amanhã em Divinopolis · 2 itens atrasados');
    expect(a.valorEsperado).toBe(1200.5);
    expect(a.payload).toEqual({ kind: 'recompra', compradorId: 'c1', sugestaoIds: ['s1', 's2'] });
  });

  it('comprador sem valor → valorEsperado null (ausente ≠ zero)', () => {
    const b = acoes.find((x) => x.clienteUserId === 'c2')!;
    expect(b.valorEsperado).toBeNull();
    expect(b.tipoValor).toBe('sem_valor');
    expect(b.motivo).toBe('maior atraso da carteira · 1 item atrasado');
  });

  it('dedupeKey estável por comprador', () => {
    expect(acoes.map((a) => a.dedupeKey)).toEqual(['recompra:c1', 'recompra:c2']);
    expect(adaptarRecompra(lerMinhasSugestoes(cru)).map((a) => a.dedupeKey)).toEqual(['recompra:c1', 'recompra:c2']);
  });

  it('comprador só com sugestões de outras ondas não vira ação de recompra', () => {
    const r = lerMinhasSugestoes({
      dia: '2026-10-21',
      compradores: [{ comprador_id: 'c3', nome: 'X', telefone: null, motivo_entrada: 'm', valor_ref_total: null,
        sugestoes: [{ id: 's9', tipo: 'complemento', empresa: 'oben', omie_codigo_produto: null, descricao: null, familia: 'Lixas', qtd_ref: null, valor_ref: null, preco_alvo: null }] }],
    });
    expect(adaptarRecompra(r)).toEqual([]);
  });

  it('total parcial (item sem preço) → piso = soma dos conhecidos, nunca null nem o item como 0', () => {
    const r = lerMinhasSugestoes({
      dia: '2026-10-28',
      compradores: [{ comprador_id: 'c5', nome: 'Grande', telefone: null, motivo_entrada: 'm', valor_ref_total: null,
        sugestoes: [
          { id: 'p1', tipo: 'recompra', empresa: 'oben', omie_codigo_produto: 1, descricao: null, familia: null, qtd_ref: 1, valor_ref: 30000, preco_alvo: null },
          { id: 'p2', tipo: 'recompra', empresa: 'oben', omie_codigo_produto: 2, descricao: null, familia: null, qtd_ref: 1, valor_ref: null, preco_alvo: null },
          { id: 'p3', tipo: 'recompra', empresa: 'colacor', omie_codigo_produto: 3, descricao: null, familia: null, qtd_ref: 1, valor_ref: 4221, preco_alvo: null },
          { id: 'p4', tipo: 'complemento', empresa: 'oben', omie_codigo_produto: null, descricao: null, familia: 'X', qtd_ref: null, valor_ref: 999, preco_alvo: null },
        ] }],
    });
    const [a] = adaptarRecompra(r);
    expect(a.valorEsperado).toBe(34221);
    expect(a.tipoValor).toBe('piso');
  });

  it('null → []', () => {
    expect(adaptarRecompra(null)).toEqual([]);
  });
});

describe('lerMinhasSugestoes', () => {
  it('forma inesperada lança (fail-closed, não vira lista vazia)', () => {
    expect(() => lerMinhasSugestoes(null)).toThrow('resposta sem compradores');
    expect(() => lerMinhasSugestoes({ dia: '2026-10-21' })).toThrow('resposta sem compradores');
    expect(() => lerMinhasSugestoes({ dia: '2026-10-21', compradores: [{ nome: 'x', sugestoes: [] }] }))
      .toThrow('campo comprador_id ausente');
  });

  it('número ausente vira null, não 0', () => {
    const r = lerMinhasSugestoes(cru);
    const s3 = r.compradores[1].sugestoes[0];
    expect(s3.qtdRef).toBeNull();
    expect(s3.valorRef).toBeNull();
    expect(r.compradores[1].valorRefTotal).toBeNull();
  });
});
