import { describe, it, expect, vi, beforeEach } from 'vitest';

type Resposta = { data: unknown; error: { message: string } | null };
type Chamada = { metodo: string; args: unknown[] };
let chamadas: Chamada[] = [];
let respostas: Resposta[] = [];

function builder() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'range']) {
    b[m] = (...args: unknown[]) => {
      chamadas.push({ metodo: m, args });
      return b;
    };
  }
  b.then = (ok: (v: Resposta) => unknown, no?: (e: unknown) => unknown) =>
    Promise.resolve(respostas.shift() ?? { data: [], error: null }).then(ok, no);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => builder() } }));

import { fetchReceitaCompetencia } from '../fetch-receita-competencia';

const r = (company: string, ano: number, mes: number, valor_total: number) => ({ company, ano, mes, valor_total });

beforeEach(() => {
  chamadas = [];
  respostas = [];
});

describe('fetchReceitaCompetencia', () => {
  it('[DRE-JANELA] soma só os pares (ano, mês) da janela: o produto cartesiano não vaza', async () => {
    respostas = [
      {
        data: [r('oben', 2025, 11, 10), r('oben', 2025, 1, 999), r('oben', 2026, 1, 5), r('oben', 2026, 12, 999)],
        error: null,
      },
    ];
    const m = await fetchReceitaCompetencia('oben', { de: '2025-11-01', ate: '2026-02-01' });
    expect(m.get('oben')).toBe(15);
  });

  it('[DRE-CR] lê só receita (origem CR) e escopa a empresa; grupo não filtra empresa', async () => {
    await fetchReceitaCompetencia('colacor', { de: '2026-07-01', ate: '2026-10-01' });
    const eqs = chamadas.filter((c) => c.metodo === 'eq').map((c) => c.args);
    expect(eqs).toEqual([['origem', 'CR'], ['company', 'colacor']]);
    chamadas = [];
    await fetchReceitaCompetencia('all', { de: '2026-07-01', ate: '2026-10-01' });
    expect(chamadas.filter((c) => c.metodo === 'eq').map((c) => c.args)).toEqual([['origem', 'CR']]);
  });

  it('[DRE-AUSENTE] empresa sem linha no período fica fora do mapa (não vira 0)', async () => {
    respostas = [{ data: [r('oben', 2026, 7, 10)], error: null }];
    const m = await fetchReceitaCompetencia('all', { de: '2026-07-01', ate: '2026-10-01' });
    expect(m.has('colacor')).toBe(false);
  });

  it('[DRE-ERRO] erro e data null lançam', async () => {
    respostas = [{ data: null, error: { message: 'rls' } }];
    await expect(fetchReceitaCompetencia('oben', { de: '2026-07-01', ate: '2026-10-01' })).rejects.toThrow('rls');
    respostas = [{ data: null, error: null }];
    await expect(fetchReceitaCompetencia('oben', { de: '2026-07-01', ate: '2026-10-01' })).rejects.toThrow(/malformada/);
  });
});
