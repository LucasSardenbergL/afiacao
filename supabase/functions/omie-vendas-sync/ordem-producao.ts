// Ordem de produção honesta (PR 8.4 da rodada 3 do Novo Pedido) — regras PURAS de `criar_ordem_producao`.
//
// Antes: o `catch` do `IncluirOrdemProducao` só logava, a linha local nascia com `omie_ordem_numero = "null"`
// (`String(null)`) e a resposta era `{ success: true }` incondicional — o vendedor via "OP criada" para uma
// OP que o Omie recusou.
//
// Agora (núcleo, sem reaproveitar linha — a 1ª rodada do Codex mostrou que a "idempotência local" criava
// bordas novas e nenhum caminho do app chama a OP de novo: o reenvio pula o PV já enviado):
//   • cada produto tem DESFECHO (`criada` · `falhou` com o motivo e a chave `cCodIntOP` para procurar no Omie);
//     `success` só é true sem falha;
//   • o mesmo produto em duas linhas vira UMA OP com a soma (o `cCodIntOP` é por produto: a 2ª chamada era
//     recusada e a quantidade dela sumia da produção). Linha com quantidade inválida derruba o produto inteiro
//     (nunca soma parcial); a data prometida mais CEDO vale, já resolvida com o prazo do pedido.
//   • a falha diz o TIPO (2ª rodada do Codex): `invalido` (nem foi ao Omie — não grava linha local executável),
//     `indeterminado` (recusa ou timeout depois de gravar — conferir no Omie antes de criar outra) e
//     `sem_registro_local` (a OP EXISTE no Omie, só o app não a guardou — não criar outra).
//
// Testado em ./ordem-producao_test.ts.

import { diaIsoValido } from "./o-que-vai-ao-omie.ts";
import { ehEscritaIndeterminada } from "../_shared/omie-chamada-relogio.ts";

export interface ItemOp {
  product_id?: string | null;
  omie_codigo_produto?: number;
  codigo?: string;
  descricao?: string;
  quantidade: number;
  unidade?: string;
  assigned_to?: string | null;
  ready_by_date?: string | null;
}

/** Produto a produzir: as linhas do carrinho já juntas; `invalido` = alguma linha não pode ir ao Omie. */
export interface ProdutoOp extends ItemOp {
  invalido: string | null;
}

type TipoFalhaOp = "invalido" | "indeterminado" | "sem_registro_local";

export type DesfechoOp =
  | { status: "criada"; omie_ordem_id: number; omie_ordem_numero: string | null }
  | { status: "falhou"; tipo: TipoFalhaOp; motivo: string; chave: string | null };

/** Chave do produto no Omie — a mesma do `cCodIntOP`. Ausente/0 = sem chave (não fabricar). */
function chaveProduto(item: ItemOp): number | null {
  const c = item.omie_codigo_produto;
  return typeof c === "number" && Number.isFinite(c) && c > 0 ? c : null;
}

function quantidadeValida(q: unknown): q is number {
  return typeof q === "number" && Number.isFinite(q) && q > 0;
}

/** Data prometida da linha: a dela, senão a do pedido. Só dia que EXISTE no calendário conta (2027-02-30
 *  não vence um prazo válido — não fabricar). */
function prazoDaLinha(item: ItemOp, prazoDoPedido: unknown): string | null {
  const ok = (d: unknown) => {
    const dia = typeof d === "string" ? d.slice(0, 10) : null;
    return diaIsoValido(dia) ? dia : null;
  };
  return ok(item.ready_by_date) ?? ok(prazoDoPedido);
}

/**
 * Junta as linhas do MESMO produto numa só (soma a quantidade; a data prometida mais CEDO). Validação
 * por LINHA, antes de somar: uma linha inválida marca o produto inteiro como inválido (5 + (−2) nunca
 * vira 3). Sem código Omie → produto sozinho, inválido.
 */
export function agruparItensOp(itens: ItemOp[], prazoDoPedido: unknown): ProdutoOp[] {
  const saida: ProdutoOp[] = [];
  const porChave = new Map<number, ProdutoOp>();
  for (const it of itens) {
    const k = chaveProduto(it);
    const prazo = prazoDaLinha(it, prazoDoPedido);
    const invalidoLinha = k === null ? "produto sem código no Omie"
      : !quantidadeValida(it.quantidade) ? "quantidade inválida" : null;
    if (k === null) { saida.push({ ...it, ready_by_date: prazo, invalido: invalidoLinha }); continue; }
    const ja = porChave.get(k);
    if (!ja) {
      const novo: ProdutoOp = { ...it, ready_by_date: prazo, invalido: invalidoLinha };
      porChave.set(k, novo);
      saida.push(novo);
      continue;
    }
    if (invalidoLinha) ja.invalido = invalidoLinha;
    else if (!ja.invalido) ja.quantidade = ja.quantidade + it.quantidade;
    if (prazo && (!ja.ready_by_date || prazo < ja.ready_by_date)) ja.ready_by_date = prazo;
  }
  return saida;
}

/**
 * Lê o `nCodOP` da resposta do `IncluirOrdemProducao`. Sem `nCodOP` válido = NÃO confirmou.
 * O `cNumOP` (número que o operador vê) só se vier — o id interno nunca é apresentado como número.
 */
export function lerRespostaOp(r: unknown): { id: number; numero: string | null } | null {
  if (!r || typeof r !== "object") return null;
  const o = r as { nCodOP?: unknown; cNumOP?: unknown };
  const id = typeof o.nCodOP === "number" ? o.nCodOP : typeof o.nCodOP === "string" ? Number(o.nCodOP) : NaN;
  if (!Number.isFinite(id) || id <= 0) return null;
  const numero = typeof o.cNumOP === "string" && o.cNumOP.trim() ? o.cNumOP.trim() : null;
  return { id, numero };
}

/** Como o operador acha a OP no Omie: o número se houver, senão o id interno rotulado. */
export function rotuloOp(id: number, numero: string | null): string {
  return numero ? `OP ${numero}` : `OP de id ${id} no Omie`;
}

export function resumoOps(desfechos: DesfechoOp[]): { success: boolean; falhas: number } {
  const falhas = desfechos.filter((d) => d.status === "falhou").length;
  return { success: falhas === 0, falhas };
}

/**
 * Motivo da falha que vai ao vendedor. A escrita INDETERMINADA (timeout depois de enviar) traz no texto
 * "confira no Omie antes de repetir" — instrução de repetir que, ao lado de "não crie à mão", induz OP em
 * dobro (5ª rodada do Codex). Ela vira um motivo SEM instrução; o erro completo fica no log da edge.
 */
export function motivoDaFalhaOp(err: unknown): string {
  if (ehEscritaIndeterminada(err)) return "a chamada terminou sem confirmação do Omie (ele pode ter gravado)";
  return err instanceof Error ? err.message : String(err);
}
