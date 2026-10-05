import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

// Money-path §7 na zona de vendas do cockpit: a leitura de `sales_orders` que FALHA não pode virar
// "Faturado hoje R$ 0". Antes o erro era descartado (`const { data } = …`) e o `catch` devolvia 0;
// agora ela lança, a query fica em erro e a VendasZone mostra o `CockpitCardError` com retry.
//
// Cada ramo de falha é provado pela SUA mensagem (Codex no #2766): com `{ data: null, error }`, tirar
// só o `throw` do erro ainda cai no guard de `data == null` — a zona acenderia o erro pela causa
// errada e um teste que olhasse só `isError` seguiria verde. E com cache os `kpis` continuam
// calculados do dado antigo: quem esconde o número velho é o `isError` na TELA, então é lá que a
// falha-após-sucesso é provada.
//
// E a falha que NÃO vira erro (adversarial do Codex no #2766): offline a query PAUSA — `status`
// segue 'success' com o cache, `isError` falso —, inclusive quando a rede cai entre uma tentativa
// falha e a próxima (o `retry: 2` de produção). A tela tem de dizer que o número é da última leitura.

type Resposta = { data: unknown; error: unknown; count?: number | null };
type Chamada = { table: string; metodos: Array<[string, unknown[]]> };

const ERRO_PG = { message: 'canceling statement due to statement timeout', code: '57014' };
const MSG_ERRO_PG = 'sales_orders (vendas do dia): canceling statement due to statement timeout';
const MSG_MALFORMADA = 'sales_orders (vendas do dia): data null sem error — malformada';

let leituraVendas: 'ok' | 'erro' | 'malformada' = 'ok';
let vendas: unknown[] = [];
let chamadas: Chamada[] = [];

function respostaVendas(): Resposta {
  if (leituraVendas === 'erro') return { data: null, error: ERRO_PG };
  if (leituraVendas === 'malformada') return { data: null, error: null };
  return { data: vendas, error: null };
}

function chain(table: string): unknown {
  const registro: Chamada = { table, metodos: [] };
  chamadas.push(registro);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'lt', 'lte', 'is', 'not', 'in', 'order', 'limit', 'maybeSingle']) {
    c[m] = (...args: unknown[]) => {
      registro.metodos.push([m, args]);
      return c;
    };
  }
  c.then = (resolve: (v: Resposta) => void) => {
    if (table === 'sales_orders') return resolve(respostaVendas());
    return resolve({ data: [], error: null, count: 0 });
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

import { useVendasZone } from '../useVendasZone';
import { VendasZone } from '@/components/dashboard/zones/VendasZone';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import { hojeSP } from '@/lib/dashboard/sp-date';

const novoQc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const estadoDaZona = (qc: QueryClient) => qc.getQueryCache().find({ queryKey: ['dashboard', 'vendas'], exact: false })?.state;

/** O erro que pôs a zona em falha — é ele que diz QUAL ramo lançou. */
function erroDaZona(qc: QueryClient): string | undefined {
  const erro = estadoDaZona(qc)?.error;
  return erro instanceof Error ? erro.message : undefined;
}

function montarHook() {
  const qc = novoQc();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, ...renderHook(() => useVendasZone(), { wrapper }) };
}

function montarZona(qc = novoQc()) {
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <VendasZone />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

const VENDA_DE_HOJE = () => [{ total: 1500, status: 'faturado', order_date_kpi: hojeSP() }];

beforeEach(() => {
  leituraVendas = 'ok';
  vendas = [];
  chamadas = [];
});
afterEach(() => {
  onlineManager.setOnline(true);
});

describe('useVendasZone — falha da leitura de vendas', () => {
  it('erro do PostgREST vira ERRO da zona com a mensagem DELE — não "Faturado hoje R$ 0"', async () => {
    leituraVendas = 'erro';
    const { result, qc } = montarHook();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(erroDaZona(qc)).toBe(MSG_ERRO_PG);
    // sem dado bom anterior, nenhum KPI é afirmado — em particular nenhum faturado zero
    expect(result.current.kpis).toEqual([]);
  });

  it('resposta malformada (data null SEM error) também é erro — com a marca de malformada', async () => {
    leituraVendas = 'malformada';
    const { result, qc } = montarHook();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(erroDaZona(qc)).toBe(MSG_MALFORMADA);
    expect(result.current.kpis).toEqual([]);
  });

  it('a leitura de vendas pede o universo de VENDA da autoridade, e o faturado sai dele', async () => {
    vendas = VENDA_DE_HOJE();
    const { result } = montarHook();
    await waitFor(() => expect(result.current.kpis.length).toBeGreaterThan(0));
    expect(result.current.isError).toBe(false);
    const leitura = chamadas.find((c) => c.table === 'sales_orders');
    expect(leitura?.metodos).toContainEqual(['not', ['status', 'in', STATUS_NAO_VENDA_POSTGREST]]);
    expect(leitura?.metodos).toContainEqual(['is', ['deleted_at', null]]);
    expect(result.current.kpis[0]).toMatchObject({ label: 'Faturado hoje', value: 'R$ 2k' });
  });
});

describe('VendasZone — a falha aparece como card de erro com retry, nunca como número', () => {
  it('sem cache: falha → card de erro (pelo erro do PostgREST); "Tentar novamente" com a leitura de volta mostra o faturado', async () => {
    leituraVendas = 'erro';
    vendas = VENDA_DE_HOJE();
    const qc = montarZona();

    expect(await screen.findByText('Erro ao carregar dados.')).toBeTruthy();
    expect(erroDaZona(qc)).toBe(MSG_ERRO_PG);
    expect(screen.queryByText('Faturado hoje')).toBeNull();

    leituraVendas = 'ok';
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/ }));
    expect(await screen.findByText('R$ 2k')).toBeTruthy();
    expect(screen.getByText('Faturado hoje')).toBeTruthy();
    expect(screen.queryByText('Erro ao carregar dados.')).toBeNull();
  });

  it('com cache: o refetch que falha troca o faturado ANTIGO pelo card de erro', async () => {
    vendas = VENDA_DE_HOJE();
    const qc = montarZona();
    expect(await screen.findByText('R$ 2k')).toBeTruthy();

    leituraVendas = 'erro';
    await act(async () => {
      await qc.refetchQueries({ queryKey: ['dashboard', 'vendas'] });
    });

    expect(await screen.findByText('Erro ao carregar dados.')).toBeTruthy();
    expect(erroDaZona(qc)).toBe(MSG_ERRO_PG);
    expect(estadoDaZona(qc)?.data).toBeDefined(); // o cache ainda existe…
    expect(screen.queryByText('R$ 2k')).toBeNull(); // …mas o número velho não vai para a tela
    expect(screen.queryByText('Faturado hoje')).toBeNull();
  });
});

describe('VendasZone — offline a query PAUSA (não é erro), e a tela diz isso', () => {
  it('sem cache: aviso de sem conexão — nenhum número e nada de "Sem orçamentos aguardando."', async () => {
    onlineManager.setOnline(false);
    vendas = VENDA_DE_HOJE();
    const qc = montarZona();

    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
    expect(aviso.textContent).toContain('as vendas de hoje');
    expect(estadoDaZona(qc)).toMatchObject({ status: 'pending', fetchStatus: 'paused' });
    expect(screen.queryByText('Faturado hoje')).toBeNull();
    expect(screen.queryByText('Sem orçamentos aguardando.')).toBeNull();
  });

  it('com cache: o faturado antigo fica COM o aviso de que é da última leitura; a volta da rede o tira', async () => {
    vendas = VENDA_DE_HOJE();
    const qc = montarZona();
    expect(await screen.findByText('R$ 2k')).toBeTruthy();
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();

    onlineManager.setOnline(false);
    act(() => {
      void qc.refetchQueries({ queryKey: ['dashboard', 'vendas'] }); // pausada, não resolve — não aguardar
    });
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
    expect(aviso.textContent).toContain('os números acima são da última leitura');
    expect(estadoDaZona(qc)).toMatchObject({ status: 'success', fetchStatus: 'paused' });
    expect(screen.getByText('R$ 2k')).toBeTruthy();

    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull());
    expect(screen.getByText('R$ 2k')).toBeTruthy();
  });

  it('a leitura falha e a rede cai ANTES da nova tentativa (retry de produção): o número velho vem com o aviso', async () => {
    vendas = VENDA_DE_HOJE();
    const qc = montarZona(new QueryClient({ defaultOptions: { queries: { retry: 2, retryDelay: 300 } } }));
    expect(await screen.findByText('R$ 2k')).toBeTruthy();

    leituraVendas = 'erro';
    act(() => {
      void qc.refetchQueries({ queryKey: ['dashboard', 'vendas'] });
    });
    // a 1ª tentativa falhou e o status segue 'success' — o retry ainda não desistiu…
    await waitFor(() => expect(estadoDaZona(qc)?.fetchFailureCount).toBe(1));
    expect(estadoDaZona(qc)?.status).toBe('success');
    act(() => onlineManager.setOnline(false)); // …e a rede cai antes da 2ª

    const aviso = await screen.findByTestId('aviso-leitura-falhou', {}, { timeout: 3000 });
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
    expect(estadoDaZona(qc)).toMatchObject({ status: 'success', fetchStatus: 'paused', fetchFailureCount: 1 });
    expect(screen.getByText('R$ 2k')).toBeTruthy();
  });
});
