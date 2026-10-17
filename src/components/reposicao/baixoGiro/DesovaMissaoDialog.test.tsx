import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const track = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a), captureException: vi.fn() }));
vi.mock('@/hooks/useCoverage', () => ({ useSalespeople: () => ({ data: [{ user_id: 'u1', name: 'Vend' }] }) }));
vi.mock('@/hooks/useTarefas', () => ({ useTarefaMutations: () => ({ criarTarefas: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ onValueChange, children }: { onValueChange: (v: string) => void; children: React.ReactNode }) => (
    <div><button onClick={() => onValueChange('u1')}>escolher</button>{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { DesovaMissaoDialog } from './DesovaMissaoDialog';
import type { AlvoDesova } from '@/lib/reposicao/desova-helpers';

const alvos: AlvoDesova[] = [{ sku_codigo_omie: 1, sku_descricao: 'X', excedente_un: 2, capital_excedente: 10, tempo_digerir_dias: null, dias_sem_vender: null }];

function criar(tituloPrefixo?: string, onCriada?: () => void) {
  render(<DesovaMissaoDialog open onOpenChange={() => {}} alvos={alvos} empresa="oben" tituloPrefixo={tituloPrefixo} onCriada={onCriada} />);
  fireEvent.click(screen.getByText('escolher'));
  fireEvent.click(screen.getByRole('button', { name: 'Criar missão' }));
}

describe('DesovaMissaoDialog — sensor da aba Excesso', () => {
  beforeEach(() => track.mockClear());

  it('sem prefixo (aba Excesso) dispara reposicao.desova_missao_criada', async () => {
    criar();
    await waitFor(() => expect(track).toHaveBeenCalledWith('reposicao.desova_missao_criada', expect.any(Object)));
  });

  it('com prefixo (Raio-X) NÃO dispara reposicao.desova_missao_criada', async () => {
    const onCriada = vi.fn();
    criar('Cliente X', onCriada);
    await waitFor(() => expect(onCriada).toHaveBeenCalled());
    expect(track).not.toHaveBeenCalledWith('reposicao.desova_missao_criada', expect.anything());
  });
});
