import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// A tarefa por voz da 360 segue a regra do CriarTarefaDialog (onda B, item 3): sem empresa comprovada
// o diálogo PERGUNTA e não grava antes da escolha — nunca o "oben" fixo de antes.
const criarTarefas = vi.fn(async () => undefined);
vi.mock('@/hooks/useTarefas', () => ({ useTarefaMutations: () => ({ criarTarefas }) }));
vi.mock('@/hooks/useGravacaoTranscricao', () => ({
  useGravacaoTranscricao: () => ({
    isRecording: false, isTranscribing: false, transcricao: 'Regina liga pro cliente',
    setTranscricao: vi.fn(), toggle: vi.fn(), reset: vi.fn(),
  }),
}));
vi.mock('@/hooks/useBuscaClienteOmie', () => ({ useBuscaClienteOmie: () => ({ buscar: vi.fn(async () => []) }) }));
vi.mock('@/lib/invoke-function', () => ({
  invokeFunction: vi.fn(async () => ({
    detectei_n: 1, texto_nao_coberto: null,
    tarefas: [{
      evidence_text: 'Regina liga pro cliente', descricao: 'Ligar pro cliente', categoria_palpite: 'ligar',
      cliente_nome_falado: null, vendedora_nome_falado: 'Regina', raw_date_text: null, target_texto: null,
    }],
  })),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));

import { VozTarefaDialog } from '../VozTarefaDialog';

beforeAll(() => {
  // Radix Select no jsdom
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});
beforeEach(() => criarTarefas.mockClear());

const vendedoras = [{ user_id: 'v1', nome: 'Regina' }];
const clienteFixo = { customer_user_id: 'cli-1', nome: 'Marcenaria X', empresa_omie: null };

async function detectar() {
  fireEvent.click(screen.getByRole('button', { name: /Detectar tarefas/ }));
  return (await screen.findByRole('button', { name: /Criar 1 tarefa/ })) as HTMLButtonElement;
}
const empresaGravada = () => (criarTarefas.mock.calls[0] as unknown as [Array<{ empresa: string }>])[0][0].empresa;

describe('VozTarefaDialog — empresa da tarefa com cliente fixo (360)', () => {
  it('empresa comprovada: grava ELA, sem perguntar', async () => {
    render(<VozTarefaDialog open onOpenChange={() => {}} vendedoras={vendedoras} empresa="colacor_sc" clienteFixo={clienteFixo} />);
    expect(screen.queryByTestId('voz-escolher-empresa')).toBeNull();
    fireEvent.click(await detectar());
    await waitFor(() => expect(criarTarefas).toHaveBeenCalledTimes(1));
    expect(empresaGravada()).toBe('colacor_sc');
  });

  it('não comprovada: pergunta com o motivo e o salvar fica travado (nada de "oben" por default)', async () => {
    render(
      <VozTarefaDialog
        open onOpenChange={() => {}} vendedoras={vendedoras} clienteFixo={clienteFixo}
        empresa={null} empresaOpcoes={['oben', 'colacor_sc']} empresaMotivo="O cliente tem cadastro em mais de uma empresa."
      />,
    );
    expect(screen.getByTestId('voz-escolher-empresa').textContent).toContain('mais de uma empresa');
    const salvar = await detectar();
    expect(salvar.disabled).toBe(true);
    fireEvent.click(salvar);
    expect(criarTarefas).not.toHaveBeenCalled();
  });

  it('depois de ESCOLHER, grava a escolhida (mesmo com o card criado antes da escolha)', async () => {
    render(
      <VozTarefaDialog
        open onOpenChange={() => {}} vendedoras={vendedoras} clienteFixo={clienteFixo}
        empresa={null} empresaOpcoes={['oben', 'colacor_sc']}
      />,
    );
    const salvar = await detectar();
    fireEvent.click(screen.getByRole('combobox', { name: 'Empresa da tarefa' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Colacor SC' }));
    await waitFor(() => expect(salvar.disabled).toBe(false));
    fireEvent.click(salvar);
    await waitFor(() => expect(criarTarefas).toHaveBeenCalledTimes(1));
    expect(empresaGravada()).toBe('colacor_sc');
  });
});
