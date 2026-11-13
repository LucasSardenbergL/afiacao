import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Revisão do Radar 2026-11-11, item 16 — sair da tela com o lote de cadastro rodando PAUSA os itens não iniciados (de
 * propósito: o store guarda e a volta oferece retomar), mas a pausa era silenciosa. Agora a saída avisa; sair com o
 * lote parado não avisa nada.
 */
const { toast } = vi.hoisted(() => ({ toast: { warning: vi.fn(), success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-sair' } }) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
const deps = vi.hoisted(() => ({ criarNoOmie: vi.fn(), registrarNoRadar: vi.fn(), lerEstado: vi.fn(), registrarConflito: vi.fn() }));
vi.mock('@/queries/useRadarAcoesLead', () => ({ depsCadastroSupabase: deps }));

import { useRadarLoteOmie } from '../useRadarLote';

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
const EMPRESA = { cnpj: '11111111000111', razao_social: 'Alfa', nome_fantasia: null } as unknown as RadarEmpresa;

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe('useRadarLoteOmie — sair da tela', () => {
  it('com o lote rodando: pausa E avisa', async () => {
    let soltar!: () => void;
    deps.lerEstado.mockImplementation(() => new Promise((ok) => { soltar = () => ok({ vinculo: '9', conflitos: [] }); }));
    const h = renderHook(() => useRadarLoteOmie(), { wrapper });
    act(() => { expect(h.result.current.iniciar([EMPRESA])).toBe(true); });
    await waitFor(() => expect(deps.lerEstado).toHaveBeenCalledTimes(1));
    h.unmount();
    expect(toast.warning).toHaveBeenCalledWith('Lote de cadastro no Omie pausado', expect.objectContaining({ description: expect.any(String) }));
    await act(async () => { soltar(); });
  });

  it('sem lote rodando: sair não avisa nada', () => {
    const h = renderHook(() => useRadarLoteOmie(), { wrapper });
    h.unmount();
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
