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
  calls: Array<{ tabela: string; company: string; statuses: string[]; order: string; from: number; to: number }>;
} = { pages: [], calls: [] };

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, company: string) => ({
          in: (_col2: string, statuses: string[]) => ({
            order: (orderCol: string) => ({
              range: (from: number, to: number) => {
                const idx = Math.floor(from / 1000);
                state.calls.push({ tabela, company, statuses, order: orderCol, from, to });
                return Promise.resolve(
                  state.pages[idx] ?? { data: [], error: null },
                );
              },
            }),
          }),
        }),
      }),
    }),
  },
}));

// Telemetria de página perdida: só existe no paginador canônico (`fetchAllPages`). O laço
// manual que a soma tinha antes LANÇAVA certo, mas ninguém media a frequência (money-path §7).
const captureExceptionMock = vi.fn();
vi.mock('@/lib/analytics', () => ({
  captureException: (...a: unknown[]) => captureExceptionMock(...a),
}));

import { somarSaldoAberto, somarSaldoPorStatus } from '@/services/financeiroService';

const page = (n: number, saldo = 10): { data: Row[]; error: null } => ({
  data: Array.from({ length: n }, () => ({ saldo })),
  error: null,
});

describe('somarSaldoAberto (contrato do B1)', () => {
  beforeEach(() => {
    state.pages = [];
    state.calls = [];
    captureExceptionMock.mockClear();
  });

  it('filtra pelos status NATIVOS de aberto (A VENCER/ATRASADO/VENCE HOJE), na tabela e empresa pedidas', async () => {
    state.pages = [page(3)];
    await somarSaldoAberto('fin_contas_receber', 'oben');
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].tabela).toBe('fin_contas_receber');
    expect(state.calls[0].company).toBe('oben');
    expect(state.calls[0].statuses).toEqual([...OPEN_TITLE_STATUSES]);
    // 3 nativos + 3 fallbacks do ingest (retroativo Codex 2026-06-11)
    expect(state.calls[0].statuses).toEqual(['A VENCER', 'ATRASADO', 'VENCE HOJE', 'ABERTO', 'VENCIDO', 'PARCIAL']);
  });

  it('pagina ORDENADO por id — offset sem ORDER BY não é estável entre páginas (sync grava a cada 10min)', async () => {
    state.pages = [page(3)];
    await somarSaldoAberto('fin_contas_receber', 'oben');
    expect(state.calls[0].order).toBe('id');
  });

  it('última página exatamente cheia (múltiplo de 1000): faz a request extra vazia e encerra', async () => {
    state.pages = [page(1000, 2)];
    const total = await somarSaldoAberto('fin_contas_receber', 'oben');
    expect(total).toBe(2000);
    expect(state.calls).toHaveLength(2);
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

  it('erro de página LANÇA um Error real (consumidores fazem `e instanceof Error ? e.message : ...`)', async () => {
    state.pages = [page(1000, 2), { data: null, error: { message: 'RLS negou' } }];
    await expect(somarSaldoAberto('fin_contas_receber', 'oben')).rejects.toBeInstanceOf(Error);
    state.pages = [page(1000, 2), { data: null, error: { message: 'RLS negou' } }];
    await expect(somarSaldoAberto('fin_contas_receber', 'oben')).rejects.toThrow(/RLS negou/);
  });
});

describe('somarSaldoPorStatus pagina pelo fetchAllPages (telemetria de página perdida)', () => {
  beforeEach(() => {
    state.pages = [];
    state.calls = [];
    captureExceptionMock.mockClear();
  });

  it('página com error é MEDIDA: captureException com fonte tabela/empresa, página e linhas perdidas', async () => {
    state.pages = [page(1000, 2), { data: null, error: { message: 'RLS negou' } }];
    await expect(somarSaldoAberto('fin_contas_receber', 'oben')).rejects.toThrow(/RLS negou/);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0][1]).toMatchObject({
      fonte: 'saldo de fin_contas_receber (oben)',
      pagina: 1,
      linhas_lidas_antes_da_falha: 1000,
    });
  });

  it('data null sem error também é medida — e a mensagem diz que foi resposta malformada', async () => {
    state.pages = [{ data: null, error: null }];
    await expect(somarSaldoPorStatus('fin_contas_pagar', 'colacor', ['ATRASADO'])).rejects.toThrow(
      /data null sem error/,
    );
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0][1]).toMatchObject({
      fonte: 'saldo de fin_contas_pagar (colacor)',
      pagina: 0,
    });
  });
});

/**
 * Variante genérica por status (getResumoFinanceiro usa com ['ATRASADO'] pros
 * vencidos). Mesmos contratos de paginação/erro da somarSaldoAberto — que
 * delega nela (os testes acima provam que a delegação preserva o contrato).
 */
describe('somarSaldoPorStatus (contrato dos vencidos do resumo)', () => {
  beforeEach(() => {
    state.pages = [];
    state.calls = [];
  });

  it('filtra EXATAMENTE pelos status pedidos (vencido = só ATRASADO), na tabela e empresa pedidas', async () => {
    state.pages = [page(2)];
    await somarSaldoPorStatus('fin_contas_pagar', 'colacor', ['ATRASADO']);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].tabela).toBe('fin_contas_pagar');
    expect(state.calls[0].company).toBe('colacor');
    expect(state.calls[0].statuses).toEqual(['ATRASADO']);
  });

  it('pagina além do cap de 1000 e soma TODAS as páginas', async () => {
    state.pages = [page(1000, 3), page(1000, 2), page(10, 1)];
    const total = await somarSaldoPorStatus('fin_contas_receber', 'oben', ['ATRASADO']);
    expect(total).toBe(1000 * 3 + 1000 * 2 + 10 * 1);
    expect(state.calls).toHaveLength(3);
    expect(state.calls[2]).toMatchObject({ from: 2000, to: 2999 });
  });

  it('saldo null contribui 0 e erro de página LANÇA', async () => {
    state.pages = [{ data: [{ saldo: null }, { saldo: 4 }], error: null }];
    expect(await somarSaldoPorStatus('fin_contas_receber', 'oben', ['ATRASADO'])).toBe(4);

    state.pages = [page(1000), { data: null, error: { message: 'boom' } }];
    state.calls = [];
    await expect(
      somarSaldoPorStatus('fin_contas_receber', 'oben', ['ATRASADO']),
    ).rejects.toBeTruthy();
  });
});
