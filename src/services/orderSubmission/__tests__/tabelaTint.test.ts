import { describe, it, expect, vi } from 'vitest';
import type { ProductCartItem } from '@/hooks/unifiedOrder/types';
import type { SubmitClient } from '../types';
import { coresTabelaInvalida, bloqueioTabelaTint } from '../tabelaTint';

const item = (over: Partial<ProductCartItem>): ProductCartItem =>
  ({
    product: { id: 'p1', codigo: 'BASE-405', descricao: 'Base 405ML' },
    quantity: 1,
    unit_price: 0.7,
    tint_cor_id: '360V - BS',
    tint_formula_id: 'f1',
    tint_price_source: 'tabela',
    ...over,
  }) as ProductCartItem;

describe('coresTabelaInvalida — elegibilidade da fonte tint "tabela" no orçamento', () => {
  const csv = new Map<string, number | null>([['f1', 0.6824], ['f2', 51.2], ['f3', 51.1]]);
  const calc = new Map<string, number | null>([['f1', 102.47], ['f2', 102.3457], ['f3', 102.3457]]);

  it('o caso real (CSV 0,68 × calc 102,47) bloqueia', () => {
    expect(coresTabelaInvalida([item({})], csv, calc)).toEqual(['360V - BS']);
  });

  it('exatamente 50% passa; 0,1 abaixo bloqueia (mesma régua do gate)', () => {
    expect(coresTabelaInvalida([item({ tint_formula_id: 'f2', tint_cor_id: 'K41' })], csv, calc)).toEqual([]);
    expect(coresTabelaInvalida([item({ tint_formula_id: 'f3', tint_cor_id: 'K42' })], csv, calc)).toEqual(['K42']);
  });

  it('fontes que não são "tabela" ficam fora (o gate da conversão as valida)', () => {
    expect(coresTabelaInvalida([item({ tint_price_source: 'calculado' }), item({ tint_price_source: 'manual' })], csv, calc)).toEqual([]);
  });

  it('fail-closed: sem formula_id, fora da canônica ou motor sem preço → bloqueia', () => {
    expect(coresTabelaInvalida([item({ tint_formula_id: undefined, tint_cor_id: 'A' })], csv, calc)).toEqual(['A']);
    expect(coresTabelaInvalida([item({ tint_formula_id: 'fx', tint_cor_id: 'B' })], csv, calc)).toEqual(['B']);
    const semCalc = new Map<string, number | null>([['f2', null]]);
    expect(coresTabelaInvalida([item({ tint_formula_id: 'f2', tint_cor_id: 'C' })], csv, semCalc)).toEqual(['C']);
  });
});

describe('bloqueioTabelaTint — leitura do estado atual', () => {
  const mkClient = (opts: { csv?: number | null; precoFinal?: number | null; erroView?: boolean }) => {
    const inFn = vi.fn().mockResolvedValue(
      opts.erroView
        ? { data: null, error: { message: 'boom' } }
        : { data: [{ id: 'f1', preco_csv_legado: opts.csv ?? null }], error: null },
    );
    const from = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ in: inFn }) });
    const rpc = vi.fn().mockResolvedValue({ data: { precoFinal: opts.precoFinal ?? null }, error: null });
    return { client: { from, rpc } as unknown as SubmitClient, from, rpc };
  };

  it('sem item "tabela" não lê nada (o caminho comum não paga a consulta)', async () => {
    const { client, from, rpc } = mkClient({});
    expect(await bloqueioTabelaTint(client, [item({ tint_price_source: 'calculado' })])).toBeNull();
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('CSV implausível → mensagem que nomeia a cor', async () => {
    const { client } = mkClient({ csv: 0.6824, precoFinal: 102.47 });
    expect(await bloqueioTabelaTint(client, [item({})])).toMatch(/Preço de tabela inválido para 360V - BS/);
  });

  it('CSV plausível → segue (null)', async () => {
    const { client } = mkClient({ csv: 120, precoFinal: 170.16 });
    expect(await bloqueioTabelaTint(client, [item({})])).toBeNull();
  });

  it('erro de leitura (PostgrestError, não Error) → bloqueia com a mensagem do banco', async () => {
    const { client } = mkClient({ erroView: true });
    expect(await bloqueioTabelaTint(client, [item({})])).toMatch(/Não foi possível confirmar o preço de tabela das tintas \(boom\)/);
  });
});
