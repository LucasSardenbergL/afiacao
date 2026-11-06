import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Pacote A3 (reproduzido pelo Codex): sair e voltar à tela do Radar com um lote de cadastro em voo. O runner
 * nasceu na instância ANTIGA do hook e atualizava só o `useState` dela; a instância nova restaurava `rodando`
 * pelo Set global e nunca mais saía de `aguardando` — o localStorage já dizia falha/ok e a retomada ficava
 * bloqueada. O estado agora é um store por usuário que toda instância observa.
 */
const from = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (...a: unknown[]) => from(...a) } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-remontar' } }) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
const deps = vi.hoisted(() => ({
  criarNoOmie: vi.fn(),
  registrarNoRadar: vi.fn(),
  lerEstado: vi.fn(),
  registrarConflito: vi.fn(),
}));
vi.mock('@/queries/useRadarAcoesLead', () => ({ depsCadastroSupabase: deps }));

import { useRadarLoteOmie } from '../useRadarLote';
import { chaveLotePersistido, parsearLote } from '@/lib/radar/lote-persistido';

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const EMPRESA = { cnpj: '11111111000111', razao_social: 'Alfa Tintas', nome_fantasia: null } as unknown as RadarEmpresa;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('useRadarLoteOmie — sair e voltar com o lote em voo', () => {
  it('a instância nova acompanha o runner antigo até o fim e libera a retomada', async () => {
    let falhar!: (e: Error) => void;
    deps.lerEstado.mockImplementation(() => new Promise((_ok, ko) => { falhar = ko; }));

    const h1 = renderHook(() => useRadarLoteOmie(), { wrapper });
    act(() => { expect(h1.result.current.iniciar([EMPRESA])).toBe(true); });
    await waitFor(() => expect(deps.lerEstado).toHaveBeenCalledTimes(1));
    expect(h1.result.current.rodando).toBe(true);

    h1.unmount(); // sai da tela: o item em voo termina sozinho
    const h2 = renderHook(() => useRadarLoteOmie(), { wrapper });
    expect(h2.result.current.rodando).toBe(true);
    expect(h2.result.current.lote?.itens[0].estado.status).toBe('aguardando');

    await act(async () => { falhar(new Error('Failed to fetch')); });

    // A tela NOVA vê o fim: não está mais rodando e mostra a falha como pendência retomável.
    await waitFor(() => expect(h2.result.current.rodando).toBe(false));
    expect(h2.result.current.lote?.itens[0].estado.status).toBe('falha');
    expect(h2.result.current.progresso?.pendentes).toBe(1);
    // O localStorage e a tela dizem a MESMA coisa.
    const salvo = parsearLote(localStorage.getItem(chaveLotePersistido('u-remontar')));
    expect(salvo?.itens[0].estado.status).toBe('falha');

    // E a retomada não fica bloqueada: dispara de novo pela instância nova (relê o lead no Radar — a instância
    // nova não tem o snapshot — e passa de novo pelo vínculo).
    from.mockReturnValue({
      select: () => ({ in: () => ({ order: () => ({ range: async () => ({ data: [EMPRESA], error: null }) }) }) }),
    });
    deps.lerEstado.mockRejectedValueOnce(new Error('Failed to fetch'));
    act(() => { h2.result.current.retomar(); });
    await waitFor(() => expect(deps.lerEstado).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(h2.result.current.rodando).toBe(false));
  });
});
