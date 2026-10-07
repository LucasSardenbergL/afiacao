import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A leitura que decide QUEM vendeu no ranking do Master (spec 2026-10-06 §5.2): cliente → dono ATUAL da
 * carteira ELEGÍVEL. Falha de leitura nunca pode virar "cliente sem carteira" — isso mandaria a venda
 * para "Sem vendedor atribuído", um veredito sobre o que ninguém leu.
 */
type Resposta = { data: unknown; error: { message: string } | null };
type Chamada = { metodo: string; args: unknown[] };

/** Uma lista de chamadas por requisição (cada `from()` abre uma). */
let requisicoes: Chamada[][] = [];
let tabelas: string[] = [];
/** Resposta da requisição `n` (0-based), dado o lote pedido nela. */
let responder: (lote: string[], n: number) => Resposta = () => ({ data: [], error: null });

function builder() {
  const n = requisicoes.length;
  const chamadas: Chamada[] = [];
  requisicoes.push(chamadas);
  let lote: string[] = [];
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in']) {
    b[m] = (...args: unknown[]) => {
      chamadas.push({ metodo: m, args });
      if (m === 'in') lote = args[1] as string[];
      return b;
    };
  }
  b.then = (ok: (v: Resposta) => unknown, no?: (e: unknown) => unknown) =>
    Promise.resolve(responder(lote, n)).then(ok, no);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => {
      tabelas.push(t);
      return builder();
    },
  },
}));

import { fetchDonosCarteira } from '../fetch-donos-carteira';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `C${i + 1}`);
const loteDe = (req: Chamada[]) => (req.find((c) => c.metodo === 'in')?.args[1] ?? []) as string[];

beforeEach(() => {
  requisicoes = [];
  tabelas = [];
  responder = () => ({ data: [], error: null });
});

describe('fetchDonosCarteira', () => {
  it('[FD-VAZIO] lista vazia: mapa vazio e nenhuma requisição', async () => {
    expect(await fetchDonosCarteira([])).toEqual(new Map());
    expect(requisicoes).toHaveLength(0);
  });

  it('[FD-LOTE] 151 clientes: 2 requisições (150 + 1), cada cliente pedido uma vez', async () => {
    await fetchDonosCarteira(ids(151));
    expect(requisicoes.map((r) => loteDe(r).length)).toEqual([150, 1]);
    expect(new Set(requisicoes.flatMap(loteDe))).toEqual(new Set(ids(151)));
  });

  it('[FD-DEDUP] cliente repetido vai uma vez só', async () => {
    await fetchDonosCarteira(['C1', 'C2', 'C1', 'C2', 'C3']);
    expect(requisicoes).toHaveLength(1);
    expect([...loteDe(requisicoes[0])].sort()).toEqual(['C1', 'C2', 'C3']);
  });

  it('[FD-ELIG] toda requisição lê carteira_assignments filtrando eligible = true', async () => {
    await fetchDonosCarteira(ids(151));
    expect(tabelas).toEqual(['carteira_assignments', 'carteira_assignments']);
    for (const req of requisicoes) expect(req).toContainEqual({ metodo: 'eq', args: ['eligible', true] });
  });

  it('[FD-MAPA] devolve cliente → dono das linhas lidas; cliente sem linha fica fora', async () => {
    responder = () => ({
      data: [
        { customer_user_id: 'C1', owner_user_id: 'V1' },
        { customer_user_id: 'C2', owner_user_id: 'MASTER' },
      ],
      error: null,
    });
    const donos = await fetchDonosCarteira(['C1', 'C2', 'C3']);
    expect(donos).toEqual(new Map([['C1', 'V1'], ['C2', 'MASTER']]));
    expect(donos.has('C3')).toBe(false);
  });

  it('[FD-ERRO] erro da leitura lança com a marca da carteira — nunca vira "sem carteira"', async () => {
    responder = () => ({ data: null, error: { message: 'permission denied' } });
    await expect(fetchDonosCarteira(['C1'])).rejects.toThrow('carteira_assignments (donos): permission denied');
  });

  it('[FD-ERRO-LOTE2] erro no 2º lote lança — o 1º lote não vira mapa parcial', async () => {
    responder = (lote, n) =>
      n === 0
        ? { data: lote.map((c) => ({ customer_user_id: c, owner_user_id: 'V1' })), error: null }
        : { data: null, error: { message: 'statement timeout' } };
    await expect(fetchDonosCarteira(ids(151))).rejects.toThrow('carteira_assignments (donos): statement timeout');
  });

  it('[FD-NULO] data nula sem error lança — malformada não é fim', async () => {
    responder = () => ({ data: null, error: null });
    await expect(fetchDonosCarteira(['C1'])).rejects.toThrow('carteira_assignments (donos): data null sem error');
  });
});
