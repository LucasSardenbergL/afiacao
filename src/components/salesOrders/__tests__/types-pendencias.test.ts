import { describe, it, expect } from 'vitest';
import { BLOCKED_STATUSES, bloqueioDaEdicao, motivoEdicaoBloqueada } from '@/components/salesOrderEdit/types';
import { contagemDoDia, mensagemDoLote, podeEditarPedido, ultimoDiaAberto, type GrupoDia, type OrderFeedRow } from '../types';

describe('podeEditarPedido — a MESMA regra da tela de edição', () => {
  it.each(BLOCKED_STATUSES)('%s: bloqueado (a edição também recusa)', (status) => {
    expect(podeEditarPedido({ status, origin: 'sales' })).toBe(false);
  });
  // Literal de propósito: o it.each acima passa vazio se 'importado' sair da lista.
  it('importado do Omie: bloqueado, e o motivo diz onde alterar', () => {
    expect(podeEditarPedido({ status: 'importado', origin: 'sales' })).toBe(false);
    expect(motivoEdicaoBloqueada('importado')).toContain('altere no Omie');
    expect(motivoEdicaoBloqueada('faturado')).toBe('Este pedido está com status "faturado" e não pode ser editado.');
  });
  it('rascunho/enviado de venda: editável', () => {
    expect(podeEditarPedido({ status: 'rascunho', origin: 'sales' })).toBe(true);
    expect(podeEditarPedido({ status: 'enviado', _source: 'sales' })).toBe(true);
  });
  it('afiação nunca (pelas duas marcas: origin da view e _source do detalhe)', () => {
    expect(podeEditarPedido({ status: 'rascunho', origin: 'afiacao' })).toBe(false);
    expect(podeEditarPedido({ status: 'rascunho', _source: 'afiacao' })).toBe(false);
  });
});

describe('mensagemDoLote — concordância', () => {
  it.each([
    [1, 0, '1 pedido excluído'],
    [3, 0, '3 pedidos excluídos'],
    [0, 1, '1 pedido não pôde ser excluído'],
    [0, 2, '2 pedidos não puderam ser excluídos'],
    [2, 1, '2 pedidos excluídos; 1 pedido não pôde ser excluído'],
  ])('%i ok, %i falhas → %s', (ok, falhas, esperado) => {
    expect(mensagemDoLote(ok, falhas)).toBe(esperado);
    expect(mensagemDoLote(ok, falhas)).not.toContain('(s)');
  });
});

describe('contagem do cabeçalho do dia', () => {
  const grupo = (dia: string, n: number): GrupoDia => ({ dia, rotulo: dia, pedidos: Array.from({ length: n }, () => ({}) as OrderFeedRow) });

  it('sem mais páginas: todo grupo está completo e mostra a contagem', () => {
    expect(contagemDoDia(grupo('2026-11-20', 1), false, '2026-11-20')).toBe('1 pedido');
    expect(contagemDoDia(grupo('2026-11-20', 12), false, null)).toBe('12 pedidos');
  });
  it('com mais páginas: o dia ainda aberto NÃO mostra contagem (parcial com cara de total)', () => {
    expect(contagemDoDia(grupo('2026-11-20', 5), true, '2026-11-20')).toBeNull();
    expect(contagemDoDia(grupo('2026-11-19', 5), true, '2026-11-20')).toBeNull();
    expect(contagemDoDia(grupo('sem-data', 5), true, '2026-11-20')).toBeNull();
    expect(contagemDoDia(grupo('2026-11-21', 5), true, '2026-11-20')).toBe('5 pedidos');
  });

  it('dia aberto = o MAIOR entre o dia local e o UTC do último carregado (data-pura do Omie é dia UTC)', () => {
    // Em São Paulo, 21/11 01:00Z é dia 20 local, mas um 21/11 00:00Z (data-pura) ainda pode vir depois.
    const dia = ultimoDiaAberto('2026-11-21T01:00:00Z');
    expect(dia).toBe('2026-11-21');
    expect(ultimoDiaAberto('lixo')).toBeNull();
  });
});

describe('bloqueioDaEdicao — status E origem (Codex P0, 2026-11-25)', () => {
  it('criado no Omie e já em separação: bloqueado com o motivo do importado', () => {
    expect(bloqueioDaEdicao({ status: 'separacao', origem_omie: true })).toBe(motivoEdicaoBloqueada('importado'));
  });
  it('do app em separação: livre; origem ausente = do app', () => {
    expect(bloqueioDaEdicao({ status: 'separacao', origem_omie: false })).toBeNull();
    expect(bloqueioDaEdicao({ status: 'rascunho' })).toBeNull();
  });
  it('status bloqueado continua bloqueando sem a origem', () => {
    expect(bloqueioDaEdicao({ status: 'faturado' })).toBe(motivoEdicaoBloqueada('faturado'));
  });
});
