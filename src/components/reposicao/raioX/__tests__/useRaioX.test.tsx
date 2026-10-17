/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

type Resp = { data: unknown[] | null; error: unknown };
const respostas = vi.hoisted(() => ({
  fatos: (_de: number, _ate: number): Resp => ({ data: [], error: null }),
  decisoes: (_de: number, _ate: number): Resp => ({ data: [], error: null }),
  manuais: (_de: number, _ate: number): Resp => ({ data: [], error: null }),
}));
const chamadas = vi.hoisted(() => ({ rpc: [] as string[] }));

vi.mock('@/integrations/supabase/client', () => {
  const builder = (fn: (de: number, ate: number) => Resp) => {
    const b = {
      select: () => b,
      eq: () => b,
      order: () => b,
      range: (de: number, ate: number) => Promise.resolve(fn(de, ate)),
    };
    return b;
  };
  return {
    supabase: {
      rpc: (nome: string) => {
        chamadas.rpc.push(nome);
        return builder((d, a) => respostas.fatos(d, a));
      },
      from: (tabela: string) =>
        builder((d, a) =>
          tabela === 'raio_x_decisao' ? respostas.decisoes(d, a) : respostas.manuais(d, a),
        ),
    },
  };
});

vi.mock('@/lib/reposicao/raio-x/classificar', async (orig) => {
  const mod = await orig<typeof import('@/lib/reposicao/raio-x/classificar')>();
  return { ...mod, classificar: vi.fn(mod.classificar) };
});

import { classificar } from '@/lib/reposicao/raio-x/classificar';
import { useRaioX } from '../useRaioX';

function fato(i: number, extra: Record<string, unknown> = {}) {
  return {
    sku_codigo_omie: i, codigo: `C${i}`, descricao: `Item ${i}`, familia: null, tipo_produto: null,
    ativo: true, saldo: 10, cmc: 5, unidade_estoque: 'UN', unidades_venda: null, no_motor: false,
    tipo_reposicao: null, classe_abc: null, cadastro_em: '2020-01-01', ult_entrada: '2020-01-01',
    fornecedor: null, q12: 0, ncli: 0, ult_venda: null, preco_medio_12m: null, clientes: null,
    synced_at: new Date().toISOString(), habilitado_reposicao_automatica: null, ...extra,
  };
}

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  chamadas.rpc.length = 0;
  respostas.fatos = () => ({ data: [], error: null });
  respostas.decisoes = () => ({ data: [], error: null });
  respostas.manuais = () => ({ data: [], error: null });
});

describe('useRaioX', () => {
  it('erro 42501 preserva o code e NÃO vira lista vazia de sucesso', async () => {
    respostas.fatos = () => ({
      data: null,
      error: { code: '42501', message: 'permission denied' },
    });
    const { result } = renderHook(() => useRaioX('oben'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.erro).not.toBeNull());
    expect((result.current.erro as Error & { code?: string }).code).toBe('42501');
    expect(result.current.itens).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('pagina além de 1.000 linhas: 1.205 itens em 2 páginas', async () => {
    const todas = Array.from({ length: 1205 }, (_, i) => fato(i + 1));
    respostas.fatos = (de, ate) => ({ data: todas.slice(de, ate + 1), error: null });
    const { result } = renderHook(() => useRaioX('oben'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.itens.length).toBeGreaterThan(0));
    expect(result.current.itens).toHaveLength(1205);
    expect(result.current.erro).toBeNull();
  });

  it('syncedHoras vem do MÁXIMO synced_at (30h atrás => >= 24)', async () => {
    const h30 = new Date(Date.now() - 30 * 3600_000).toISOString();
    const h40 = new Date(Date.now() - 40 * 3600_000).toISOString();
    respostas.fatos = () => ({ data: [fato(1, { synced_at: h40 }), fato(2, { synced_at: h30 })], error: null });
    const { result } = renderHook(() => useRaioX('oben'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.syncedHoras).not.toBeNull());
    expect(result.current.syncedHoras!).toBeGreaterThanOrEqual(24);
    expect(result.current.syncedHoras!).toBeLessThan(35);
  });

  it('syncedHoras é null quando nenhuma linha tem synced_at', async () => {
    respostas.fatos = () => ({ data: [fato(1, { synced_at: null })], error: null });
    const { result } = renderHook(() => useRaioX('oben'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.itens).toHaveLength(1));
    expect(result.current.syncedHoras).toBeNull();
  });

  it('empresa null desliga as queries', async () => {
    const { result } = renderHook(() => useRaioX(null), { wrapper: wrapper() });
    await new Promise((r) => setTimeout(r, 30));
    expect(chamadas.rpc).toEqual([]);
    expect(result.current.itens).toEqual([]);
    expect(result.current.erro).toBeNull();
  });

  it('erro na leitura de raio_x_decisao => erro preenchido e itens vazios', async () => {
    respostas.fatos = () => ({ data: [fato(1)], error: null });
    respostas.decisoes = () => ({ data: null, error: { code: 'XX000', message: 'falhou decisao' } });
    const { result } = renderHook(() => useRaioX('oben'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.erro).not.toBeNull());
    expect(result.current.erro?.message).toContain('falhou decisao');
    expect(result.current.itens).toEqual([]);
  });

  it('erro na leitura de raio_x_classificacao_manual => erro preenchido e itens vazios', async () => {
    respostas.fatos = () => ({ data: [fato(1)], error: null });
    respostas.manuais = () => ({ data: null, error: { code: 'XX000', message: 'falhou manual' } });
    const { result } = renderHook(() => useRaioX('oben'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.erro).not.toBeNull());
    expect(result.current.erro?.message).toContain('falhou manual');
    expect(result.current.itens).toEqual([]);
  });

  it('hoje é a data de São Paulo, não UTC (02:30Z de 17/10 => 2026-10-16)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T02:30:00Z'));
    try {
      respostas.fatos = () => ({ data: [fato(1, { synced_at: null })], error: null });
      const { result } = renderHook(() => useRaioX('oben'), { wrapper: wrapper() });
      await waitFor(() => expect(result.current.itens).toHaveLength(1));
      expect(vi.mocked(classificar).mock.calls.at(-1)?.[3]).toBe('2026-10-16');
    } finally {
      vi.useRealTimers();
    }
  });
});
