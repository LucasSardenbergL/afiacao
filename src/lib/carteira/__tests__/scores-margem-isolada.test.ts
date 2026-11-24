import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Onda E (clientes): a falha SÓ da RPC de margem (`get_scores_margem`) derrubava os scores e a
 * prioridade da lista inteira — `fetchScoresPorCustomer` lançava, o scope virava `scoresEstado:
 * 'falha'`, e a carteira perdia a ordem "Priorizar contatos" e o filtro de saúde por causa de um
 * número que nem aparece na lista. Agora a margem degrada sozinha.
 *
 * DISCRIMINADOR (a marca do ramo): `margem_indisponivel === true`. Nos três ramos o
 * `gross_margin_pct` é `null` (falhou · não concedida · não apurada) — checar só o null passaria
 * na versão que confunde "falhou" com "sem custo". E a falha dos SCORES continua lançando.
 */

const h = vi.hoisted(() => ({
  margem: 'ok' as 'ok' | 'falha',
  scoresFalham: false,
  ordem: [] as string[],
}));

vi.mock('@/integrations/supabase/client', () => {
  const cadeia = () => {
    const c: Record<string, unknown> = {};
    let ids: string[] = [];
    for (const m of ['select', 'eq', 'order', 'range']) c[m] = () => c;
    c.in = (_col: string, v: string[]) => { ids = v; return c; };
    c.then = (res: (v: unknown) => void) => {
      h.ordem.push('score');
      if (h.scoresFalham) return res({ data: null, error: { message: 'timeout', code: '57014' } });
      return res({
        data: ids.map((id) => ({
          customer_user_id: id, health_score: 70, health_class: 'saudavel', churn_risk: 30,
          expansion_score: null, priority_score: 42, avg_monthly_spend_180d: 900,
          days_since_last_purchase: 12, category_count: 2, itens_com_custo: 3, itens_sem_custo: 0,
          avg_repurchase_interval: 30, sales_history_status: 'ativo',
        })),
        error: null,
      });
    };
    return c;
  };
  return { supabase: { from: () => cadeia() } };
});

vi.mock('@/lib/scoring/margemScores', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/scoring/margemScores')>();
  return {
    ...real,
    buscarMargensScores: async ({ customerIds }: { customerIds: string[] }) => {
      h.ordem.push('margem');
      if (h.margem === 'falha') throw new Error('get_scores_margem: 500');
      return new Map(customerIds.map((id) => [id, { margem: 31.5, visivel: true }]));
    },
  };
});

import { fetchScoresPorCustomer } from '@/lib/carteira/escopo-clientes';

const IDS = Array.from({ length: 400 }, (_, i) => `cli-${i}`); // 3 lotes de 150

beforeEach(() => {
  h.margem = 'ok';
  h.scoresFalham = false;
  h.ordem = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('fetchScoresPorCustomer — margem isolada dos scores', () => {
  it('RPC de margem FALHA → scores e prioridade seguem; margem marcada indisponível (não oculta, não "não apurada")', async () => {
    h.margem = 'falha';
    const mapa = await fetchScoresPorCustomer(IDS);
    expect(mapa.size).toBe(400);
    const s = mapa.get('cli-7')!;
    expect(s.priority_score).toBe(42);
    expect(s.health_class).toBe('saudavel');
    expect(s.margem_indisponivel).toBe(true);
    expect(s.margem_oculta).toBe(false);
    expect(s.gross_margin_pct).toBeNull();
  });

  it('RPC de margem OK → margem lida e margem_indisponivel === false', async () => {
    const s = (await fetchScoresPorCustomer(IDS)).get('cli-7')!;
    expect(s.gross_margin_pct).toBe(31.5);
    expect(s.margem_indisponivel).toBe(false);
    expect(s.margem_oculta).toBe(false);
  });

  it('falha dos SCORES continua lançando (a degradação é só da margem)', async () => {
    h.scoresFalham = true;
    await expect(fetchScoresPorCustomer(IDS)).rejects.toMatchObject({ code: '57014' });
  });

  it('a margem sai junto com os lotes de score (não depois do último)', async () => {
    await fetchScoresPorCustomer(IDS);
    // Antes: score,score,score,margem. Agora a margem é disparada antes de o último lote voltar.
    expect(h.ordem.indexOf('margem')).toBeLessThan(h.ordem.lastIndexOf('score'));
  });
});
