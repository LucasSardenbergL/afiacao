import { describe, it, expect } from 'vitest';
import { ehPaiSplit, pedidosVisiveis } from '../shared';

describe('ehPaiSplit (PR5 — esconder pai do split)', () => {
  it('pai split (status=split_em_filhos) → true', () => {
    expect(ehPaiSplit({ status: 'split_em_filhos' })).toBe(true);
  });

  it('filho do split (status normal) → false', () => {
    // o filho carrega split_parent_id/split_lote/split_total mas status NÃO é split_em_filhos
    expect(ehPaiSplit({ status: 'aprovado_aguardando_disparo' })).toBe(false);
    expect(ehPaiSplit({ status: 'disparado' })).toBe(false);
  });

  it('pedido normal (sem split) → false', () => {
    expect(ehPaiSplit({ status: 'pendente_aprovacao' })).toBe(false);
    expect(ehPaiSplit({ status: 'bloqueado_guardrail' })).toBe(false);
    expect(ehPaiSplit({ status: 'falha_envio' })).toBe(false);
    expect(ehPaiSplit({ status: 'cancelado' })).toBe(false);
  });
});

describe('pedidosVisiveis (PR5 — lista sem o pai, com os filhos)', () => {
  it('remove o pai split e mantém os filhos', () => {
    const lista = [
      { id: 1, status: 'split_em_filhos', valor_total: 300 }, // pai (soma)
      { id: 2, status: 'aprovado_aguardando_disparo', valor_total: 100, split_parent_id: 1 },
      { id: 3, status: 'aprovado_aguardando_disparo', valor_total: 200, split_parent_id: 1 },
      { id: 4, status: 'pendente_aprovacao', valor_total: 50 },
    ];
    const vis = pedidosVisiveis(lista);
    expect(vis.map((p) => p.id)).toEqual([2, 3, 4]);
  });

  it('o total dos visíveis NÃO dobra o split (pai 300 excluído; filhos 100+200 contam)', () => {
    const lista = [
      { id: 1, status: 'split_em_filhos', valor_total: 300 },
      { id: 2, status: 'aprovado_aguardando_disparo', valor_total: 100, split_parent_id: 1 },
      { id: 3, status: 'aprovado_aguardando_disparo', valor_total: 200, split_parent_id: 1 },
      { id: 4, status: 'pendente_aprovacao', valor_total: 50 },
    ];
    const vis = pedidosVisiveis(lista);
    const totalVisivel = vis.reduce((acc, p) => acc + p.valor_total, 0);
    // com o pai (350+300=650) dobraria o valor do split; sem ele = 350
    expect(totalVisivel).toBe(350);
    expect(vis.length).toBe(3);
  });

  it('lista vazia → vazia; lista sem split → inalterada', () => {
    expect(pedidosVisiveis([])).toEqual([]);
    const semSplit = [
      { id: 1, status: 'pendente_aprovacao' },
      { id: 2, status: 'disparado' },
    ];
    expect(pedidosVisiveis(semSplit)).toEqual(semSplit);
  });
});
