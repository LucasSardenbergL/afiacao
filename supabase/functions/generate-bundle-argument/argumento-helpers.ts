// Lógica PURA do gerador de argumentação de bundle: montagem do bloco de contexto do
// cliente que vai no prompt. Puro de propósito — `test:edges` roda com `--no-remote` e não
// resolve `npm:`/`jsr:`, então tudo que precisa de teste mora aqui e o index.ts só orquestra.
//
// MONEY-PATH — este módulo existe para um invariante só:
// a argumentação é lida por uma vendedora como análise DAQUELE cliente. Campo que ninguém
// mediu tem de chegar ao modelo como "não medido", nunca como número. `Number(null) === 0`,
// `?? 0` e `|| 0` são as portas de fabricação — e num prompt de TEXTO a porta é a
// interpolação: `R$ ${x || 0}` imprime "R$ 0", que o modelo lê como um valor apurado.
//
// Antes desta correção o bloco dizia "Gasto médio mensal: R$ 0" e "Categorias compradas: 0"
// para qualquer cliente cujo dado não tivesse chegado — e o modelo concluía "cliente pequeno,
// sensível a preço", que é uma abordagem comercial diferente da que o cliente merecia.

/** Rótulo único para ausência. Texto, não número — é o que impede o modelo de calcular com ele. */
export const NAO_MEDIDO = "não medido";

/**
 * Número FINITO ou null. Aceita number e string numérica (o contexto trafega em JSON e o
 * front às vezes manda `"12.5"`), e rejeita TODO o resto.
 *
 * ⚠️ A allowlist por `typeof` não é preciosismo — `Number()` coage silenciosamente vários
 * valores a 0: `Number("") === 0` (campo em branco viraria gasto medido de R$ 0) e
 * `Number([]) === 0` (payload malformado que traz array vazio no lugar do número, pego pelo
 * teste deste módulo). Testar `Number.isFinite` DEPOIS da coerção chega tarde: nesse ponto a
 * fabricação já aconteceu e o resultado é um zero de aparência perfeita.
 *
 * Espelha `numeroValido` de `generate-tactical-plan/plano-helpers.ts` e `valorMedido` de
 * `src/lib/scoring/margin.ts`.
 */
export function valorMedido(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.length === 0) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Texto não-vazio aparado, ou null. */
function textoOuNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Renderiza um número para o prompt: o valor quando medido, o rótulo textual quando não.
 * `prefixo`/`sufixo` só entram quando há número — "R$ não medido" seria pior que a ausência.
 */
export function campoNumerico(
  raw: unknown,
  { prefixo = "", sufixo = "" }: { prefixo?: string; sufixo?: string } = {},
): string {
  const n = valorMedido(raw);
  return n == null ? NAO_MEDIDO : `${prefixo}${n}${sufixo}`;
}

export interface ContextoCliente {
  name?: unknown;
  cnae?: unknown;
  customerType?: unknown;
  healthScore?: unknown;
  daysSinceLastPurchase?: unknown;
  avgMonthlySpend?: unknown;
  categoryCount?: unknown;
  recentProducts?: unknown;
}

/**
 * Bloco de contexto do cliente, compartilhado pelos dois modos (argument e
 * diagnostic_questions) — eram dois templates COPIADOS, e a fabricação vivia nos dois.
 *
 * ⚠️ `daysSinceLastPurchase` merece atenção contrária: o `|| 'N/A'` anterior engolia o **0
 * legítimo** (cliente que comprou HOJE) e o exibia como ausência — a mesma confusão
 * ausente↔zero, no sentido inverso. Aqui 0 é um fato e chega como "0".
 */
export function blocoCliente(customer: ContextoCliente): string {
  const produtos = Array.isArray(customer.recentProducts)
    ? customer.recentProducts.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : [];

  return [
    `Cliente: ${textoOuNull(customer.name) ?? NAO_MEDIDO}`,
    `Segmento/CNAE: ${textoOuNull(customer.cnae) ?? "Não informado"}`,
    `Tipo: ${textoOuNull(customer.customerType) ?? "Não informado"}`,
    `Health Score: ${campoNumerico(customer.healthScore, { sufixo: "/100" })}`,
    `Dias desde última compra: ${campoNumerico(customer.daysSinceLastPurchase)}`,
    `Gasto médio mensal: ${campoNumerico(customer.avgMonthlySpend, { prefixo: "R$ " })}`,
    `Categorias compradas: ${campoNumerico(customer.categoryCount)}`,
  ].join("\n") + `\n\nHistórico de compras recentes: ${produtos.length > 0 ? produtos.join(", ") : "Sem dados"}`;
}

/**
 * Instrução de dado ausente para o system prompt. Sem ela o rótulo "não medido" chega ao
 * modelo sem contrato e ele preenche a lacuna sozinho — trocar o número fabricado por uma
 * palavra só move a fabricação de camada. Espelha REGRA_DADO_AUSENTE de
 * `generate-tactical-plan/plano-helpers.ts`.
 */
export const REGRA_DADO_AUSENTE =
  `DADO AUSENTE: um campo com o valor "${NAO_MEDIDO}" significa NÃO MEDIDO — não é zero, não é
valor baixo e não é sinal de cliente pequeno. NUNCA estime, preencha ou infira um número para ele,
e não construa argumento econômico sobre ele. Em especial, "Gasto médio mensal: ${NAO_MEDIDO}" NÃO
autoriza tratar o cliente como sensível a preço. Se um argumento seu dependeria de um dado não
medido, escreva o argumento sem número em vez de inventar um valor plausível. Um número inventado
que chega à vendedora como medido é pior do que a ausência do dado.`;
