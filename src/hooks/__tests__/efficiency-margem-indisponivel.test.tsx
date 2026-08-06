import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — `checkEfficiency` precisa de TRÊS estados, não dois.
 *
 * O gate de R$/h decide se a vendedora liga para o cliente. Ele já distinguia "margem zero"
 * (veredito: esta ligação não paga) de "margem desconhecida" (indecidível). Faltava o
 * terceiro: FALHA DE CONSULTA.
 *
 * Sem o guard de `error`, um timeout/RLS/500 caía no mesmo `null` do cliente sem custo — e o
 * diálogo então AFIRMA "nenhum item comprado tem custo cadastrado". Isso é alegar um fato
 * sobre o cliente a partir de uma falha nossa: a vendedora lê que aquele cliente não tem
 * custo cadastrado (e pode agir sobre isso, pedindo cadastro ao financeiro) quando na
 * verdade a rede piscou.
 *
 * DISCRIMINADOR: os dois cenários produzem `estimatedProfitPerHour: null` e
 * `isAboveThreshold: false` — indistinguíveis por esses campos. Só `motivo` os separa, então
 * um teste que checasse apenas "profitPerHour é null" passaria na versão quebrada.
 */
const MASTER = 'master-id';
const CUSTOMER = 'cliente-x';

type ModoScore = 'margem_conhecida' | 'margem_zero' | 'sem_margem' | 'falha_consulta';
let modo: ModoScore = 'margem_conhecida';

const BASE = { revenue_potential: 5000, avg_monthly_spend_180d: 1000 };

type Q = { table: string; single: boolean };

function result(q: Q): { data: unknown; error: unknown } {
  if (q.table === 'farmer_client_scores' && q.single) {
    switch (modo) {
      case 'falha_consulta':
        // O que o PostgREST devolve num statement timeout: data null + error preenchido.
        return { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } };
      case 'sem_margem':
        return { data: { ...BASE, gross_margin_pct: null }, error: null };
      case 'margem_zero':
        return { data: { ...BASE, gross_margin_pct: 0 }, error: null };
      default:
        return { data: { ...BASE, gross_margin_pct: 50 }, error: null };
    }
  }
  return { data: [], error: null };
}

function chain(table: string): unknown {
  const q: Q = { table, single: false };
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'limit', 'or', 'order', 'range', 'filter']) c[m] = () => c;
  c.single = () => { q.single = true; return c; };
  c.maybeSingle = () => { q.single = true; return c; };
  c.then = (resolve: (v: unknown) => void) => resolve(result(q));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
    functions: { invoke: vi.fn().mockResolvedValue({ data: {}, error: null }) },
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false, effectiveUserId: MASTER }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: MASTER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useTacticalPlan } from '../useTacticalPlan';

beforeEach(() => { modo = 'margem_conhecida'; vi.clearAllMocks(); });

async function checar() {
  const { result: r } = renderHook(() => useTacticalPlan());
  let out: Awaited<ReturnType<typeof r.current.checkEfficiency>> | undefined;
  await act(async () => { out = await r.current.checkEfficiency(CUSTOMER); });
  return out!;
}

describe('checkEfficiency — falha de consulta ≠ ausência de margem ≠ margem zero', () => {
  it('falha na consulta ⇒ motivo "indisponivel" (não acusa o cliente de não ter custo)', async () => {
    modo = 'falha_consulta';
    const r = await checar();

    expect(r.motivo).toBe('indisponivel');
    // O ponto do teste: sem o guard, este mesmo cenário devolveria `sem_margem` e o diálogo
    // afirmaria "nenhum item comprado tem custo cadastrado" sobre um cliente que talvez tenha.
    expect(r.motivo).not.toBe('sem_margem');
    expect(r.estimatedProfitPerHour).toBeNull();
  });

  it('margem desconhecida ⇒ motivo "sem_margem" (fato real sobre o dado do cliente)', async () => {
    modo = 'sem_margem';
    const r = await checar();

    expect(r.motivo).toBe('sem_margem');
    expect(r.estimatedProfitPerHour).toBeNull();
  });

  it('margem ZERO medida ⇒ R$ 0,00/h, sem motivo — é veredito, não ausência', async () => {
    modo = 'margem_zero';
    const r = await checar();

    // Zero é decidível: a régua REPROVA o cliente, e isso é uma informação legítima.
    // Degradar zero para `null` seria o erro simétrico ao que o PR corrige.
    expect(r.estimatedProfitPerHour).toBe(0);
    expect(r.motivo).toBeUndefined();
    expect(r.isAboveThreshold).toBe(false);
  });

  it('margem conhecida ⇒ R$/h calculado (5000 × 50% × 0,1 ÷ 0,25h = R$ 1.000/h)', async () => {
    const r = await checar();

    expect(r.estimatedProfitPerHour).toBeCloseTo(1000, 6);
    expect(r.motivo).toBeUndefined();
    expect(r.isAboveThreshold).toBe(true);
  });

  it('os dois estados indecidíveis são indistinguíveis SEM `motivo` — por isso ele existe', async () => {
    modo = 'falha_consulta';
    const falha = await checar();
    modo = 'sem_margem';
    const ausente = await checar();

    // Prova explícita de que os campos numéricos não carregam a diferença: quem quiser
    // escrever a mensagem certa na tela PRECISA ler `motivo`.
    expect(falha.estimatedProfitPerHour).toBe(ausente.estimatedProfitPerHour);
    expect(falha.isAboveThreshold).toBe(ausente.isAboveThreshold);
    expect(falha.motivo).not.toBe(ausente.motivo);
  });
});
