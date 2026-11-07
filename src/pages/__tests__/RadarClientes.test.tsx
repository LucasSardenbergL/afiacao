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
  // Visão "Meus atendimentos" (B2): as páginas que a RPC devolve com p_so_meus, e a última chamada da lista.
  paginasMeus: [] as RadarEmpresa[][],
  falharMeus: null as string | null,
  ultimaChamada: null as { filtros: Record<string, unknown>; soMeus: boolean } | null,
  atendimentos: [] as { cnpj: string; ehMeu: boolean; expiraEm: string }[],
  falharAtendimentos: false,
  // Pacote F: território do vendedor (radar_meu_territorio) e uma trava para segurar a 1ª página da fila.
  territorio: [] as { municipioCodigo: string; municipioNome: string; uf: string; clientes: number }[],
  falharTerritorio: false,
  travaLista: null as Promise<void> | null,
}));
const toastMock = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isMaster: false, isGestorComercial: false, role: 'employee', commercialRole: null }),
}));
vi.mock('@/hooks/useInfiniteScroll', () => ({ useInfiniteScroll: () => () => {} }));

vi.mock('@/queries/useRadarLista', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/queries/useRadarLista')>();
  return {
    // Os filtros neutros e a chave da visão são os REAIS: o teste confere o que a página manda à RPC.
    FILTROS_MEUS_ATENDIMENTOS: real.FILTROS_MEUS_ATENDIMENTOS,
    CHAVE_VISAO_MEUS: real.CHAVE_VISAO_MEUS,
    useRadarLista: (filtros: Record<string, unknown>, _hoje: string, opcoes: { soMeus?: boolean; aguardar?: boolean } = {}) => {
      const soMeus = opcoes.soMeus === true;
      if (!opcoes.aguardar) fonte.ultimaChamada = { filtros, soMeus };
      // Mesma posição da chave da visão que a query real (7º elemento): é por ela que a página relê "meus".
      return useInfiniteQuery({
        queryKey: ['radar', 'lista', filtros, '', '', '', soMeus ? real.CHAVE_VISAO_MEUS : 'fila'],
        enabled: !opcoes.aguardar,
        initialPageParam: 0,
        queryFn: async ({ pageParam }) => {
          fonte.leiturasLista += 1;
          if (fonte.travaLista) await fonte.travaLista;
          if (soMeus) {
            if (fonte.falharMeus) throw new Error(fonte.falharMeus);
            return fonte.paginasMeus[pageParam as number] ?? [];
          }
          if (fonte.falharPagina.has(pageParam as number)) throw new Error('falha de rede na página');
          return fonte.paginas[pageParam as number] ?? [];
        },
        getNextPageParam: (_last, pages) => (pages.length < (soMeus ? fonte.paginasMeus : fonte.paginas).length ? pages.length : undefined),
        retry: false,
      });
    },
  };
});
vi.mock('@/queries/useRadarAtendimentos', () => ({
  useRadarAtendimentosAtivos: () =>
    useQuery({
      queryKey: ['radar', 'atendimentos-ativos'],
      queryFn: async () => {
        if (fonte.falharAtendimentos) throw new Error('falha ao ler atendimentos');
        return new Map(fonte.atendimentos.map((a) => [a.cnpj, {
        cnpj: a.cnpj, donoUserId: a.ehMeu ? 'u1' : 'u2', donoNome: null, assumidoEm: '2026-11-01T12:00:00Z', expiraEm: a.expiraEm, ehMeu: a.ehMeu,
      }]));
      },
      retry: false,
    }),
}));
vi.mock('@/queries/useRadarMeuTerritorio', () => ({
  useRadarMeuTerritorio: () =>
    useQuery({
      queryKey: ['radar', 'meu-territorio', 'eu'],
      queryFn: async () => {
        if (fonte.falharTerritorio) throw new Error('falha ao ler território');
        return fonte.territorio;
      },
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
vi.mock('@/components/radar/RadarConflitosCadastro', () => ({
  // Porta para abrir uma ficha FORA da fila pela própria página (abrirPorCnpj) — usada no F6.
  RadarConflitosIndicador: ({ onAbrir }: { onAbrir: (cnpj: string) => Promise<void> }) => (
    <button onClick={() => void onAbrir('Z')}>abrir conflito Z</button>
  ),
}));
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
  fonte.paginasMeus = [];
  fonte.falharMeus = null;
  fonte.ultimaChamada = null;
  fonte.atendimentos = [];
  fonte.falharAtendimentos = false;
  fonte.territorio = [];
  fonte.falharTerritorio = false;
  fonte.travaLista = null;
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
    // Pacote F: a leitura pelo CNPJ sai em PARALELO com a fila, mesmo quando o lead está nela (a fila, se chegar
    // antes, vence); antes a página esperava a 1ª página e só então decidia.
    lerEmpresaRadar.mockResolvedValueOnce(lead('B'));
    const v = montar('/radar?cnpj=B');
    await waitFor(() => expect(screen.getByTestId('ficha-cnpj').textContent).toBe('B'));
    v.unmount();

    lerEmpresaRadar.mockResolvedValueOnce(lead('Z', { prospeccao_status: 'descartado' }));
    montar('/radar?cnpj=Z');
    await waitFor(() => expect(screen.getByTestId('ficha-cnpj').textContent).toBe('Z'));
    expect(lerEmpresaRadar).toHaveBeenCalledWith('Z');
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A', 'B'])); // abrir pelo link não mexe na fila
  });

  it('B5: CNPJ do link que não existe no Radar fecha a ficha e diz por quê', async () => {
    fonte.paginas = [[lead('A')]];
    lerEmpresaRadar.mockResolvedValueOnce(null);
    montar('/radar?cnpj=NAOEXISTE');
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Lead não encontrado no Radar', expect.anything()));
    expect(screen.queryByTestId('ficha')).toBeNull();
  });

  it('B1: a fila de hoje vem no topo com "Começar pelo 1º lead"; filtros e território ficam recolhidos para o vendedor', async () => {
    fonte.paginas = [[lead('A'), lead('B')]];
    montar('/radar?uf=SP');
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A', 'B']));
    const topo = screen.getByTestId('radar-fila-de-hoje');
    expect(within(topo).getByText('Sua fila de hoje')).toBeTruthy();
    // filtro ativo é CONTADO no rótulo da seção recolhida (fechar não esconde o recorte)
    expect(within(topo).getByRole('button', { name: /Mais filtros e território/ }).getAttribute('aria-expanded')).toBe('false');
    expect(within(topo).getByText(/1 ativo/)).toBeTruthy();
    fireEvent.click(within(topo).getByText('Começar pelo 1º lead'));
    expect(screen.getByTestId('ficha-cnpj').textContent).toBe('A');
  });

  it('F5: o lead do link é lido EM PARALELO com a fila — a ficha abre antes da 1ª página chegar', async () => {
    let soltar: () => void = () => {};
    fonte.travaLista = new Promise<void>((r) => { soltar = r; });
    fonte.paginas = [[lead('A'), lead('B')]];
    lerEmpresaRadar.mockResolvedValueOnce(lead('Z'));
    montar('/radar?cnpj=Z');
    await waitFor(() => expect(screen.getByTestId('ficha-cnpj').textContent).toBe('Z'));
    expect(cnpjsNaLista()).toEqual([]); // a fila ainda não chegou
    await act(async () => { soltar(); });
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A', 'B']));
  });

  it('F6: "Próximo" na ficha do link (fora da fila) vai para o 1º da fila, não diz "fim"', async () => {
    fonte.paginas = [[lead('A'), lead('B')]];
    lerEmpresaRadar.mockResolvedValueOnce(lead('Z'));
    montar('/radar?cnpj=Z');
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A', 'B']));
    await waitFor(() => expect(screen.getByTestId('ficha-cnpj').textContent).toBe('Z'));
    fireEvent.click(screen.getByText('Próximo'));
    await waitFor(() => expect(screen.getByTestId('ficha-cnpj').textContent).toBe('A'));
    expect(toastMock.info).not.toHaveBeenCalledWith('Fim da fila', expect.anything());
  });

  it('F6: a posição de OUTRO lead não vale para a ficha do link (abri B, depois o link Z → Próximo = A)', async () => {
    fonte.paginas = [[lead('A'), lead('B'), lead('C')]];
    lerEmpresaRadar.mockResolvedValue(lead('Z'));
    montar();
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A', 'B', 'C']));
    fireEvent.click(screen.getByText('abrir B'));
    expect(screen.getByTestId('ficha-cnpj').textContent).toBe('B');
    // Z fora da fila, aberto pela mesma página (indicador de conflitos → abrirPorCnpj)
    fireEvent.click(screen.getByText('abrir conflito Z'));
    await waitFor(() => expect(screen.getByTestId('ficha-cnpj').textContent).toBe('Z'));
    fireEvent.click(screen.getByText('Próximo'));
    // com a posição de B (1) valendo para Z, reabriria B — o certo é o 1º da fila
    await waitFor(() => expect(screen.getByTestId('ficha-cnpj').textContent).toBe('A'));
  });
});

describe('RadarClientes — "Perto dos seus clientes" (pacote F)', () => {
  const T = [
    { municipioCodigo: '4123', municipioNome: 'DIVINOPOLIS', uf: 'MG', clientes: 12 },
    { municipioCodigo: '4567', municipioNome: 'NOVA SERRANA', uf: 'MG', clientes: 5 },
  ];
  const topo = () => within(screen.getByTestId('radar-fila-de-hoje'));

  it('vendedor com território: a fila abre na cidade nº 1 (código exato + UF), com chips e o resumo dizendo', async () => {
    fonte.territorio = T;
    fonte.paginas = [[lead('A')]];
    montar();
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A']));
    expect(fonte.ultimaChamada?.filtros).toMatchObject({ municipioCodigo: '4123', municipio: 'DIVINOPOLIS', uf: 'MG' });
    expect(screen.getByTestId('radar-fila-resumo').textContent).toMatch(/perto dos seus clientes · Divinopolis\/MG/);
    const chip = topo().getByRole('button', { name: /Divinopolis\/MG/ });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    // o automático é o default do vendedor, não "filtro ativo"
    expect(topo().queryByText(/ativo/)).toBeNull();
  });

  it('chip de outra cidade troca o recorte; "Toda a região" volta ao default de antes e fica', async () => {
    fonte.territorio = T;
    fonte.paginas = [[lead('A')]];
    montar();
    await waitFor(() => expect(fonte.ultimaChamada?.filtros).toMatchObject({ municipioCodigo: '4123' }));
    fireEvent.click(topo().getByRole('button', { name: /Nova Serrana\/MG/ }));
    await waitFor(() => expect(fonte.ultimaChamada?.filtros).toMatchObject({ municipioCodigo: '4567', uf: 'MG' }));
    fireEvent.click(topo().getByRole('button', { name: 'Toda a região' }));
    await waitFor(() => expect(fonte.ultimaChamada?.filtros).toMatchObject({ municipioCodigo: '', uf: '', regiao: 'atuacao' }));
    expect(screen.getByTestId('radar-fila-resumo').textContent).toMatch(/MG e vizinhos/);
  });

  it('a fila NÃO busca antes de saber o território (nada de buscar a fila errada e jogar fora)', async () => {
    fonte.territorio = T;
    fonte.paginas = [[lead('A')]];
    montar();
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A']));
    expect(fonte.leiturasLista).toBe(1);
  });

  it('staff sem território: o default de antes (MG e vizinhos), sem chips', async () => {
    fonte.paginas = [[lead('A')]];
    montar();
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A']));
    expect(fonte.ultimaChamada?.filtros).toMatchObject({ municipioCodigo: '', uf: '', regiao: 'atuacao' });
    expect(screen.queryByTestId('radar-territorio')).toBeNull();
  });

  it('lugar explícito na URL vence o território', async () => {
    fonte.territorio = T;
    fonte.paginas = [[lead('A')]];
    montar('/radar?uf=SP');
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A']));
    expect(fonte.ultimaChamada?.filtros).toMatchObject({ uf: 'SP', municipioCodigo: '' });
  });

  it('território que não deu para ler: default de antes e a tela DIZ (ausente ≠ sem território)', async () => {
    fonte.falharTerritorio = true;
    fonte.paginas = [[lead('A')]];
    montar();
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A']));
    expect(screen.getByTestId('radar-fila-resumo').textContent).toMatch(/não consegui ler seu território/);
    expect(fonte.ultimaChamada?.filtros).toMatchObject({ municipioCodigo: '' });
  });
});

describe('RadarClientes — Meus atendimentos (B2)', () => {
  const visao = () => within(screen.getByTestId('radar-fila-de-hoje'));

  it('F4: o cabeçalho e o botão falam da visão — "Seus atendimentos", não "Sua fila de hoje"', async () => {
    fonte.paginasMeus = [[lead('M1')]];
    montar('/radar?visao=meus');
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['M1']));
    expect(screen.getByTestId('radar-fila-titulo').textContent).toBe('Seus atendimentos');
    expect(visao().queryByText('Sua fila de hoje')).toBeNull();
    expect(visao().queryByText('Começar pelo 1º lead')).toBeNull();
    fireEvent.click(visao().getByText('Abrir o 1º atendimento'));
    expect(screen.getByTestId('ficha-cnpj').textContent).toBe('M1');
  });

  it('a visão pede à RPC só os meus (p_so_meus), com filtros NEUTROS, e volta à fila com o recorte de antes', async () => {
    fonte.paginas = [[lead('A'), lead('B')]];
    fonte.paginasMeus = [[lead('M1', { ja_cliente: true }), lead('M2', { uf: 'SP' })]];
    fonte.atendimentos = [
      { cnpj: 'M1', ehMeu: true, expiraEm: '2026-11-12T15:00:00Z' },
      { cnpj: 'M2', ehMeu: true, expiraEm: '2026-11-09T15:00:00Z' },
      { cnpj: 'O1', ehMeu: false, expiraEm: '2026-11-08T15:00:00Z' }, // de outro dono: não é o "próximo vencimento"
    ];
    montar('/radar?uf=SP&soSugeridos=1');
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A', 'B']));
    expect(fonte.ultimaChamada?.soMeus).toBe(false);

    fireEvent.click(visao().getByRole('button', { name: 'Meus atendimentos' }));
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['M1', 'M2']));
    expect(fonte.ultimaChamada?.soMeus).toBe(true);
    // Neutros: o UF=SP e o "só sugeridos" da URL NÃO recortam a visão; já-clientes, Brasil, lote antigo e sem contato entram.
    expect(fonte.ultimaChamada?.filtros).toMatchObject({
      uf: '', soSugeridos: false, incluirJaClientes: true, regiao: 'brasil', incluirSaiuDoDump: true, incluirSemContato: true, status: '',
    });
    expect(visao().getByRole('button', { name: 'Meus atendimentos' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(screen.getByTestId('radar-fila-resumo').textContent).toBe('2 leads com você · o próximo vence em 09/11'));
    // Filtros e território não aparecem (não valem aqui) — e a tela diz por quê.
    expect(visao().queryByRole('button', { name: /Mais filtros e território/ })).toBeNull();
    expect(screen.getByTestId('radar-meus-explica')).toBeTruthy();

    fireEvent.click(visao().getByRole('button', { name: 'Fila' }));
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A', 'B']));
    expect(fonte.ultimaChamada).toMatchObject({ soMeus: false, filtros: { uf: 'SP', soSugeridos: true } });
    expect(visao().getByText(/2 ativos/)).toBeTruthy(); // os filtros da fila seguem contados: a visão não os apagou
  });

  it('a visão vive na URL (/radar?visao=meus abre nela) e entrar nela a partir do mapa volta para a lista', async () => {
    fonte.paginasMeus = [[lead('M1')]];
    const v = montar('/radar?visao=meus');
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['M1']));
    expect(fonte.ultimaChamada?.soMeus).toBe(true);
    v.unmount();

    fonte.paginas = [[lead('A')]];
    montar('/radar?vista=mapa');
    await waitFor(() => expect(screen.getByTestId('mapa')).toBeTruthy());
    fireEvent.click(visao().getByRole('button', { name: 'Meus atendimentos' }));
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['M1']));
    expect(screen.queryByTestId('mapa')).toBeNull();
  });

  it('sem nenhum atendimento: vazio PRÓPRIO com "Ver a fila"; migration ausente: o erro com o motivo, nunca um vazio', async () => {
    fonte.paginas = [[lead('A')]];
    fonte.paginasMeus = [[]];
    const v = montar('/radar?visao=meus');
    await waitFor(() => expect(screen.getByText('Nenhum lead com você agora')).toBeTruthy());
    expect(screen.queryByText('Limpar filtros')).toBeNull(); // não manda limpar filtro que nem vale aqui
    fireEvent.click(screen.getByText('Ver a fila'));
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['A']));
    v.unmount();

    fonte.falharMeus = 'Could not find the function public.radar_lista(p_so_meus, ...) in the schema cache';
    montar('/radar?visao=meus');
    await waitFor(() => expect(screen.getByText('Não foi possível carregar a fila')).toBeTruthy());
    expect(screen.getByText(/Could not find the function public\.radar_lista/)).toBeTruthy();
    expect(screen.queryByText('Nenhum lead com você agora')).toBeNull();
  });

  it('leitura da posse falhou: o resumo DIZ "vencimento indisponível" (ausente ≠ nada vence) e a lista segue', async () => {
    fonte.paginasMeus = [[lead('M1')]];
    fonte.falharAtendimentos = true;
    montar('/radar?visao=meus');
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['M1']));
    await waitFor(() => expect(screen.getByTestId('radar-fila-resumo').textContent).toBe('1 lead com você · vencimento indisponível'));
  });

  it('assumir/liberar muda o conjunto dos meus → as páginas da visão são relidas (a lista não fica com a posse velha)', async () => {
    fonte.paginasMeus = [[lead('M1'), lead('M2')]];
    fonte.atendimentos = [{ cnpj: 'M1', ehMeu: true, expiraEm: '2026-11-12T15:00:00Z' }, { cnpj: 'M2', ehMeu: true, expiraEm: '2026-11-12T15:00:00Z' }];
    const { qc } = montar('/radar?visao=meus');
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['M1', 'M2']));
    await waitFor(() => expect(screen.getByTestId('radar-fila-resumo').textContent).toContain('o próximo vence em'));
    const leituras = fonte.leiturasLista;

    // Releitura dos atendimentos SEM mudança no conjunto: nada a reler.
    await act(async () => { await qc.invalidateQueries({ queryKey: ['radar', 'atendimentos-ativos'] }); });
    expect(fonte.leiturasLista).toBe(leituras);

    // O vendedor liberou o M2 (o servidor já não o devolve como meu).
    fonte.atendimentos = [{ cnpj: 'M1', ehMeu: true, expiraEm: '2026-11-12T15:00:00Z' }];
    fonte.paginasMeus = [[lead('M1')]];
    await act(async () => { await qc.invalidateQueries({ queryKey: ['radar', 'atendimentos-ativos'] }); });
    await waitFor(() => expect(cnpjsNaLista()).toEqual(['M1']));
  });
});
