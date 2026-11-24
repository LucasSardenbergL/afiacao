import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Onda B, item 2: (a) o título vencido no 60º dia ENTRA (`<=` no corte, não `<`); (b) sem títulos, o
// frescor por empresa SOBREVIVE — é o que separa "nada vencido" de "não sincronizado".
// O mock grava cada filtro aplicado: a asserção casa o OPERADOR da fronteira (a marca do ramo), não
// só "a query rodou".

type Chamada = { tabela: string; op: string; args: unknown[] };
let chamadas: Chamada[] = [];
let logsSync: Record<string, { data: unknown[]; error: null }> = {};

function cadeia(tabela: string) {
  const filtros: Chamada[] = [];
  const c: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'in', 'lt', 'lte', 'gt', 'gte', 'order', 'contains', 'range', 'limit']) {
    c[op] = (...args: unknown[]) => {
      const ch = { tabela, op, args };
      chamadas.push(ch);
      filtros.push(ch);
      return c;
    };
  }
  c.then = (sim: (v: unknown) => unknown, nao?: (e: unknown) => unknown) => {
    if (tabela === 'fin_sync_log') {
      const empresa = (filtros.find((f) => f.op === 'contains')?.args[1] as string[])[0];
      const status = filtros.find((f) => f.op === 'eq' && f.args[0] === 'status')?.args[1] as string;
      return Promise.resolve(logsSync[`${empresa}:${status}`] ?? { data: [], error: null }).then(sim, nao);
    }
    return Promise.resolve({ data: [], error: null }).then(sim, nao);
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => cadeia(t) } }));

import { buscarAlertaCredito } from '../useAlertaCreditoCliente';

beforeEach(() => {
  chamadas = [];
  logsSync = {};
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-24T15:00:00Z')); // 12:00 em São Paulo → hoje_SP = 2026-11-24
});
afterEach(() => vi.useRealTimers());

describe('crédito — fronteira dos 60 dias', () => {
  it('vencimento NO corte (60º dia de atraso) entra: filtro `lte` em hoje_SP − 60', async () => {
    await buscarAlertaCredito([{ company: 'oben', codigo: 10 }]);
    const venc = chamadas.filter((c) => c.tabela === 'fin_contas_receber' && c.args[0] === 'data_vencimento');
    expect(venc).toEqual([{ tabela: 'fin_contas_receber', op: 'lte', args: ['data_vencimento', '2026-09-25'] }]);
  });
});

describe('crédito — sem títulos, o frescor não se perde', () => {
  it('nenhum título + último sync da empresa FALHOU: alerta null, frescor diz erro (não verde)', async () => {
    logsSync['colacor:complete'] = { data: [{ started_at: '2026-11-23T10:00:00Z', completed_at: '2026-11-23T10:05:00Z' }], error: null };
    logsSync['colacor:error'] = { data: [{ started_at: '2026-11-24T14:00:00Z', completed_at: null }], error: null };
    const r = await buscarAlertaCredito([{ company: 'colacor', codigo: 20 }]);
    expect(r.alerta).toBeNull();
    expect(r.frescor).toEqual([{ company: 'colacor', syncAt: '2026-11-23T10:05:00Z', estado: 'erro' }]);
  });

  it('frescor é POR EMPRESA: cada empresa lida consulta o próprio log (`companies @> {empresa}`)', async () => {
    await buscarAlertaCredito([{ company: 'oben', codigo: 10 }, { company: 'colacor_sc', codigo: 30 }]);
    const empresas = chamadas
      .filter((c) => c.tabela === 'fin_sync_log' && c.op === 'contains')
      .map((c) => (c.args[1] as string[])[0]);
    expect([...new Set(empresas)].sort()).toEqual(['colacor_sc', 'oben']);
  });
});
