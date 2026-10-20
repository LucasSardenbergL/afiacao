import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EstadoRecompra } from '@/hooks/useMinhasSugestoes';

const mixMock = vi.fn();
vi.mock('@/hooks/useMyMixGap', () => ({ useMyMixGap: () => mixMock() }));
const recompraMock = vi.fn();
vi.mock('@/hooks/useMinhasSugestoes', () => ({ useMinhasSugestoes: () => recompraMock() }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));

import { useFilaAcoes } from '@/hooks/useFilaAcoes';

const pronta: EstadoRecompra = {
  tipo: 'pronta',
  resp: {
    dia: '2026-10-21',
    compradores: [{
      compradorId: 'c1', nome: 'A', telefone: null, motivoEntrada: 'maior atraso da carteira', valorRefTotal: null,
      sugestoes: [{ id: 's1', tipo: 'recompra', empresa: 'oben', omieCodigoProduto: 1, descricao: null, familia: null, qtdRef: null, valorRef: null, precoAlvo: null }],
    }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mixMock.mockReturnValue({ data: null, isError: false, isLoading: false, error: null, refetch: vi.fn() });
  recompraMock.mockReturnValue({ estado: pronta, refetch: vi.fn() });
});

describe('useFilaAcoes', () => {
  it('fonte rota desligada não aparece em fontesComErro (nem tarefa, nem WhatsApp)', () => {
    // Sem `vi.mock` dos hooks congelados de propósito: o fiscal de fronteiras lê `vi.mock` como
    // import, e mockar a telefonia abriria vazamento. A prova é dupla: o hook não IMPORTA as fontes
    // desligadas, e com as fontes vivas OK a lista de erro é vazia.
    const src = readFileSync(resolve(__dirname, '../../../hooks/useFilaAcoes.ts'), 'utf8');
    expect(src).not.toMatch(/useRouteContactList|useMinhasTarefas|useWhatsappPendentes/);
    expect(src).not.toMatch(/adapters\/(rota|tarefa|whatsappPendente)'/);
    const { result } = renderHook(() => useFilaAcoes());
    expect(result.current.fontesComErro).toEqual([]);
    expect(result.current.isError).toBe(false);
  });

  it('a recompra vira 1 ação por comprador', () => {
    const { result } = renderHook(() => useFilaAcoes());
    expect(result.current.acoes.map((a) => a.dedupeKey)).toEqual(['recompra:c1']);
  });

  it('falha da recompra é nomeada (erro ≠ dia limpo)', () => {
    recompraMock.mockReturnValue({ estado: { tipo: 'erro', erro: new Error('x') }, refetch: vi.fn() });
    const { result } = renderHook(() => useFilaAcoes());
    expect(result.current.fontesComErro).toEqual(['recompra']);
    expect(result.current.acoes).toEqual([]);
  });

  it('onda desligada não é erro nem carregando — o estado chega à UI', () => {
    recompraMock.mockReturnValue({ estado: { tipo: 'onda_desligada' }, refetch: vi.fn() });
    const { result } = renderHook(() => useFilaAcoes());
    expect(result.current.isError).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.recompra.tipo).toBe('onda_desligada');
  });
});
