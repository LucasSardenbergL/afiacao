/**
 * Margem utilizável, ou `null` se desconhecida.
 *
 * `farmer_client_scores.gross_margin_pct` era `0` LITERAL em 6.632/6.632 linhas (com
 * `column_default = 0`), então `?? 0` e `|| 0` nunca disparavam e o problema ficava invisível.
 * Com a margem calculada no servidor (#1495), **5.579 de 6.632 linhas (84,1%) passam a ser
 * `NULL`** — e aí cada `|| 0` vira uma afirmação de negócio sobre a maioria da base.
 *
 * ⚠️ `0` é CONHECIDO (margem nula apurada, um veredito: "cliente não-lucrativo"). Só
 * null/undefined/NaN/Infinity são ausência. Confundir os dois é o erro que este helper existe
 * para impedir.
 *
 * ⚠️ Em comparação relacional o guard é obrigatório: `null < 20` é `true` em JS (null coage a
 * 0), então `if (margem < 20)` sem checar null classifica como "margem baixa" justamente quem
 * não foi medido.
 *
 * Espelhado em `supabase/functions/_shared/tactical-margem.ts` (Deno não importa de `src/`).
 */
export function margemConhecida(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Média das margens conhecidas, ou `null` se nenhuma for conhecida.
 *
 * Existe como função própria porque a forma errada é sedutora: filtrar o numerador e esquecer
 * o denominador (`soma(conhecidas) / total`) devolve um número plausível e sistematicamente
 * baixo — pior que um erro visível, porque não parece errado. Aqui numerador e denominador
 * saem da MESMA lista filtrada.
 */
export interface CoberturaMargem {
  /** Quantos clientes têm margem CONHECIDA (0 conta; ausente e não-finito não). */
  comMargem: number;
  /** Tamanho da lista avaliada. */
  total: number;
}

/**
 * Cobertura da amostra por trás de uma média de margem.
 *
 * Companheira obrigatória de `mediaMargensConhecidas`: ela devolve a conta certa, mas um
 * número sozinho não diz sobre QUANTOS clientes foi feito. Com ~84% da base sem margem
 * apurada (pós-#1495), a mesma "margem média" pode descrever a carteira inteira ou um sexto
 * dela, e a tela precisa dizer qual (money-path: no silent caps).
 */
export function coberturaMargem(valores: Iterable<unknown>): CoberturaMargem {
  let comMargem = 0;
  let total = 0;
  for (const v of valores) {
    total++;
    if (margemConhecida(v) != null) comMargem++;
  }
  return { comMargem, total };
}

/** Legenda pronta para acompanhar o KPI. Sem isso, quem lê assume "todos os clientes". */
export function legendaCobertura({ comMargem, total }: CoberturaMargem): string {
  if (total === 0) return 'sem clientes';
  if (comMargem === 0) return 'nenhum cliente c/ margem conhecida';
  const cobertos = comMargem.toLocaleString('pt-BR');
  if (comMargem === total) return `${cobertos} clientes c/ margem`;
  return `parcial — ${cobertos} de ${total.toLocaleString('pt-BR')} clientes c/ margem`;
}

/**
 * Cobertura de custo POR CLIENTE — quantos itens de pedido dele têm custo conhecido, e quantos não.
 * É a CONFIANÇA por trás do `gross_margin_pct` do cliente: "53% sobre 3 de 40 itens" e "53% sobre
 * 40 de 40" são vereditos opostos. A RPC `get_customer_margin_summary` já retorna as duas contagens
 * (`itens_com_custo`/`itens_sem_custo`), mas o writer `calculate-scores` as descartava.
 *
 * ⚠️ ausente≠zero: cliente FORA do resultado da RPC (sem item de pedido elegível — 97% dos sem-margem,
 * ver docs/historico/farmer-margem-cobertura-custo.md) → `{ null, null }`, NUNCA `{ 0, 0 }`. O 0 é o
 * veredito "tem itens, nenhum com custo" (categoria D do doc), que é dado; "não computado" é ausência.
 * `Number(...)` não-finito degrada para null — jamais fabrica contagem.
 *
 * Espelhado inline em `supabase/functions/calculate-scores/index.ts` (Deno não importa de `src/`).
 */
export interface CoberturaCustoCliente {
  /** Itens com custo conhecido (base do gross_margin_pct). null = cobertura não computada. */
  itensComCusto: number | null;
  /** Itens sem custo conhecido (excluídos do gross_margin_pct). null = cobertura não computada. */
  itensSemCusto: number | null;
}

export function coberturaCustoCliente(
  row: { itens_com_custo?: unknown; itens_sem_custo?: unknown } | null | undefined,
): CoberturaCustoCliente {
  if (row == null) return { itensComCusto: null, itensSemCusto: null };
  return {
    itensComCusto: contagemFinita(row.itens_com_custo),
    itensSemCusto: contagemFinita(row.itens_sem_custo),
  };
}

/**
 * Contagem utilizável (inteiro ≥ 0) ou null. bigint via PostgREST pode vir string → `Number`.
 *
 * Fail-closed de propósito, e NÃO `Number.isFinite` puro: `Number('')`, `Number('  ')`,
 * `Number(false)` e `Number([])` são todos **0** — lixo viraria o veredito "medi e deu zero",
 * exatamente a fabricação que este módulo existe para impedir. Fração/negativo/acima de 2^53 são
 * violação do contrato de `count(*)` → null, e assim nunca alcançam o `::bigint` da RPC (onde um
 * `3.5` derrubaria o batch inteiro com 22P02). [endurecido após challenge adversarial /codex]
 */
function contagemFinita(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function mediaMargensConhecidas(valores: Iterable<unknown>): number | null {
  const conhecidas: number[] = [];
  for (const v of valores) {
    const m = margemConhecida(v);
    if (m != null) conhecidas.push(m);
  }
  if (conhecidas.length === 0) return null;
  return conhecidas.reduce((s, m) => s + m, 0) / conhecidas.length;
}

interface MarginItem {
  product_id?: string;
  omie_codigo_produto?: number | string;
  quantity?: number | string;
  quantidade?: number | string;
  unit_price?: number | string;
  valor_unitario?: number | string;
}

/**
 * Resolve o UUID do produto a partir do item de pedido.
 *
 * O jsonb de `sales_orders.items` em produção é pt-BR e traz `omie_codigo_produto`, NÃO
 * `product_id` (medido 2026-07-20: 46.396 de 46.396 itens com omie_codigo, ZERO com
 * product_id). Ler só `product_id` descartava todos os itens em silêncio. Mesmo fallback
 * que useCrossSellEngine e useBundleEngine já aplicam.
 */
function resolveProductId(
  item: MarginItem,
  omieToProductId?: Map<number, string>,
): string | undefined {
  if (item.product_id) return item.product_id;
  if (item.omie_codigo_produto == null || !omieToProductId) return undefined;
  return omieToProductId.get(Number(item.omie_codigo_produto));
}

/**
 * Acumula receita e custo de itens de pedido para o cálculo de margem do cliente,
 * contando SOMENTE os SKUs com custo conhecido no `costMap`.
 *
 * SKU sem custo é EXCLUÍDO (receita e custo) em vez de virar custo 0 — senão a margem
 * bruta infla silenciosamente (ausente ≠ zero, money-path). O cliente que só compra SKU
 * sem custo fica com receita/custo 0 → margem indefinida (não 100%).
 *
 * `omieToProductId` mapeia omie_codigo_produto → UUID; sem ele, itens que só têm o código
 * Omie (a maioria absoluta em produção) são descartados.
 */
export function accumulateMarginFromItems(
  items: MarginItem[],
  costMap: Map<string, number>,
  omieToProductId?: Map<number, string>,
): { revenue: number; cost: number } {
  let revenue = 0;
  let cost = 0;
  for (const item of items) {
    const productId = resolveProductId(item, omieToProductId);
    if (!productId) continue;
    const c = costMap.get(productId);
    if (c == null) continue;
    const qty = Number(item.quantity || item.quantidade || 1);
    const price = Number(item.unit_price || item.valor_unitario || 0);
    revenue += price * qty;
    cost += c * qty;
  }
  return { revenue, cost };
}

/**
 * SKUs distintos de um pedido, para a diversidade de mix (componente X do health score).
 * Mesma resolução pt-BR do cálculo de margem — ler só `product_id` zerava o X de todo cliente.
 */
export function resolveProductIdsFromItems(
  items: MarginItem[],
  omieToProductId?: Map<number, string>,
): string[] {
  const ids: string[] = [];
  for (const item of items) {
    const productId = resolveProductId(item, omieToProductId);
    if (productId) ids.push(productId);
  }
  return ids;
}
