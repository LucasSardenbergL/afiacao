import { describe, expect, it } from 'vitest';
import type { Json } from '@/integrations/supabase/types';
import { lerCandidatos, lerPainel, lerSensor } from '../painel-rpc';

type Obj = { [k: string]: Json | undefined };

const contagem = { virou: 1, nao_virou: 2, nao_medivel: 0, pendentes: 3 };

const linha = (over: Obj = {}): Obj => ({
  farmer_user_id: 'f1',
  farmer_nome: null,
  semana: '2026-10-12',
  na_lista: 10,
  mostradas: 8,
  contatados: 5,
  compraram: 1,
  ...contagem,
  receita_realizada: null,
  receita_incompleta: false,
  taxa_ativa: 0.3333,
  na_lista_sombra: 0,
  base_historico: contagem,
  taxa_base_historico_mesma_semana: null,
  base_sombra: contagem,
  taxa_base_sombra: null,
  base_confiavel: true,
  ...over,
});

const onda = (prerequisitos: Obj): Obj => ({ ligada: false, ligada_em: null, condicao_ao_ligar: null, prerequisitos });

const painel = (over: Obj = {}): Obj => ({
  hoje: '2026-10-21',
  periodo: { de: '2026-10-12', ate: '2026-10-25' },
  base_confiavel: true,
  repasse_disponivel: true,
  linhas: [linha()],
  ondas: {
    onda_recompra: onda({
      historico_dias: 30,
      historico_meta: 365,
      sombra_ao_vivo: [{ dia: '2026-10-20', ao_vivo: true }],
      avaliada_hoje: false,
    }),
    onda_complemento: onda({
      onda_recompra_ligada: false,
      semanas: [{ semana: '2026-10-05', farmers: 0, menor_taxa: null, ok: false }],
    }),
    onda_preco: onda({ onda_complemento_ligada: false, repasse_vigente: null }),
  },
  ...over,
});

describe('lerPainel', () => {
  it('lê a forma montada pela função em prod', () => {
    const p = lerPainel(painel());
    expect(p.linhas[0].taxa_ativa).toBe(0.3333);
    expect(p.linhas[0].receita_realizada).toBeNull();
    expect(p.ondas.onda_complemento.prerequisitos.semanas[0].menor_taxa).toBeNull();
  });

  it('repasse_vigente NULL continua NULL ("não sei"), nunca false', () => {
    expect(lerPainel(painel()).ondas.onda_preco.prerequisitos.repasse_vigente).toBeNull();
  });

  it('chave ausente LANÇA (ausente ≠ NULL)', () => {
    const { taxa_ativa: _t, ...semTaxa } = linha();
    expect(() => lerPainel(painel({ linhas: [semTaxa] }))).toThrow(/venda_painel\.linhas\[0\]: sem "taxa_ativa"/);
    const { repasse_disponivel: _r, ...semRepasse } = painel();
    expect(() => lerPainel(semRepasse)).toThrow(/sem "repasse_disponivel"/);
  });

  it('número em texto ou contagem nula LANÇA (não vira 0)', () => {
    expect(() => lerPainel(painel({ linhas: [linha({ receita_realizada: '1200.50' })] }))).toThrow(
      /"receita_realizada" não é número/,
    );
    expect(() => lerPainel(painel({ linhas: [linha({ na_lista: null })] }))).toThrow(/"na_lista" não é número/);
  });

  it('data NULL ou forma que não é objeto LANÇA', () => {
    expect(() => lerPainel(null)).toThrow(/devolveu vazio/);
    expect(() => lerPainel([])).toThrow(/não é objeto/);
  });
});

const candidato = (over: Obj = {}): Obj => ({
  comprador_id: 'c1',
  empresa: 'oben',
  omie_codigo_produto: 123,
  descricao: 'Verniz PU',
  status_defasagem: 'defasado',
  motivo: null,
  abaixo_piso: null,
  ultimo_preco: 10.5,
  data_ultima_compra: '2026-09-01',
  preco_sugerido: 11.2,
  alta_custo_perc: 6.67,
  valor_anual_recuperavel: 840,
  c_last: 7,
  c_now: 7.5,
  n_pedidos: 4,
  cadencia_dias: 30,
  qtd_sugerida: 20,
  situacao_compra: 'comprando',
  demanda_viva: true,
  recompra_sugerida_em: null,
  dias_sem_comprar: 12,
  substituto: null,
  repasse_atual: null,
  ...over,
});

const substituto = {
  omie_codigo_produto: 456,
  codigo: 'PRD03666',
  descricao: 'DILUENTE PU DFA.4080LT',
  primeira_compra: '2026-06-24',
  ultima_compra: '2026-10-27',
  dias_com_compra: 7,
};

describe('lerCandidatos', () => {
  it('lê o candidato e ignora a evidência de custo extra (c_last/c_now)', () => {
    const [c] = lerCandidatos([candidato()]);
    expect(c.preco_sugerido).toBe(11.2);
    expect(c.repasse_atual).toBeNull();
    expect(c).not.toHaveProperty('c_now');
  });

  it('lê o repasse atual', () => {
    const ra = { id: 'r1', preco_alvo: 11, valido_ate: '2026-12-31', revogado: false, vigente: true };
    expect(lerCandidatos([candidato({ repasse_atual: ra })])[0].repasse_atual).toEqual(ra);
  });

  it('preço sugerido ausente LANÇA; NULL é contrato (sem sugestão)', () => {
    const { preco_sugerido: _p, ...semPreco } = candidato();
    expect(() => lerCandidatos([semPreco])).toThrow(/sem "preco_sugerido"/);
    expect(lerCandidatos([candidato({ preco_sugerido: null })])[0].preco_sugerido).toBeNull();
  });

  it('preço em texto LANÇA', () => {
    expect(() => lerCandidatos([candidato({ ultimo_preco: '10.50' })])).toThrow(/"ultimo_preco" não é número/);
  });

  it('empresa fora de oben LANÇA (repasse v1 é só oben)', () => {
    expect(() => lerCandidatos([candidato({ empresa: 'colacor' })])).toThrow(/empresa "colacor" fora do repasse v1/);
  });

  it('lê a situação de compra e o substituto', () => {
    const [c] = lerCandidatos([
      candidato({ situacao_compra: 'substituido', substituto, preco_sugerido: null, valor_anual_recuperavel: null, demanda_viva: false }),
    ]);
    expect(c.situacao_compra).toBe('substituido');
    expect(c.substituto).toEqual(substituto);
    const semCad = candidato({ situacao_compra: null, demanda_viva: false, preco_sugerido: null, valor_anual_recuperavel: null });
    expect(lerCandidatos([semCad])[0].situacao_compra).toBeNull();
  });

  it('situação desconhecida, ausente ou incoerente com o substituto LANÇA', () => {
    expect(() => lerCandidatos([candidato({ situacao_compra: 'trocado' })])).toThrow(/situacao_compra "trocado" desconhecida/);
    const { situacao_compra: _s, ...semSituacao } = candidato();
    expect(() => lerCandidatos([semSituacao])).toThrow(/sem "situacao_compra"/);
    expect(() => lerCandidatos([candidato({ situacao_compra: 'substituido' })])).toThrow(/incoerente com o substituto/);
    expect(() => lerCandidatos([candidato({ substituto })])).toThrow(/incoerente com o substituto/);
    expect(() => lerCandidatos([candidato({ situacao_compra: 'substituido', demanda_viva: false, preco_sugerido: null, valor_anual_recuperavel: null, substituto: { ...substituto, dias_com_compra: '7' } })]))
      .toThrow(/substituto: "dias_com_compra" não é número/);
  });

  it('só a demanda viva é repasse (20261113213000): parado lê sem sugerido/valor e com a data da lista da farmer', () => {
    const parado = candidato({
      situacao_compra: 'parado', demanda_viva: false, preco_sugerido: null, valor_anual_recuperavel: null,
      recompra_sugerida_em: '2026-11-12', dias_sem_comprar: 40,
    });
    const [c] = lerCandidatos([parado]);
    expect(c.demanda_viva).toBe(false);
    expect(c.recompra_sugerida_em).toBe('2026-11-12');
    expect(lerCandidatos([candidato()])[0].demanda_viva).toBe(true);
  });

  it('fora da demanda viva com sugerido OU valor LANÇA (corpo antigo não entra na soma do painel)', () => {
    const parado = { situacao_compra: 'parado', demanda_viva: false, preco_sugerido: null, valor_anual_recuperavel: null };
    expect(() => lerCandidatos([candidato({ ...parado, preco_sugerido: 11.2 })])).toThrow(/fora da demanda viva com/);
    expect(() => lerCandidatos([candidato({ ...parado, valor_anual_recuperavel: 840 })])).toThrow(/fora da demanda viva com/);
    // detector: o mesmo parado sem sugerido nem valor é lido
    expect(lerCandidatos([candidato(parado)])).toHaveLength(1);
  });

  it('demanda_viva incoerente com a situação ou ausente LANÇA', () => {
    expect(() => lerCandidatos([candidato({ demanda_viva: false })])).toThrow(/demanda_viva incoerente com situacao_compra "comprando"/);
    expect(() => lerCandidatos([candidato({ situacao_compra: 'parado', preco_sugerido: null, valor_anual_recuperavel: null })]))
      .toThrow(/demanda_viva incoerente com situacao_compra "parado"/);
    const { demanda_viva: _d, ...semViva } = candidato();
    expect(() => lerCandidatos([semViva])).toThrow(/sem "demanda_viva"/);
    const { recompra_sugerida_em: _r, ...semEnc } = candidato();
    expect(() => lerCandidatos([semEnc])).toThrow(/sem "recompra_sugerida_em"/);
  });

  it('resposta que não é lista LANÇA', () => {
    expect(() => lerCandidatos(null)).toThrow(/formato inesperado/);
    expect(() => lerCandidatos({})).toThrow(/formato inesperado/);
  });
});

describe('lerPainel — parte herdada (sucessor declarado, 20261108010000)', () => {
  const herdadas = { na_lista: 2, sugestoes: 4, virou: 1, nao_virou: 1, nao_medivel: 0, pendentes: 1,
    receita_realizada: 50, receita_incompleta: true };
  const proprias = { base_historico_propria: contagem, taxa_base_historico_propria: null,
    base_sombra_propria: { ...contagem, virou: 2 }, taxa_base_sombra_propria: 0.5 };
  it('lê a fatia herdada, a conversão própria e as bases próprias', () => {
    const l = lerPainel(painel({ linhas: [linha({ herdadas, taxa_ativa_propria: 0.5, ...proprias })] })).linhas[0];
    expect(l.herdadas).toEqual(herdadas);
    expect(l.taxa_ativa_propria).toBe(0.5);
    expect(l.base_sombra_propria).toEqual({ ...contagem, virou: 2 });
    expect(l.taxa_base_historico_propria).toBeNull();
  });
  it('servidor anterior (sem as duas chaves): sem fatia, NÃO "zero herdadas"', () => {
    const l = lerPainel(painel()).linhas[0];
    expect(l.herdadas).toBeNull();
    expect(l.taxa_ativa_propria).toBeNull();
    expect(l.base_historico_propria).toBeNull();
    expect(l.base_sombra_propria).toBeNull();
  });
  it('receita herdada ausente segue null (ausente ≠ zero)', () => {
    const l = lerPainel(painel({ linhas: [linha({ herdadas: { ...herdadas, receita_realizada: null }, taxa_ativa_propria: null, ...proprias })] })).linhas[0];
    expect(l.herdadas?.receita_realizada).toBeNull();
  });
  it('só uma das chaves, ou forma errada, LANÇA', () => {
    expect(() => lerPainel(painel({ linhas: [linha({ herdadas })] })))
      .toThrow('venda_painel.linhas[0]: as chaves da herança vêm juntas');
    expect(() => lerPainel(painel({ linhas: [linha({ herdadas, taxa_ativa_propria: 0.5 })] })))
      .toThrow('venda_painel.linhas[0]: as chaves da herança vêm juntas');
    expect(() => lerPainel(painel({ linhas: [linha({ herdadas: { ...herdadas, sugestoes: '4' }, taxa_ativa_propria: 0.5, ...proprias })] })))
      .toThrow('venda_painel.linhas[0].herdadas: "sugestoes" não é número');
    expect(() => lerPainel(painel({ linhas: [linha({ herdadas: null, taxa_ativa_propria: null, ...proprias })] })))
      .toThrow('venda_painel.linhas[0].herdadas: não é objeto');
    expect(() => lerPainel(painel({ linhas: [linha({ herdadas, taxa_ativa_propria: 0.5, ...proprias, base_sombra_propria: null })] })))
      .toThrow('venda_painel.linhas[0].base_sombra_propria: não é objeto');
  });
});

const sensorItem = (over: Obj = {}): Obj => ({
  id: 's1', comprador_id: 'c1', empresa: 'oben', omie_codigo_produto: 123, descricao: 'LIXA',
  preco_alvo: 120, ultimo_preco_na_aprovacao: 100, aprovado_em: '2026-09-14T13:00:00+00:00', valido_ate: '2026-12-13',
  revogado_em: null, vigente: true, dias_janela: 60, cadencia_na_aprovacao: 14, qtd_elegivel: 10,
  qtd_ao_preco_novo: 10, qtd_sem_preco: 0, razao_preco_novo: 1, qtd_esperada: 42.86, ganho_preco: 180,
  perda_volume: 985.8, criterio_desligar: 'atingido', motivo: null,
  ...over,
});

describe('lerSensor (20261113213000)', () => {
  it('lê a versão aprovada; razão e perda NULL são contrato', () => {
    const [s] = lerSensor([sensorItem()]);
    expect(s.criterio_desligar).toBe('atingido');
    expect(s.razao_preco_novo).toBe(1);
    const [i] = lerSensor([sensorItem({ razao_preco_novo: null, perda_volume: null, qtd_esperada: null,
      criterio_desligar: 'indisponivel', motivo: 'sem_linha_de_base' })]);
    expect(i.perda_volume).toBeNull();
    expect(i.motivo).toBe('sem_linha_de_base');
  });

  it('critério desconhecido, razão fora de [0,1], quantidade em texto ou chave ausente LANÇA', () => {
    expect(() => lerSensor([sensorItem({ criterio_desligar: 'desligado' })])).toThrow(/criterio_desligar "desligado" desconhecido/);
    expect(() => lerSensor([sensorItem({ razao_preco_novo: 1.5 })])).toThrow(/fora de \[0, 1\]/);
    expect(() => lerSensor([sensorItem({ qtd_elegivel: '10' })])).toThrow(/"qtd_elegivel" não é número/);
    const { ganho_preco: _g, ...semGanho } = sensorItem();
    expect(() => lerSensor([semGanho])).toThrow(/sem "ganho_preco"/);
    expect(() => lerSensor(null)).toThrow(/formato inesperado/);
  });
});
