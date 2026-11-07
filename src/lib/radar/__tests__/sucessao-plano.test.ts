import { describe, expect, it } from 'vitest';
import {
  aplicarFamilia, lerItensDoPlano, lerPlanoDoEvento, lerResultadoPlano, mensagemRecusaPlano, mesmoRascunho,
  rascunhoDoPlano, regrasDoRascunho, resumoRascunho, type ItemDaAntiga,
} from '../sucessao-plano';

const regra = (o: Record<string, unknown> = {}) => ({
  empresa: 'oben', omie_codigo_produto: 1001, descricao: 'PROD 1001', novo_documento: '22222222000122',
  destino_sucessao_id: 'd2', origem: 'item', familia: null, destino_estado: 'ativa', destino_impedimento: null, ...o,
});
const planoCru = (o: Record<string, unknown> = {}) => ({
  evento_id: 'ev1', revisao: 1, revogado: false, regras: [regra()],
  revisoes: [{ revisao: 1, revoga: false, motivo: null, publicado_por_nome: 'Gestor', publicado_em: '2026-11-07T15:00:00Z', regras: 1 }],
  ...o,
});
const itensCru = (o: Record<string, unknown> = {}) => ({
  evento_id: 'ev1', ativo: true, tipo: 'cisao', data_corte: '2026-10-06', antigo_documento: '03166577000166',
  antigo_nome: 'DIVIMOVEIS', antigo_resolvido: true,
  destinos: [{ destino_sucessao_id: 'd2', novo_documento: '22222222000122', novo_nome: 'NOVA DOIS', estado: 'ativa', impedimento: null }],
  itens: [{ empresa: 'oben', omie_codigo_produto: 1001, descricao: 'PROD 1001', familia: 'OUTRA', pedidos: 3, ultimo_pedido: '2026-08-01' }],
  sugestoes_hoje: { herdadas: 4, mostradas: 1 },
  ...o,
});

describe('lerPlanoDoEvento', () => {
  it('lê o plano vigente e o histórico', () => {
    const p = lerPlanoDoEvento(planoCru());
    expect(p.revisao).toBe(1);
    expect(p.regras[0]).toMatchObject({ omieCodigoProduto: 1001, novoDocumento: '22222222000122', destinoEstado: 'ativa' });
    expect(p.revisoes[0].publicadoPorNome).toBe('Gestor');
  });
  it('nunca publicado = revisão 0, sem regras', () => {
    expect(lerPlanoDoEvento(planoCru({ revisao: 0, regras: [], revisoes: [] })).revisao).toBe(0);
  });
  it('forma inesperada LANÇA (ausente ≠ sem plano)', () => {
    expect(() => lerPlanoDoEvento(null)).toThrow('cliente_sucessao_plano_do_evento: resposta fora da forma esperada');
    expect(() => lerPlanoDoEvento(planoCru({ revisao: '1' }))).toThrow('resposta fora da forma esperada');
    expect(() => lerPlanoDoEvento(planoCru({ regras: [regra({ destino_estado: 'sumida' })] }))).toThrow('regra fora da forma esperada');
    expect(() => lerPlanoDoEvento(planoCru({ revisoes: [{ revisao: 1 }] }))).toThrow('revisão fora da forma esperada');
  });
});

describe('lerItensDoPlano', () => {
  it('lê destinos, itens e o sensor do dia', () => {
    const r = lerItensDoPlano(itensCru());
    expect(r.ativo).toBe(true);
    expect(r.destinos[0].novoNome).toBe('NOVA DOIS');
    expect(r.itens[0]).toMatchObject({ familia: 'OUTRA', pedidos: 3 });
    expect(r.sugestoesHoje).toEqual({ herdadas: 4, mostradas: 1 });
  });
  it('evento sem declaração ativa: só evento, ativo=false e listas vazias', () => {
    const r = lerItensDoPlano({ evento_id: 'ev1', ativo: false, destinos: [], itens: [] });
    expect(r).toMatchObject({ ativo: false, tipo: null, dataCorte: null, sugestoesHoje: null });
  });
  it('forma inesperada LANÇA', () => {
    expect(() => lerItensDoPlano(itensCru({ tipo: 'fusao' }))).toThrow('evento fora da forma esperada');
    expect(() => lerItensDoPlano(itensCru({ sugestoes_hoje: null }))).toThrow('sensor do dia fora da forma esperada');
    expect(() => lerItensDoPlano(itensCru({ itens: [{ empresa: 'oben' }] }))).toThrow('item fora da forma esperada');
    expect(() => lerItensDoPlano(itensCru({ destinos: [{ novo_documento: 'x' }] }))).toThrow('destino fora da forma esperada');
  });
});

describe('lerResultadoPlano + mensagemRecusaPlano', () => {
  it('ok traz a revisão nova', () => {
    expect(lerResultadoPlano({ ok: true, revisao: 2, regras: 3, reprocesso: 'agendado' }, 'x')).toEqual({ ok: true, revisao: 2 });
  });
  it('revisao_mudou diz que outra pessoa publicou e devolve a revisão atual', () => {
    const r = lerResultadoPlano({ ok: false, motivo: 'revisao_mudou', revisao: 3 }, 'x');
    expect(r).toMatchObject({ ok: false, motivo: 'revisao_mudou', revisao: 3 });
    if (r.ok) throw new Error('esperava recusa');
    expect(mensagemRecusaPlano(r)).toBe(
      'Outra pessoa publicou ou revogou este plano agora há pouco. Recarreguei: confira e publique de novo.');
  });
  it('recusas com detalhe citam o que falhou', () => {
    const c = lerResultadoPlano({ ok: false, motivo: 'regra_conflitante', itens: [{ empresa: 'oben', omie_codigo_produto: 1004 }] }, 'x');
    if (c.ok) throw new Error('esperava recusa');
    expect(mensagemRecusaPlano(c)).toBe('O mesmo item foi para duas empresas novas: oben:1004.');
    const d = lerResultadoPlano({ ok: false, motivo: 'destino_fora_do_evento', documentos: '99999999000199' }, 'x');
    if (d.ok) throw new Error('esperava recusa');
    expect(mensagemRecusaPlano(d)).toBe('Uma das empresas novas não está (mais) nesta sucessão: 99999999000199.');
    const s = lerResultadoPlano({ ok: false, motivo: 'sem_plano' }, 'x');
    if (s.ok) throw new Error('esperava recusa');
    expect(mensagemRecusaPlano(s)).toBe('Não há plano vigente para revogar.');
    const z = lerResultadoPlano({ ok: false, motivo: 'motivo_novo' }, 'x');
    if (z.ok) throw new Error('esperava recusa');
    expect(mensagemRecusaPlano(z)).toBe('Não foi possível gravar (motivo_novo).');
  });
  it('resposta sem ok / ok sem revisão / recusa sem motivo LANÇAM', () => {
    expect(() => lerResultadoPlano({}, 'pub')).toThrow('pub: resposta fora da forma esperada');
    expect(() => lerResultadoPlano({ ok: true }, 'pub')).toThrow('pub: resposta sem a revisão nova');
    expect(() => lerResultadoPlano({ ok: false }, 'pub')).toThrow('pub: recusa sem motivo');
  });
});

describe('rascunho', () => {
  const itens: ItemDaAntiga[] = [
    { empresa: 'oben', omieCodigoProduto: 1004, descricao: 'VERNIZ A', familia: 'VERNIZ', pedidos: 3, ultimoPedido: '2026-08-01' },
    { empresa: 'oben', omieCodigoProduto: 1005, descricao: 'VERNIZ B', familia: 'VERNIZ', pedidos: 3, ultimoPedido: '2026-08-01' },
    { empresa: 'oben', omieCodigoProduto: 1001, descricao: 'PROD', familia: 'OUTRA', pedidos: 3, ultimoPedido: '2026-08-01' },
  ];
  it('o inicial é o plano vigente; revogado começa vazio', () => {
    const p = lerPlanoDoEvento(planoCru());
    expect(rascunhoDoPlano(p)).toEqual({ 'oben:1001': '22222222000122' });
    expect(rascunhoDoPlano({ ...p, revogado: true })).toEqual({});
  });
  it('aplicar a família muda só os itens dela; null devolve à antiga', () => {
    const r = aplicarFamilia({ 'oben:1001': 'B' }, itens, 'VERNIZ', 'A');
    expect(r).toEqual({ 'oben:1001': 'B', 'oben:1004': 'A', 'oben:1005': 'A' });
    expect(aplicarFamilia(r, itens, 'VERNIZ', null)).toEqual({ 'oben:1001': 'B' });
  });
  it('regras só de item explícito, em ordem estável', () => {
    expect(regrasDoRascunho({ 'oben:1005': 'A', 'colacor:1003': 'A', 'oben:1001': 'B' })).toEqual([
      { empresa: 'colacor', omie_codigo_produto: 1003, novo_documento: 'A' },
      { empresa: 'oben', omie_codigo_produto: 1001, novo_documento: 'B' },
      { empresa: 'oben', omie_codigo_produto: 1005, novo_documento: 'A' },
    ]);
  });
  it('mesmoRascunho compara chave a chave', () => {
    expect(mesmoRascunho({ a: '1' }, { a: '1' })).toBe(true);
    expect(mesmoRascunho({ a: '1' }, { a: '2' })).toBe(false);
    expect(mesmoRascunho({ a: '1' }, {})).toBe(false);
  });
  it('resumo diz quantos vão para quem e quantos ficam', () => {
    expect(resumoRascunho({ 'oben:1004': 'A', 'oben:1005': 'A' }, itens,
      [{ destinoSucessaoId: 'd', novoDocumento: 'A', novoNome: 'MARQUES', estado: 'ativa', impedimento: null }]))
      .toBe('2 itens para MARQUES · 1 fica com a antiga');
  });
});
