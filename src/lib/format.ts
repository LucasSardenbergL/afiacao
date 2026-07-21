/**
 * Pequenos helpers de formatação compartilhados.
 *
 * IMPORTANTE: máscara de documento existe para LGPD — nunca logue CPF/CNPJ
 * inteiro em logs de aplicação. Use `maskDocument()` antes de passar para o
 * logger.
 */

/**
 * Mascara um CPF/CNPJ preservando os 4 primeiros dígitos e os 2 últimos.
 * Útil para logs e analytics: permite identificar aproximadamente o cliente
 * sem expor o documento completo.
 *
 * @example
 *   maskDocument('123.456.789-00') → '1234***00'
 *   maskDocument('12.345.678/0001-99') → '1234***99'
 *   maskDocument('123') → '***'
 *   maskDocument('') → '***'
 */
export function maskDocument(doc: string | null | undefined): string {
  if (!doc) return '***';
  const clean = doc.replace(/\D/g, '');
  if (clean.length < 6) return '***';
  return clean.slice(0, 4) + '***' + clean.slice(-2);
}

/**
 * Decodifica entidades HTML que vieram salvas em texto livre no banco
 * (ex.: nomes de clientes importados de fontes que escaparam apóstrofos
 * para `&apos;`, ampersand para `&amp;`, etc.). React por segurança não
 * decoda entidades automaticamente — então sem essa função, um nome como
 * `&apos;PALLET&apos;S EMBALAR&apos;` aparece literal na tela em vez de
 * `'PALLET'S EMBALAR'`.
 *
 * Implementação usa o próprio parser do navegador (`textarea.innerHTML`),
 * que cobre todas as ~2000 entidades HTML5 + numéricas (`&#39;`, `&#x27;`).
 * Como é Set-then-Get em um elemento DESCONECTADO do DOM, não há risco de
 * XSS — nenhum script é executado mesmo se a string tiver `<script>`.
 *
 * @example
 *   decodeHtmlEntities('&apos;PALLET&apos;S EMBALAR&apos;') → "'PALLET'S EMBALAR'"
 *   decodeHtmlEntities('Caf&eacute; &amp; Cia') → 'Café & Cia'
 *   decodeHtmlEntities(null) → ''
 */
export function decodeHtmlEntities(text: string | null | undefined): string {
  if (!text) return '';
  if (typeof document === 'undefined') return text;
  if (!text.includes('&')) return text;
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
}

/**
 * Margem bruta em PERCENTUAL (0–100, negativos válidos), sem adivinhar unidade.
 *
 * `farmer_client_scores.gross_margin_pct` é percentual — é a convenção de `useTacticalPlan`
 * (`marginPct / 100`), `useBundleArguments` (compara com 20 e 35), das abas de Intelligence e da
 * própria `get_customer_margin_summary` (`round(… * 100, 2)`). Enquanto a coluna valia 0 em 100%
 * das linhas, nenhuma divergência de unidade aparecia; com a margem calculada no servidor, aparece.
 *
 * ⚠️ NÃO use `formatPctMaybe` (de components/customer360/format) para margem: a heurística
 * `v > 1 ? v : v * 100` de lá erra em dois casos que a margem produz de verdade — margem abaixo de
 * 1% (0,5 vira "50%") e margem NEGATIVA (−143,22, o mínimo medido em prod, vira "−14322%").
 *
 * `null` → "—" (não medida), nunca "0%", que afirmaria margem nula apurada.
 */
export function formatMargemPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const rounded = Math.round(v);
  return Math.abs(v - rounded) < 0.05 ? `${rounded}%` : `${v.toFixed(1)}%`;
}
