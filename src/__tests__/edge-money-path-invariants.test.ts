import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// repo root: src/__tests__ → src → repo (2 níveis).
const CWD = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(CWD, rel), 'utf8');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

// ── Guard de invariante money-path dos EDGES (Deno, fora do typecheck/vitest do src) ──
// Por que TEXTUAL: edge function roda no Lovable Cloud; o deploy via chat pode REVERTER um
// fix mergeado e COMMITAR a reversão na `main` como "Changes" (mordido 2026-06-26: o fallback
// do analyze #1077 voltou a override no deploy; re-aplicado #1080 — ver docs/agent/deploy.md).
// Este teste roda no CI (`validate`) e FALHA se o invariante sumir da `main` → a reversão do
// bot fica visível em vez de mascarada. NÃO substitui a canária de comportamento, só a fonte.

const ANALYZE = 'supabase/functions/analyze-unified-order/index.ts';
const AUDIT = 'supabase/functions/algorithm-a-audit/index.ts';
const HELPER = 'src/lib/pricing/mergeCustomerPrices.ts';

// Extrai o bloco espelhado entre os marcadores-COMENTÁRIO `// MIRROR-START`/`// MIRROR-END` e
// normaliza (remove `export `, comentários e whitespace) para comparar o helper de src/ × a cópia
// no edge. O `// ` ancora no comentário-marcador real (a prosa de JSDoc menciona o token sem `//`).
function mirrorBlock(s: string): string {
  const m = s.match(/\/\/ MIRROR-START[^\n]*\n([\s\S]*?)\n[^\n]*\/\/ MIRROR-END/);
  if (!m) throw new Error('bloco // MIRROR-START.../END não encontrado');
  return m[1]
    .replace(/\bexport\s+/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .join('\n');
}

// O merge de preço (order_items vence, Omie só preenche gap) foi extraído para um helper puro
// (src/lib/pricing/mergeCustomerPrices.ts, testado por vitest) e ESPELHADO verbatim no edge,
// porque o Deno do edge não importa de src/. Estes testes provam que o edge USA o helper (não
// só que tem os gates) e que a cópia NÃO divergiu — a canária {canary:true} fecha o ciclo
// provando o comportamento DEPLOYADO. Ver docs/agent/money-path.md (§ "Helper espelhado").
describe('guardrail money-path: analyze-unified-order USA o helper de merge de preço', () => {
  const src = read(ANALYZE);
  const helper = read(HELPER);

  it('sentinela: leu os arquivos reais (edge + helper)', () => {
    expect(src).toContain('priceMap');
    expect(src).toContain('mergeCustomerPrices');
    expect(helper).toContain('mergeCustomerPrices');
  });

  it('o helper puro existe e exporta mergeCustomerPrices + isValidUnitPrice', () => {
    expect(helper).toMatch(/export function mergeCustomerPrices/);
    expect(helper).toMatch(/export function isValidUnitPrice/);
  });

  it('o edge USA o helper: define o espelho E o chama (não só define)', () => {
    expect(src, 'edge não define mais o helper espelhado').toMatch(/function mergeCustomerPrices/);
    expect(src, 'REGRESSÃO: edge não chama mais mergeCustomerPrices — voltou à lógica inline?')
      .toMatch(/priceMap\s*=\s*mergeCustomerPrices\(/);
    expect(
      count(src, 'mergeCustomerPrices'),
      'helper deve ser DEFINIDO e CHAMADO (≥2 menções)',
    ).toBeGreaterThanOrEqual(2);
  });

  it('PARIDADE: o bloco espelhado no edge é IDÊNTICO ao helper de src/ (pega reversão do Lovable)', () => {
    expect(
      mirrorBlock(src),
      'edge divergiu do helper de src/ — o Lovable reescreveu o merge no deploy?',
    ).toBe(mirrorBlock(helper));
  });

  it('Omie é FALLBACK, não override: o helper preserva o gate de gap `!(… in priceMap)`', () => {
    expect(
      mirrorBlock(helper),
      'sumiu o gate de gap — Omie voltaria a sobrescrever order_items (override)',
    ).toMatch(/!\(\s*\w+\s+in\s+priceMap\s*\)/);
    expect(src).not.toContain('// Omie overrides local');
  });

  it('NÃO lê sales_price_history no price path (lê order_items, fonte de verdade)', () => {
    expect(src).not.toContain('from("sales_price_history")');
    expect(src).not.toContain("from('sales_price_history')");
  });

  it('canária comportamental {canary:true} prova o merge DEPLOYADO (123 local vence 999 Omie)', () => {
    expect(src, 'canária {canary:true} ausente — sem prova do comportamento deployado').toContain('canary');
    expect(src, 'canária sem o valor esperado 123 — não prova local-vence-Omie').toMatch(/expected[^0-9]*123/);
  });
});

describe('guardrail money-path: algorithm-a-audit (margem)', () => {
  const src = read(AUDIT);

  it('sentinela: leu o arquivo real do edge', () => {
    expect(src).toContain('bestPriceMap');
    expect(src).toContain('margin_audit_log');
  });

  it('bestPriceMap (potencial) só de pedidos praticados: filtra excludedOrderIds', () => {
    expect(
      src,
      'o filtro de praticados sumiu do bestPriceMap — orçamento de preço absurdo voltaria a inflar margin_potential',
    ).toContain('excludedOrderIds.has(sp.sales_order_id)');
  });

  it('margem real só de pedidos praticados: filtra excludedOrderIds no agrupamento', () => {
    expect(
      src,
      'o filtro de praticados sumiu do recentOrders — orçamento absurdo voltaria a inflar margin_real',
    ).toContain('excludedOrderIds.has(oi.sales_order_id)');
  });

  it('bestPriceMap lê order_items (não a sph poluída)', () => {
    expect(src).toContain("'order_items', 'product_id, unit_price, sales_order_id'");
  });
});
