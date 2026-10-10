import { describe, it, expect } from 'vitest';
import { acharSingleShots } from '@/lib/gates/single-shot-truncado';

// Calibração do predicado (matar-classe, passo 1): a assinatura TEM que casar o sítio
// pré-fix e NÃO casar o pós-fix. Assinatura que não discrimina = varredura teatro.

describe('acharSingleShots — calibração contra o fix real do #1471', () => {
  it('casa a forma pré-fix do #1471 (trecho removido de useCrossSellEngine)', () => {
    const preFix = `
      const { data: products } = (await supabase
        .from('omie_products')
        .select('id, codigo, descricao, valor_unitario, metadata, ativo, omie_codigo_produto, estoque')
        .eq('ativo', true)) as unknown as { data: ProductRow[] | null };

      const { data: productCosts } = (await supabase
        .from('product_costs')
        .select('product_id, cost_final, cost_price')) as unknown as { data: ProductCostRow[] | null };`;
    const achados = acharSingleShots(preFix);
    expect(achados.map((a) => a.tabela)).toEqual(['omie_products', 'product_costs']);
  });

  it('NÃO casa a forma pós-fix (callback de fetchAllPages)', () => {
    const posFix = `
      const products = await fetchAllPages<ProductRow>((de, ate) =>
        supabase
          .from('omie_products')
          .select('id, codigo, descricao')
          .eq('ativo', true)
          .order('id', { ascending: true })
          .range(de, ate) as unknown as PromiseLike<{ data: ProductRow[] | null; error: unknown }>,
        'omie_products/exemplo',
      );`;
    expect(acharSingleShots(posFix)).toEqual([]);
  });

  it('NÃO casa callback delegado cujo `.range()` mora em OUTRA instrução', () => {
    // Forma real de getConciliacaoPendente: sem a janela de delegação isto seria
    // falso-vermelho sobre o próprio código corrigido.
    const delegado = `
      const data = await fetchAllPages<Row>((de, ate) => {
        let query = supabase
          .from("fin_conciliacao")
          .select("*")
          .eq("company", company)
          .order("id", { ascending: true });
        if (cc) query = query.eq("omie_ncodcc", cc);
        return query.range(de, ate) as unknown as PromiseLike<{ data: Row[] | null; error: unknown }>;
      }, 'fin_conciliacao/pendentes');`;
    expect(acharSingleShots(delegado)).toEqual([]);
  });

  it('NÃO casa delimitadores legítimos', () => {
    const legitimos = `
      const { data: um, error: e1 } = await supabase
        .from('sales_orders').select('*').eq('id', pedidoId).maybeSingle();
      const { data: janela, error: e2 } = await supabase
        .from('fin_contas_pagar').select('*').order('data_vencimento').limit(50);
      const { data: janelaVar, error: e3 } = await supabase
        .from('fin_sync_log').select('*').order('started_at').limit(limit);
      const { data: doLote, error: e4 } = await supabase
        .from('product_costs').select('product_id, cost_final').in('product_id', chunk);
      const { count, error: e5 } = await supabase
        .from('sales_orders').select('id', { count: 'exact', head: true }).eq('company', co);
      const { data: mes, error: e6 } = await supabase
        .from('fin_dre_snapshots').select('*').eq('company', co).eq('ano', ano).eq('mes', mes);`;
    expect(acharSingleShots(legitimos)).toEqual([]);
  });

  it('casa filtro só CATEGÓRICO — `.eq(company)`/`.eq(status)` não delimitam', () => {
    const categorico = `
      const { data, error } = await supabase
        .from('fin_conciliacao')
        .select('status')
        .eq('company', company);`;
    expect(acharSingleShots(categorico).map((a) => a.tabela)).toEqual(['fin_conciliacao']);
  });

  it('casa `.limit(1000)` como truncagem NA capa, disfarçada de delimitador', () => {
    // Caso real: analyze-unified-order documentava "ALL profiles" logo acima disto.
    const naCapa = `
      const { data, error } = await supabase
        .from('profiles').select('user_id, name').limit(1000);`;
    const achados = acharSingleShots(naCapa);
    expect(achados).toHaveLength(1);
    expect(achados[0].limitNaCapa).toBe(true);
  });

  it('ignora tabela fora do risco (config pequena não é defeito)', () => {
    const pequena = `const { data, error } = await supabase.from('company_config').select('key, value');`;
    expect(acharSingleShots(pequena)).toEqual([]);
  });

  it('ignora o `.select()` de retorno de escrita (herda a cardinalidade do write)', () => {
    const escrita = `
      const { data, error } = await supabase
        .from('sales_orders').update({ status: 'x' }).eq('company', co).select('id');`;
    expect(acharSingleShots(escrita)).toEqual([]);
  });

  it('reporta a linha do `.from(` (orientação para quem for quitar)', () => {
    const fonte = 'const a = 1;\nconst b = 2;\nconst { data, error } = await supabase\n  .from("sales_orders")\n  .select("*");';
    expect(acharSingleShots(fonte)[0].linha).toBe(4);
  });
});
