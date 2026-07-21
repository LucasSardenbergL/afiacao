/**
 * Contrato de leitura de `farmer_client_scores.gross_margin_pct`.
 *
 * Mora na PLATAFORMA — e não em `src/lib/scoring/` — porque a coluna é lida por dois
 * módulos de negócio distintos (`farmer-inteligencia` e `admin-crm`), e a regra de
 * fronteira do CI só isenta imports de plataforma (`src/lib/modulos/fronteiras.ts`).
 * Aqui vive só a MECÂNICA, que é fato do schema; a POLÍTICA (thresholds de cor, média
 * da carteira) vive em `src/lib/scoring/margem-leitura.ts`, no negócio.
 *
 * Não confundir com `src/lib/scoring/margin.ts`: aquele CALCULA margem a partir de itens
 * de pedido (o cálculo do browser, espelhado no servidor pela RPC do #1495). Este LÊ a
 * coluna já calculada.
 *
 * ## Escala: sempre 0–100
 *
 * A fonte é a RPC `get_customer_margin_summary()`, que já multiplica por 100 no SQL
 * (média medida em prod: 53,47%; p50 56,39%; faixa −143,22% a 88,33%).
 *
 * Aqui NÃO há heurística de normalização, de propósito. `formatPctMaybe`
 * (`src/components/customer360/format.ts`) adivinha a escala com `v > 1 ? v : v * 100`,
 * e por isso transforma uma margem real de 0,8% em 80%. Aquela heurística é legítima lá,
 * onde a escala da entrada é genuinamente ambígua (taxas de conversão vindas de fontes
 * variadas). Aqui a escala é CONHECIDA — adivinhar seria introduzir o bug, não evitá-lo.
 *
 * ## Ausente ≠ zero
 *
 * Margem desconhecida é `null`, jamais 0. Zero é um veredito ("cliente sem margem");
 * `null` é ausência de dado. O #1495 grava `null` para os 162 clientes sem custo
 * conhecido, e `Number(null) === 0` fabricaria o veredito a partir da ausência.
 *
 * Margem NEGATIVA é dado real (cliente vendido no prejuízo) e passa intacta.
 */

const PCT = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

/**
 * Lê a margem em escala 0–100, ou `null` se desconhecida.
 *
 * Fail-closed: qualquer entrada que não seja número finito ou string numérica vira `null`.
 * String vazia é `null` e não 0 — `Number('') === 0` fabricaria margem zero a partir de
 * uma célula em branco.
 *
 * @example
 *   lerMargemPct(53.47)  → 53.47
 *   lerMargemPct('53.47')→ 53.47   // PostgREST devolve numeric como string
 *   lerMargemPct(-143.22)→ -143.22 // prejuízo é dado real
 *   lerMargemPct(null)   → null
 *   lerMargemPct('')     → null    // NÃO 0
 *   lerMargemPct(NaN)    → null
 */
export function lerMargemPct(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Formata a margem para exibição, em pt-BR. Ausente vira travessão — nunca "0%",
 * que o leitor entenderia como "este cliente não dá margem".
 *
 * @example
 *   formatarMargemPct(53.47)   → '53,5%'
 *   formatarMargemPct(0.8)     → '0,8%'   // e não '80%'
 *   formatarMargemPct(-143.22) → '-143,2%'
 *   formatarMargemPct(0)       → '0%'
 *   formatarMargemPct(null)    → '—'
 */
export function formatarMargemPct(v: unknown): string {
  const n = lerMargemPct(v);
  return n === null ? '—' : `${PCT.format(n)}%`;
}
