import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * Pacote F, achado 7: leitura da posse que FALHOU não é "lead livre". Antes o botão Assumir aparecia LIGADO sobre um
 * estado desconhecido — assumir às cegas podia passar por cima de um colega. Agora fica desligado, com o motivo, e há
 * um "Tentar de novo".
 */
let posse: { isError: boolean; isSuccess: boolean; isLoading: boolean; data: Map<string, unknown> | undefined } = {
  isError: false, isSuccess: true, isLoading: false, data: new Map(),
};
const refetch = vi.fn();
const mutateAsync = vi.fn();
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ role: 'employee', commercialRole: 'farmer' }) }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/queries/useRadarAtendimentos', () => ({
  useRadarAtendimentosAtivos: () => ({ ...posse, refetch }),
  useRadarDefinirAtendimento: () => ({ isPending: false, mutateAsync }),
  useRadarVendedoresAtribuiveis: () => ({ isLoading: false, isError: false, data: [] }),
  useRadarAtribuirAtendimento: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

import { RadarAtendimentoLead } from '../RadarAtendimentoLead';

beforeEach(() => {
  posse = { isError: false, isSuccess: true, isLoading: false, data: new Map() };
  refetch.mockReset(); mutateAsync.mockReset();
});

describe('RadarAtendimentoLead — posse desconhecida', () => {
  it('controle: posse lida e livre → Assumir ligado', () => {
    render(<RadarAtendimentoLead cnpj="69491768000101" jaCliente={false} />);
    expect((screen.getByRole('button', { name: /Assumir/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('leitura falhou → Assumir DESLIGADO com o motivo, e "Tentar de novo" relê', () => {
    posse = { isError: true, isSuccess: false, isLoading: false, data: undefined };
    render(<RadarAtendimentoLead cnpj="69491768000101" jaCliente={false} />);
    const b = screen.getByRole('button', { name: /Assumir/ }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe('Indisponível: não consegui ver se alguém está atendendo este lead');
    fireEvent.click(b);
    expect(mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
