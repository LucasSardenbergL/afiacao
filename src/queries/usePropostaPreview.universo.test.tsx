import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// A cesta da proposta (o que vai ao CLIENTE por WhatsApp) sai do universo de VENDA da autoridade — o
// mesmo do preço que a cota. Antes a query trazia todo status e só o cancelado saía, em memória.
// E sai de TODOS os itens do cliente: a leitura de itens é por cliente (histórico inteiro), e sem
// paginação o PostgREST devolvia 1.000 linhas arbitrárias — nos 2 maiores clientes, 18–23% dos SKUs
// da janela sumiam da cesta (medido em prod, 2026-10-03).

type Chamada = { table: string; metodos: Array<[string, unknown[]]> };
let chamadas: Chamada[] = [];
let dados: Record<string, unknown[]> = {};
/** Tabela → erro PostgREST: a leitura daquela tabela falha (as outras seguem normais). */
let erros: Record<string, unknown> = {};

/** O mock imita a capa do PostgREST: sem `.range()`, só as 1.000 primeiras linhas voltam. */
const CAPA_POSTGREST = 1000;

function chain(table: string): unknown {
  const registro: Chamada = { table, metodos: [] };
  chamadas.push(registro);
  let faixa: [number, number] | null = null;
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'not', 'in', 'gte', 'order', 'range', 'limit', 'maybeSingle']) {
    c[m] = (...args: unknown[]) => {
      registro.metodos.push([m, args]);
      if (m === 'range') faixa = [args[0] as number, args[1] as number];
      return c;
    };
  }
  c.then = (resolve: (v: unknown) => void) => {
    if (erros[table]) return resolve({ data: null, error: erros[table] });
    const linhas = dados[table] ?? [];
    const pagina = faixa ? linhas.slice(faixa[0], faixa[1] + 1) : linhas.slice(0, CAPA_POSTGREST);
    resolve({ data: pagina, error: null });
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));

import { usePropostaPreview } from './usePropostaPreview';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import { addDias, hojeSP } from '@/lib/time/sp-day';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => usePropostaPreview('c1'), { wrapper });
}

describe('usePropostaPreview — a cesta no universo de venda', () => {
  beforeEach(() => {
    chamadas = [];
    dados = {};
    erros = {};
  });

  it('a leitura de pedidos carrega o par canônico', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const m = chamadas.find((c) => c.table === 'sales_orders')?.metodos ?? [];
    expect(m).toContainEqual(['not', ['status', 'in', STATUS_NAO_VENDA_POSTGREST]]);
    expect(m).toContainEqual(['is', ['deleted_at', null]]);
    // a janela de busca existe (sem ela, o histórico INTEIRO de pedidos entraria)
    expect(m.some(([nome, args]) => nome === 'gte' && args[0] === 'created_at')).toBe(true);
    // o filtro é do SERVIDOR (o mock não filtra): o que prende orçamento fora é o par acima;
    // aqui, 0 pedidos de venda → a proposta é VAZIA
    expect(result.current.data?.semHistorico).toBe(true);
  });

  it('a cesta lê TODOS os itens do cliente — paginados além da capa de 1.000 linhas', async () => {
    const dia = (n: number) => addDias(hojeSP(), -n);
    dados.sales_orders = [
      { id: 'p1', account: 'oben', order_date_kpi: dia(40), created_at: `${dia(40)}T12:00:00Z`, status: 'faturado' },
      { id: 'p2', account: 'oben', order_date_kpi: dia(10), created_at: `${dia(10)}T12:00:00Z`, status: 'faturado' },
    ];
    // 1.000 itens do pedido antigo ocupam a 1ª página inteira; o pedido recente só aparece na 2ª
    const item = (pedido: string) => ({ omie_codigo_produto: 111, quantity: 1, unit_price: 10, sales_order_id: pedido });
    dados.order_items = [...Array.from({ length: CAPA_POSTGREST }, () => item('p1')), item('p2')];
    dados.omie_products = [{ omie_codigo_produto: 111, descricao: 'Lixa 120', ativo: true }];

    const { result } = montar();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // pedidos também paginados (hoje o maior cliente tem 706 na janela — abaixo da capa, sem folga larga)
    const leiturasPedidos = chamadas.filter((c) => c.table === 'sales_orders').map((c) => c.metodos);
    expect(leiturasPedidos.every((m) => m.some(([nome, args]) => nome === 'order' && args[0] === 'id'))).toBe(true);
    // (página curta encerra o laço: 2 pedidos = 1 página)
    expect(leiturasPedidos.map((m) => m.find(([nome]) => nome === 'range')?.[1])).toEqual([[0, 999]]);
    const leiturasItens = chamadas.filter((c) => c.table === 'order_items').map((c) => c.metodos);
    expect(leiturasItens.every((m) => m.some(([nome, args]) => nome === 'order' && args[0] === 'id'))).toBe(true);
    // a 1ª página veio CHEIA (1.000) → o laço pede a 2ª, onde está o item do pedido recente
    expect(leiturasItens.map((m) => m.find(([nome]) => nome === 'range')?.[1])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    // os DOIS pedidos chegam à cesta (só com a 1ª página, seria 1 pedido → cesta vazia)
    expect(result.current.data?.totalPedidos).toBe(2);
    expect(result.current.data?.cesta.principal.map((i) => i.omie_codigo_produto)).toEqual([111]);
  });
});

describe('usePropostaPreview — falha de leitura é ERRO, nunca uma cesta "vazia"', () => {
  const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

  beforeEach(() => {
    chamadas = [];
    erros = {};
    // cesta de 1 SKU ativo em 2 pedidos: passa por produtos, cross-sell e perfil
    const dia = (n: number) => addDias(hojeSP(), -n);
    dados = {
      sales_orders: [
        { id: 'p1', account: 'oben', order_date_kpi: dia(40), created_at: `${dia(40)}T12:00:00Z`, status: 'faturado' },
        { id: 'p2', account: 'oben', order_date_kpi: dia(10), created_at: `${dia(10)}T12:00:00Z`, status: 'faturado' },
      ],
      order_items: ['p1', 'p2'].map((pedido) => ({ omie_codigo_produto: 111, quantity: 1, unit_price: 10, sales_order_id: pedido })),
      omie_products: [{ omie_codigo_produto: 111, descricao: 'Lixa 120', ativo: true }],
    };
  });

  it('controle: sem falha, a cesta sai com o SKU', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.cesta.principal.map((i) => i.omie_codigo_produto)).toEqual([111]);
  });

  // omie_products: sem o lance, `ativos` vazio tirava a cesta inteira ("só SKUs inativos", causa fabricada);
  // farmer_recommendations: a seção de cross-sell sumia em silêncio; profiles: o envio saía sem documento.
  it.each(['omie_products', 'farmer_recommendations', 'profiles'])('falha em %s → ERRO, sem proposta', async (tabela) => {
    erros[tabela] = ERRO_TIMEOUT;
    const { result } = montar();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(chamadas.some((c) => c.table === tabela)).toBe(true);
  });
});
