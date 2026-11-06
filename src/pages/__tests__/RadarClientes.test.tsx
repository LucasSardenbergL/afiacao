import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * A página da fila do Radar não tinha teste — por isso o A1 ("Próximo" voltava ao 1º lead no fim dos 50
 * carregados) passou. Aqui a página roda com o react-query DE VERDADE: a lista é um `useInfiniteQuery` sobre
 * páginas falsas e a amostra um `useQuery` com a chave e o staleTime reais, então paginação, erro de página
 * seguinte e invalidação se comportam como em prod. Os filhos pesados viram stubs finos.
 */

// ── fonte falsa ──────────────────────────────────────────────────────────────────────────────
const fonte = vi.hoisted(() => ({
  paginas: [] as RadarEmpresa[][],
  falharPagina: new Set<number>(),
  leiturasLista: 0,
  amostra: [] as { posicao: number; cnpj: string; empresa: RadarEmpresa | null }[],
}));
const toastMock = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isMaster: false, isGestorComercial: false, role: 'employee', commercialRole: null }),
}));
vi.mock('@/hooks/useInfiniteScroll', () => ({ useInfiniteScroll: () => () => {} }));

vi.mock('@/queries/useRadarLista', () => ({
  useRadarLista: (filtros: unknown) =>
    useInfiniteQuery({
      queryKey: ['radar', 'lista', filtros],
      initialPageParam: 0,
      queryFn: async ({ pageParam }) => {
        fonte.leiturasLista += 1;
        if (fonte.falharPagina.has(pageParam as number)) throw new Error('falha de rede na página');
        return fonte.paginas[pageParam as number] ?? [];
      },
      getNextPageParam: (_last, pages) => (pages.length < fonte.paginas.length ? pages.length : undefined),
      retry: false,
    }),
}));
vi.mock('@/queries/useRadarAmostra', () => ({
  useRadarAmostra: () =>
    useQuery({
      queryKey: ['radar', 'amostra'],
      staleTime: 30_000, // o mesmo da query real: sem invalidação, a amostra velha SEGUE na fila
      queryFn: async () => (fonte.amostra.length ? { sorteio: 's1', itens: fonte.amostra.map((i) => ({ ...i })) } : null),
    }),
}));
vi.mock('@/queries/useRadarIrmaos', () => ({ useRadarIrmaos: () => ({ dados: new Map(), estadoDe: () => 'ok' }) }));
vi.mock('@/queries/useRadarVinculosLista', () => ({ useRadarVinculosLista: () => ({ dados: new Map(), estadoDe: () => 'ok' }) }));
vi.mock('@/queries/useRadarKpis', () => ({ useRadarKpis: () => ({ data: undefined }) }));
vi.mock('@/queries/useRadarLoteVigente', () => ({ useRadarLoteVigente: () => ({ data: null }) }));
const lerEmpresaRadar = vi.hoisted(() => vi.fn());
vi.mock('@/queries/useRadarConflitosCadastro', () => ({ lerEmpresaRadar }));
vi.mock('@/queries/useRadarAcoesLead', () => ({ depsCadastroSupabase: {} }));
vi.mock('@/queries/useRadarLote', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/queries/useRadarLote')>();
  return { ...real, useRadarLoteOmie: () => ({ lote: null, rodando: false, progresso: null }) };
});

// ── filhos pesados → stubs ───────────────────────────────────────────────────────────────────
vi.mock('@/components/radar/RadarKpis', () => ({ RadarKpis: () => null, RadarChipsLote: () => null }));
vi.mock('@/components/radar/RadarFavoritos', () => ({ RadarFavoritos: () => null }));
vi.mock('@/components/radar/RadarFiltros', () => ({ RadarFiltros: () => null }));
vi.mock('@/components/radar/RadarAmostraRegra', () => ({ RadarAmostraRegra: () => null }));
vi.mock('@/components/radar/RadarRankingCidades', () => ({ RadarRankingCidades: () => null }));
vi.mock('@/components/radar/RadarConflitosCadastro', () => ({ RadarConflitosIndicador: () => null }));
vi.mock('@/components/radar/RadarLoteDialog', () => ({ RadarLoteDialog: () => null }));
vi.mock('@/components/radar/RadarMapa', () => ({ default: () => <div data-testid="mapa">mapa</div> }));
vi.mock('@/components/radar/RadarLinha', () => ({
  RadarLinha: ({ empresa, selecionada, onSelecionar, onAbrir }: {
    empresa: RadarEmpresa; selecionada: boolean; onSelecionar: (v: boolean) => void; onAbrir: () => void;
  }) => (
    <div data-testid="linha" data-cnpj={empresa.cnpj}>
      <input type="checkbox" aria-label={`Selecionar ${empresa.cnpj}`} checked={selecionada} onChange={(e) => onSelecionar(e.target.checked)} />
      <button onClick={onAbrir}>abrir {empresa.cnpj}</button>
    </div>
  ),
}));
vi.mock('@/components/radar/RadarDetailSheet', () => ({
  RadarDetailSheet: ({ empresa, onProximo }: { empresa: RadarEmpresa | null; onProximo?: () => void }) =>
    empresa ? (
      <div data-testid="ficha">
        <span data-testid="ficha-cnpj">{empresa.cnpj}</span>
        <button onClick={onProximo}>Próximo</button>
      </div>
    ) : null,
}));
// A barra de lote de verdade é grande; o stub usa a ação em lote REAL (é ela que invalida o cache).
vi.mock('@/components/radar/RadarAcoesLote', async () => {
  const { useRadarAcaoEmLote } = await import('@/queries/useRadarLote');
  return {
    RadarAcoesLote: ({ selecao }: { selecao: RadarEmpresa[] }) => {
      const acao = useRadarAcaoEmLote();
      return (
        <div>
          <span data-testid="selecionados">{selecao.length}</span>
          <button
            onClick={() => void acao.executar(selecao.map((e) => e.cnpj), async (cnpj: string) => {
              // o servidor descarta: a linha de radar_empresas muda de status
              fonte.amostra = fonte.amostra.map((i) => (i.cnpj === cnpj && i.empresa ? { ...i, empresa: { ...i.empresa, prospeccao_status: 'descartado' } } : i));
              fonte.paginas = fonte.paginas.map((p) => p.filter((e) => e.cnpj !== cnpj));
              return { id: cnpj, deduped: false };
            }, 'radar.descartar_lote')}
          >
            Descartar selecionados
          </button>
        </div>
      );
    },
  };
});

import RadarClientes from '../RadarClientes';

function lead(cnpj: string, extra: Partial<RadarEmpresa> = {}): RadarEmpresa {
  return {
    cnpj, razao_social: `Empresa ${cnpj}`, nome_fantasia: null, uf: 'MG', municipio_nome: 'BELO HORIZONTE',
    cnae_principal: '4744005', cnaes_secundarios: null, prospeccao_status: 'a_contatar', ja_cliente: false, ...extra,
  } as unknown as RadarEmpresa;
}

function montar(rota = '/radar') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[rota]}>{children}</MemoryRouter></QueryClientProvider>
  );
  return { qc, ...render(<RadarClientes />, { wrapper }) };
}
const cnpjsNaLista = () => screen.queryAllByTestId('linha').map((l) => l.getAttribute('data-cnpj'));

beforeEach(() => {
  vi.clearAllMocks();
  fonte.paginas = [];
  fonte.falharPagina = new Set();
  fonte.leiturasLista = 0;
  fonte.amostra = [];
});

describe('RadarClientes — fila do vendedor', () => {
  it('A1: "Próximo" no fim da página carrega a seguinte; no fim de verdade fecha a ficha e avisa (nunca volta ao 1º)', async () => {
    fonte.paginas = [[lead('A'), lead('B')], [lead('C')]];
    montar();
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A', 'B']));

    fireEvent.click(screen.getByText('abrir B'));
    expect(screen.getByTestId('ficha-cnpj').textContent).toBe('B');

    fireEvent.click(within(screen.getByTestId('ficha')).getByText('Próximo'));
    await waitFor(() => expect(screen.getByTestId('ficha-cnpj').textContent).toBe('C'));
    expect(cnpjsNaLista()).toEqual(['A', 'B', 'C']);

    fireEvent.click(within(screen.getByTestId('ficha')).getByText('Próximo'));
    await waitFor(() => expect(screen.queryByTestId('ficha')).toBeNull());
    expect(toastMock.info).toHaveBeenCalledWith('Fim da fila', expect.objectContaining({ description: expect.any(String) }));
  });

  it('A2: o lead de controle (amostra) descartado em lote sai da fila', async () => {
    fonte.paginas = [[lead('A'), lead('B')]];
    fonte.amostra = [{ posicao: 1, cnpj: 'X', empresa: lead('X') }];
    montar();
    // Fila acabou → a amostra pendente entra no fim.
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A', 'B', 'X']));

    fireEvent.click(screen.getByLabelText('Selecionar X'));
    fireEvent.click(screen.getByText('Descartar selecionados'));

    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A', 'B']));
  });

  it('A5: falha na página seguinte PRESERVA a lista e oferece "Tentar carregar mais"', async () => {
    fonte.paginas = [[lead('A'), lead('B')], [lead('C')]];
    fonte.falharPagina = new Set([1]);
    montar();
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A', 'B']));

    fireEvent.click(screen.getByText('abrir B'));
    fireEvent.click(within(screen.getByTestId('ficha')).getByText('Próximo'));

    await waitFor(() => expect(screen.getByTestId('radar-erro-pagina')).toBeTruthy());
    expect(cnpjsNaLista()).toEqual(['A', 'B']); // a lista não sumiu
    expect(screen.queryByText('Não foi possível carregar a fila')).toBeNull();
    expect(toastMock.error).toHaveBeenCalled();

    fonte.falharPagina = new Set();
    fireEvent.click(screen.getByText('Tentar carregar mais'));
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A', 'B', 'C']));
  });

  it('A5: falha sem nenhuma página mostra o erro com "Tentar de novo"; fila vazia oferece "Limpar filtros"', async () => {
    fonte.paginas = [[lead('A')]];
    fonte.falharPagina = new Set([0]);
    const v = montar();
    await waitFor(() => expect(screen.getByText('Não foi possível carregar a fila')).toBeTruthy());
    fonte.falharPagina = new Set();
    fireEvent.click(screen.getByText('Tentar de novo'));
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A']));
    v.unmount();

    fonte.paginas = [[]];
    montar('/radar?uf=SP');
    await waitFor(() => expect(screen.getByText('Nenhuma empresa nesta fila')).toBeTruthy());
    expect(screen.queryByText(/modo de ataque/)).toBeNull();
    expect(screen.getByText('Limpar filtros')).toBeTruthy();
  });

  it('A6: trocar Lista ↔ Mapa preserva a seleção e não relê a fila', async () => {
    fonte.paginas = [[lead('A'), lead('B')]];
    montar();
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A', 'B']));
    fireEvent.click(screen.getByLabelText('Selecionar A'));
    expect(screen.getByTestId('selecionados').textContent).toBe('1');
    const leituras = fonte.leiturasLista;

    fireEvent.click(screen.getByRole('button', { name: 'Mapa' }));
    await waitFor(() => expect(screen.getByTestId('mapa')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Lista' }));
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A', 'B']));

    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('selecionados').textContent).toBe('1');
    expect((screen.getByLabelText('Selecionar A') as HTMLInputElement).checked).toBe(true);
    expect(fonte.leiturasLista).toBe(leituras);
  });

  it('B5: /radar?cnpj=… abre a ficha — da fila carregada, ou lida pelo CNPJ quando fora dela', async () => {
    fonte.paginas = [[lead('A'), lead('B')]];
    const v = montar('/radar?cnpj=B');
    await waitFor(() => expect(screen.getByTestId('ficha-cnpj').textContent).toBe('B'));
    expect(lerEmpresaRadar).not.toHaveBeenCalled();
    v.unmount();

    lerEmpresaRadar.mockResolvedValueOnce(lead('Z', { prospeccao_status: 'descartado' }));
    montar('/radar?cnpj=Z');
    await waitFor(() => expect(screen.getByTestId('ficha-cnpj').textContent).toBe('Z'));
    expect(lerEmpresaRadar).toHaveBeenCalledWith('Z');
    expect(cnpjsNaLista()).toEqual(['A', 'B']); // abrir pelo link não mexe na fila
  });

  it('B5: CNPJ do link que não existe no Radar fecha a ficha e diz por quê', async () => {
    fonte.paginas = [[lead('A')]];
    lerEmpresaRadar.mockResolvedValueOnce(null);
    montar('/radar?cnpj=NAOEXISTE');
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Lead não encontrado no Radar', expect.anything()));
    expect(screen.queryByTestId('ficha')).toBeNull();
  });
});
