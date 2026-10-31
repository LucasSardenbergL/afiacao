import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Ranking e mapa seguem a REGIÃO e o filtro de CONTATO da fila (migration 20261030071150): a RPC recebe
 * `p_ufs` (MG e vizinhos, sem UF escolhida) e `p_com_contato`; com "só sugeridos" o mesmo recorte vai na
 * consulta de tabela. Builder FALSO: prova a FORMA da chamada, não o banco.
 */
type Chamada = [string, ...unknown[]];
const chamadas: Record<string, Chamada[]> = {};
let rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
const LOTES = [{ mes_referencia: '2026-10', status: 'complete', total_recebido: 500000, novos: 1000, iniciado_em: '2026-10-29T03:00:00+00:00' }];

function builder(tabela: string) {
  chamadas[tabela] = chamadas[tabela] ?? [];
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'like', 'is', 'or', 'filter', 'in', 'order', 'range', 'limit']) {
    b[m] = (...args: unknown[]) => { chamadas[tabela].push([m, ...args]); return b; };
  }
  b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) =>
    Promise.resolve(tabela === 'radar_ingest_state' ? { data: LOTES, error: null } : { data: [], error: null }).then(res, rej);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => builder(t),
    rpc: (fn: string, args: Record<string, unknown>) => { rpcs.push({ fn, args }); return Promise.resolve({ data: [], error: null }); },
  },
}));

import { useRadarContagemMunicipios } from '../useRadarContagemMunicipios';
import type { RadarFiltros } from '../useRadarLista';
import { UFS_ATUACAO } from '@/lib/radar/ui-helpers';

const FILTROS: RadarFiltros = {
  busca: '', uf: '', municipio: '', cnae: '', status: '', incluirJaClientes: false, comTelefone: false,
  preset: 'novas', incluirSaiuDoDump: false, soIneditos: false, soSugeridos: false,
};

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
async function rodar(f: RadarFiltros) {
  const { result } = renderHook(() => useRadarContagemMunicipios(f, '2026-10-30', true), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
}
const argsRpc = () => rpcs.find((r) => r.fn === 'radar_contagem_por_municipio')?.args;

beforeEach(() => { rpcs = []; for (const k of Object.keys(chamadas)) delete chamadas[k]; });

describe('useRadarContagemMunicipios — região e contato da fila', () => {
  it('default da tela (MG e vizinhos, sem contato escondido): p_ufs da região e p_com_contato', async () => {
    await rodar({ ...FILTROS, regiao: 'atuacao', incluirSemContato: false });
    expect(argsRpc()).toMatchObject({ p_uf: null, p_ufs: [...UFS_ATUACAO], p_com_contato: true });
  });
  it('UF escolhida vence a região', async () => {
    await rodar({ ...FILTROS, regiao: 'atuacao', uf: 'PR', incluirSemContato: true });
    expect(argsRpc()).toMatchObject({ p_uf: 'PR', p_ufs: null, p_com_contato: false });
  });
  it('Brasil: sem p_ufs', async () => {
    await rodar({ ...FILTROS, regiao: 'brasil', incluirSemContato: false });
    expect(argsRpc()).toMatchObject({ p_uf: null, p_ufs: null, p_com_contato: true });
  });
  it('chamador sem os campos (testes antigos): o recorte de antes', async () => {
    await rodar(FILTROS);
    expect(argsRpc()).toMatchObject({ p_uf: null, p_ufs: null, p_com_contato: false });
  });
  it('"só sugeridos": a região e o contato entram na consulta de tabela (a RPC nem é chamada)', async () => {
    await rodar({ ...FILTROS, soSugeridos: true, regiao: 'atuacao', incluirSemContato: false });
    expect(argsRpc()).toBeUndefined();
    const c = chamadas.radar_empresas ?? [];
    expect(c).toContainEqual(['in', 'uf', [...UFS_ATUACAO]]);
    expect(c).toContainEqual(['or', 'telefone1.not.is.null,telefone2.not.is.null,email.not.is.null']);
  });
});
