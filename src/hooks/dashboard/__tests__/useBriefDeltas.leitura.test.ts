import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Plano v8, C13 — HOME-DELTA-FANTASMA.
 *
 * O delta "aumentos anunciados" filtrava `eventos_outlier` por `created_at`, coluna que não existe:
 * toda carga da home fazia um request 400, e o `error` não era lido. Os outros três deltas também
 * descartavam o `error` — e falha virava "Sem mudanças desde sua última visita".
 */

type Resposta = { count: number | null; error: { message: string } | null };
let respostas: Record<string, Resposta> = {};
const tabelasConsultadas: string[] = [];

function builder(tabela: string) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'is', 'in']) q[m] = () => q;
  q.then = (ok: (r: Resposta) => unknown) =>
    Promise.resolve(respostas[tabela] ?? { count: 0, error: null }).then(ok);
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => {
      tabelasConsultadas.push(tabela);
      return builder(tabela);
    },
  },
}));

import { lerDeltas } from '../useBriefDeltas';

const SINCE = '2026-11-10T12:00:00.000Z';

beforeEach(() => {
  respostas = {};
  tabelasConsultadas.length = 0;
});

describe('lerDeltas — falha de contagem não vira "nada novo"', () => {
  it('CONTROLE: leituras boas → os deltas com novidade, nenhuma falha', async () => {
    respostas = {
      sales_orders: { count: 3, error: null },
      nfe_recebimentos: { count: 0, error: null },
      orders: { count: 2, error: null },
    };
    const r = await lerDeltas(SINCE);
    expect(r.falhas).toEqual([]);
    expect(r.deltas.map((d) => [d.type, d.value])).toEqual([
      ['sales_new', 3],
      ['orcamentos_new', 2],
    ]);
  });

  it('erro numa contagem → o rótulo vai para `falhas`, as outras seguem', async () => {
    respostas = {
      sales_orders: { count: 3, error: null },
      nfe_recebimentos: { count: 0, error: { message: 'permission denied' } },
      orders: { count: 0, error: null },
    };
    const r = await lerDeltas(SINCE);
    expect(r.falhas).toEqual(['NF chegaram']);
    expect(r.deltas.map((d) => d.type)).toEqual(['sales_new']);
  });

  it('count ausente sem erro também é falha (ausente ≠ zero)', async () => {
    respostas = { orders: { count: null, error: null } };
    const r = await lerDeltas(SINCE);
    expect(r.falhas).toEqual(['orçamentos enviados']);
  });

  it('não consulta eventos_outlier (o delta fantasma saiu)', async () => {
    await lerDeltas(SINCE);
    expect(tabelasConsultadas).toEqual(['sales_orders', 'nfe_recebimentos', 'orders']);
  });
});
