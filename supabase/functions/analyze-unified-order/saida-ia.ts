// Guards money-path da SAÍDA da IA — puros, sem import remoto (rodam sob
// `deno test --no-remote`, o `test:edges` do CI).
//
// Por que existe: forced tool-use garante que a ferramenta É USADA, não que os
// tipos declarados no `input_schema` sejam respeitados — isso só com
// `strict: true`. O gateway antigo era igualmente permissivo, então esta é uma
// trava de FRONTEIRA (a edge é o ponto por onde todo esse dado passa), não uma
// regressão da migração.
//
// Os caminhos concretos que fecha, confirmados no código consumidor:
//   - `unit_price: "12.50"` (string) passa em `preco > 0` por coerção do JS,
//     entra no carrinho como string e explode no `.toFixed(2)` do checkout;
//   - `quantity: "2"` faz `1 + "2"` virar `"12"` ao somar com item existente —
//     uma quantidade FABRICADA que ninguém digitou.

/**
 * Número utilizável a partir da saída da IA.
 * Aceita number finito e string numérica LIMPA ("12.50"). Rejeita o ambíguo
 * ("12,50", "R$ 12,50", "", "doze") — precisão > recall: preço que não dá para
 * ler sem adivinhar não vira preço.
 */
export function numeroFinito(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  if (typeof valor === "string") {
    const texto = valor.trim();
    if (!/^-?\d+(\.\d+)?$/.test(texto)) return null;
    const n = Number(texto);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Preço só entra se for número positivo. Inválido devolve `undefined` para o
 * caller REMOVER o campo — aí o frontend cai no preço de tabela (`usouTabela`),
 * que é o fallback correto. Nunca 0: ausente ≠ zero.
 */
export function precoValido(valor: unknown): number | undefined {
  const n = numeroFinito(valor);
  return n !== null && n > 0 ? n : undefined;
}

/**
 * Quantidade inválida/ausente vira 1 — o default DECLARADO no schema da tool
 * ("Quantidade (padrão 1)"), não um número inventado. Fracionário é preservado
 * (litro/kg são quantidades legítimas). O vendedor revisa antes de fechar.
 */
export function quantidadeValida(valor: unknown): number {
  const n = numeroFinito(valor);
  return n !== null && n > 0 ? n : 1;
}

/**
 * Normaliza UM item vindo da IA. Devolve `null` para o que não é objeto —
 * string solta ou number no array não vira item de pedido.
 */
export function sanitizarItemIA(cru: unknown): Record<string, unknown> | null {
  if (!cru || typeof cru !== "object" || Array.isArray(cru)) return null;
  const item = { ...(cru as Record<string, unknown>) };

  // Sempre presente e numérico: `undefined` viraria NaN ao somar no carrinho.
  item.quantity = quantidadeValida(item.quantity);

  const preco = precoValido(item.unit_price);
  if (preco === undefined) delete item.unit_price;
  else item.unit_price = preco;

  if ("omie_codigo_servico" in item) {
    const cod = numeroFinito(item.omie_codigo_servico);
    if (cod === null) delete item.omie_codigo_servico;
    else item.omie_codigo_servico = cod;
  }

  return item;
}

/** Aplica `sanitizarItemIA` na lista; entrada não-array degrada para []. */
export function sanitizarListaIA(bruto: unknown): Record<string, unknown>[] {
  if (!Array.isArray(bruto)) return [];
  const out: Record<string, unknown>[] = [];
  for (const cru of bruto) {
    const item = sanitizarItemIA(cru);
    if (item) out.push(item);
  }
  return out;
}

export type ResultadoToolUse =
  | { ok: true; input: unknown }
  | { ok: false; motivo: "ausente" | "multiplo"; quantidade: number };

/**
 * Exige EXATAMENTE um bloco `tool_use`.
 *
 * `tool_choice: {type:"tool"}` sozinho NÃO desliga chamada paralela — o modelo
 * pode emitir um bloco por grupo de itens/foto. Pegar só o primeiro entregaria
 * pedido PARCIAL com cara de completo, que é a falha money-path clássica.
 * O caller manda `disable_parallel_tool_use: true`; este guard é a rede.
 */
export function extrairToolUseUnico(
  blocos: ReadonlyArray<{ type: string; input?: unknown }>,
): ResultadoToolUse {
  const usos = blocos.filter((b) => b?.type === "tool_use");
  if (usos.length === 0) return { ok: false, motivo: "ausente", quantidade: 0 };
  if (usos.length > 1) {
    return { ok: false, motivo: "multiplo", quantidade: usos.length };
  }
  return { ok: true, input: usos[0].input };
}
