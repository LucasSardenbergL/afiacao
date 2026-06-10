import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OPEN_TITLE_STATUSES } from '@/lib/financeiro/titulo-status';

/**
 * Teste de contrato da somarSaldoAberto — a fonte canônica de "total a
 * receber/pagar em aberto" (DSO + KPIs de /financeiro/gestao). Trava os 4
 * contratos que o bug do KPI violava (B1 da auditoria 2026-06-09):
 *  1. filtra por OPEN_TITLE_STATUSES (vocabulário NATIVO do Omie) — o KPI
 *     antigo usava .neq('PAGO'), que incluía RECEBIDO/LIQUIDADO (saldo cheio
 *     por causa do #396) e até CANCELADO;
 *  2. pagina além do cap de 1000 do PostgREST — o KPI antigo truncava a soma;
 *  3. soma `saldo ?? 0` (sem fallback pro valor_documento);
 *  4. erro de QUALQUER página LANÇA — nunca soma parcial silenciosa.
 */

type Row = { saldo: number | null };

const state: {
  pages: Array<{ data: Row[] | null; error: { message: string } | null }>;
  calls: Array<{ tabela: string; company: string; statuses: string[]; from: number; to: number }>;
} = { pages: [], calls: [] };

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, company: string) => ({
          in: (_col2: string, statuses: string[]) => ({
            range: (from: number, to: number) => {
              const idx = Math.floor(from / 1000);
              state.calls.push({ tabela, company, statuses, from, to });
              return Promise.resolve(
                state.pages[idx] ?? { data: [], error: null },
              );
            },
          }),
        }),
      }),
    }),
  },
}));

import { somarSaldoAberto } from '@/services/financeiroService';

const page = (n: number, saldo = 10): { data: Row[]; error: null } => ({
  data: Array.from({ length: n }, () => ({ saldo })),
  error: null,
});

describe('somarSaldoAberto (contrato do B1)', () => {
  beforeEach(() => {
    state.pages = [];
    state.calls = [];
  });

  it('filtra pelos status NATIVOS de aberto (A VENCER/ATRASADO/VENCE HOJE), na tabela e empresa pedidas', async () => {
    state.pages = [page(3)];
    await somarSaldoAberto('fin_contas_receber', 'oben');
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].tabela).toBe('fin_contas_receber');
    expect(state.calls[0].company).toBe('oben');
    expect(state.calls[0].statuses).toEqual([...OPEN_TITLE_STATUSES]);
    expect(state.calls[0].statuses).toEqual(['A VENCER', 'ATRASADO', 'VENCE HOJE']);
  });

  it('pagina além do cap de 1000 e soma TODAS as páginas (o KPI antigo truncava)', async () => {
    state.pages = [page(1000, 2), page(234, 1)];
    const total = await somarSaldoAberto('fin_contas_receber', 'oben');
    expect(total).toBe(1000 * 2 + 234 * 1);
    expect(state.calls).toHaveLength(2);
    expect(state.calls[0]).toMatchObject({ from: 0, to: 999 });
    expect(state.calls[1]).toMatchObject({ from: 1000, to: 1999 });
  });

  it('para na primeira página parcial (não faz request à toa)', async () => {
    state.pages = [page(3, 5)];
    const total = await somarSaldoAberto('fin_contas_pagar', 'colacor');
    expect(total).toBe(15);
    expect(state.calls).toHaveLength(1);
  });

  it('saldo null contribui 0 — sem fallback pro valor_documento', async () => {
    state.pages = [{ data: [{ saldo: null }, { saldo: 7 }, { saldo: 0 }], error: null }];
    const total = await somarSaldoAberto('fin_contas_receber', 'oben');
    expect(total).toBe(7);
  });

  it('erro de página LANÇA (nunca devolve soma parcial silenciosa)', async () => {
    state.pages = [page(1000, 2), { data: null, error: { message: 'RLS negou' } }];
    await expect(somarSaldoAberto('fin_contas_receber', 'oben')).rejects.toBeTruthy();
  });
});
