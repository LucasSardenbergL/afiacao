import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// O "Faturamento 12m" do Customer 360 saía da lista de pedidos recentes: todo status e um limit(200)
// por created_at que escondia 55–72% do faturamento dos 3 maiores clientes (2026-10-01). Agora é uma
// query própria — universo canônico, janela por order_date_kpi, paginada — e a falha é ERRO, não R$ 0.
//
// O mock é FIEL ao PostgREST onde a prova depende dele (parecer Codex de desenho, P1-3): o `range`
// devolve SÓ a fatia pedida e nenhuma resposta passa de 1.000 linhas (a capa silenciosa). Um mock que
// ignorasse o `range` aprovaria `.range(0, 199)` — exatamente o corte que este hook existe para tirar.

type Chamada = { table: string; metodos: Array<[string, unknown[]]> };
const ERRO_PG = { message: 'canceling statement due to statement timeout', code: '57014' };
const CAPA_POSTGREST = 1000;

let linhas: Array<{ total: number }> = [];
/** Página (de 1.000) do `sales_orders` que volta com erro; `null` = nenhuma. */
let paginaQueFalha: number | null = null;
let mvFalha = false;
let chamadas: Chamada[] = [];

function chain(table: string): unknown {
  const registro: Chamada = { table, metodos: [] };
  chamadas.push(registro);
  let de = 0;
  let ate = Number.POSITIVE_INFINITY;
  let limite = Number.POSITIVE_INFINITY;
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lte', 'not', 'is', 'order', 'maybeSingle']) {
    c[m] = (...args: unknown[]) => {
      registro.metodos.push([m, args]);
      return c;
    };
  }
  c.range = (inicio: number, fim: number) => {
    registro.metodos.push(['range', [inicio, fim]]);
    de = inicio;
    ate = fim;
    return c;
  };
  c.limit = (n: number) => {
    registro.metodos.push(['limit', [n]]);
    limite = n;
    return c;
  };
  c.then = (resolve: (v: unknown) => void) => {
    if (table === 'customer_metrics_mv') {
      return resolve(mvFalha ? { data: null, error: ERRO_PG } : { data: null, error: null });
    }
    if (paginaQueFalha !== null && Math.floor(de / CAPA_POSTGREST) === paginaQueFalha) {
      return resolve({ data: null, error: ERRO_PG });
    }
    const fim = Math.min(ate + 1, de + CAPA_POSTGREST, de + limite);
    return resolve({ data: linhas.slice(de, fim), error: null });
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));

import { useCustomerFaturamento12m, useCustomerMetrics } from '../hooks';
import { CustomerKpiStrip } from '../CustomerKpiStrip';
import { formatBRL } from '../format';
import { leituraDaQuery } from '../kpi-rotulos';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import { ehFalhaDePagina } from '@/lib/postgrest';
import { addDias, hojeSP } from '@/lib/time/sp-day';

function montar<T>(hook: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(hook, { wrapper });
}

/**
 * 2.345 pedidos com centavos → 3 páginas (1.000 + 1.000 + 345). O esperado é somado em CENTAVOS
 * INTEIROS, por um caminho independente do ponto flutuante que o hook usa.
 */
const N_PEDIDOS = 2345;
function massa(): { linhas: Array<{ total: number }>; centavos: number } {
  const ls: Array<{ total: number }> = [];
  let centavos = 0;
  for (let i = 0; i < N_PEDIDOS; i++) {
    const c = ((i * 7919) % 1_000_000) + 1; // de R$ 0,01 a R$ 10.000,00, com centavos quebrados
    centavos += c;
    ls.push({ total: c / 100 });
  }
  return { linhas: ls, centavos };
}

const faixasPedidas = () =>
  chamadas
    .filter((c) => c.table === 'sales_orders')
    .map((c) => c.metodos.find(([nome]) => nome === 'range')?.[1]);

describe('useCustomerFaturamento12m', () => {
  beforeEach(() => {
    linhas = [];
    paginaQueFalha = null;
    mvFalha = false;
    chamadas = [];
  });

  it('lê o universo de VENDA na janela [hoje−365, hoje] por order_date_kpi, com ordem estável e sem limit', async () => {
    linhas = [{ total: 1000 }, { total: 500.5 }];
    const { result } = montar(() => useCustomerFaturamento12m('c1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ total: 1500.5, pedidos: 2 });
    const m = chamadas.find((c) => c.table === 'sales_orders')?.metodos ?? [];
    expect(m).toContainEqual(['eq', ['customer_user_id', 'c1']]);
    expect(m).toContainEqual(['not', ['status', 'in', STATUS_NAO_VENDA_POSTGREST]]);
    expect(m).toContainEqual(['is', ['deleted_at', null]]);
    expect(m).toContainEqual(['gte', ['order_date_kpi', addDias(hojeSP(), -365)]]);
    // teto em HOJE, como o tile 90d da MV (`d <= hoje SP`): kpi no futuro não é faturamento passado
    expect(m).toContainEqual(['lte', ['order_date_kpi', hojeSP()]]);
    expect(m).toContainEqual(['order', ['id', { ascending: true }]]);
    // e NÃO o corte antigo: nada de limit sobre a janela
    expect(m.map(([nome]) => nome)).not.toContain('limit');
  });

  it('soma TODAS as páginas: 2.345 pedidos com centavos, total exato ao centavo e as 3 faixas pedidas (P1-3)', async () => {
    const { linhas: ls, centavos } = massa();
    linhas = ls;
    const { result } = montar(() => useCustomerFaturamento12m('c1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pedidos).toBe(N_PEDIDOS);
    expect(Math.round((result.current.data?.total ?? Number.NaN) * 100)).toBe(centavos);
    expect(formatBRL(result.current.data?.total ?? Number.NaN)).toBe(formatBRL(centavos / 100));
    expect(faixasPedidas()).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('falha na 1ª página → ERRO com a MARCA do fetchAllPages (motivo, fonte, página, causa 57014), nunca R$ 0', async () => {
    linhas = massa().linhas;
    paginaQueFalha = 0;
    const { result } = montar(() => useCustomerFaturamento12m('c1'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    const erro = result.current.error;
    expect(ehFalhaDePagina(erro)).toBe(true);
    if (!ehFalhaDePagina(erro)) return;
    expect(erro.motivo).toBe('pagina_falhou');
    expect(erro.fonte).toBe('sales_orders/c360-faturamento-12m');
    expect(erro.pagina).toBe(0);
    expect((erro.cause as { code?: string }).code).toBe('57014');
  });

  it('falha numa página POSTERIOR → ERRO na página 1, sem publicar o acumulado parcial (1.000 pedidos)', async () => {
    linhas = massa().linhas;
    paginaQueFalha = 1;
    const { result } = montar(() => useCustomerFaturamento12m('c1'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    const erro = result.current.error;
    expect(ehFalhaDePagina(erro) ? erro.pagina : 'sem a marca').toBe(1);
    expect(faixasPedidas()).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('sucesso e depois o refetch FALHA: o valor fica, mas a faixa o declara desatualizado (P1-1)', async () => {
    linhas = [{ total: 1000 }];
    const { result } = montar(() => useCustomerFaturamento12m('c1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    paginaQueFalha = 0;
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    // o react-query GUARDA o último sucesso depois do refetch que falha — é daí que vinha o número
    // velho apresentado como recém-lido
    expect(result.current.data).toEqual({ total: 1000, pedidos: 1 });

    // a MESMA ponte que a página usa (Customer360.tsx), sobre o estado real do react-query
    const leitura = leituraDaQuery(result.current);
    expect(leitura).toMatchObject({ emMaos: true, desatualizado: 'erro' });
    render(<CustomerKpiStrip faturamento12m={leitura} metricas={{ emMaos: false, motivo: 'carregando' }} score={undefined} />);
    expect(screen.getByText(formatBRL(1000))).toBeTruthy();
    expect(screen.getByTestId('aviso-c360-faturamento-12m').getAttribute('data-estado')).toBe('erro');
  });
});

describe('useCustomerMetrics', () => {
  beforeEach(() => {
    mvFalha = false;
    chamadas = [];
  });

  it('falha da MV → ERRO com o erro do PostgREST (57014), não "sem dado" (que a faixa lia como R$ 0 no 90d)', async () => {
    mvFalha = true;
    const { result } = montar(() => useCustomerMetrics('c1'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: '57014' });
  });

  it('lê o carimbo do consolidado (`calculated_at`) — é ele que a faixa declara como a hora da MV', async () => {
    const { result } = montar(() => useCustomerMetrics('c1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const select = chamadas.find((c) => c.table === 'customer_metrics_mv')?.metodos.find(([nome]) => nome === 'select');
    expect(String(select?.[1][0])).toContain('calculated_at');
  });
});
