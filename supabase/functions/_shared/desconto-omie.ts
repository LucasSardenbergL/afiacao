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

// ── O que o chamador faz com o null ───────────────────────────────────────────────────────────
// `receitaLiquidaItem`/`precoUnitarioLiquido` devolvem `null` quando NÃO SABEM — e quem consome
// não pode trocá-lo por 0. Com desconto, `null → 0` devolve o número CHEIO, numericamente
// IDÊNTICO ao caso legítimo "o Omie informou que não há desconto": a fabricação fica invisível
// na tela, sem nada para conferir. É o mesmo defeito que já renasceu duas vezes — `prod.desconto
// || 0` na ingestão, depois `finitoNaoNegativo(discount) ?? 0` aqui dentro — e cujo próximo
// endereço natural é exatamente o primeiro consumidor desta régua.
//
// A régua para quem consome, alinhada ao repo (ausente ≠ zero):
//   1. Some só o que conhece — uma linha que degradou NÃO entra no total como 0.
//   2. Conte as recusadas num contador SEPARADO e torne-o legível na superfície: "R$ X em 128
//      de 130 itens" é verdade; "R$ X" com 2 itens comidos em silêncio não é.
//   3. Nunca apresente um agregado incompleto com a mesma cara de um completo.
//
// ⚠️ O contra-exemplo está VIVO e é o consumidor previsto: `fin-valor-cockpit` compõe receita
// com `l.discount ?? 0` em todos os pontos onde a monta à mão — endereço estável:
//     git grep -n "discount ?? 0" supabase/functions/fin-valor-cockpit
// Hoje isso é INALCANÇÁVEL, não ativo, e a diferença importa: medido em 2026-09-08,
// `order_items.discount` tem default 0 e ZERO NULLs em 71.006 linhas, então o `?? 0` nunca
// dispara. Ele acorda no dia em que a ingestão passar a gravar o `null` desta régua, ou quando
// o cockpit passar a ler `order_items.desconto_valor` — nullable, sem default e 100% NULL
// (71.006/71.006) na mesma medição. Ligar a leitura ANTES de trocar o `?? 0` converteria 71 mil
// linhas de "não apurado" em receita cheia de uma vez só, e o total continuaria parecendo são.

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
 *
 * ⚠️ E devolve `null` quando o DESCONTO é desconhecido — o eixo que este módulo existe para
 * proteger. `discount` nulo tem duas origens, e nenhuma delas é "não há desconto": ou
 * `descontoItemOmie` recusou-se a ler (discriminador ambíguo, percentual fora de faixa,
 * desconto maior que a base), ou a linha é anterior à apuração e `order_items.desconto_valor`
 * ainda é NULL. `0` é a ÚNICA forma de dizer "o Omie informou que não há desconto".
 *
 * Tratar esse `null` como 0 devolveria a receita CHEIA — numericamente idêntica ao caso sem
 * desconto — e seria o bug original (`prod.desconto || 0`) renascido um andar acima, com a
 * mesma assinatura: superestimar a receita silenciosamente. Quem chama deve somar só o que
 * conhece e tornar a incompletude legível (ver §"O que o chamador faz com o null" no cabeçalho).
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
  const desc = finitoNaoNegativo(discount);
  if (desc === null) return null;
  return Math.round((preco * qtd - desc) * 100) / 100;
}

/**
 * Preço unitário LÍQUIDO — para quem audita margem, que trabalha por unidade e não por linha.
 *
 * O desconto é da LINHA inteira, então ele se dilui pela quantidade: `preço − desconto/qtd`.
 * Subtrair o desconto cheio de cada unidade multiplicaria o desconto pela quantidade (com qtd 2
 * e R$ 10 de desconto, o preço unitário cairia 10 em vez de 5) e produziria margem pessimista
 * fabricada. É a armadilha específica da troca de unidade: a fórmula percentual antiga
 * `preço × (1 − d/100)` já era por unidade, então quem migrar por analogia direta erra aqui.
 *
 * `null` quando o preço é desconhecido, quando a quantidade não serve de divisor, ou quando o
 * DESCONTO é desconhecido — pela mesma razão de `receitaLiquidaItem`: desconto nulo tratado como
 * zero devolve o preço CHEIO, que é o número superestimado que este módulo existe para impedir.
 */
export function precoUnitarioLiquido(
  unitPrice: number | null | undefined,
  quantity: number | null | undefined,
  discount: number | null | undefined,
): number | null {
  const preco = finitoNaoNegativo(unitPrice);
  if (preco === null) return null;
  const qtd = finitoNaoNegativo(quantity);
  if (qtd === null || qtd === 0) return null;
  const desc = finitoNaoNegativo(discount);
  if (desc === null) return null;
  return Math.round((preco - desc / qtd) * 100) / 100;
}
