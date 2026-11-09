// 5.2 do plano Sayerlack (revisão 2), fatia 1: o pedido do app × a leitura do portal, ANTES de qualquer re-disparo.
// A decisão mora na RPC `sayerlack_conferir_portal` (escritor único do retrato, da divergência e do gate que o claim
// lê). Aqui só se monta a leitura e se interpreta a resposta — fail-closed: qualquer coisa fora do contrato LANÇA
// (o chamador cai no "não re-disparei"), nunca vira "pode disparar".

export interface ItemLeitura { sku_portal: string; qtde_portal: number; valor_mercadoria: number }

export interface Diferenca { tipo: string; sku: string | null; app: unknown; portal: unknown }

export type Conferencia =
  | { tipo: "bate" }
  | { tipo: "divergente"; divergenciaId: number; diferencas: Diferenca[] }
  | { tipo: "recusada"; motivo: string };

interface Rpc {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

/** A leitura no formato da RPC. Condição vazia/ausente não chega aqui: o chamador recusa antes (ausente ≠ zero). */
export function montarLeitura(
  protocolo: string,
  itens: readonly ItemLeitura[],
  valorTotal: number,
  condicao: string,
  lidoDe: string,
  lidoAte: string,
): Record<string, unknown> {
  return {
    protocolo,
    condicao,
    valor_total: valorTotal,
    itens: itens.map((i) => ({ sku_portal: i.sku_portal, qtde_portal: i.qtde_portal, valor_mercadoria: i.valor_mercadoria })),
    lido_de: lidoDe,
    lido_ate: lidoAte,
  };
}

/** Interpreta a resposta da RPC. Lança em qualquer forma fora do contrato. */
export function interpretarConferencia(data: unknown): Conferencia {
  const r = data as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw new Error("conferência do portal sem resposta legível");
  if (r.conferido === false) {
    if (typeof r.motivo !== "string" || !r.motivo) throw new Error("conferência recusada sem motivo");
    return { tipo: "recusada", motivo: r.motivo };
  }
  if (r.conferido !== true) throw new Error("conferência do portal sem o campo 'conferido'");
  if (r.divergente === false) return { tipo: "bate" };
  if (r.divergente !== true) throw new Error("conferência do portal sem o campo 'divergente'");
  const id = Number(r.divergencia_id);
  if (!Number.isInteger(id) || id <= 0 || !Array.isArray(r.diferencas) || r.diferencas.length === 0) {
    throw new Error("divergência do portal sem id ou sem diferenças");
  }
  return { tipo: "divergente", divergenciaId: id, diferencas: r.diferencas as Diferenca[] };
}

export async function conferirPortal(
  db: Rpc,
  pedidoId: number,
  leitura: Record<string, unknown>,
  evidenciaId: number | null,
): Promise<Conferencia> {
  const { data, error } = await db.rpc("sayerlack_conferir_portal", {
    p_pedido_id: pedidoId,
    p_leitura: leitura,
    p_evidencia_id: evidenciaId,
    p_origem: "redisparo",
  });
  if (error) throw new Error(`conferência do portal falhou: ${error.message}`);
  return interpretarConferencia(data);
}

const ROTULO: Record<string, string> = {
  quantidade: "quantidade",
  sku_novo_no_portal: "SKU novo no portal",
  sku_fora_do_portal: "SKU que saiu do portal",
  valor_item: "valor do item",
  valor_total: "valor total",
  condicao: "condição de pagamento",
  item_sem_mapa_portal: "item do app sem SKU do portal",
  pedido_sem_itens: "pedido do app sem itens",
};

/** Resumo curto das diferenças para a mensagem (no máximo 4; o resto vai no campo `diferencas`). */
export function resumoDiferencas(diferencas: readonly Diferenca[]): string {
  const fmt = (v: unknown) => (v === null || v === undefined ? "—" : String(v));
  const partes = diferencas.slice(0, 4).map((d) =>
    `${ROTULO[d.tipo] ?? d.tipo}${d.sku ? ` ${d.sku}` : ""}: app ${fmt(d.app)} → portal ${fmt(d.portal)}`
  );
  const resto = diferencas.length - partes.length;
  return partes.join("; ") + (resto > 0 ? `; e mais ${resto}` : "");
}

const MENSAGEM_RECUSA: Record<string, string> = {
  leitura_antiga: "Outra leitura mais recente do portal já registrou uma alteração neste pedido; esta não a substitui.",
  tem_po: "O pedido já tem pedido de compra no Omie.",
  status_nao_conferivel: "O pedido saiu do status de disparo durante a conferência.",
  pedido_nao_encontrado: "O pedido não foi encontrado na conferência.",
};

export function mensagemRecusa(motivo: string): string {
  return MENSAGEM_RECUSA[motivo] ?? `A conferência com o portal recusou (${motivo}).`;
}
