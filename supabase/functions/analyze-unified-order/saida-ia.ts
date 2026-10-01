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
//   - `quantity: "2"` faz `1 + "2"` virar `"12"` ao somar com item existente —
//     uma quantidade FABRICADA que ninguém digitou.
//
// PREÇO não é saneado aqui porque não SAI desta edge: a IA não precifica (ver
// `montarRespostaAnalise` abaixo, a fronteira de saída). O `unit_price: "12.50"`
// que este módulo já travou contra coerção deixou de ter consumidor.

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

// ─── Fronteira de SAÍDA: a IA não precifica ─────────────────────────────────
//
// O preço de nascimento de um item no carrinho tem UM decisor: o `precoPartida` do
// front (`getProductPrice`: último praticado ≤180d da RPC `get_ultimos_precos_cliente`
// → tabela×mult(tier) → tabela), para o cliente SELECIONADO. Enquanto esta edge mandava
// `unit_price`, o carrinho o aplicava VERBATIM e sem `precoNascimento` (nunca
// reprecificava), e eram dois decisores. Medido em prod (2026-09-30, 23.496 pares
// cliente×produto): com cliente já selecionado a edge nem buscava preço e saía o
// `unit_price` do LLM (que só via a TABELA no prompt) ou `match.valor_unitario` — até
// 2.571 pares em que o manual aplicaria o praticado ≤180d; com o cliente identificado
// pela IA saía o `order_items` cru + Omie de qualquer idade — 16.840 pares em que o
// manual aplicaria a tabela. Sem `unit_price`, o front já nasce o item pelo
// `getProductPrice` e marca `precoNascimento`.
//
// LISTA FECHADA, não "apaga unit_price": a garantia é sobre o que SAI, e uma lista de
// bloqueio só barra o nome que alguém lembrou (um `preco`/`price` alucinado, ou um campo
// novo de amanhã, vazaria). Campo fora daqui não sai — inclusive os que o LLM inventar.
// Os campos são exatamente os que o front lê (`src/components/unifiedAI/types.ts`).
export const CAMPOS_SAIDA_PRODUTO = [
  "product_id", "codigo", "descricao", "quantity", "account", "notes",
] as const;
export const CAMPOS_SAIDA_SERVICO = [
  "userToolId", "omie_codigo_servico", "servico_descricao", "quantity", "notes",
] as const;
export const CAMPOS_SAIDA_SUGESTAO = [
  "type", "product_id", "codigo", "descricao", "quantity", "account", "reason",
  "userToolId", "omie_codigo_servico", "servico_descricao",
] as const;

/** Copia só as chaves permitidas que vieram preenchidas — o resto (preço incluso) fica. */
export function apenasCampos(
  item: object,
  campos: ReadonlyArray<string>,
): Record<string, unknown> {
  const origem = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const campo of campos) {
    if (Object.prototype.hasOwnProperty.call(origem, campo) && origem[campo] !== undefined) {
      out[campo] = origem[campo];
    }
  }
  return out;
}

export interface RespostaAnalise {
  products: Record<string, unknown>[];
  services: Record<string, unknown>[];
  suggestions: Record<string, unknown>[];
  customer: unknown;
  imagens_rejeitadas: unknown;
  message: string;
}

/**
 * Monta o corpo de resposta do fluxo real — e da canária, que chama ESTA função com fixture
 * (a canária prova o bundle servido; o guard textual do vitest prova que o fluxo real passa
 * por aqui). Toda via até o JSON cruza este ponto.
 */
export function montarRespostaAnalise(entrada: {
  products: ReadonlyArray<object>;
  services: ReadonlyArray<object>;
  suggestions: ReadonlyArray<object>;
  customer: unknown;
  imagens_rejeitadas: unknown;
  message: string;
}): RespostaAnalise {
  return {
    products: entrada.products.map((p) => apenasCampos(p, CAMPOS_SAIDA_PRODUTO)),
    services: entrada.services.map((s) => apenasCampos(s, CAMPOS_SAIDA_SERVICO)),
    suggestions: entrada.suggestions.map((s) => apenasCampos(s, CAMPOS_SAIDA_SUGESTAO)),
    customer: entrada.customer,
    imagens_rejeitadas: entrada.imagens_rejeitadas,
    message: entrada.message,
  };
}

/**
 * VERSION MARKER da canária de preço (docs/agent/deploy.md §Canárias). Quem o exige é o card de
 * Governança — `CONTRATO_ESPERADO` em `src/lib/governanca/canaria-preco.ts`, código do FRONT —, então
 * a troca só discrimina com o Publish E o deploy desta edge. Até a v1.3 o contrato era
 * `praticado-vence-omie-v1` (o merge saiu da edge; o objeto atestado mudou, não é bump de fatia).
 * ⚠️ Bump a cada fatia que mude o que a canária atesta (`bun run canaria:bump`).
 */
export const CONTRATO_CANARIA_PRECO = "ia-nao-precifica-v1";

export interface RespostaCanariaPreco {
  canary: true;
  contrato: string;
  precos_na_saida: number;
  itens_na_saida: number;
  ok: boolean;
}

/**
 * Canária `{canary:true}`: roda a fronteira de saída sobre uma fixture cujos itens TRAZEM preço — o
 * `unit_price` que o LLM devolvia e um `preco` alucinado — e exige que nenhum saia E que os itens saiam.
 *
 * Conta pelo NOME LITERAL da chave, não pelas listas `CAMPOS_SAIDA_*`: comparar a saída com a lista que
 * a produziu é tautológico (uma lista sabotada, com `unit_price` dentro, aprovaria a si mesma).
 * `itens_na_saida` fecha o outro lado: "zero preços porque zero itens" é o sempre-verde, não a propriedade.
 *
 * `montar` é injetável SÓ para o controle de calibração do teste (a forma velha tem de deixar a canária
 * vermelha); a edge chama sem argumento.
 */
export function canariaSemPreco(
  montar: typeof montarRespostaAnalise = montarRespostaAnalise,
): RespostaCanariaPreco {
  const saida = montar({
    products: [{ product_id: "CANARY", quantity: 1, account: "oben", unit_price: 999, preco: 999 }],
    services: [],
    suggestions: [
      { type: "product", product_id: "CANARY", descricao: "canária", reason: "canária", unit_price: 999 },
    ],
    customer: null,
    imagens_rejeitadas: [],
    message: "canária",
  });
  const itens = [...saida.products, ...saida.suggestions];
  const precosNaSaida = itens.reduce(
    (n, item) => n + Object.keys(item).filter((k) => /pre[cç]o|price/i.test(k)).length,
    0,
  );
  const itensNaSaida = itens.filter((item) => item.product_id === "CANARY").length;
  return {
    canary: true,
    contrato: CONTRATO_CANARIA_PRECO,
    precos_na_saida: precosNaSaida,
    itens_na_saida: itensNaSaida,
    ok: precosNaSaida === 0 && itensNaSaida === 2,
  };
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
