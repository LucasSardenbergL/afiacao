import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard money-path — a falha do sync financeiro tem de CHEGAR à tela.
 *
 * Último sítio money-path da classe #1565→#1579→#1697→#2894→#2905→#2907→#2912 ("o hook expõe a
 * falha e o consumidor não a lê"): `useFinanceiro` expõe `error` e `FinanceiroSync` destruturava
 * `{ syncing, syncSpecific, calcularDREAnual, view, setView }` — sem ele.
 *
 * E aqui a classe tem uma forma própria, pior que o zero fabricado: **o `catch` do hook devolve
 * `undefined`**. `syncSpecific` captura a exceção, chama `setError(...)` e sai sem relançar; a
 * página faz `const result = await syncSpecific(action); if (result?.results) { … }`, então
 * nada entra no `if`, nada entra no `catch` dela (não houve throw) — e as linhas que ela marcou
 * como `running` ANTES de chamar ficam `running` **para sempre**. Spinner eterno por empréstimo:
 * o estado de erro existe, mora no hook, e a tela nunca o lê.
 *
 * O `calcularDREAnual` é o caso extremo: devolve `void`, engole no `catch` e a tela não tem nem
 * `result` para olhar. Clicar em "Calcular DRE" num dia de falha dava spinner e **silêncio** —
 * num botão que recalcula a DRE gerencial de um ano inteiro.
 *
 * Contrato (§7 do money-path.md): sem cache → "indisponível" com o motivo. Nunca skeleton (nem
 * spinner) eterno.
 *
 * O hook roda de VERDADE (só o supabase é dublê): a cadeia edge→hook→tela é o que precisa ser
 * honesta — mockar `useFinanceiro` provaria só que a página renderiza o estado que eu montei.
 */

let falharInvoke = false;
let travarInvoke = false;

const RESULTADO_OK = {
  oben: { totalSynced: 5 },
  colacor: { totalSynced: 3 },
  colacor_sc: { totalSynced: 1 },
};

function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains', 'returns',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => chain(),
    rpc: () => Promise.resolve({ data: [], error: null }),
    functions: {
      invoke: () => {
        if (travarInvoke) return new Promise(() => {});
        if (falharInvoke) {
          return Promise.resolve({ data: null, error: { message: 'edge retornou 500 (omie-financeiro)' } });
        }
        return Promise.resolve({ data: RESULTADO_OK, error: null });
      },
    },
  },
}));
vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'gestor-1' };
  return { useAuth: () => ({ user, isStaff: true, isMaster: true, loading: false }) };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: vi.fn() }));

import FinanceiroSync from '../FinanceiroSync';

const montar = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <FinanceiroSync />
      </QueryClientProvider>,
    ),
  };
};

/** Os spinners da tela — é um deles que ficava girando para sempre. */
const girando = () => document.querySelectorAll('.animate-spin');
const botaoSyncDe = (rotulo: string) => {
  const card = screen.getByText(rotulo).closest('.rounded-lg');
  if (!card) throw new Error(`card "${rotulo}" não encontrado`);
  const botoes = Array.from(card.querySelectorAll('button')).filter((b) => /Sync/i.test(b.textContent ?? ''));
  if (botoes.length !== 1) throw new Error(`esperava 1 botão Sync em "${rotulo}", achei ${botoes.length}`);
  return botoes[0];
};

beforeEach(() => {
  falharInvoke = false;
  travarInvoke = false;
  vi.clearAllMocks();
});

describe('FinanceiroSync — o sync que falha não fica girando para sempre', () => {
  it('DETECTOR: o seletor de spinner enxerga um VIVO enquanto o sync corre', async () => {
    // Sem este par, `girando().length === 0` no teste de erro passaria com seletor morto
    // (armadilha do #1585) — e é justamente o spinner que ficava eterno.
    travarInvoke = true;

    montar();
    fireEvent.click(botaoSyncDe('Categorias'));

    await waitFor(() => { expect(girando().length).toBeGreaterThan(0); });
  });

  it('DETECTOR: o caminho feliz conclui e não alerta nada', async () => {
    montar();
    fireEvent.click(botaoSyncDe('Categorias'));

    expect(await screen.findByText('5')).toBeTruthy();
    await waitFor(() => { expect(girando().length).toBe(0); });
    expect(screen.queryByTestId('aviso-sync-financeiro')).toBeNull();
  });

  it('sob falha: alerta com o motivo e NENHUM spinner pendurado', async () => {
    falharInvoke = true;

    montar();
    fireEvent.click(botaoSyncDe('Categorias'));

    const aviso = await screen.findByTestId('aviso-sync-financeiro');
    expect(aviso.textContent, 'o alerta não trouxe o motivo que o hook já tinha').toMatch(
      /omie-financeiro|500/i,
    );
    await waitFor(() => {
      expect(girando().length, 'spinner eterno: a linha ficou "running" para sempre').toBe(0);
    });
    expect(
      screen.getAllByText(/Erro/i).length,
      'a linha não foi marcada como erro — o operador não sabe o que falhou',
    ).toBeGreaterThan(0);
  });

  it('o DRE anual que falha deixa de ser silêncio', async () => {
    // `calcularDREAnual` devolve `void` e engole no catch: a tela não tinha NADA para olhar.
    falharInvoke = true;

    montar();
    fireEvent.click(screen.getByRole('button', { name: /Calcular DRE/i }));

    const aviso = await screen.findByTestId('aviso-sync-financeiro');
    expect(aviso.textContent).toMatch(/omie-financeiro|500/i);
  });
});
