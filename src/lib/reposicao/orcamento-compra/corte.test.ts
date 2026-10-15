// src/lib/reposicao/orcamento-compra/corte.test.ts
import { describe, expect, it } from 'vitest';
import { cortar, type BaseCaixa, type Candidata } from './corte';

const c = (sku: string, k: number, desembolso: number, deltaV: number | null, extra: Partial<Candidata> = {}): Candidata => ({
  pedidoRaizId: 1, sku, k, qtde: 1, desembolso, dataPagamento: '2026-10-10', deltaV, protegida: false, motivoSemScore: null, ...extra,
});
const base = (saldo: number): BaseCaixa => ({ saldoInicial: saldo, inicio: '2026-10-01', dias: 91, fluxos: [], ausencias: [] });

describe('cortar', () => {
  it('paridade: tudo com ΔV>0 e caixa folgado → aceita exatamente o que o motor pede (spec §8 teste 1)', () => {
    const cands = [c('A', 1, 10, 5), c('A', 2, 10, 3), c('B', 1, 20, 1)];
    const r = cortar(cands, base(1_000_000), 224_000, 0);
    expect(r.aceitas).toHaveLength(3);
    expect(r.cortadas).toHaveLength(0);
    expect(r.estado.tipo).toBe('viavel');
    expect(r.escassezCaixa).toBe(false);
  });
  it('ΔV ≤ 0 corta por motivo econômico, mesmo com caixa', () => {
    const r = cortar([c('A', 1, 10, 5), c('A', 2, 10, -1)], base(1_000_000), 224_000, 0);
    expect(r.cortadas.map((x) => [x.c.k, x.motivo])).toEqual([[2, 'economico']]);
  });
  it('prefixo: score de k nunca acima do de k−1 (k=2 com ΔV alto não entra sem k=1)', () => {
    const r = cortar([c('A', 1, 10, -1), c('A', 2, 10, 50)], base(1_000_000), 224_000, 0);
    expect(r.aceitas).toHaveLength(0);
    expect(r.cortadas.every((x) => x.motivo === 'economico')).toBe(true);
  });
  it('proteção inviável: base 240k, reserva 224k, protegidos 30k → inviável, déficit 14k (spec §8 teste 6)', () => {
    const r = cortar([c('A', 1, 30_000, null, { protegida: true }), c('B', 1, 10, 5)], base(240_000), 224_000, 0);
    expect(r.estado).toEqual({ tipo: 'inviavel', primeiraViolacao: '2026-10-10', deficitMax: 14_000 });
    expect(r.cortadas.map((x) => [x.c.sku, x.motivo])).toEqual([['B', 'financeiro']]);
  });
  it('guloso não-ótimo documentado (caso A/B/C do Codex, spec §8 teste 12)', () => {
    const cands = [c('A', 1, 60, 60), c('B', 1, 50, 49), c('C', 1, 50, 49)];
    const r = cortar(cands, base(224_100), 224_000, 0);
    expect(r.aceitas.map((x) => x.sku)).toEqual(['A']);
    expect(r.escassezCaixa).toBe(true);
    expect(r.scoreMarginal).toBeCloseTo(1, 9);
  });
  it('base de caixa ausente → estado indeterminado e só o gate econômico corta (nunca inviável sobre saldo 0)', () => {
    const semBase: BaseCaixa = { saldoInicial: 0, inicio: '2026-10-01', dias: 91, fluxos: [], ausencias: ['snapshot'] };
    const r = cortar([c('A', 1, 30_000, 5, { protegida: true }), c('B', 1, 10, 5), c('C', 1, 10, -1)], semBase, 224_000, 0);
    expect(r.estado.tipo).toBe('indeterminado');
    expect(r.aceitas.map((x) => x.sku).sort()).toEqual(['A', 'B']);
    expect(r.cortadas.map((x) => [x.c.sku, x.motivo])).toEqual([['C', 'economico']]);
  });
  it('sem score → cortada como sem_score, nunca aceita', () => {
    const r = cortar([c('A', 1, 10, null, { motivoSemScore: 'historico_insuficiente' })], base(1_000_000), 224_000, 0);
    expect(r.cortadas.map((x) => x.motivo)).toEqual(['sem_score']);
  });
  it('split equivalente: filhos com a mesma raiz dão o mesmo resultado do pedido inteiro (spec §8 teste 4)', () => {
    const inteiro = [c('A', 1, 10, 5), c('B', 1, 10, 4)];
    const splitado = [c('A', 1, 10, 5, { pedidoRaizId: 1 }), c('B', 1, 10, 4, { pedidoRaizId: 1 })];
    const chave = (r: ReturnType<typeof cortar>) => r.aceitas.map((x) => `${x.sku}:${x.k}`).sort();
    expect(chave(cortar(splitado, base(1_000_000), 224_000, 50))).toEqual(chave(cortar(inteiro, base(1_000_000), 224_000, 50)));
  });
  it('mínimo por pedido: completa com a melhor cortada quando cabe e ainda soma ΔV positivo', () => {
    const r = cortar([c('A', 1, 900, 50), c('A', 2, 100, -1)], base(1_000_000), 224_000, 1_000);
    expect(r.aceitas.map((x) => x.k)).toEqual([1, 2]);
  });
  it('mínimo inalcançável e sem protegida → zera o pedido com motivo mínimo', () => {
    const r = cortar([c('A', 1, 900, 50)], base(1_000_000), 224_000, 1_000);
    expect(r.aceitas).toHaveLength(0);
    expect(r.cortadas.map((x) => x.motivo)).toEqual(['minimo']);
  });
  it('mínimo inalcançável com protegida → mantém e sinaliza', () => {
    const r = cortar([c('A', 1, 900, 50, { protegida: true })], base(1_000_000), 224_000, 1_000);
    expect(r.aceitas).toHaveLength(1);
    expect(r.pedidosAbaixoMinimo).toEqual([1]);
  });
});
