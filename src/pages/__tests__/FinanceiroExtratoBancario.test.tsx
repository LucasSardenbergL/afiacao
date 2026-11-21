import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = { isStaff: true };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/components/execucoes/UltimaExecucao', () => ({ UltimaExecucao: () => null }));
const ok = <T,>(data: T) => ({ data, isLoading: false, error: null });
vi.mock('@/hooks/useFinanceiroExtratoBancario', () => ({
  useContasBancarias: () => ok([{ id: 'c1', descricao: 'Itaú', bancoCodigo: '341', company: 'oben' }]),
  useArquivosExtrato: () => ok([
    { id: 'f1', status: 'pendente_revisao', motivo: 'sem_saldo_inicial', periodoInicio: '2026-11-10', periodoFim: '2026-11-15',
      qtdLinhasNovas: 1, enviadoEm: '2026-11-20T10:00:00Z', conferidoEm: null },
  ]),
  useResumoDiarioExtrato: () => ok([]),
  useAncorasConta: () => ok([]),
  useImportarExtrato: () => ({ isPending: false, mutate: vi.fn() }),
  useMarcarConferido: () => ({ isPending: false, mutate: vi.fn(), variables: null }),
  useRegistrarAncora: () => ({ isPending: false, mutate: vi.fn() }),
}));

import FinanceiroExtratoBancario from '../FinanceiroExtratoBancario';

const montar = () => render(<MemoryRouter><FinanceiroExtratoBancario /></MemoryRouter>);

describe('FinanceiroExtratoBancario — gate do upload', () => {
  beforeEach(() => { auth.isStaff = true; });
  it('staff vê o botão Importar extrato', () => {
    montar();
    expect(screen.getByRole('button', { name: /Importar extrato/ })).toBeTruthy();
  });
  it('não-staff não vê o botão, mas a lista e o resumo continuam', () => {
    auth.isStaff = false;
    montar();
    expect(screen.queryByRole('button', { name: /Importar extrato/ })).toBeNull();
    expect(screen.getByText('Resumo diário')).toBeTruthy();
    expect(screen.getByText('Arquivos importados')).toBeTruthy();
  });
  it('data da âncora pré-preenchida com a véspera do pendente', () => {
    montar();
    expect((screen.getByLabelText('Data') as HTMLInputElement).value).toBe('2026-11-09');
  });
});
