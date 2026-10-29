import { describe, expect, it } from 'vitest';
import type { Json } from '@/integrations/supabase/types';
import { lerCandidatos, lerPainel } from '../painel-rpc';

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
  repasse_atual: null,
  ...over,
});

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

  it('resposta que não é lista LANÇA', () => {
    expect(() => lerCandidatos(null)).toThrow(/formato inesperado/);
    expect(() => lerCandidatos({})).toThrow(/formato inesperado/);
  });
});
