import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Onda B, item 3: sem empresa comprovada o diálogo PERGUNTA — e não grava enquanto ninguém escolheu.
const criarTarefas = vi.fn(async () => undefined);
vi.mock('@/hooks/useTarefas', () => ({ useTarefaMutations: () => ({ criarTarefas }) }));

import { CriarTarefaDialog } from '../CriarTarefaDialog';

const cliente = { customer_user_id: 'cli-1', nome: 'Marcenaria X' };

beforeEach(() => criarTarefas.mockClear());

function preencher() {
  fireEvent.change(screen.getByPlaceholderText('O que a vendedora precisa fazer?'), { target: { value: 'Ligar amanhã' } });
}

describe('CriarTarefaDialog — empresa da tarefa', () => {
  it('empresa comprovada: grava ELA, sem perguntar', async () => {
    render(<CriarTarefaDialog open onOpenChange={() => {}} cliente={cliente} assignedTo="v1" empresa="colacor_sc" />);
    expect(screen.queryByTestId('tarefa-escolher-empresa')).toBeNull();
    preencher();
    fireEvent.click(screen.getByRole('button', { name: /salvar|criar/i }));
    await waitFor(() => expect(criarTarefas).toHaveBeenCalledTimes(1));
    expect((criarTarefas.mock.calls[0] as unknown as [Array<{ empresa: string }>])[0][0].empresa).toBe('colacor_sc');
  });

  it('empresa não comprovada: pergunta, com o motivo, e o salvar fica travado (nada de "oben" por default)', () => {
    render(
      <CriarTarefaDialog
        open onOpenChange={() => {}} cliente={cliente} assignedTo="v1"
        empresa={null} empresaOpcoes={['oben', 'colacor_sc']} empresaMotivo="O cliente tem cadastro em mais de uma empresa."
      />,
    );
    expect(screen.getByTestId('tarefa-escolher-empresa').textContent).toContain('mais de uma empresa');
    preencher();
    const salvar = screen.getByRole('button', { name: /salvar|criar/i }) as HTMLButtonElement;
    expect(salvar.disabled).toBe(true);
    fireEvent.click(salvar);
    expect(criarTarefas).not.toHaveBeenCalled();
  });
});
