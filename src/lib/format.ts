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
 * Janela da margem por cliente: desde 2026-10-09, `private.margem_cliente_agregada()` só agrega
 * itens de pedidos dos ÚLTIMOS 12 MESES móveis — o custo (`product_costs`) é o ATUAL, e aplicá-lo
 * a preço de venda de anos atrás deprimia a margem (~5 p.p.). Toda legenda de margem cita a janela,
 * senão quem lê assume "histórico inteiro" (docs/historico/farmer-margem-cobertura-custo.md).
 */
const JANELA_MARGEM_ROTULO = 'últimos 12 meses';
const JANELA_MARGEM_DIAS = 365;

/**
 * Por que o cliente não tem margem, quando o motivo é a JANELA: nenhuma compra nos últimos 12 meses.
 * Lê `days_since_last_purchase` (MEDIDO pelo calculate-scores; 999 = sem compra registrada) — é o
 * que permite afirmar o motivo em vez de mostrar "—". Dias ausente/não-finito → null (não afirma nada).
 */
export function legendaMargemSemCompraNaJanela(diasSemCompra: number | null | undefined): string | null {
  if (diasSemCompra == null || !Number.isFinite(diasSemCompra)) return null;
  return diasSemCompra > JANELA_MARGEM_DIAS ? `sem compra nos ${JANELA_MARGEM_ROTULO}` : null;
}

/**
 * Legenda da cobertura de custo de UM cliente, para acompanhar a margem na tela:
 * "3 de 40 linhas c/ custo (últimos 12 meses)". Sem ela, "53%" parece apurado sobre o cliente inteiro.
 *
 * ⚠️ São LINHAS de item de pedido, não unidades nem receita — e a margem é ponderada por RECEITA.
 * "3 de 40" pode cobrir 99% do faturamento, e "39 de 40" pode omitir justamente a linha grande.
 * Por isso a palavra é "linhas", nunca "itens"/"produtos" (que soariam como fração da compra), e
 * quem exibe deve acompanhar de `DICA_COBERTURA_LINHAS`.
 *
 * Mora em `format` (plataforma) e não em `lib/scoring/margin` por fronteira de módulo: o admin-crm
 * exibe e não pode depender de farmer-inteligencia. A entrada é estrutural — quem lê o banco
 * normaliza com `coberturaCustoCliente` (margin.ts) antes de chegar aqui.
 *
 * ausente≠zero: cobertura não computada (qualquer lado null) → null, jamais "0 de 0". O 0 de
 * `itensComCusto` com total > 0 é VEREDITO ("nenhuma de 40 linhas c/ custo") e aparece.
 */
export function legendaCoberturaItens({ itensComCusto, itensSemCusto }: {
  itensComCusto: number | null; itensSemCusto: number | null;
}): string | null {
  if (itensComCusto == null || itensSemCusto == null) return null;
  const total = itensComCusto + itensSemCusto;
  if (total === 0) return null;
  const linhas = total === 1 ? 'linha' : 'linhas';
  const totalFmt = total.toLocaleString('pt-BR');
  const janela = `(${JANELA_MARGEM_ROTULO})`;
  if (itensComCusto === 0) return `nenhuma de ${totalFmt} ${linhas} c/ custo ${janela}`;
  return `${itensComCusto.toLocaleString('pt-BR')} de ${totalFmt} ${linhas} c/ custo ${janela}`;
}

/** Tooltip que acompanha a legenda: impede ler contagem de linhas como cobertura de receita. */
export const DICA_COBERTURA_LINHAS =
  'Contagem de LINHAS de pedido com custo conhecido — não é fração da receita. A margem é ' +
  'ponderada por valor: poucas linhas podem cobrir quase todo o faturamento, e o contrário também. ' +
  `Só entram pedidos dos ${JANELA_MARGEM_ROTULO}: o custo cadastrado é o atual e não vale para preço antigo.`;

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
