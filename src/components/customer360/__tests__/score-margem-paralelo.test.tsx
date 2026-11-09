import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';

// F12 (plano v7): a margem do Customer 360 esperava o score — leitura própria → fallback → só então
// `buscarMargemScore`, que só precisa do cliente. Agora as duas saem juntas (espera = max, não soma).
// E os `error` das leituras de score, antes descartados, LANÇAM: o descarte virava "Sem score" na
// tela, ausência afirmada sobre uma leitura que não aconteceu.
//
// O mock devolve PROMESSAS CONTROLADAS: a prova do paralelo é "as duas começaram antes de qualquer
// uma resolver" — com respostas imediatas, o laço serial passaria verde.

type Resposta = { data: unknown; error: { message: string; code?: string } | null };
type Adiada<T> = { promessa: Promise<T>; resolver: (v: T) => void; rejeitar: (e: unknown) => void };
function adiada<T>(): Adiada<T> {
  let resolver!: (v: T) => void;
  let rejeitar!: (e: unknown) => void;
  const promessa = new Promise<T>((res, rej) => { resolver = res; rejeitar = rej; });
  return { promessa, resolver, rejeitar };
}

const CLIENTE = 'cli-1';
const FARMER = 'farmer-1';
const LINHA = { health_class: 'saudavel', churn_risk: 10, priority_score: 70, sales_history_status: 'ok' };
const ERRO_PG = { message: 'canceling statement due to statement timeout', code: '57014' };

/** Cada leitura de `farmer_client_scores`, na ordem em que SAIU: própria (com farmer_id) ou fallback. */
let leiturasScore: Array<{ tipo: 'proprio' | 'fallback'; resposta: Adiada<Resposta> }> = [];
let margem: Adiada<{ margem: number | null; visivel: boolean } | null>;
let chamadasMargem = 0;

function cadeiaScore(): unknown {
  let temFarmer = false;
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'limit', 'maybeSingle']) c[m] = () => c;
  c.eq = (coluna: string) => {
    if (coluna === 'farmer_id') temFarmer = true;
    return c;
  };
  let registrada: Adiada<Resposta> | null = null;
  c.then = (sim: (v: Resposta) => unknown, nao?: (e: unknown) => unknown) => {
    if (!registrada) {
      registrada = adiada<Resposta>();
      leiturasScore.push({ tipo: temFarmer ? 'proprio' : 'fallback', resposta: registrada });
    }
    return registrada.promessa.then(sim, nao);
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => cadeiaScore() } }));
vi.mock('@/lib/scoring/margemScores', () => ({
  buscarMargemScore: () => {
    chamadasMargem += 1;
    return margem.promessa;
  },
}));
const captureException = vi.fn();
vi.mock('@/lib/analytics', () => ({ captureException: (...a: unknown[]) => captureException(...a) }));
// O hero renderiza o AgendarVisitaDialog (useAuth/useQueryClient) — fora do escopo deste teste.
vi.mock('@/hooks/useVisitasAgendadas', () => ({ useVisitasAgendadas: () => ({ agendar: { mutate: vi.fn(), isPending: false } }) }));

import { useCustomerScore } from '../hooks';
import { CustomerHero } from '../CustomerHero';
import { IdentityColumn } from '../IdentityColumn';
import type { Customer, CustomerScore, AddressQuery, ContactsQuery } from '../viewTypes';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useCustomerScore(CLIENTE, FARMER), { wrapper });
}

const leitura = (tipo: 'proprio' | 'fallback') => leiturasScore.find((l) => l.tipo === tipo);

beforeEach(() => {
  leiturasScore = [];
  margem = adiada();
  chamadasMargem = 0;
  captureException.mockReset();
});

describe('useCustomerScore — score e margem em PARALELO (F12)', () => {
  it('a margem sai ANTES de a leitura do score resolver', async () => {
    const { result } = montar();
    await waitFor(() => expect(leiturasScore).toHaveLength(1));
    // Nada resolveu ainda e a margem já está em voo.
    expect(chamadasMargem).toBe(1);
    expect(result.current.isPending).toBe(true);

    margem.resolver({ margem: 42.5, visivel: true });
    leitura('proprio')!.resposta.resolver({ data: LINHA, error: null });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ ...LINHA, gross_margin_pct: 42.5, margem_oculta: false });
    // Score próprio com linha: o fallback não roda.
    expect(leitura('fallback')).toBeUndefined();
  });

  it('fallback: a margem também não espera a leitura própria NEM o fallback', async () => {
    const { result } = montar();
    await waitFor(() => expect(leiturasScore).toHaveLength(1));
    expect(chamadasMargem).toBe(1);
    leitura('proprio')!.resposta.resolver({ data: null, error: null });
    await waitFor(() => expect(leitura('fallback')).toBeDefined());
    leitura('fallback')!.resposta.resolver({ data: LINHA, error: null });
    // Score em mãos, margem em voo: o resultado espera a margem (o número não é fabricado).
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.isPending).toBe(true);
    margem.resolver({ margem: 30, visivel: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ gross_margin_pct: 30, margem_oculta: false });
    expect(chamadasMargem).toBe(1);
  });

  it('ausência legítima (própria e fallback sem linha) → `null`, sem esperar a margem', async () => {
    const { result } = montar();
    await waitFor(() => expect(leiturasScore).toHaveLength(1));
    leitura('proprio')!.resposta.resolver({ data: null, error: null });
    await waitFor(() => expect(leitura('fallback')).toBeDefined());
    leitura('fallback')!.resposta.resolver({ data: null, error: null });
    // A margem segue PENDENTE de propósito: o "sem score" não pode depender dela.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});

describe('useCustomerScore — falha de CADA leitura', () => {
  it('falha da leitura PRÓPRIA → erro da query (antes virava "sem score"), e o fallback não roda', async () => {
    const { result } = montar();
    await waitFor(() => expect(leiturasScore).toHaveLength(1));
    leitura('proprio')!.resposta.resolver({ data: null, error: ERRO_PG });
    margem.resolver({ margem: 42.5, visivel: true });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: '57014' });
    expect(result.current.data).toBeUndefined();
    expect(leitura('fallback')).toBeUndefined();
  });

  it('falha do FALLBACK → erro da query (antes virava "sem score")', async () => {
    const { result } = montar();
    await waitFor(() => expect(leiturasScore).toHaveLength(1));
    leitura('proprio')!.resposta.resolver({ data: null, error: null });
    await waitFor(() => expect(leitura('fallback')).toBeDefined());
    leitura('fallback')!.resposta.resolver({ data: null, error: ERRO_PG });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: '57014' });
  });

  it('falha da MARGEM não derruba o score: margem some (`margem_oculta`), sem número fabricado', async () => {
    const { result } = montar();
    await waitFor(() => expect(leiturasScore).toHaveLength(1));
    margem.rejeitar(new Error('get_scores_margem: 57014'));
    leitura('proprio')!.resposta.resolver({ data: LINHA, error: null });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ ...LINHA, gross_margin_pct: null, margem_oculta: true });
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), { fonte: 'get_scores_margem/c360' });
  });

  it('margem que REJEITA enquanto o score falha não vira rejeição sem dono', async () => {
    const semDono = vi.fn();
    process.on('unhandledRejection', semDono);
    try {
      const { result } = montar();
      await waitFor(() => expect(leiturasScore).toHaveLength(1));
      leitura('proprio')!.resposta.resolver({ data: null, error: ERRO_PG });
      await waitFor(() => expect(result.current.isError).toBe(true));
      margem.rejeitar(new Error('get_scores_margem: 57014'));
      await new Promise((r) => setTimeout(r, 10));
      expect(semDono).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', semDono);
    }
  });
});

const customer = {
  name: 'Acme Ltda', document: '12345678000190', user_id: 'u1', created_at: '2026-01-01', avatar_url: null,
  requires_po: false, phone: null, email: null, customer_type: null, cnae: null,
} as unknown as Customer;
const emptyContacts = { data: [], isLoading: false } as unknown as ContactsQuery;
const semEndereco = { data: [], isLoading: false } as unknown as AddressQuery;
const comMoldura = (ui: React.ReactElement) => render(<MemoryRouter><TooltipProvider>{ui}</TooltipProvider></MemoryRouter>);

describe('consumidor: score que não foi lido FALA (Customer360 → hero e coluna)', () => {
  it('hero: falha → "Score indisponível", nunca "Sem score"', () => {
    comMoldura(<CustomerHero customer={customer} score={undefined} scoreSemLeitura="erro" isPj onBack={() => {}} />);
    expect(screen.getByText('Score indisponível')).toBeTruthy();
    expect(screen.queryByText('Sem score')).toBeNull();
  });

  it('hero: sem rede → "Score: sem rede"', () => {
    comMoldura(<CustomerHero customer={customer} score={undefined} scoreSemLeitura="sem-rede" isPj onBack={() => {}} />);
    expect(screen.getByText('Score: sem rede')).toBeTruthy();
  });

  it('hero: ausência legítima (`null` lido) segue "Sem score"', () => {
    comMoldura(<CustomerHero customer={customer} score={null} isPj onBack={() => {}} />);
    expect(screen.getByText('Sem score')).toBeTruthy();
  });

  it('coluna: falha → aviso no lugar do card que sumiria', () => {
    comMoldura(
      <IdentityColumn customer={customer} isPj customerId="u1" contacts={emptyContacts} address={semEndereco} score={undefined} scoreSemLeitura="erro" />,
    );
    expect(screen.getByTestId('aviso-c360-score').getAttribute('data-estado')).toBe('erro');
  });

  it('coluna: ausência legítima → sem aviso e sem card', () => {
    comMoldura(
      <IdentityColumn customer={customer} isPj customerId="u1" contacts={emptyContacts} address={semEndereco} score={null as CustomerScore} />,
    );
    expect(screen.queryByTestId('aviso-c360-score')).toBeNull();
    expect(screen.queryByText('Score comercial')).toBeNull();
  });
});
