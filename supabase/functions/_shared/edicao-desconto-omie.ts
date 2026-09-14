// Desconto na LEITURA do Omie, para a edição de pedido pelo app (`alterar_pedido`, omie-vendas-sync).
//
// ── O defeito que este guard fecha (lido no código e na doc em 2026-09-14) ────────────────────────
// A edição EXCLUI todos os itens do pedido no Omie (`ExcluirItemPedido`) e reinclui a lista nova
// (`IncluirItemPedido`) só com produto/quantidade/preço/CFOP. O desconto de item mora no próprio item
// (`det.produto`: `tipo_desconto`/`percentual_desconto`/`valor_desconto`; o de capa é distribuído aos
// itens e, distribuído, "os valores do desconto serão exibidos apenas nos itens" — doc oficial). Excluir
// leva o desconto junto, reincluir sem o trio cria item sem desconto e o `TotalizarPedido` recalcula
// para o bruto. A validação final compara `produto:quantidade:preço` (cega a desconto) e o write-back
// (`aplicar_edicao_pedido_omie`) recusa desconto ≠ 0. Sem este guard, editar pelo app um pedido com
// desconto comercial o apaga no ERP com "Pedido alterado com sucesso!".
// Detalhe e medição: docs/historico/edicao-do-app-apaga-desconto-do-omie.md.
//
// ── Presença, não apuração ─────────────────────────────────────────────────────────────────────────
// `descontoItemOmie` é a régua para SOMAR receita, e três zeros dela são cegueira quando a pergunta é
// "é seguro APAGAR?" (achado do challenge Codex, 2026-09-14):
//   · campo PRESENTE mas inválido ("abc", negativo, "5,00") ela lê como ausente → 0;
//   · desconto abaixo de ½ centavo ela arredonda → 0;
//   · base lixo (quantidade não numérica) produz NaN, e `NaN > 0` é false.
// Por isso só passa o item em que a régua leu EXATAMENTE zero E nenhum campo cru informa desconto.
// Régua e campo discordando é ILEGÍVEL, e ilegível acusa: na dúvida, não se apaga desconto.
//
// ── Universo: o det INTEIRO ────────────────────────────────────────────────────────────────────────
// ≠ `apurarSubtotalPedido`, que pula item sem `codigo_produto` ou sem preço (não viram linha em
// `order_items`). A edição exclui TODOS os itens do Omie, então todos entram aqui.
//
// ── 2º eixo: `total_pedido.valor_descontos` ────────────────────────────────────────────────────────
// "Valor dos descontos. Preenchimento automático" (doc oficial, separado de `valor_deducoes`). Não
// depende dos campos do item: se a forma do det mudar e o trio sumir da resposta, a capa ainda acusa.
// Ausente não acusa (o eixo primário é o item); presente e inválido acusa como ilegível.

import { descontoItemOmie, type DescontoOmieBruto, finitoNaoNegativo } from "./desconto-omie.ts";
import { precoUnitarioOmie } from "./omie-pedido.ts";

/** O que a leitura do Omie traz de um item de pedido — só o que o guard usa. */
export interface ItemOmieLido {
  produto?:
    | (DescontoOmieBruto & {
      codigo_produto?: number | string;
      quantidade?: number | string;
      valor_unitario?: number | string;
    })
    | null;
}

export interface DescontoDeItemLido {
  /** Posição do item no `det` lido do Omie (0-based). */
  indice: number;
  codigo_produto: number | string | null;
  /** `desconto` = a régua leu um valor > 0; `ilegivel` = não dá para afirmar que o desconto é zero. */
  motivo: "desconto" | "ilegivel";
  /** R$ do desconto da linha quando legível; `null` quando ilegível — nunca um 0 fabricado. */
  valor: number | null;
}

export interface DescontoDaCapaLido {
  motivo: "desconto" | "ilegivel";
  valor: number | null;
}

export interface DescontoNaLeitura {
  /** `true` ⇔ algum item OU a capa mostra desconto, ou não permite afirmar que não há. */
  acusado: boolean;
  itens: DescontoDeItemLido[];
  capa: DescontoDaCapaLido | null;
}

type SinalDoCampo = "ausente" | "zero" | "positivo" | "invalido";

/** Estado CRU de um campo de desconto: ausente e "informou 0" não colapsam, e lixo não vira ausente. */
function sinalDoCampo(raw: unknown): SinalDoCampo {
  if (raw === null || raw === undefined) return "ausente";
  if (typeof raw === "string" && raw.trim() === "") return "ausente";
  const n = finitoNaoNegativo(raw);
  if (n === null) return "invalido";
  return n > 0 ? "positivo" : "zero";
}

/** Itens do det cuja leitura mostra desconto (ou não permite afirmar que é zero). Vazio = todos limpos. */
export function descontosDeItemNaLeitura(det: readonly ItemOmieLido[]): DescontoDeItemLido[] {
  const acusados: DescontoDeItemLido[] = [];
  det.forEach((item, indice) => {
    const prod = item?.produto || {};
    const sinais = [sinalDoCampo(prod.valor_desconto), sinalDoCampo(prod.percentual_desconto)];
    // Base IGUAL à de `apurarSubtotalPedido` — a mesma que grava `order_items.desconto_valor`.
    const preco = precoUnitarioOmie(prod.valor_unitario);
    const base = preco === null ? null : Number(prod.quantidade || 1) * preco;
    const desconto = descontoItemOmie(prod, base);
    const legivel = desconto !== null && Number.isFinite(desconto) && !sinais.includes("invalido");
    if (legivel && desconto > 0) {
      acusados.push({ indice, codigo_produto: prod.codigo_produto ?? null, motivo: "desconto", valor: desconto });
    } else if (!legivel || sinais.includes("positivo")) {
      acusados.push({ indice, codigo_produto: prod.codigo_produto ?? null, motivo: "ilegivel", valor: null });
    }
  });
  return acusados;
}

/** Desconto que a CAPA (`total_pedido`) mostra, ou `null` quando ela não informa desconto. */
export function descontoDaCapaNaLeitura(totalPedido: { valor_descontos?: unknown } | null | undefined): DescontoDaCapaLido | null {
  const raw = totalPedido?.valor_descontos;
  const sinal = sinalDoCampo(raw);
  if (sinal === "invalido") return { motivo: "ilegivel", valor: null };
  if (sinal === "positivo") return { motivo: "desconto", valor: finitoNaoNegativo(raw) };
  return null;
}

/** Veredito da leitura inteira do pedido: itens E capa. É o que a edge consulta antes e depois de mutar. */
export function descontoNaLeituraDoOmie(leitura: {
  det: readonly ItemOmieLido[];
  total_pedido?: { valor_descontos?: unknown } | null;
}): DescontoNaLeitura {
  const itens = descontosDeItemNaLeitura(leitura.det);
  const capa = descontoDaCapaNaLeitura(leitura.total_pedido);
  return { acusado: itens.length > 0 || capa !== null, itens, capa };
}
