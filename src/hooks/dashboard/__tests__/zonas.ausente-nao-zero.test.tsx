import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

// Ausente ≠ zero nas zonas Estoque, Reposição e Vendas da home (a zona Sistema já foi no lote 5).
// O supabase-js DEVOLVE o erro (`{ data: null, count: null, error }`), não lança: o `try/catch`
// antigo nunca o via e o `count ?? 0` afirmava "0" com a mesma cara de um zero medido; a lista de
// topo vazia por falha dizia "Sem pendências".
//
// Cada ramo é casado pela SUA mensagem: com `{ data: null, count: null, error }`, tirar só o
// `throw` do erro ainda cairia no guard de contagem ausente — o KPI mostraria "—" pela causa errada
// e um teste que olhasse só o "—" seguiria verde. O controle é o zero MEDIDO, que continua "0".

type Resposta = { data: unknown; error: unknown; count?: number | null };

const ERRO_PG = { message: 'canceling statement due to statement timeout', code: '57014' };
const ERRO = { data: null, count: null, error: ERRO_PG };
const MALFORMADA = { data: null, count: null, error: null };

const L = {
  nf: 'nfe_recebimentos:id, razao_social_emitente, created_at, status',
  picking: 'picking_tasks:id',
  fefo: 'picking_task_items:id, product_descricao, validade_fefo',
  conferidas: 'nfe_recebimentos:id',
  sugeridos: 'pedido_compra_sugerido:id',
  alertas: 'eventos_outlier:id',
  topCritico: 'eventos_outlier:id, tipo, sku_descricao, severidade:critico',
  topAtencao: 'eventos_outlier:id, tipo, sku_descricao, severidade:atencao',
  topInfo: 'eventos_outlier:id, tipo, sku_descricao, severidade:info',
  aumentos: 'fornecedor_aumento_anunciado:id',
  vendasDia: 'sales_orders:total, status, order_date_kpi',
  orcamentos: 'orders:id',
  orcamentosTop: 'orders:id, total, status, created_at, user_id',
  nomes: 'profiles:user_id, name',
} as const;

const ANTIGA = '2020-01-01T00:00:00.000Z';

function padrao(): Record<string, Resposta> {
  return {
    [L.nf]: { data: [{ id: 'n1', razao_social_emitente: 'Fornecedor A', created_at: ANTIGA, status: 'pendente' }], error: null },
    [L.picking]: { data: null, count: 4, error: null },
    [L.fefo]: { data: [{ id: 'f1', product_descricao: 'Lixa 120', validade_fefo: ANTIGA }], error: null },
    [L.conferidas]: { data: null, count: 2, error: null },
    [L.sugeridos]: { data: null, count: 3, error: null },
    [L.alertas]: { data: null, count: 7, error: null },
    [L.topCritico]: { data: [{ id: 1, tipo: 'venda_atipica', sku_descricao: 'Verniz PU', severidade: 'critico' }], error: null },
    [L.topAtencao]: { data: [], error: null },
    [L.topInfo]: { data: [], error: null },
    [L.aumentos]: { data: null, count: 1, error: null },
    [L.vendasDia]: { data: [], error: null },
    [L.orcamentos]: { data: null, count: 5, error: null },
    [L.orcamentosTop]: { data: [{ id: 'o1', total: 1200, status: 'orcamento_enviado', created_at: ANTIGA, user_id: 'u1' }], error: null },
    [L.nomes]: { data: [{ user_id: 'u1', name: 'Marcenaria Beta' }], error: null },
  };
}

let respostas: Record<string, Resposta> = padrao();

function chain(table: string): unknown {
  let selecao = '';
  let severidade = '';
  const c: Record<string, unknown> = {};
  for (const m of ['neq', 'in', 'not', 'is', 'gte', 'lt', 'order', 'limit', 'or', 'maybeSingle']) c[m] = () => c;
  c.eq = (col: string, v: string) => {
    if (col === 'severidade') severidade = v;
    return c;
  };
  c.select = (cols: string) => {
    selecao = cols;
    return c;
  };
  c.then = (resolve: (v: Resposta) => void) => {
    const rotulo = `${table}:${selecao}${severidade ? `:${severidade}` : ''}`;
    const r = respostas[rotulo];
    if (!r) throw new Error(`leitura sem resposta no teste: ${rotulo}`);
    return resolve(r);
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock('@/hooks/useDashboardCompany', () => ({
  useDashboardCompany: () => ({ companies: ['oben'], mode: 'single', primary: 'oben' }),
}));
vi.mock('@/hooks/dashboard/useCockpitChannel', () => ({ useCockpitChannel: () => ({ isLive: false }) }));
vi.mock('@/contexts/DashboardPersonaContext', () => ({ useDashboardPersonaContext: () => ({ persona: 'master' }) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: vi.fn() }));

import { useEstoqueZone } from '../useEstoqueZone';
import { useReposicaoZone } from '../useReposicaoZone';
import { useVendasZone } from '../useVendasZone';
import { EstoqueZone } from '@/components/dashboard/zones/EstoqueZone';
import { ReposicaoZone } from '@/components/dashboard/zones/ReposicaoZone';
import { VendasZone } from '@/components/dashboard/zones/VendasZone';

const TIMEOUT = 'canceling statement due to statement timeout';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

async function montar<T extends { kpis: unknown[]; isError: boolean }>(hook: () => T) {
  const { result } = renderHook(hook, { wrapper: wrapper() });
  await waitFor(() => expect(result.current.kpis.length).toBeGreaterThan(0));
  expect(result.current.isError).toBe(false);
  return result.current;
}

const kpi = (kpis: Array<{ label: string; value: string }>, label: string) => kpis.find((k) => k.label === label)?.value;

beforeEach(() => {
  respostas = padrao();
});

describe('Estoque: leitura que falha vira "—", não 0', () => {
  it('controle: tudo lido → números medidos e prioridade de NF >24h', async () => {
    const z = await montar(useEstoqueZone);
    expect(kpi(z.kpis, 'NF pendentes')).toBe('1');
    expect(kpi(z.kpis, 'Picking abertos')).toBe('4');
    expect(kpi(z.kpis, 'Conferidas hoje')).toBe('2');
    expect(z.erros).toEqual({ nf: null, picking: null, fefo: null, recebimentos: null });
    expect(z.erroTopo).toBeNull();
    expect(z.priority?.item.id).toBe('nfe_overdue');
  });

  it('zero MEDIDO continua "0"', async () => {
    respostas[L.picking] = { data: null, count: 0, error: null };
    respostas[L.conferidas] = { data: null, count: 0, error: null };
    const z = await montar(useEstoqueZone);
    expect(kpi(z.kpis, 'Picking abertos')).toBe('0');
    expect(kpi(z.kpis, 'Conferidas hoje')).toBe('0');
  });

  it('picking com erro → "—" com a mensagem do ramo; os outros KPIs seguem', async () => {
    respostas[L.picking] = ERRO;
    const z = await montar(useEstoqueZone);
    expect(kpi(z.kpis, 'Picking abertos')).toBe('—');
    expect(z.erros?.picking).toBe(`picking_tasks (picking abertos): ${TIMEOUT}`);
    expect(kpi(z.kpis, 'NF pendentes')).toBe('1');
    expect(kpi(z.kpis, 'Conferidas hoje')).toBe('2');
  });

  it('picking malformado (count null sem error) → "—" pelo guard de contagem', async () => {
    respostas[L.picking] = MALFORMADA;
    const z = await montar(useEstoqueZone);
    expect(kpi(z.kpis, 'Picking abertos')).toBe('—');
    expect(z.erros?.picking).toBe('picking_tasks (picking abertos): contagem ausente sem error — malformada');
  });

  it('conferidas hoje com erro → "—" com a mensagem do ramo', async () => {
    respostas[L.conferidas] = ERRO;
    const z = await montar(useEstoqueZone);
    expect(kpi(z.kpis, 'Conferidas hoje')).toBe('—');
    expect(z.erros?.recebimentos).toBe(`nfe_recebimentos (conferidas hoje): ${TIMEOUT}`);
  });

  it('NF com erro → KPI "—", sem prioridade de NF, topo avisa', async () => {
    respostas[L.nf] = ERRO;
    const z = await montar(useEstoqueZone);
    expect(kpi(z.kpis, 'NF pendentes')).toBe('—');
    expect(z.erros?.nf).toBe(`nfe_recebimentos (NF pendentes): ${TIMEOUT}`);
    expect(z.erroTopo).toBe(z.erros?.nf);
    // A prioridade cai no FEFO, que foi lido — não some, e não inventa NF.
    expect(z.priority?.item.id).toBe('picking_fefo');
    expect(z.topItems.map((t) => t.id)).toEqual(['f1']);
  });

  it('NF malformada (data null sem error) → "—" pelo guard de data', async () => {
    respostas[L.nf] = MALFORMADA;
    const z = await montar(useEstoqueZone);
    expect(kpi(z.kpis, 'NF pendentes')).toBe('—');
    expect(z.erros?.nf).toBe('nfe_recebimentos (NF pendentes): data null sem error — malformada');
  });

  it('FEFO com erro → topo avisa e a prioridade de FEFO não dispara', async () => {
    respostas[L.nf] = { data: [], error: null };
    respostas[L.fefo] = ERRO;
    const z = await montar(useEstoqueZone);
    expect(z.erros?.fefo).toBe(`picking_task_items (FEFO vencendo): ${TIMEOUT}`);
    expect(z.erroTopo).toBe(z.erros?.fefo);
    expect(z.priority).toBeNull();
  });

  it('tela: topo que falhou avisa em vez de "Sem pendências de estoque."', async () => {
    respostas[L.nf] = { data: [], error: null };
    respostas[L.fefo] = ERRO;
    render(<EstoqueZone />, { wrapper: wrapper() });
    expect(await screen.findByTestId('aviso-topo-falhou')).toBeTruthy();
    expect(screen.queryByText('Sem pendências de estoque.')).toBeNull();
  });

  it('tela: topo parcial mostra o que veio E avisa', async () => {
    respostas[L.fefo] = ERRO;
    render(<EstoqueZone />, { wrapper: wrapper() });
    expect(await screen.findByTestId('aviso-topo-falhou')).toBeTruthy();
    expect(screen.getByText('Fornecedor A')).toBeTruthy();
  });

  it('tela (controle): topo lido e vazio diz "Sem pendências de estoque." sem aviso', async () => {
    respostas[L.nf] = { data: [], error: null };
    respostas[L.fefo] = { data: [], error: null };
    render(<EstoqueZone />, { wrapper: wrapper() });
    expect(await screen.findByText('Sem pendências de estoque.')).toBeTruthy();
    expect(screen.queryByTestId('aviso-topo-falhou')).toBeNull();
  });
});

describe('Reposição: leitura que falha vira "—", não 0', () => {
  it('controle: tudo lido → números medidos e prioridade de sugeridos', async () => {
    const z = await montar(useReposicaoZone);
    expect(kpi(z.kpis, 'Sugeridos prontos')).toBe('3');
    expect(kpi(z.kpis, 'Alertas ativos')).toBe('7');
    expect(kpi(z.kpis, 'Aumentos 7d')).toBe('1');
    expect(z.erros).toEqual({ sugeridos: null, alertas: null, topAlertas: null, aumentos: null });
    expect(z.priority?.item.id).toBe('sugeridos_pronto');
  });

  it('zero MEDIDO continua "0"', async () => {
    respostas[L.sugeridos] = { data: null, count: 0, error: null };
    respostas[L.alertas] = { data: null, count: 0, error: null };
    respostas[L.aumentos] = { data: null, count: 0, error: null };
    const z = await montar(useReposicaoZone);
    expect(kpi(z.kpis, 'Sugeridos prontos')).toBe('0');
    expect(kpi(z.kpis, 'Alertas ativos')).toBe('0');
    expect(kpi(z.kpis, 'Aumentos 7d')).toBe('0');
  });

  it('sugeridos com erro → "—" e o cartão de prioridade não dispara', async () => {
    respostas[L.sugeridos] = ERRO;
    const z = await montar(useReposicaoZone);
    expect(kpi(z.kpis, 'Sugeridos prontos')).toBe('—');
    expect(z.erros?.sugeridos).toBe(`pedido_compra_sugerido (sugeridos prontos): ${TIMEOUT}`);
    expect(z.priority).toBeNull();
    expect(kpi(z.kpis, 'Alertas ativos')).toBe('7');
  });

  it('sugeridos malformado → "—" pelo guard de contagem', async () => {
    respostas[L.sugeridos] = MALFORMADA;
    const z = await montar(useReposicaoZone);
    expect(z.erros?.sugeridos).toBe('pedido_compra_sugerido (sugeridos prontos): contagem ausente sem error — malformada');
  });

  it('alertas ativos com erro → "—" com a mensagem do ramo', async () => {
    respostas[L.alertas] = ERRO;
    const z = await montar(useReposicaoZone);
    expect(kpi(z.kpis, 'Alertas ativos')).toBe('—');
    expect(z.erros?.alertas).toBe(`eventos_outlier (alertas ativos): ${TIMEOUT}`);
  });

  it('aumentos com erro → "—" com a mensagem do ramo', async () => {
    respostas[L.aumentos] = ERRO;
    const z = await montar(useReposicaoZone);
    expect(kpi(z.kpis, 'Aumentos 7d')).toBe('—');
    expect(z.erros?.aumentos).toBe(`fornecedor_aumento_anunciado (aumentos 7d): ${TIMEOUT}`);
  });

  it('topo: a severidade crítica falhando não deixa uma lista "completa" sem os críticos', async () => {
    respostas[L.topCritico] = ERRO;
    respostas[L.topAtencao] = { data: [{ id: 2, tipo: 'lt_atipico', sku_descricao: 'Selador', severidade: 'atencao' }], error: null };
    const z = await montar(useReposicaoZone);
    expect(z.erros?.topAlertas).toBe(`eventos_outlier (topo de alertas, critico): ${TIMEOUT}`);
    expect(z.erroTopo).toBe(z.erros?.topAlertas);
    expect(z.topItems).toEqual([]);
  });

  it('topo: severidade malformada → mensagem de data null', async () => {
    respostas[L.topInfo] = MALFORMADA;
    const z = await montar(useReposicaoZone);
    expect(z.erros?.topAlertas).toBe('eventos_outlier (topo de alertas, info): data null sem error — malformada');
  });

  it('tela: topo que falhou avisa em vez de "Sem alertas ativos."', async () => {
    respostas[L.topCritico] = ERRO;
    render(<ReposicaoZone />, { wrapper: wrapper() });
    expect(await screen.findByTestId('aviso-topo-falhou')).toBeTruthy();
    expect(screen.queryByText('Sem alertas ativos.')).toBeNull();
  });

  it('tela (controle): topo lido e vazio diz "Sem alertas ativos." sem aviso', async () => {
    respostas[L.topCritico] = { data: [], error: null };
    render(<ReposicaoZone />, { wrapper: wrapper() });
    expect(await screen.findByText('Sem alertas ativos.')).toBeTruthy();
    expect(screen.queryByTestId('aviso-topo-falhou')).toBeNull();
  });
});

describe('Vendas: orçamentos que falham viram "—", não 0', () => {
  it('controle: orçamentos lidos → número medido e topo com prioridade', async () => {
    const z = await montar(useVendasZone);
    expect(kpi(z.kpis, 'Aguardando')).toBe('5');
    expect(z.erros).toEqual({ orcamentos: null, top: null, nomes: null });
    expect(z.topItems.map((t) => t.title)).toEqual(['Marcenaria Beta']);
    expect(z.priority?.zone).toBe('vendas');
  });

  it('zero MEDIDO continua "0"', async () => {
    respostas[L.orcamentos] = { data: null, count: 0, error: null };
    const z = await montar(useVendasZone);
    expect(kpi(z.kpis, 'Aguardando')).toBe('0');
  });

  it('contagem de orçamentos com erro → "—" com a mensagem do ramo; a zona não cai', async () => {
    respostas[L.orcamentos] = ERRO;
    const z = await montar(useVendasZone);
    expect(kpi(z.kpis, 'Aguardando')).toBe('—');
    expect(z.erros?.orcamentos).toBe(`orders (orçamentos aguardando): ${TIMEOUT}`);
    expect(kpi(z.kpis, 'Faturado hoje')).toBe('R$ 0');
  });

  it('contagem de orçamentos malformada → "—" pelo guard de contagem', async () => {
    respostas[L.orcamentos] = MALFORMADA;
    const z = await montar(useVendasZone);
    expect(z.erros?.orcamentos).toBe('orders (orçamentos aguardando): contagem ausente sem error — malformada');
  });

  it('topo de orçamentos >24h com erro → aviso no topo e sem prioridade', async () => {
    respostas[L.orcamentosTop] = ERRO;
    const z = await montar(useVendasZone);
    expect(z.erros?.top).toBe(`orders (orçamentos >24h): ${TIMEOUT}`);
    expect(z.erroTopo).toBe(z.erros?.top);
    expect(z.topItems).toEqual([]);
    expect(z.priority).toBeNull();
  });

  it('topo de orçamentos >24h malformado → mensagem de data null', async () => {
    respostas[L.orcamentosTop] = MALFORMADA;
    const z = await montar(useVendasZone);
    expect(z.erros?.top).toBe('orders (orçamentos >24h): data null sem error — malformada');
  });

  it('controle: cadastro sem nome continua "Cliente"', async () => {
    respostas[L.nomes] = { data: [{ user_id: 'u1', name: null }], error: null };
    const z = await montar(useVendasZone);
    expect(z.topItems.map((t) => t.title)).toEqual(['Cliente']);
    expect(z.erros?.nomes).toBeNull();
  });

  it('nomes do topo com erro → "Nome indisponível", o orçamento segue na lista', async () => {
    respostas[L.nomes] = ERRO;
    const z = await montar(useVendasZone);
    expect(z.erros?.nomes).toBe(`profiles (nomes do topo): ${TIMEOUT}`);
    expect(z.topItems.map((t) => t.title)).toEqual(['Nome indisponível']);
    expect(z.erroTopo).toBeNull();
    expect(z.priority?.item.title).toBe('Orçamento >24h aguardando — Nome indisponível');
  });

  it('nomes do topo malformados → "Nome indisponível" pela mensagem de data null', async () => {
    respostas[L.nomes] = MALFORMADA;
    const z = await montar(useVendasZone);
    expect(z.erros?.nomes).toBe('profiles (nomes do topo): data null sem error — malformada');
    expect(z.topItems.map((t) => t.title)).toEqual(['Nome indisponível']);
  });

  it('tela: topo que falhou avisa em vez de "Sem orçamentos aguardando."', async () => {
    respostas[L.orcamentosTop] = ERRO;
    render(<VendasZone />, { wrapper: wrapper() });
    expect(await screen.findByTestId('aviso-topo-falhou')).toBeTruthy();
    expect(screen.queryByText('Sem orçamentos aguardando.')).toBeNull();
  });

  it('tela (controle): topo lido e vazio diz "Sem orçamentos aguardando." sem aviso', async () => {
    respostas[L.orcamentosTop] = { data: [], error: null };
    render(<VendasZone />, { wrapper: wrapper() });
    expect(await screen.findByText('Sem orçamentos aguardando.')).toBeTruthy();
    expect(screen.queryByTestId('aviso-topo-falhou')).toBeNull();
  });
});
