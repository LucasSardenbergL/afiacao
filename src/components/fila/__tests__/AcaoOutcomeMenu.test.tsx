import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AcaoOutcomeMenu } from '@/components/fila/AcaoOutcomeMenu';
import type { AcaoSugerida } from '@/lib/fila/types';

const impMock = vi.fn();
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/hooks/useTarefas', () => ({ useTarefaMutations: () => ({ concluir: vi.fn() }) }));
vi.mock('@/hooks/useMarkMixGapFeedback', () => ({ useMarkMixGapFeedback: () => ({ mutate: vi.fn() }) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

const acaoTarefa = {
  fonte: 'tarefa', dedupeKey: 'k1', clienteNome: 'Cliente X',
  payload: { kind: 'tarefa', tarefaId: 't1' },
} as unknown as AcaoSugerida;

beforeEach(() => { vi.clearAllMocks(); });

describe('AcaoOutcomeMenu — guard de lente', () => {
  it('na lente: o trigger de opções fica disabled', () => {
    impMock.mockReturnValue({ isImpersonating: true });
    render(<AcaoOutcomeMenu acao={acaoTarefa} onNaoUtilAgora={vi.fn()} />);
    expect(screen.getByTitle(/Ver como/i)).toBeDisabled();
  });

  it('fora da lente: o trigger de opções fica habilitado', () => {
    impMock.mockReturnValue({ isImpersonating: false });
    render(<AcaoOutcomeMenu acao={acaoTarefa} onNaoUtilAgora={vi.fn()} />);
    expect(screen.getByTitle('Opções')).not.toBeDisabled();
  });
});
