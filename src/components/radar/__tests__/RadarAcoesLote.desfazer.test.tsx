// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Revisão do Radar 2026-11-11, item 15 — o descarte em LOTE não tinha "Desfazer" (o individual tem). Com o executor
 * real do lote (`useRadarAcaoEmLote`), o toast oferece desfazer SÓ os registros que este lote gravou, e o desfazer
 * chama `desfazer_contato_radar` por id.
 */
const { toast, registrar, desfazer } = vi.hoisted(() => ({
  toast: { success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn() },
  registrar: vi.fn(),
  desfazer: vi.fn(),
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isMaster: false, isGestorComercial: false, user: { id: 'u' } }) }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/queries/useRegistrarContatoRadar', () => ({
  registrarContatoRadar: (v: { cnpj: string }) => registrar(v),
  desfazerContatoRadar: (id: string) => desfazer(id),
}));

import { RadarAcoesLote } from '../RadarAcoesLote';

const emp = (cnpj: string) => ({ cnpj, razao_social: `E ${cnpj}` }) as RadarEmpresa;
type LoteOmie = Parameters<typeof RadarAcoesLote>[0]['loteOmie'];
const loteOmie = { rodando: false, temPendencias: false, iniciar: vi.fn(() => true) } as unknown as LoteOmie;

beforeEach(() => {
  vi.clearAllMocks();
  registrar.mockImplementation(async ({ cnpj }: { cnpj: string }) => ({ id: `r-${cnpj}`, deduped: cnpj === '33333333000133' }));
  desfazer.mockResolvedValue({ deleted: true, statusRestaurado: true });
});

describe('RadarAcoesLote — "Desfazer" no descarte em lote', () => {
  it('o toast oferece desfazer os registros DESTE lote (sem o deduplicado) e o desfazer chama cada id', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <RadarAcoesLote selecao={[emp('11111111000111'), emp('22222222000122'), emp('33333333000133')]}
          onLimpar={() => {}} onRemover={() => {}} loteOmie={loteOmie} onAbrirLote={() => {}} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /descartar/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^descartar$/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const [titulo, opcoes] = toast.success.mock.calls[0] as [string, { action?: { label: string; onClick: () => void } }];
    expect(titulo).toBe('3 lead(s) descartado(s)');
    expect(opcoes.action?.label).toBe('Desfazer');
    opcoes.action!.onClick();
    await waitFor(() => expect(desfazer).toHaveBeenCalledTimes(2));
    expect(desfazer.mock.calls.map((c) => c[0]).sort()).toEqual(['r-11111111000111', 'r-22222222000122']);
    await waitFor(() => expect(toast.success).toHaveBeenLastCalledWith('2 descarte(s) desfeito(s)'));
  });
});
