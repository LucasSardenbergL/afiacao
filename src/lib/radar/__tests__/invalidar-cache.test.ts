/**
 * Pacote N, item 1: a invalidação depois de uma ação sobre UM lead não relê as N páginas da fila.
 *
 * Cache REAL do react-query (QueryClient + observers, sem React): as filas são queries infinitas com a mesma forma de
 * chave da `useRadarLista` (['radar','lista', filtros, hoje, versão, lote, visão]) e o MESMO `proximoOffset`. O
 * supabase é falso (a lista não é lida daqui); a leitura avulsa do lead (`lerEmpresaRadar`) é um mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InfiniteQueryObserver, QueryClient, QueryObserver, type InfiniteData } from '@tanstack/react-query';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
const lerEmpresaRadar = vi.fn();
vi.mock('@/queries/useRadarConflitosCadastro', () => ({ lerEmpresaRadar: (c: string) => lerEmpresaRadar(c) }));

import { invalidarRadar } from '@/lib/radar/invalidar-cache';
import {
  aplicarLeadNasPaginas, leadSegueNaFila, PAGINACAO_DA_FILA, type RadarEmpresa, type RadarFiltros,
} from '@/queries/useRadarLista';

const FILTROS: RadarFiltros = {
  busca: '', uf: '', municipio: '', cnae: '', status: '', incluirJaClientes: false, comTelefone: false,
  preset: 'score', incluirSaiuDoDump: false, soIneditos: false, soSugeridos: false,
};
const lead = (cnpj: string, extra: Partial<RadarEmpresa> = {}) =>
  ({ cnpj, prospeccao_status: 'a_contatar', ja_cliente: false, ...extra }) as RadarEmpresa;
const pagina = (prefixo: string, n: number) => Array.from({ length: n }, (_, i) => lead(`${prefixo}${i}`));

type Paginas = InfiniteData<RadarEmpresa[], number>;

/** Uma fila "montada": observer ativo, servidor falso por offset, contador de leituras. */
function montarFila(qc: QueryClient, servidor: RadarEmpresa[], opcoes: { filtros?: RadarFiltros; visao?: string } = {}) {
  const leituras: number[] = [];
  const obs = new InfiniteQueryObserver<RadarEmpresa[], Error, Paginas, readonly unknown[], number>(qc, {
    queryKey: ['radar', 'lista', opcoes.filtros ?? FILTROS, '2026-11-08', 'v1', 'lote', opcoes.visao ?? 'fila'],
    ...PAGINACAO_DA_FILA, // a MESMA paginação da useRadarLista (offset, marca das páginas encolhidas)
    queryFn: async ({ pageParam }) => { leituras.push(pageParam); return servidor.slice(pageParam, pageParam + 50); },
  });
  const sair = obs.subscribe(() => {});
  return { obs, leituras, sair, cnpjs: () => (obs.getCurrentResult().data?.pages ?? []).flat().map((e) => e.cnpj) };
}

async function carregarPaginas(f: ReturnType<typeof montarFila>, n: number) {
  await vi.waitFor(() => expect(f.obs.getCurrentResult().isSuccess).toBe(true));
  for (let i = 1; i < n; i++) await f.obs.fetchNextPage();
}

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  lerEmpresaRadar.mockReset();
});

describe('invalidarRadar com cnpj — a fila troca a linha, não relê as páginas', () => {
  it('contato registrado num lead da página 3 de 3: zero radar_lista, a linha fica no lugar com o estado novo', async () => {
    const servidor = [...pagina('A', 50), ...pagina('B', 50), ...pagina('C', 50)];
    const f = montarFila(qc, servidor);
    await carregarPaginas(f, 3);
    expect(f.leituras).toEqual([0, 50, 100]);
    const antes = f.cnpjs();

    lerEmpresaRadar.mockResolvedValue(lead('C7', { prospeccao_status: 'em_conversa' }));
    await invalidarRadar(qc, { cnpj: 'C7' });

    expect(f.leituras).toEqual([0, 50, 100]); // nenhuma página relida
    expect(lerEmpresaRadar).toHaveBeenCalledTimes(1);
    expect(f.cnpjs()).toEqual(antes); // mesma ordem, nada pisca
    const c7 = f.obs.getCurrentResult().data!.pages[2].find((e) => e.cnpj === 'C7');
    expect(c7?.prospeccao_status).toBe('em_conversa');
    f.sair();
  });

  it('o lead virou cliente (fila sem já-clientes): sai no lugar, e a página seguinte começa no offset certo', async () => {
    const servidor = [...pagina('A', 50), ...pagina('B', 50), lead('Z')];
    const f = montarFila(qc, servidor);
    await carregarPaginas(f, 1);

    lerEmpresaRadar.mockResolvedValue(lead('A3', { ja_cliente: true, prospeccao_status: 'convertido' }));
    await invalidarRadar(qc, { cnpj: 'A3' });
    expect(f.cnpjs()).not.toContain('A3');
    expect(f.cnpjs()).toHaveLength(49);
    // No servidor o A3 também saiu do recorte: o recorte encolheu uma linha antes do offset 50.
    servidor.splice(3, 1);
    // A última página encolheu para 49, mas o servidor mandou 50: ainda há mais.
    expect(f.obs.getCurrentResult().hasNextPage).toBe(true);
    await f.obs.fetchNextPage();
    expect(f.leituras).toEqual([0, 49]); // offset = linhas em cache, não página × 50 (pularia o B0)
    expect(f.cnpjs().slice(48, 50)).toEqual(['A49', 'B0']);
    f.sair();
  });

  it('com "incluir já-clientes" o lead que virou cliente FICA, atualizado', async () => {
    const f = montarFila(qc, pagina('A', 10), { filtros: { ...FILTROS, incluirJaClientes: true } });
    await carregarPaginas(f, 1);
    lerEmpresaRadar.mockResolvedValue(lead('A2', { ja_cliente: true, prospeccao_status: 'convertido' }));
    await invalidarRadar(qc, { cnpj: 'A2' });
    expect(f.cnpjs()).toHaveLength(10);
    expect(f.obs.getCurrentResult().data!.pages[0][2].ja_cliente).toBe(true);
    expect(f.leituras).toEqual([0]);
    f.sair();
  });

  it('descartado sai da fila padrão; com o filtro de status "descartado" ele fica', () => {
    const descartado = lead('X', { prospeccao_status: 'descartado' });
    expect(leadSegueNaFila(FILTROS, 'fila', descartado)).toBe(false);
    expect(leadSegueNaFila({ ...FILTROS, status: 'descartado' }, 'fila', descartado)).toBe(true);
    expect(leadSegueNaFila({ ...FILTROS, status: 'a_contatar' }, 'fila', lead('Y', { prospeccao_status: 'em_conversa' }))).toBe(false);
  });

  it('recorte que depende de outra tabela (meus, para visitar, só sugeridos): não decide — relê a fila', async () => {
    expect(leadSegueNaFila(FILTROS, 'meus', lead('A'))).toBeNull();
    expect(leadSegueNaFila({ ...FILTROS, paraVisitar: true }, 'fila', lead('A'))).toBeNull();
    expect(leadSegueNaFila({ ...FILTROS, soSugeridos: true }, 'fila', lead('A'))).toBeNull();

    const f = montarFila(qc, [...pagina('M', 50), ...pagina('N', 5)], { visao: 'meus' });
    await carregarPaginas(f, 2);
    lerEmpresaRadar.mockResolvedValue(lead('M1', { prospeccao_status: 'em_conversa' }));
    await invalidarRadar(qc, { cnpj: 'M1' });
    await vi.waitFor(() => expect(f.leituras).toEqual([0, 50, 0, 50]));
    f.sair();
  });

  it('leitura do lead FALHA: a fila relê inteira (nunca fica com a linha velha em silêncio)', async () => {
    const f = montarFila(qc, pagina('A', 10));
    await carregarPaginas(f, 1);
    lerEmpresaRadar.mockRejectedValue(new Error('falha de rede'));
    await invalidarRadar(qc, { cnpj: 'A1' });
    await vi.waitFor(() => expect(f.leituras).toEqual([0, 0]));
    f.sair();
  });

  it('lead fora das páginas carregadas: dentro do recorte relê (pode ter entrado no meio); fora, não faz nada', () => {
    const data: InfiniteData<RadarEmpresa[], unknown> = { pages: [pagina('A', 3)], pageParams: [0] };
    expect(aplicarLeadNasPaginas(data, FILTROS, 'fila', 'Q', lead('Q')).tipo).toBe('reler');
    expect(aplicarLeadNasPaginas(data, FILTROS, 'fila', 'Q', lead('Q', { ja_cliente: true })).tipo).toBe('nada');
    expect(aplicarLeadNasPaginas(data, FILTROS, 'fila', 'Q', null).tipo).toBe('nada');
    // Lead que não existe mais e ESTÁ na página: sai.
    const r = aplicarLeadNasPaginas(data, FILTROS, 'fila', 'A1', null);
    expect(r.tipo === 'trocar' && r.data.pages[0].map((e) => e.cnpj)).toEqual(['A0', 'A2']);
  });

  it('o mapa e o ranking só ficam velhos (sem releitura); a ficha e os KPIs relêem', async () => {
    const f = montarFila(qc, pagina('A', 5));
    await carregarPaginas(f, 1);
    const chamadas = { mapa: 0, kpis: 0 };
    const mapa = new QueryObserver(qc, { queryKey: ['radar', 'contagem-municipios', {}], queryFn: async () => { chamadas.mapa++; return []; } });
    const kpis = new QueryObserver(qc, { queryKey: ['radar', 'kpis'], queryFn: async () => { chamadas.kpis++; return 1; } });
    const s1 = mapa.subscribe(() => {}); const s2 = kpis.subscribe(() => {});
    await vi.waitFor(() => expect(chamadas).toEqual({ mapa: 1, kpis: 1 }));

    lerEmpresaRadar.mockResolvedValue(lead('A1', { prospeccao_status: 'em_conversa' }));
    await invalidarRadar(qc, { cnpj: 'A1' });
    await vi.waitFor(() => expect(chamadas.kpis).toBe(2));
    expect(chamadas.mapa).toBe(1);
    expect(qc.getQueryState(['radar', 'contagem-municipios', {}])?.isInvalidated).toBe(true);
    // A leitura avulsa foi para a MESMA chave da ficha: quem abrir a ficha não relê de novo.
    expect(qc.getQueryData(['radar', 'empresa', 'A1'])).toMatchObject({ prospeccao_status: 'em_conversa' });
    s1(); s2(); f.sair();
  });

  it('allowlist (revisão 2026-11-11, item 1): os selos por página e as chaves de OUTRO lead só ficam velhos', async () => {
    const f = montarFila(qc, [...pagina('A', 50), ...pagina('B', 50)]);
    await carregarPaginas(f, 2);
    const chamadas: Record<string, number> = {};
    const observar = (chave: readonly unknown[]) => {
      const nome = chave.map(String).join('|');
      chamadas[nome] = 0;
      const o = new QueryObserver(qc, { queryKey: chave, queryFn: async () => { chamadas[nome]++; return []; } });
      return o.subscribe(() => {});
    };
    const saidas = [
      observar(['radar', 'irmaos', ['A0', 'A1']]), observar(['radar', 'irmaos', ['B0', 'B1']]),
      observar(['radar', 'vinculos-lista', ['A0', 'A1']]), observar(['radar', 'vinculos-lista', ['B0', 'B1']]),
      observar(['radar', 'contatos', 'A1']), observar(['radar', 'contatos', 'B7']),
      observar(['radar', 'kpis']), observar(['radar', 'prospectar-hoje', 'eu']),
      observar(['radar', 'chave-que-nasceu-depois']),
    ];
    await vi.waitFor(() => expect(Object.values(chamadas).every((n) => n === 1)).toBe(true));

    lerEmpresaRadar.mockResolvedValue(lead('A1', { prospeccao_status: 'em_conversa' }));
    await invalidarRadar(qc, { cnpj: 'A1' });
    await vi.waitFor(() => expect(chamadas['radar|kpis']).toBe(2));
    await vi.waitFor(() => expect(chamadas['radar|prospectar-hoje|eu']).toBe(2));
    await vi.waitFor(() => expect(chamadas['radar|contatos|A1']).toBe(2));
    // Nenhuma RPC por página: 2 páginas × (irmãos + vínculos) = 4 leituras que antes saíam a cada contato.
    expect(chamadas['radar|irmaos|A0,A1']).toBe(1);
    expect(chamadas['radar|irmaos|B0,B1']).toBe(1);
    expect(chamadas['radar|vinculos-lista|A0,A1']).toBe(1);
    expect(chamadas['radar|vinculos-lista|B0,B1']).toBe(1);
    expect(chamadas['radar|contatos|B7']).toBe(1);
    expect(chamadas['radar|chave-que-nasceu-depois']).toBe(1);
    // …mas ficam velhas: a próxima montagem relê.
    expect(qc.getQueryState(['radar', 'irmaos', ['A0', 'A1']])?.isInvalidated).toBe(true);
    expect(f.leituras).toEqual([0, 50]);
    saidas.forEach((s) => s()); f.sair();
  });

  it('sem cnpj (desfazer, ações sem lead definido): o comportamento de antes — relê todas as páginas', async () => {
    const f = montarFila(qc, [...pagina('A', 50), ...pagina('B', 50), ...pagina('C', 3)]);
    await carregarPaginas(f, 3);
    await invalidarRadar(qc);
    await vi.waitFor(() => expect(f.leituras).toEqual([0, 50, 100, 0, 50, 100]));
    expect(lerEmpresaRadar).not.toHaveBeenCalled();
    f.sair();
  });

  it('fila sem ninguém olhando: só fica velha, sem leitura do lead', async () => {
    const f = montarFila(qc, pagina('A', 5));
    await carregarPaginas(f, 1);
    f.sair();
    await invalidarRadar(qc, { cnpj: 'A1' });
    expect(lerEmpresaRadar).not.toHaveBeenCalled();
    expect(f.leituras).toEqual([0]);
    expect(qc.getQueryCache().findAll({ queryKey: ['radar', 'lista'] })[0].state.isInvalidated).toBe(true);
  });
});
