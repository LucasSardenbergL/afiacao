// Vincular o PO lançado À MÃO no Omie ao pedido do app (portal Sayerlack, revisão 2, item 7.1).
//
// Usado pelos DOIS pontos que detectam `po_manual_no_omie`: a importadora (pedido existente sem PO) e a reconsulta
// da varredura. Toda a decisão de dinheiro mora na RPC `sayerlack_vincular_po_manual` (migration 20261111110000,
// prova PG17 `db/test-sayerlack-vincular-po-manual.sh`): contrato por token exato, dono do PO, claim, conteúdo
// (SKU, quantidade, valor) e a trilha em `acoes_execucoes`. Aqui só se chama e se traduz a resposta.
//
// Erro da RPC LANÇA (fail-closed): quem chama nunca pode tratar "não consegui conferir" como "não há PO manual" —
// isso levaria ao re-disparo e a um PO duplicado no Omie.

/** O que a RPC devolve (só os campos que as edges leem). */
export interface ResultadoVinculo {
  vinculado: boolean;
  motivo: string;
  po_numero?: string | null;
  po_codigo?: string | null;
  contrato_composto?: boolean;
  diferencas?: { sku: string; qtde_app: number | null; qtde_po: number | null; valor_app: number | null; valor_po: number | null }[];
  detalhe?: string;
  execucao_id?: string;
}

// deno-lint-ignore no-explicit-any
type DbRpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string } | null }> };

export async function vincularPoManual(
  db: DbRpc,
  pedidoId: number,
  ator: string | null,
  origem: "importar" | "varredura",
): Promise<ResultadoVinculo> {
  const { data, error } = await db.rpc("sayerlack_vincular_po_manual", { p_pedido_id: pedidoId, p_ator: ator, p_origem: origem });
  if (error) throw new Error(`Vinculação do PO manual: ${error.message}`);
  const r = data as ResultadoVinculo | null;
  if (!r || typeof r.vinculado !== "boolean" || typeof r.motivo !== "string") {
    throw new Error("Vinculação do PO manual: resposta da RPC sem 'vinculado'/'motivo'");
  }
  return r;
}

const MOTIVOS: Record<string, string> = {
  conteudo_divergente: "os itens do PO não batem com os do pedido",
  conteudo_ausente: "não consegui ler os itens do PO ou do pedido para conferir",
  po_ambiguo: "há mais de um PO no Omie com este número no contrato",
  po_de_outro_pedido: "o PO já pertence a outro pedido do app",
  disparo_pendente: "há uma tentativa de disparo em aberto para este pedido",
  status_nao_vinculavel: "o status do pedido não permite vincular",
  tem_po: "o pedido já tem PO no app",
};

/** Resumo legível das diferenças (no máximo 5 SKUs), para a mensagem ao humano. */
export function resumirDiferencas(d: ResultadoVinculo["diferencas"]): string {
  if (!d || d.length === 0) return "";
  const fmt = (x: number | null) => (x == null ? "—" : String(x));
  const linhas = d.slice(0, 5).map((x) =>
    `SKU ${x.sku}: app ${fmt(x.qtde_app)} un./R$ ${fmt(x.valor_app)} × PO ${fmt(x.qtde_po)} un./R$ ${fmt(x.valor_po)}`
  );
  return linhas.join("; ") + (d.length > 5 ? ` (+${d.length - 5})` : "");
}

/** Mensagem da recusa: o PO manual existe, mas não foi vinculado — e nada foi re-disparado. */
export function mensagemNaoVinculado(protocolo: string, pedidoId: number, poNumero: string | null, r: ResultadoVinculo): string {
  const motivo = MOTIVOS[r.motivo] ?? r.motivo;
  const diff = r.motivo === "conteudo_divergente" ? ` Diferenças: ${resumirDiferencas(r.diferencas)}.` : "";
  const composto = r.contrato_composto ? " O contrato do PO é composto (mais de um pedido do portal)." : "";
  return `O pedido ${protocolo} está no app (#${pedidoId}) sem pedido de compra, e o Omie já tem o PO ` +
    `${poNumero ?? "?"} com este número no contrato (lançado à mão). Não vinculei: ${motivo}.${diff}${composto} ` +
    `Não re-disparei para não duplicar. Não lance outro no Omie: confira o PO ${poNumero ?? "?"} e o pedido #${pedidoId}.`;
}

/** Mensagem do sucesso. */
export function mensagemVinculado(protocolo: string, pedidoId: number, r: ResultadoVinculo): string {
  return `O pedido ${protocolo} (#${pedidoId}) foi vinculado ao PO ${r.po_numero ?? "?"} lançado à mão no Omie: ` +
    `itens e valores conferidos. Nada foi re-disparado.`;
}
