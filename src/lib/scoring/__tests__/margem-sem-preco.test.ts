import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';
import { accumulateMarginFromItems } from '../margin';

const costMap = new Map([['A', 10]]);

describe('accumulateMarginFromItems — item SEM preço não fabrica margem negativa (M-04, ausente ≠ zero)', () => {
  it('unit_price null/undefined/""/0/"0"/lixo/NaN → item PULADO (receita E custo) e contado em semPreco', () => {
    for (const unit_price of [null, undefined, '', 0, '0', 'abc', NaN] as const) {
      const r = accumulateMarginFromItems([{ product_id: 'A', quantity: 2, unit_price: unit_price as never }], costMap);
      // era o bug: receita 0 + custo 20 = margem NEGATIVA fabricada (custo sem receita)
      expect(r, `unit_price=${String(unit_price)}`).toEqual({ revenue: 0, cost: 0, semPreco: 1 });
    }
  });

  it('preço negativo ou não-finito → pulado (finitude POSITIVA, a mesma régua do custo)', () => {
    for (const unit_price of [-5, Infinity, -Infinity]) {
      const r = accumulateMarginFromItems([{ product_id: 'A', quantity: 1, unit_price }], costMap);
      expect(r, `unit_price=${unit_price}`).toEqual({ revenue: 0, cost: 0, semPreco: 1 });
    }
  });

  it('mistura: só o item com preço entra; o sem preço NÃO puxa a margem para baixo', () => {
    const r = accumulateMarginFromItems(
      [
        { product_id: 'A', quantity: 1, unit_price: 100 },
        { product_id: 'A', quantity: 3, unit_price: null as never },
      ],
      costMap,
    );
    expect(r).toEqual({ revenue: 100, cost: 10, semPreco: 1 });
  });

  it('item pt-BR (a forma de produção): valor_unitario ausente idem', () => {
    const omie = new Map([[7, 'A']]);
    const r = accumulateMarginFromItems(
      [
        { omie_codigo_produto: 7, quantidade: 2, valor_unitario: 50 },
        { omie_codigo_produto: 7, quantidade: 2 },
      ],
      costMap,
      omie,
    );
    expect(r).toEqual({ revenue: 100, cost: 20, semPreco: 1 });
  });

  it('semPreco NÃO conta item sem custo nem sem product_id — são outras ausências, já excluídas antes', () => {
    const r = accumulateMarginFromItems(
      [
        { product_id: 'SEM-CUSTO', quantity: 1, unit_price: null as never },
        { quantity: 1, unit_price: null as never },
      ],
      costMap,
    );
    expect(r).toEqual({ revenue: 0, cost: 0, semPreco: 0 });
  });

  it('preço válido continua entrando (regressão): string numérica do jsonb inclusive', () => {
    const r = accumulateMarginFromItems([{ product_id: 'A', quantity: '2', unit_price: '12.5' }], costMap);
    expect(r).toEqual({ revenue: 25, cost: 20, semPreco: 0 });
  });
});

describe('origem — a fatia FECHOU (o vigia do M-04 virou o invariante que ele vigiava)', () => {
  // Este bloco era um VIGIA: ele afirmava que `valor_unitario || 0` AINDA existia na edge, para
  // que sumir fosse um evento visível. A fatia de origem entrou (migration 20260905225613 +
  // writers + leitores), então o vigia sai e no lugar fica o invariante ao contrário.
  //
  // ⚠️ Por que ler o FONTE e não chamar a função: `bun run test` (vitest, Node) não importa
  // módulo Deno. Este é o mesmo compromisso dos outros gates textuais do repo — e por isso passa
  // pelo stripper COMPARTILHADO: sem ele, um `precoUnitarioOmie` escrito só num COMENTÁRIO
  // deixaria o teste verde por cegueira, que é a falha exata que este arquivo existe para evitar.
  //
  // O gêmeo executável destes asserts é db/test-preco-ausente-nao-e-zero.sh (PG17, 45 asserts,
  // com falsificação). Aqui é a camada de TEXTO; lá é a de comportamento.
  const fonte = (rel: string) => removerComentarios(readFileSync(rel, 'utf8'));

  const WRITERS_DE_ITEM_DE_PEDIDO = [
    'supabase/functions/omie-vendas-sync/index.ts',
    'supabase/functions/sync-reprocess/index.ts',
    'supabase/functions/_shared/omie-pedido.ts',
  ];

  it.each(WRITERS_DE_ITEM_DE_PEDIDO)('%s usa a régua precoUnitarioOmie (código, não comentário)', (rel) => {
    expect(fonte(rel)).toMatch(/precoUnitarioOmie\s*\(/);
  });

  it('nenhum writer fabrica preço de ITEM DE PEDIDO com `prod.valor_unitario || 0`', () => {
    // Específico de propósito: `prod.` é o item do `det` do Omie. O catálogo de PRODUTO
    // (omie_products.valor_unitario) tem o mesmo `|| 0` e NÃO é esta fatia — um regex solto em
    // `valor_unitario || 0` casaria com ele e daria verde sem medir nada desta correção.
    for (const rel of WRITERS_DE_ITEM_DE_PEDIDO) {
      expect(fonte(rel)).not.toMatch(/prod\.valor_unitario\s*\|\|\s*0/);
    }
  });

  it('a RPC de ingestão parou de fazer coalesce(unit_price, 0) e a coluna aceita NULL', () => {
    const mig = readFileSync('supabase/migrations/20260905225613_preco_ausente_nao_e_zero.sql', 'utf8');
    expect(mig).toMatch(/ALTER COLUMN unit_price DROP NOT NULL/);
    expect(mig).toMatch(/ALTER COLUMN unit_price DROP DEFAULT/);
    // a régua nova, e a ausência da velha, no corpo que a migration instala
    expect(mig).toMatch(/\(it->>'unit_price'\)::numeric >= 0/);
    expect(mig).not.toMatch(/coalesce\(\(it->>'unit_price'\)::numeric, 0\),/);
  });

  it('o backfill de cor MESCLA o preço em vez de sobrescrever o gravado', () => {
    // O bloco reconstrói sales_orders.items inteiro a partir da leitura ATUAL do Omie. Sem a
    // mescla, uma leitura sem `valor_unitario` APAGARIA um preço bom já gravado.
    const src = fonte('supabase/functions/omie-vendas-sync/index.ts');
    expect(src).toMatch(/mesclarPrecoPreservado\s*\(/);
    expect(src).not.toMatch(/update\(\{\s*items:\s*bfItems\s*\}\)/);
  });
});
