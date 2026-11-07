import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * "Atribuir" na ficha do Radar: só gestor/master vê (o banco é a fronteira — gate de gestor em
 * radar_atribuir_atendimento), some para já-cliente, fica desligado na lente "Ver como", e escolher um vendedor chama
 * a escrita com o CNPJ e o user_id do destino.
 */
let auth: { role: string | null; commercialRole: string | null } = { role: 'master', commercialRole: null };
let lente = false;
const mutateAsync = vi.fn();
const toastSuccess = vi.fn();
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: lente }) }));
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/queries/useRadarAtendimentos', () => ({
  useRadarAtendimentosAtivos: () => ({ isError: false, isSuccess: true, isLoading: false, data: new Map() }),
  useRadarDefinirAtendimento: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useRadarVendedoresAtribuiveis: () => ({
    isLoading: false, isError: false,
    data: [{ userId: 'u-ana', nome: 'Ana Farmer', papel: 'farmer' }, { userId: 'u-bia', nome: 'Bia Hunter', papel: 'hunter' }],
  }),
  useRadarAtribuirAtendimento: () => ({ isPending: false, mutateAsync }),
}));

import { RadarAtendimentoLead } from '../RadarAtendimentoLead';

// O Command (cmdk) mede a lista e rola o item ativo; o jsdom não tem ResizeObserver nem scrollIntoView.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= vi.fn();

beforeEach(() => {
  auth = { role: 'master', commercialRole: null };
  lente = false;
  mutateAsync.mockReset();
  toastSuccess.mockReset();
});

describe('RadarAtendimentoLead — atribuir a um vendedor', () => {
  it('vendedor (farmer) não vê "Atribuir"', () => {
    auth = { role: 'employee', commercialRole: 'farmer' };
    render(<RadarAtendimentoLead cnpj="69491768000101" jaCliente={false} />);
    expect(screen.queryByRole('button', { name: /Atribuir/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Assumir/ })).toBeTruthy();
  });

  it('já cliente: sem "Atribuir" mesmo para o master', () => {
    render(<RadarAtendimentoLead cnpj="69491768000101" jaCliente />);
    expect(screen.queryByRole('button', { name: /Atribuir/ })).toBeNull();
  });

  it('lente "Ver como": o botão aparece desligado', () => {
    lente = true;
    render(<RadarAtendimentoLead cnpj="69491768000101" jaCliente={false} />);
    expect((screen.getByRole('button', { name: /Atribuir/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('gestor comercial escolhe a vendedora e a escrita recebe CNPJ + user_id', async () => {
    auth = { role: 'employee', commercialRole: 'gerencial' };
    mutateAsync.mockResolvedValue({
      ok: true, jaEraDono: false, tirouDeOutro: false, donoNome: 'Ana Farmer', anteriorNome: null, expiraEm: null,
    });
    render(<RadarAtendimentoLead cnpj="69491768000101" jaCliente={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Atribuir/ }));
    fireEvent.click(await screen.findByText('Ana Farmer'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ cnpj: '69491768000101', donoUserId: 'u-ana' }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Lead atribuído a Ana Farmer', expect.anything()));
  });
});
