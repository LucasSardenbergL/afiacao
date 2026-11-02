import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

// Ausente ≠ zero na zona Sistema do cockpit (plano v4, lote 5 — N3). O supabase-js DEVOLVE o erro
// (`{ data: null, count: null, error }`), não lança: o `try/catch` antigo nunca o via e o
// `count ?? 0` afirmava "0 aprovações" / "0 staff" — e a lista vazia dizia "Tudo em dia.".
//
// Cada ramo é casado pela SUA mensagem (não "falhou algo"): com `{ data: null, count: null, error }`,
// tirar só o `throw` do erro ainda cairia no guard de contagem ausente — a zona ficaria
// indisponível pela causa errada e um teste que olhasse só o "—" seguiria verde.

type Resposta = { data: unknown; error: unknown; count?: number | null };
type Leitura = 'ok' | 'erro' | 'malformada' | 'zero';

const ERRO_PG = { message: 'canceling statement due to statement timeout', code: '57014' };

let leituraAprovacoes: Leitura = 'ok';
let leituraStaff: Leitura = 'ok';

function respostaAprovacoes(): Resposta {
  if (leituraAprovacoes === 'erro') return { data: null, count: null, error: ERRO_PG };
  if (leituraAprovacoes === 'malformada') return { data: null, count: null, error: null };
  if (leituraAprovacoes === 'zero') return { data: [], count: 0, error: null };
  return {
    data: [
      { user_id: 'u1', name: 'Ana', created_at: '2026-10-01' },
      { user_id: 'u2', name: 'Bia', created_at: '2026-10-02' },
      { user_id: 'u3', name: 'Caio', created_at: '2026-10-03' },
    ],
    count: 5,
    error: null,
  };
}

function respostaStaff(): Resposta {
  if (leituraStaff === 'erro') return { data: null, count: null, error: ERRO_PG };
  if (leituraStaff === 'malformada') return { data: null, count: null, error: null };
  if (leituraStaff === 'zero') return { data: null, count: 0, error: null };
  return { data: null, count: 12, error: null };
}

function chain(table: string): unknown {
  let selecao = '';
  const c: Record<string, unknown> = {};
  for (const m of ['eq', 'neq', 'or', 'order', 'limit', 'maybeSingle']) c[m] = () => c;
  c.select = (cols: string) => {
    selecao = cols;
    return c;
  };
  c.then = (resolve: (v: Resposta) => void) => {
    if (table === 'profiles' && selecao === 'user_id, name, created_at') return resolve(respostaAprovacoes());
    if (table === 'profiles' && selecao === 'user_id') return resolve(respostaStaff());
    // orders / sales_orders (última atividade): fora do escopo deste teste — sempre ok.
    return resolve({ data: { created_at: new Date().toISOString() }, error: null });
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock('@/contexts/DashboardPersonaContext', () => ({ useDashboardPersonaContext: () => ({ persona: 'master' }) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: vi.fn() }));

import { useSistemaZone } from '../useSistemaZone';
import { SistemaZone } from '@/components/dashboard/zones/SistemaZone';

const MSG_APROV_ERRO = 'profiles (aprovações pendentes): canceling statement due to statement timeout';
const MSG_APROV_MALFORMADA = 'profiles (aprovações pendentes): contagem ausente sem error — malformada';
const MSG_STAFF_ERRO = 'profiles (staff ativos): canceling statement due to statement timeout';
const MSG_STAFF_MALFORMADA = 'profiles (staff ativos): contagem ausente sem error — malformada';

const novoQc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function montarHook() {
  const qc = novoQc();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useSistemaZone(), { wrapper });
}

function montarZona() {
  render(
    <QueryClientProvider client={novoQc()}>
      <MemoryRouter>
        <SistemaZone />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const kpi = (kpis: Array<{ label: string; value: string }>, label: string) => kpis.find((k) => k.label === label)?.value;

beforeEach(() => {
  leituraAprovacoes = 'ok';
  leituraStaff = 'ok';
});

describe('useSistemaZone — leitura de aprovações pendentes', () => {
  it('erro DEVOLVIDO pelo PostgREST vira indisponível com a mensagem dele — não "0"', async () => {
    leituraAprovacoes = 'erro';
    const { result } = montarHook();
    await waitFor(() => expect(result.current.kpis.length).toBeGreaterThan(0));
    expect(result.current.erroAprovacoes).toBe(MSG_APROV_ERRO);
    expect(kpi(result.current.kpis, 'Aprovações')).toBe('—');
    expect(result.current.topItems).toEqual([]);
    expect(result.current.priority).toBeNull();
    // a falha é PARCIAL: o outro KPI segue lido
    expect(result.current.erroStaff).toBeNull();
    expect(kpi(result.current.kpis, 'Staff ativos')).toBe('12');
    expect(result.current.isError).toBe(false);
  });

  it('contagem ausente SEM error também é indisponível — com a marca de malformada', async () => {
    leituraAprovacoes = 'malformada';
    const { result } = montarHook();
    await waitFor(() => expect(result.current.kpis.length).toBeGreaterThan(0));
    expect(result.current.erroAprovacoes).toBe(MSG_APROV_MALFORMADA);
    expect(kpi(result.current.kpis, 'Aprovações')).toBe('—');
  });

  it('zero MEDIDO segue zero (controle: o guard não engole o 0 legítimo)', async () => {
    leituraAprovacoes = 'zero';
    const { result } = montarHook();
    await waitFor(() => expect(result.current.kpis.length).toBeGreaterThan(0));
    expect(result.current.erroAprovacoes).toBeNull();
    expect(kpi(result.current.kpis, 'Aprovações')).toBe('0');
  });

  it('leitura ok: contagem e cartão de prioridade como antes', async () => {
    const { result } = montarHook();
    await waitFor(() => expect(result.current.kpis.length).toBeGreaterThan(0));
    expect(result.current.erroAprovacoes).toBeNull();
    expect(kpi(result.current.kpis, 'Aprovações')).toBe('5');
    expect(result.current.topItems.map((t) => t.id)).toEqual(['u1', 'u2', 'u3']);
    expect(result.current.priority?.item.title).toBe('5 liberações aguardando');
  });
});

describe('useSistemaZone — leitura de staff ativos', () => {
  it('erro DEVOLVIDO vira "—" com a mensagem dele — não "0"', async () => {
    leituraStaff = 'erro';
    const { result } = montarHook();
    await waitFor(() => expect(result.current.kpis.length).toBeGreaterThan(0));
    expect(result.current.erroStaff).toBe(MSG_STAFF_ERRO);
    expect(kpi(result.current.kpis, 'Staff ativos')).toBe('—');
    expect(result.current.erroAprovacoes).toBeNull();
  });

  it('contagem ausente SEM error também é "—" — com a marca de malformada', async () => {
    leituraStaff = 'malformada';
    const { result } = montarHook();
    await waitFor(() => expect(result.current.kpis.length).toBeGreaterThan(0));
    expect(result.current.erroStaff).toBe(MSG_STAFF_MALFORMADA);
    expect(kpi(result.current.kpis, 'Staff ativos')).toBe('—');
  });

  it('zero MEDIDO segue zero', async () => {
    leituraStaff = 'zero';
    const { result } = montarHook();
    await waitFor(() => expect(result.current.kpis.length).toBeGreaterThan(0));
    expect(result.current.erroStaff).toBeNull();
    expect(kpi(result.current.kpis, 'Staff ativos')).toBe('0');
  });
});

describe('SistemaZone — tela', () => {
  it('falha nas aprovações: a zona FALA "indisponível" e não diz "Tudo em dia."', async () => {
    leituraAprovacoes = 'erro';
    montarZona();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    expect(screen.queryByText('Tudo em dia.')).toBeNull();
  });

  it('zero medido: "Tudo em dia." sem aviso (controle)', async () => {
    leituraAprovacoes = 'zero';
    montarZona();
    expect(await screen.findByText('Tudo em dia.')).toBeTruthy();
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });
});
