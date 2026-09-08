// Desconto de ITEM de pedido de venda — a régua ÚNICA, dos dois lados: o que se LÊ do Omie na
// ingestão e o que se CALCULA a partir da coluna `order_items.discount` no consumo.
//
// ── Por que este módulo existe ────────────────────────────────────────────────────────────────
// O campo tinha DUAS semânticas em produção ao mesmo tempo, sobre o MESMO dado. Com qtd=2,
// preço=100, desconto=10, `omie-vendas-sync` calculava 180 (percentual) e `fin-valor-cockpit`
// 190 (absoluto). Ninguém viu porque a coluna é 0 em 100% do acervo — e o zero, medido em
// 2026-09-07, é CEGUEIRA, não medição: a ingestão lia `prod.desconto`, chave que a API do Omie
// NUNCA envia.
//
// ── O contrato REAL do Omie (medido, não suposto) ─────────────────────────────────────────────
// Doc oficial lida em 2026-09-07 (GET https://app.omie.com.br/api/v1/produtos/pedido/). A
// entidade `det.produto` expõe TRÊS campos de desconto — e `desconto` pelado não é nenhum deles
// (`grep -c '^desconto$'` na doc inteira = 0):
//
//   tipo_desconto        string(1)  discriminador — "V" = valor, "P" = percentual
//   percentual_desconto  decimal    percentual (0-100)
//   valor_desconto       decimal    valor em moeda
//
// Ou seja: a pergunta "percentual ou absoluto?" estava MAL-POSTA. O Omie manda os dois e diz
// qual vale. Nenhuma das duas fórmulas em produção estava certa sozinha.
//
// A capa tem o trio irmão (`tipo_desconto_pedido`/`perc_desconto_pedido`/`valor_desconto_pedido`),
// mas não precisamos lê-lo: a doc afirma que desconto de capa é distribuído proporcionalmente
// para os itens e que, feita a distribuição, "os valores do desconto serão exibidos apenas nos
// itens". Ler o item cobre os dois caminhos.
//
// ── A unidade canônica é VALOR (R$), não percentual ───────────────────────────────────────────
// Três razões, todas verificáveis:
//   1. Percentual NÃO é fechado sob soma. `fin-valor-cockpit` agrega desconto por cliente
//      (`acc.desconto += l.discount`); somar percentuais de itens distintos não significa nada.
//   2. Receita é composta em moeda; o desconto entra na conta como parcela, não como fator.
//   3. O próprio Omie distribui o desconto de capa aos itens COMO VALOR (citação acima), e o
//      exemplo canônico da doc traz `"tipo_desconto": "V"`.

/** O que a API do Omie realmente devolve em `det.produto` para desconto. */
export interface DescontoOmieBruto {
  tipo_desconto?: string | null;
  percentual_desconto?: number | string | null;
  valor_desconto?: number | string | null;
}

/** Número finito não-negativo, ou `null` quando NÃO SABIDO. Mesma régua de `precoUnitarioOmie`:
 *  ausente e "informou 0" NÃO colapsam no mesmo byte, e lixo (NaN/Infinity/negativo) vira `null`,
 *  nunca 0 — `Number(null) === 0` é a fabricação que este repo persegue. */
function finitoNaoNegativo(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Desconto do item em VALOR ABSOLUTO (R$), ou `null` quando a leitura é AMBÍGUA/inválida.
 *
 * `bruto` é a base de incidência do percentual: qtd × valor_unitario. Passe `null` quando o preço
 * for desconhecido — sem base não há como converter percentual, e o resultado degrada para `null`
 * em vez de inventar um valor.
 *
 * Régua (fail-closed — precisão > recall; na dúvida NÃO produz número):
 *   sem nenhum dos campos                → 0     (o Omie não informou desconto = não há desconto)
 *   tipo "V"                             → valor_desconto
 *   tipo "P"                             → bruto × percentual_desconto / 100
 *   sem tipo, só um campo preenchido     → usa esse campo
 *   sem tipo, os dois preenchidos        → só se CONCORDAREM; discordando → null
 *   tipo desconhecido com desconto > 0   → null  (não sei ler o discriminador)
 *   percentual fora de [0,100]           → null
 *   desconto maior que o bruto           → null  (o próprio Omie recusa aplicar; ver doc da capa)
 *
 * ⚠️ `null` NÃO é "desconto zero". É "não sei o desconto deste item" — quem chama deve degradar
 * (deixar o item fora da soma e tornar a incompletude legível), nunca substituir por 0.
 */
export function descontoItemOmie(prod: DescontoOmieBruto | null | undefined, bruto: number | null): number | null {
  const p = prod || {};
  const valor = finitoNaoNegativo(p.valor_desconto);
  const perc = finitoNaoNegativo(p.percentual_desconto);
  const tipo = typeof p.tipo_desconto === "string" ? p.tipo_desconto.trim().toUpperCase() : "";

  // Percentual só é conversível com base. Sem base, um percentual informado é dado que não
  // sabemos usar — e "não sabemos" é `null`, não 0.
  const doPercentual = (): number | null => {
    if (perc === null || perc > 100) return null;
    if (bruto === null) return null;
    return (bruto * perc) / 100;
  };

  let bruto_desconto: number | null;
  if (tipo === "V") {
    bruto_desconto = valor;
  } else if (tipo === "P") {
    bruto_desconto = doPercentual();
  } else if (tipo !== "") {
    // Discriminador presente mas fora do vocabulário. Se não há desconto para interpretar, o
    // tipo é irrelevante e a resposta segue sendo 0; havendo, não temos como decidir.
    if ((valor === null || valor === 0) && (perc === null || perc === 0)) return 0;
    return null;
  } else if (valor !== null && perc !== null && valor !== 0 && perc !== 0) {
    // Os dois vieram sem discriminador: só aceitamos se apontarem para o MESMO desconto.
    const viaPerc = doPercentual();
    if (viaPerc === null) return null;
    bruto_desconto = Math.abs(viaPerc - valor) < 0.005 ? valor : null;
  } else if (valor !== null && valor !== 0) {
    bruto_desconto = valor;
  } else if (perc !== null && perc !== 0) {
    bruto_desconto = doPercentual();
  } else {
    // Nenhum dos dois informa desconto (ausentes, ou explicitamente zero).
    return 0;
  }

  if (bruto_desconto === null) return null;
  // Desconto acima da base é anomalia, não desconto de 100%+. A doc do Omie diz que ele nem
  // aplica desconto superior ao valor; aceitar aqui produziria receita negativa fabricada.
  if (bruto !== null && bruto_desconto > bruto + 0.005) return null;
  return Math.round(bruto_desconto * 100) / 100;
}

/**
 * Receita líquida de UMA linha, a partir do que está GRAVADO em `order_items`.
 *
 * `discount` é VALOR ABSOLUTO em R$ (ver cabeçalho). Esta é a única fórmula que os consumidores
 * devem usar — a existência de `× (1 − d/100)` em qualquer leitor da coluna é o bug.
 *
 * Devolve `null` quando o preço é desconhecido: `Number(null) === 0` transformaria "não sei o
 * preço" em "receita zero", que com custo cheio vira margem negativa fabricada.
 */
export function receitaLiquidaItem(
  unitPrice: number | null | undefined,
  quantity: number | null | undefined,
  discount: number | null | undefined,
): number | null {
  const preco = finitoNaoNegativo(unitPrice);
  if (preco === null) return null;
  const qtd = finitoNaoNegativo(quantity);
  if (qtd === null) return null;
  const desc = finitoNaoNegativo(discount) ?? 0;
  return Math.round((preco * qtd - desc) * 100) / 100;
}
