import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SucessaoDeclarada, SucessoesDoDocumento } from '@/lib/radar/sucessao';

/**
 * Sucessão declarada na ficha do Radar: o selo (fato, separado das pistas) aparece para quem lê o Radar e segue lá
 * independente de já-cliente; declarar/confirmar pista/revogar só gestor/master e nunca na lente "Ver como"
 * (a fronteira é o gate das RPCs). Confirmar uma pista abre a declaração já com o CNPJ do cliente antigo, e a
 * escrita leva a versão otimista lida.
 */
let auth: { role: string | null; commercialRole: string | null } = { role: 'master', commercialRole: null };
let lente = false;
let leitura: SucessoesDoDocumento = { versao: 0, sucessoes: [] };
const declarar = vi.fn();
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: lente }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
const ok = (data: unknown) => ({
  data, isPending: false, isLoading: false, isError: false, isSuccess: true, isFetching: false, error: null,
  status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1, refetch: vi.fn(),
});
vi.mock('@/queries/useRadarSucessoes', () => ({
  useRadarSucessoes: () => ok(leitura),
  useRadarPreviaSucessao: (v: unknown) => (v ? ok({
    dataCorte: '2026-10-06', aberturaNovo: '2026-10-06',
    antigo: { documento: '03166577000166', nome: 'DIVIMOVEIS', cadastrado: true, candidatos: 1, pedidosAntes: 3,
      pedidosAPartir: 1, primeiroPedido: '2026-09-10', ultimoPedido: '2026-10-06', datasEstimadas: 1, recentes: [] },
    novo: { documento: '69491768000101', nome: 'MARQUES', cadastrado: false, candidatos: 0, pedidosAntes: null,
      pedidosAPartir: null, primeiroPedido: null, ultimoPedido: null, datasEstimadas: null, recentes: [] },
  }) : { ...ok(undefined), isSuccess: false, data: undefined }),
  useRadarDeclararSucessao: () => ({ isPending: false, mutateAsync: declarar }),
  useRadarRevogarSucessao: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock('@/queries/useRadarPossiveisVinculos', () => ({
  useRadarPossiveisVinculos: () => ok([
    { clienteCnpj: '03166577000166', clienteNome: 'DIVIMOVEIS', clienteSituacao: '02', forca: 'forte', sinais: ['pessoa'] },
  ]),
}));

import { RadarSucessaoLead } from '../RadarSucessaoLead';

const declarada = (o: Partial<SucessaoDeclarada> = {}): SucessaoDeclarada => ({
  id: 'id1', eventoId: 'ev1', papel: 'novo', antigoDocumento: '03166577000166', antigoNome: 'DIVIMOVEIS',
  novoDocumento: '69491768000101', novoNome: 'MARQUES', tipo: 'cisao', dataCorte: '2026-10-06',
  dataCorteSugerida: '2026-10-06', observacao: null, declaradoPorNome: 'Lucas', declaradoEm: '2026-11-07T01:00:00Z',
  revogadoEm: null, revogadoPorNome: null, revogadoMotivo: null, estado: 'declarada', impedimento: 'novo_sem_cadastro', ...o,
});

const ficha = () => render(<RadarSucessaoLead cnpj="69491768000101" dataAbertura="2026-10-06" />);

beforeEach(() => {
  auth = { role: 'master', commercialRole: null };
  lente = false;
  leitura = { versao: 0, sucessoes: [] };
  declarar.mockReset();
});

describe('RadarSucessaoLead', () => {
  it('selo da cisão declarada, com o impedimento concreto, para o vendedor (sem botões de gestão)', () => {
    auth = { role: 'employee', commercialRole: 'farmer' };
    leitura = { versao: 1, sucessoes: [declarada()] };
    ficha();
    expect(screen.getByTestId('radar-sucessao').textContent).toContain('Cisão confirmada de DIVIMOVEIS');
    expect(screen.getByTestId('radar-sucessao').textContent).toContain('O histórico só passa a valer depois do cadastro no Omie');
    expect(screen.queryByText('Revogar')).toBeNull();
    expect(screen.queryByTestId('radar-declarar-sucessao')).toBeNull();
    expect(screen.queryByTestId('radar-vinculo-confirmar')).toBeNull();
  });

  it('a pista já declarada não oferece "confirmar" de novo; gestor vê Revogar', () => {
    leitura = { versao: 1, sucessoes: [declarada({ estado: 'ativa', impedimento: null })] };
    ficha();
    expect(screen.getByTestId('radar-sucessao').textContent).toContain('Vale a partir de 06/10/2026');
    expect(screen.getByText('Revogar')).toBeTruthy();
    expect(screen.queryByTestId('radar-vinculo-confirmar')).toBeNull();
  });

  it('na lente "Ver como" o master não declara, não confirma nem revoga', () => {
    lente = true;
    leitura = { versao: 1, sucessoes: [declarada()] };
    ficha();
    expect(screen.queryByTestId('radar-declarar-sucessao')).toBeNull();
    expect(screen.queryByTestId('radar-vinculo-confirmar')).toBeNull();
    expect(screen.queryByText('Revogar')).toBeNull();
  });

  it('confirmar a pista abre a declaração com o CNPJ antigo e envia com a versão lida', async () => {
    leitura = { versao: 7, sucessoes: [] };
    declarar.mockResolvedValue({ ok: true, versao: 8, antigoNome: 'DIVIMOVEIS', novoCadastrado: false });
    ficha();
    fireEvent.click(screen.getByTestId('radar-vinculo-confirmar'));
    expect((screen.getByLabelText('CNPJ do cliente antigo') as HTMLInputElement).value).toBe('03166577000166');
    expect((screen.getByLabelText('Data de corte comercial') as HTMLInputElement).value).toBe('2026-10-06');
    expect(screen.getByTestId('radar-previa-sucessao').textContent).toContain('3 pedido(s) antes do corte');
    fireEvent.click(screen.getByTestId('radar-confirmar-sucessao'));
    await waitFor(() => expect(declarar).toHaveBeenCalledTimes(1));
    expect(declarar).toHaveBeenCalledWith(expect.objectContaining({
      antigo: '03166577000166', novo: '69491768000101', tipo: 'cisao', dataCorte: '2026-10-06', versao: 7,
      dataCorteSugerida: '2026-10-06',
    }));
  });
});
