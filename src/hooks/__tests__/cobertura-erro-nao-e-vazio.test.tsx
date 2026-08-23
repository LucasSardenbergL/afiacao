import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard money-path — cobertura que NÃO PÔDE SER LIDA não pode virar "não cubro ninguém".
 *
 * O irmão da classe do #1886: lá o erro colapsava em silêncio (`data` undefined → `return
 * null`); aqui o ausente colapsa em VAZIO. `useMyActiveCoverage` LANÇA quando o SELECT em
 * `carteira_coverage` falha, e os quatro consumidores faziam `(coverage ?? []).map(...)`
 * sem ler `error`. O resultado é `ownerIds = [eu]`: a carteira COBERTA some de sugestões de
 * visita, scores, plano tático e copilot — com a tela idêntica à de quem não cobre ninguém.
 *
 * Hoje o dano é zero e isso foi MEDIDO (psql-ro, 2026-08-22: `carteira_coverage` tem 0
 * linhas). O gatilho é o PRIMEIRO cadastro de cobertura, e é por isso que o teste existe
 * ANTES do primeiro uso: depois dele, a falha é silenciosa e ninguém nota a carteira faltando.
 *
 * O HOOK roda de verdade; só o supabase é mockado, e POR TABELA — mockar o hook provaria
 * apenas que ele devolve o estado que eu mesmo montei, e um mock global de erro não
 * separaria "a cobertura falhou" de "tudo falhou", que é exatamente a distinção em prova.
 */
const EU = 'eu-1';
const COBERTO = 'regina-1';

type Resposta = { data: unknown; error: { message: string } | null };
let porTabela: Record<string, Resposta> = {};

/** Declaração de função (hoisted): o factory do vi.mock a alcança sem cair em TDZ. */
function respostaDaTabela(t: string): Resposta {
  return porTabela[t] ?? { data: [], error: null };
}

vi.mock('@/integrations/supabase/client', () => {
  const mk = (tabela: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'range', 'gte', 'lte', 'not', 'is']) {
      b[m] = () => b;
    }
    b.then = (ok: (r: Resposta) => unknown, falha?: (e: unknown) => unknown) =>
      Promise.resolve(respostaDaTabela(tabela)).then(ok, falha);
    return b;
  };
  return { supabase: { from: (t: string) => mk(t) } };
});
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: EU }, isStaff: true, isMaster: false, loading: false }),
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: null }),
}));

import { useCarteirasQueEuCubro } from '../useCoverage';
import { useMyVisitSuggestions } from '../useMyVisitSuggestions';

const LINHA_COBERTURA = { id: 'c1', covered_user_id: COBERTO, valid_until: null };

function envolver() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => { porTabela = {}; onlineManager.setOnline(true); });
afterEach(() => { onlineManager.setOnline(true); });

describe('cobertura de carteira — erro de leitura NÃO é "não cubro ninguém"', () => {
  it('leitura OK com cobertura: os ids vêm e nada é sinalizado', async () => {
    porTabela = { carteira_coverage: { data: [LINHA_COBERTURA], error: null } };
    const { result } = renderHook(() => useCarteirasQueEuCubro(), { wrapper: envolver() });
    await waitFor(() => expect(result.current.coveredIds).toEqual([COBERTO]));
    expect(result.current.coberturaIndisponivel).toBeNull();
  });

  it('VAZIO legítimo: nenhuma cobertura cadastrada, e o silêncio é honesto', async () => {
    porTabela = { carteira_coverage: { data: [], error: null } };
    const { result } = renderHook(() => useCarteirasQueEuCubro(), { wrapper: envolver() });
    await waitFor(() => expect(result.current.coberturaIndisponivel).toBeNull());
    expect(result.current.coveredIds).toEqual([]);
  });

  it('ERRO: ids vazios COMO NO VAZIO — mas sinalizado, e é isto que separa os dois', async () => {
    porTabela = { carteira_coverage: { data: null, error: { message: 'permission denied' } } };
    const { result } = renderHook(() => useCarteirasQueEuCubro(), { wrapper: envolver() });
    await waitFor(() => expect(result.current.coberturaIndisponivel).toBe('erro'));
    // A lista continua vazia de propósito (a MINHA carteira segue valendo); o que não pode
    // é a tela AFIRMAR que não há cobertura. Sem o sinal, este estado é byte-a-byte o de cima.
    expect(result.current.coveredIds).toEqual([]);
  });

  it('OFFLINE (pending+paused): também sinaliza — isLoading é FALSE e data undefined', async () => {
    onlineManager.setOnline(false);
    porTabela = { carteira_coverage: { data: [LINHA_COBERTURA], error: null } };
    const { result } = renderHook(() => useCarteirasQueEuCubro(), { wrapper: envolver() });
    await waitFor(() => expect(result.current.coberturaIndisponivel).toBe('sem-rede'));
  });

  it('useMyVisitSuggestions PROPAGA: só a cobertura falha, o resto da tela lê normal', async () => {
    porTabela = {
      carteira_coverage: { data: null, error: { message: 'permission denied' } },
      customer_visit_scores: { data: [], error: null },
      profiles: { data: [], error: null },
    };
    const { result } = renderHook(() => useMyVisitSuggestions({}), { wrapper: envolver() });
    await waitFor(() => expect(result.current.coberturaIndisponivel).toBe('erro'));
  });

  it('useMyVisitSuggestions: cobertura vazia NÃO sinaliza nada', async () => {
    porTabela = {
      carteira_coverage: { data: [], error: null },
      customer_visit_scores: { data: [], error: null },
      profiles: { data: [], error: null },
    };
    const { result } = renderHook(() => useMyVisitSuggestions({}), { wrapper: envolver() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.coberturaIndisponivel).toBeNull();
  });
});
