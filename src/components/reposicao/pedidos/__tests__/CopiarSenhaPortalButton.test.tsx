import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const rpc = vi.fn();
const auth = { isMaster: true };
const toastOk = vi.fn();
const toastErro = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastOk(...a), error: (...a: unknown[]) => toastErro(...a) } }));

import { CopiarSenhaPortalButton, mensagemErroCopiarSenha } from '../CopiarSenhaPortalButton';

const SENHA = 'Segredo#Teste123';
const writeText = vi.fn();

beforeEach(() => {
  rpc.mockReset(); toastOk.mockReset(); toastErro.mockReset(); writeText.mockReset();
  auth.isMaster = true;
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

/** A senha nunca pode aparecer em toast nem na tela. */
function semSenhaVazada() {
  for (const c of [...toastOk.mock.calls, ...toastErro.mock.calls]) expect(JSON.stringify(c)).not.toContain(SENHA);
  expect(document.body.textContent ?? '').not.toContain(SENHA);
}

describe('CopiarSenhaPortalButton', () => {
  it('não renderiza para quem não é master', () => {
    auth.isMaster = false;
    const { container } = render(<CopiarSenhaPortalButton />);
    expect(container.firstChild).toBeNull();
  });

  it('master: copia a senha da RPC e mostra "Senha copiada" sem exibir a senha', async () => {
    rpc.mockResolvedValue({ data: SENHA, error: null });
    writeText.mockResolvedValue(undefined);
    render(<CopiarSenhaPortalButton />);
    fireEvent.click(screen.getByTestId('copiar-senha-portal'));
    await waitFor(() => expect(toastOk).toHaveBeenCalledWith('Senha copiada'));
    expect(rpc).toHaveBeenCalledWith('sayerlack_senha_portal_copiar');
    expect(writeText).toHaveBeenCalledWith(SENHA);
    semSenhaVazada();
  });

  it('erro da RPC (troca em andamento) vira toast de erro e não copia nada', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'TROCA_EM_ANDAMENTO: a senha do portal está sendo trocada (em_andamento)' } });
    render(<CopiarSenhaPortalButton />);
    fireEvent.click(screen.getByTestId('copiar-senha-portal'));
    await waitFor(() => expect(toastErro).toHaveBeenCalledWith(expect.stringContaining('sendo trocada')));
    expect(writeText).not.toHaveBeenCalled();
    expect(toastOk).not.toHaveBeenCalled();
  });

  it('clipboard negado: toast de erro, nunca "Senha copiada"', async () => {
    rpc.mockResolvedValue({ data: SENHA, error: null });
    writeText.mockRejectedValue(new Error('NotAllowedError'));
    render(<CopiarSenhaPortalButton />);
    fireEvent.click(screen.getByTestId('copiar-senha-portal'));
    await waitFor(() => expect(toastErro).toHaveBeenCalledWith(expect.stringContaining('área de transferência')));
    expect(toastOk).not.toHaveBeenCalled();
    semSenhaVazada();
  });

  it('mensagens por marca de erro da RPC', () => {
    expect(mensagemErroCopiarSenha({ message: 'SEM_SENHA_NO_VAULT: x' })).toBe('A senha do portal ainda não está no Vault.');
    expect(mensagemErroCopiarSenha({ message: 'APENAS_MASTER: x' })).toBe('Só o master pode copiar a senha do portal.');
    expect(mensagemErroCopiarSenha(null)).toBe('Não foi possível copiar a senha do portal.');
  });
});
