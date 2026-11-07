import { describe, expect, it } from 'vitest';
import { familiasHerdadas, lerHerancaComprador, textoHeranca } from '../heranca';
import { lerMinhasSugestoes, rotuloHeranca } from '../sugestoes';
import { adaptarRecompra } from '@/lib/fila/adapters/recompra';

/**
 * Sucessor declarado nos consumidores do vendedor (migration 20261108000000): a lista traz a origem da herança e a
 * marca "preço de referência da antiga" — o front ROTULA, não esconde; forma errada LANÇA; servidor anterior (sem as
 * chaves) segue lendo como "própria". A herança da ficha (`venda_heranca_comprador`) só tem itens e datas.
 */
const sugestao = (o: Record<string, unknown> = {}) => ({
  id: 's1', tipo: 'recompra', empresa: 'oben', omie_codigo_produto: 1004, descricao: 'VERNIZ A', familia: null,
  qtd_ref: 10, valor_ref: 100, preco_alvo: null, cadencia_dias: 30, ...o,
});
const resp = (sugestoes: unknown[], c: Record<string, unknown> = {}) => ({
  dia: '2026-11-08', ondas: { recompra: true, complemento: false, preco: false },
  compradores: [{ comprador_id: 'c1', nome: 'NOVA DOIS', telefone: null, motivo_entrada: 'recompra atrasada',
    valor_ref_total: 200, sugestoes, ...c }],
});

describe('lerMinhasSugestoes — herança', () => {
  it('a herdada carrega de quem veio e o preço da antiga; a própria não', () => {
    const r = lerMinhasSugestoes(resp([
      sugestao({ sucessao_origem: [{ evento_id: 'ev1', revisao: 1 }], herdada_de: ['DIVIMOVEIS'], valor_ref_referencia_origem: true }),
      sugestao({ id: 's2', sucessao_origem: null, herdada_de: null, valor_ref_referencia_origem: false }),
    ], { valor_ref_total_referencia_origem: true }));
    const [h, p] = r.compradores[0].sugestoes;
    expect(h.heranca).toEqual({ de: ['DIVIMOVEIS'] });
    expect(h.valorRefDaAntiga).toBe(true);
    expect(rotuloHeranca(h)).toBe('herdado de DIVIMOVEIS');
    expect(p.heranca).toBeNull();
    expect(p.valorRefDaAntiga).toBe(false);
    expect(rotuloHeranca(p)).toBeNull();
    expect(r.compradores[0].valorRefTotalDaAntiga).toBe(true);
  });
  it('servidor anterior à migration (sem as chaves): lê como própria, sem marca', () => {
    const r = lerMinhasSugestoes(resp([sugestao()]));
    expect(r.compradores[0].sugestoes[0].heranca).toBeNull();
    expect(r.compradores[0].sugestoes[0].valorRefDaAntiga).toBe(false);
    expect(r.compradores[0].valorRefTotalDaAntiga).toBe(false);
  });
  it('herdada sem nome resolvido ainda é herdada ("empresa anterior")', () => {
    const r = lerMinhasSugestoes(resp([sugestao({ sucessao_origem: [{ evento_id: 'ev1' }], herdada_de: null })]));
    expect(rotuloHeranca(r.compradores[0].sugestoes[0])).toBe('herdado de empresa anterior');
  });
  it('forma errada LANÇA: herança ilegível nunca vira "própria" calada', () => {
    expect(() => lerMinhasSugestoes(resp([sugestao({ sucessao_origem: 'ev1' })])))
      .toThrow('venda_minhas_sugestoes: sucessao_origem malformada');
    expect(() => lerMinhasSugestoes(resp([sugestao({ sucessao_origem: [] })])))
      .toThrow('venda_minhas_sugestoes: sucessao_origem malformada');
    expect(() => lerMinhasSugestoes(resp([sugestao({ sucessao_origem: [{}], herdada_de: [1] })])))
      .toThrow('venda_minhas_sugestoes: herdada_de malformada');
    expect(() => lerMinhasSugestoes(resp([sugestao({ valor_ref_referencia_origem: 'sim' })])))
      .toThrow('venda_minhas_sugestoes: valor_ref_referencia_origem malformado');
  });
});

describe('adaptarRecompra — herança na fila', () => {
  it('diz quantos itens são herdados e de quem, e que o valor usa o preço da antiga', () => {
    const r = lerMinhasSugestoes(resp([
      sugestao({ sucessao_origem: [{ evento_id: 'ev1' }], herdada_de: ['DIVIMOVEIS'], valor_ref_referencia_origem: true }),
      sugestao({ id: 's2' }),
    ], { valor_ref_total_referencia_origem: true }));
    expect(adaptarRecompra(r)[0].motivo).toBe('recompra atrasada · 2 itens atrasados · 1 herdado de DIVIMOVEIS (valor com preço da antiga)');
  });
  it('sem herança, o motivo não muda', () => {
    expect(adaptarRecompra(lerMinhasSugestoes(resp([sugestao()])))[0].motivo).toBe('recompra atrasada · 1 item atrasado');
  });
});

describe('lerHerancaComprador', () => {
  const cru = (o: Record<string, unknown> = {}) => ({
    herancas: [{ papel: 'novo', evento_id: 'ev1', declaracao_id: 'd2', tipo: 'cisao', data_corte: '2026-10-06', revisao: 1,
      outro_documento: '03166577000166', outro_nome: 'DIVIMOVEIS',
      itens: [{ empresa: 'oben', omie_codigo_produto: 1004, descricao: 'VERNIZ A', familia: 'VERNIZ' }], ...o }],
  });
  it('lê e descreve a herança e o repasse', () => {
    const [h] = lerHerancaComprador(cru());
    expect(textoHeranca(h)).toBe('Herdou 1 item de DIVIMOVEIS (cisão, corte em 06/10/2026)');
    const [a] = lerHerancaComprador(cru({ papel: 'antigo', tipo: 'sucessao', outro_nome: null, outro_documento: '22222222000122' }));
    expect(textoHeranca(a)).toBe('Repassou 1 item para 22222222000122 (sucessão, corte em 06/10/2026)');
  });
  it('famílias herdadas só do papel novo, por família|empresa', () => {
    expect([...familiasHerdadas(lerHerancaComprador(cru())).entries()]).toEqual([['VERNIZ|oben', 'DIVIMOVEIS']]);
    expect(familiasHerdadas(lerHerancaComprador(cru({ papel: 'antigo' }))).size).toBe(0);
  });
  it('forma errada LANÇA', () => {
    expect(() => lerHerancaComprador({})).toThrow('venda_heranca_comprador: resposta fora da forma esperada');
    expect(() => lerHerancaComprador(cru({ papel: 'meio' }))).toThrow('venda_heranca_comprador: herança fora da forma esperada');
    expect(() => lerHerancaComprador(cru({ itens: [{ empresa: 'oben' }] }))).toThrow('venda_heranca_comprador: item fora da forma esperada');
  });
});
