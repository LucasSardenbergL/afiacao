import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Radar, pacote M: o descarte automático da Receita é gravado pelo UUID de sistema (…ad0f), que não tem `profiles`.
 * O histórico da ficha dizia "autor não identificado" — agora diz "Receita Federal (automático)". O autor humano
 * segue vindo de `profiles`, e quem não tem perfil continua `null` (nunca um nome inventado).
 */
const SIS = '00000000-0000-0000-0000-00000000ad0f';
const contatos = [
  { id: 'c1', cnpj: '1', acao: 'descartado', criado_por: SIS, created_at: '2026-11-01T10:00:00Z' },
  { id: 'c2', cnpj: '1', acao: 'em_conversa', criado_por: 'u-regina', created_at: '2026-11-02T10:00:00Z' },
  { id: 'c3', cnpj: '1', acao: 'a_contatar', criado_por: 'u-sem-perfil', created_at: '2026-11-03T10:00:00Z' },
];
const pedidosPerfis: unknown[][] = [];
function cadeia(tabela: string) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order']) c[m] = () => c;
  c.in = (_col: string, ids: unknown[]) => { pedidosPerfis.push(ids); return c; };
  c.range = () => Promise.resolve(tabela === 'radar_contatos'
    ? { data: contatos, error: null }
    : { data: [{ user_id: 'u-regina', name: 'Regina' }], error: null });
  return c;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => cadeia(t) } }));

import { useRadarContatos, NOME_AUTOR_SISTEMA_RECEITA } from '../useRadarContatos';

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

describe('useRadarContatos — autor', () => {
  it('UUID de sistema vira "Receita Federal (automático)"; humano pelo perfil; sem perfil fica null', async () => {
    const { result } = renderHook(() => useRadarContatos('1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((c) => c.autor)).toEqual([NOME_AUTOR_SISTEMA_RECEITA, 'Regina', null]);
    expect(NOME_AUTOR_SISTEMA_RECEITA).toBe('Receita Federal (automático)');
    // O UUID de sistema não vai à consulta de perfis (não há perfil a achar).
    expect(pedidosPerfis[0]).toEqual(['u-regina', 'u-sem-perfil']);
  });
});
