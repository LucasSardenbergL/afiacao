import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * A tela abre na região de atuação (MG e vizinhos) e esconde quem não tem telefone NEM e-mail.
 * O supabase é um builder FALSO que grava a cadeia de filtros — prova a FORMA da query, não o banco.
 */
type Chamada = [string, ...unknown[]];
const chamadas: Record<string, Chamada[]> = {};
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
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => builder(t) } }));

import { useRadarLista, type RadarFiltros } from '../useRadarLista';
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
const doUf = () => chamadas.radar_empresas.filter((c) => (c[0] === 'eq' || c[0] === 'in') && c[1] === 'uf');
const CONTATO = 'telefone1.not.is.null,telefone2.not.is.null,email.not.is.null';
const doContato = () => chamadas.radar_empresas.filter((c) => c[0] === 'or' && c[1] === CONTATO);

async function rodar(f: RadarFiltros) {
  const { result } = renderHook(() => useRadarLista(f, '2026-10-29'), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
}

beforeEach(() => {
  for (const k of Object.keys(chamadas)) delete chamadas[k];
  respostas = { radar_ingest_state: { data: LOTES, error: null }, radar_empresas: { data: [], error: null } };
});

describe('useRadarLista — região de atuação', () => {
  it('regiao=atuacao sem UF: uf IN (MG e vizinhos)', async () => {
    await rodar({ ...FILTROS, regiao: 'atuacao' });
    expect(doUf()).toEqual([['in', 'uf', [...UFS_ATUACAO]]]);
  });
  it('UF escolhida vence a região', async () => {
    await rodar({ ...FILTROS, regiao: 'atuacao', uf: 'PR' });
    expect(doUf()).toEqual([['eq', 'uf', 'PR']]);
  });
  it('Brasil: nenhum filtro de UF', async () => {
    await rodar({ ...FILTROS, regiao: 'brasil' });
    expect(doUf()).toEqual([]);
  });
  it('chamador sem o campo (ranking/mapa/testes antigos): recorte de antes, Brasil', async () => {
    await rodar(FILTROS);
    expect(doUf()).toEqual([]);
  });
});

describe('useRadarLista — sem contato', () => {
  it('incluirSemContato=false: exige telefone OU e-mail (filtro positivo)', async () => {
    await rodar({ ...FILTROS, incluirSemContato: false });
    expect(doContato()).toHaveLength(1);
  });
  it('incluirSemContato=true: sem o filtro', async () => {
    await rodar({ ...FILTROS, incluirSemContato: true });
    expect(doContato()).toEqual([]);
  });
  it('ausente: sem o filtro (recorte de antes)', async () => {
    await rodar(FILTROS);
    expect(doContato()).toEqual([]);
  });
});
