import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * A tela abre na região de atuação (MG e vizinhos) e esconde quem não tem telefone NEM e-mail.
 * O supabase é FALSO: o `.rpc()` grava os argumentos da `radar_lista` (a lista lê pela RPC desde
 * 20261103131500) — prova a FORMA da chamada; a prova PG17 `db/test-radar-lista-rpc.sh` prova que a RPC
 * aplica cada recorte como a consulta de antes.
 */
type Chamada = [string, ...unknown[]];
type Args = Record<string, unknown>;
const chamadas: Record<string, Chamada[]> = {};
let lista: Args[] = [];
let respostas: Record<string, { data: unknown; error: { message: string } | null }> = {};

function builder(tabela: string) {
  chamadas[tabela] = chamadas[tabela] ?? [];
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'or', 'eq', 'neq', 'in', 'gte', 'lte', 'like', 'is', 'filter', 'order', 'range', 'limit']) {
    b[m] = (...args: unknown[]) => { chamadas[tabela].push([m, ...args]); return b; };
  }
  b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve(respostas[tabela]).then(res, rej);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => builder(t),
    rpc: (fn: string, args: Args) => {
      if (fn !== 'radar_lista') throw new Error(`rpc inesperada: ${fn}`);
      lista.push(args);
      return Promise.resolve({ data: [], error: null });
    },
  },
}));

import { useRadarLista, parametrosDaLista, type RadarFiltros } from '../useRadarLista';
import { UFS_ATUACAO } from '@/lib/radar/ui-helpers';

const FILTROS: RadarFiltros = {
  busca: '', uf: '', municipio: '', cnae: '', status: '', incluirJaClientes: false, comTelefone: false,
  preset: 'novas', incluirSaiuDoDump: false, soIneditos: false, soSugeridos: false,
};
const LOTES = [{ mes_referencia: '2026-08', status: 'complete', total_recebido: 501380, novos: 27466, iniciado_em: '2026-10-19T16:31:08.593+00:00' }];

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const doUf = () => lista.map((a) => [a.p_uf, a.p_ufs]);
const doContato = () => lista.map((a) => a.p_com_contato);

async function rodar(f: RadarFiltros) {
  const { result } = renderHook(() => useRadarLista(f, '2026-10-29'), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
}

beforeEach(() => {
  for (const k of Object.keys(chamadas)) delete chamadas[k];
  lista = [];
  respostas = { radar_ingest_state: { data: LOTES, error: null } };
});

describe('useRadarLista — região de atuação', () => {
  it('regiao=atuacao sem UF: uf IN (MG e vizinhos)', async () => {
    await rodar({ ...FILTROS, regiao: 'atuacao' });
    expect(doUf()).toEqual([[undefined, [...UFS_ATUACAO]]]);
  });
  it('UF escolhida vence a região', async () => {
    await rodar({ ...FILTROS, regiao: 'atuacao', uf: 'PR' });
    expect(doUf()).toEqual([['PR', undefined]]);
  });
  it('Brasil: nenhum filtro de UF', async () => {
    await rodar({ ...FILTROS, regiao: 'brasil' });
    expect(doUf()).toEqual([[undefined, undefined]]);
  });
  it('chamador sem o campo (ranking/mapa/testes antigos): recorte de antes, Brasil', async () => {
    await rodar(FILTROS);
    expect(doUf()).toEqual([[undefined, undefined]]);
  });
});

describe('useRadarLista — sem contato', () => {
  it('incluirSemContato=false: exige telefone OU e-mail (filtro positivo)', async () => {
    await rodar({ ...FILTROS, incluirSemContato: false });
    expect(doContato()).toEqual([true]);
  });
  it('incluirSemContato=true: sem o filtro', async () => {
    await rodar({ ...FILTROS, incluirSemContato: true });
    expect(doContato()).toEqual([false]);
  });
  it('ausente: sem o filtro (recorte de antes)', async () => {
    await rodar(FILTROS);
    expect(doContato()).toEqual([false]);
  });
});

/**
 * Busca e município: o termo vai SANITIZADO (o mesmo `sanitizeForPostgrestOr` do `.or()` de antes) — a RPC
 * casa por ILIKE com o curinga escapado; só-curinga = sem filtro (#1062). Era o seq scan que motivou a RPC.
 */
describe('parametrosDaLista — termos, CNAE, ordem e página', () => {
  const LOTE = LOTES[0];
  const params = (f: Partial<RadarFiltros>, pagina = 0) => parametrosDaLista({ ...FILTROS, ...f }, LOTE, '2026-11-03', pagina);

  it('busca e município: aparados e sanitizados; só-curinga ou vazio = sem filtro', () => {
    expect(params({ busca: '  Marcenaria (SC), ' }).p_busca).toBe('Marcenaria SC');
    expect(params({ municipio: ' pomerode ' }).p_municipio).toBe('pomerode');
    expect(params({ busca: '%%' }).p_busca).toBeUndefined();
    expect(params({ busca: '*' }).p_busca).toBeUndefined();
    expect(params({ busca: '   ', municipio: '' }).p_busca).toBeUndefined();
    expect(params({ municipio: '' }).p_municipio).toBeUndefined();
  });

  // C2 (pacote C): a cidade do ranking/mapa vai pelo CÓDIGO, exata; o nome (homônimo em outras UFs) sai.
  it('cidade escolhida: p_municipio_codigo exato e sem p_municipio; sem código, o nome de antes', () => {
    expect(params({ municipio: 'SANTA LUZIA', municipioCodigo: '4123' }))
      .toMatchObject({ p_municipio_codigo: '4123', p_municipio: undefined });
    expect(params({ municipio: 'SANTA LUZIA', municipioCodigo: '' }))
      .toMatchObject({ p_municipio_codigo: undefined, p_municipio: 'SANTA LUZIA' });
    expect(params({ municipio: 'pomerode' }).p_municipio_codigo).toBeUndefined();
  });

  it('CNAE: 7 dígitos = exato; parcial = prefixo; vazio = nada', () => {
    expect(params({ cnae: '3101-2/00' })).toMatchObject({ p_cnae_exato: '3101200', p_cnae_prefixo: undefined });
    expect(params({ cnae: '3101' })).toMatchObject({ p_cnae_exato: undefined, p_cnae_prefixo: '3101' });
    expect(params({ cnae: '' })).toMatchObject({ p_cnae_exato: undefined, p_cnae_prefixo: undefined });
  });

  it('CNAE secundário: só o código completo filtra, e combina com o principal', () => {
    expect(params({ cnae: '3101-2/00', cnaeSecundario: '2391-5/03' }))
      .toMatchObject({ p_cnae_exato: '3101200', p_cnae_secundario: '2391503' });
    expect(params({ cnaeSecundario: '2391' }).p_cnae_secundario).toBeUndefined();
    expect(params({ cnaeSecundario: '' }).p_cnae_secundario).toBeUndefined();
    expect(params({}).p_cnae_secundario).toBeUndefined();
  });

  it('preset vira a coluna de ordem; "estabelecidas" leva o corte de idade', () => {
    expect(params({ preset: 'score' }).p_ordem).toBe('score');
    expect(params({ preset: 'novas' }).p_ordem).toBe('data_abertura');
    const est = params({ preset: 'estabelecidas' });
    expect(est.p_ordem).toBe('capital_social');
    expect(est.p_data_abertura_max).toBe('2021-11-03');
  });

  it('página N = offset N×50, limite 50', () => {
    expect(params({}, 0)).toMatchObject({ p_offset: 0, p_limit: 50 });
    expect(params({}, 3)).toMatchObject({ p_offset: 150, p_limit: 50 });
  });

  it('status escolhido vai; vazio deixa a RPC esconder os descartados', () => {
    expect(params({ status: 'em_conversa' }).p_status).toBe('em_conversa');
    expect(params({ status: '' }).p_status).toBeUndefined();
  });
});
