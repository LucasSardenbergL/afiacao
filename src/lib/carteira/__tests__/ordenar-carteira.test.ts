import { describe, it, expect } from 'vitest';
import { chavePrioridade, ordenarCarteira } from '@/lib/carteira/escopo-clientes';

type S = { priority_score: number | null; sales_history_status: string | null };
const c = (user_id: string, name: string) => ({ user_id, name });
const s = (priority_score: number | null, sales_history_status: string | null = 'ativo'): S =>
  ({ priority_score, sales_history_status });

describe('chavePrioridade — gêmea do `prio` da RPC listar_clientes_base', () => {
  it('medida passa; 0 medido é 0 (não ausente)', () => {
    expect(chavePrioridade(s(42))).toBe(42);
    expect(chavePrioridade(s(0))).toBe(0);
  });
  it('sem_historico, sem score, null e não finito → null (nunca 0 fabricado)', () => {
    expect(chavePrioridade(s(88, 'sem_historico'))).toBeNull();
    expect(chavePrioridade(undefined)).toBeNull();
    expect(chavePrioridade(s(null))).toBeNull();
    expect(chavePrioridade(s(Number.NaN))).toBeNull();
  });
});

describe('ordenarCarteira', () => {
  const itens = [c('u3', 'Carlos'), c('u1', 'Ana'), c('u4', 'Bruno'), c('u2', 'Dora'), c('u5', 'Elias')];
  const scores = new Map<string, S>([
    ['u1', s(10)],
    ['u2', s(90)],
    ['u3', s(90)],
    ['u4', s(50, 'sem_historico')], // sentinela: vai pro fim
    // u5 sem score: fim
  ]);

  it('prioridade DESC, ausente no FIM, empate desfeito pelo A–Z', () => {
    expect(ordenarCarteira(itens, scores, 'prioridade').map((x) => x.name))
      .toEqual(['Carlos', 'Dora', 'Ana', 'Bruno', 'Elias']);
  });

  it('nome = A–Z normalizado', () => {
    expect(ordenarCarteira(itens, scores, 'nome').map((x) => x.name))
      .toEqual(['Ana', 'Bruno', 'Carlos', 'Dora', 'Elias']);
  });

  it('prioridade 0 medida vem ANTES de quem não tem prioridade', () => {
    const r = ordenarCarteira([c('a', 'Zeca'), c('b', 'Abel')], new Map([['a', s(0)]]), 'prioridade');
    expect(r.map((x) => x.name)).toEqual(['Zeca', 'Abel']);
  });

  it('sem scores (carregando/falha) cai no A–Z, sem inventar ordem', () => {
    expect(ordenarCarteira(itens, new Map(), 'prioridade').map((x) => x.name))
      .toEqual(['Ana', 'Bruno', 'Carlos', 'Dora', 'Elias']);
  });

  it('estável e total: homônimos desempatam pelo user_id, em qualquer ordem de entrada', () => {
    const a = [c('id-b', 'Maria'), c('id-a', 'Maria')];
    const sc = new Map([['id-a', s(5)], ['id-b', s(5)]]);
    expect(ordenarCarteira(a, sc, 'prioridade').map((x) => x.user_id)).toEqual(['id-a', 'id-b']);
    expect(ordenarCarteira([...a].reverse(), sc, 'prioridade').map((x) => x.user_id)).toEqual(['id-a', 'id-b']);
  });

  it('não muta a entrada', () => {
    const copia = [...itens];
    ordenarCarteira(itens, scores, 'prioridade');
    expect(itens).toEqual(copia);
  });
});
