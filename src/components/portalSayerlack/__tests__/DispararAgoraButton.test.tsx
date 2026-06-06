import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DispararAgoraButton } from '../DispararAgoraButton';
import { setLensActive } from '@/lib/impersonation/lens-write-guard';

const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), info: vi.fn() },
}));
// Mocka o client pra não carregar o createClient real (import.meta.env vazio em teste).
// O guard de lente vem do módulo REAL @/lib/impersonation/lens-write-guard (não mockado),
// então setLensActive do teste e o isLensActive do componente compartilham o mesmo estado.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}));

describe('DispararAgoraButton — guard de lente', () => {
  beforeEach(() => { setLensActive(false); toastError.mockClear(); });
  afterEach(() => { setLensActive(false); vi.unstubAllGlobals(); });

  it('na lente: confirmar NÃO faz fetch e mostra erro (money-path bloqueado)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    setLensActive(true);
    render(<DispararAgoraButton />);
    fireEvent.click(screen.getByText('Disparar agora')); // abre o AlertDialog
    fireEvent.click(await screen.findByText('Confirmar')); // AlertDialogAction → handleClick
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('fora da lente: confirmar dispara o fetch pra edge', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 202, json: async () => ({ pedido_ids: [1] }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    render(<DispararAgoraButton />);
    fireEvent.click(screen.getByText('Disparar agora'));
    fireEvent.click(await screen.findByText('Confirmar'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
  });
});
