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
 * ⚠️ Esta função é a metade PERCENTUAL de um par. A outra é `formatarFracaoPct` (em
 * components/customer360/format), que recebe FRAÇÃO 0–1 e multiplica por 100. Escolha pela
 * unidade da origem — as duas juntas substituíram um único formatador que adivinhava
 * (`formatPctMaybe`, com `v > 1 ? v : v * 100`) e por isso errava nos extremos de ambos os lados:
 * margem abaixo de 1% virava "50%", margem negativa virava "−14322%", e fração acima de 1 saía
 * com duas ordens de grandeza a menos.
 *
 * `null` → "—" (não medida), nunca "0%", que afirmaria margem nula apurada.
 */
export function formatMargemPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const rounded = Math.round(v);
  return Math.abs(v - rounded) < 0.05 ? `${rounded}%` : `${v.toFixed(1)}%`;
}

/**
 * Preço em BRL, ou "—" quando NÃO SABIDO. Irmã monetária de `formatMargemPct`.
 *
 * Existe porque o preço do item de pedido passou a poder ser `null`: o Omie nem sempre informa
 * `valor_unitario`, e até 2026-09-05 os writers do sync gravavam `|| 0` — "não sei" e "de graça"
 * viravam o mesmo R$ 0,00 na tela. Fechada a origem (`order_items.unit_price` nullable + a régua
 * na RPC de ingestão), o `null` chega até aqui, e é ele que a tela precisa saber mostrar.
 *
 * ⚠️ `0` NÃO é ausência: um zero gravado é fato ("o Omie informou zero" — bonificação/brinde) e
 * sai formatado como R$ 0,00. Só o desconhecido vira "—". Um `|| 0` no caller desfaz exatamente
 * a distinção que a fatia inteira existiu para criar.
 *
 * Não-finito (NaN/Infinity) também vira "—": é lixo, não número.
 */
export function formatPrecoOuAusente(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * Total de uma linha (quantidade × preço), ou `null` quando o preço é NÃO SABIDO.
 *
 * `qtd * null` é `0` em JavaScript — a multiplicação silenciosamente inventa "linha de R$ 0,00".
 * Esta função é o guard: sem preço, não há total, e o caller mostra "—".
 */
export function totalLinhaOuAusente(
  quantidade: number | null | undefined,
  precoUnitario: number | null | undefined,
): number | null {
  if (precoUnitario === null || precoUnitario === undefined || !Number.isFinite(precoUnitario)) return null;
  const q = Number(quantidade ?? 1);
  if (!Number.isFinite(q)) return null;
  return q * precoUnitario;
}

/**
 * Preço utilizável, ou `null` quando NÃO SABIDO. Régua de FINITUDE NÃO-NEGATIVA.
 *
 *   ausente / null / '' / lixo / objeto / boolean → null
 *   negativo / NaN / Infinity                     → null  (corrupção, não dado)
 *   0                                             → 0     (zero INFORMADO é fato)
 *   número ou string numérica                     → o número
 *
 * Mora na PLATAFORMA de propósito. A mesma régua existe em `valorMedido`
 * (`@/lib/scoring/margin`, módulo farmer-inteligencia) e em `precoUnitarioOmie`
 * (`_shared/omie-pedido.ts`, Deno), mas importar a versão do farmer a partir de vendas é
 * vazamento de fronteira — e registrar isso na baseline seria pagar dívida em vez de
 * resolvê-la. Difere de `valorMedido` num ponto que importa: aquele aceita qualquer finito,
 * inclusive NEGATIVO, e preço negativo não é desconto, é corrupção.
 *
 * Quem precisa de preço ESTRITAMENTE positivo (último preço praticado, base de margem)
 * acrescenta `> 0` no próprio call site — a decisão de excluir o zero é do consumidor, não
 * desta função, que só diz o que é número.
 *
 * Fail-closed contra os falsy que `Number` converte para 0: `Number('')`, `Number('  ')`,
 * `Number(false)` e `Number([])` são todos 0, e um deles virando "preço zero apurado" seria
 * a fabricação que este módulo existe para impedir.
 */
export function precoUtilizavel(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
