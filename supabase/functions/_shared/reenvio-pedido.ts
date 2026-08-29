// Guard de REENVIO da fronteira `criar_pedido` (omie-vendas-sync). PURO (zero Deno/DB):
// provado por `deno test --no-remote supabase/functions/_shared/reenvio-pedido_test.ts`.
//
// Achado Codex 2026-08-29 (ritual /codex retroativo do PR #2117). A action `criar_pedido`
// não tinha guard de "já enviado". A cadeia:
//   1. atp_gate_pedido RECONHECE o estado (`omie_pedido_id IS NOT NULL` → 'ja_enviado'),
//      mas classificarRetornoAtpGate mapeia todo `ok===true` para acao:'seguir' — é gate
//      de RESERVA (TTL), não de idempotência de ENVIO. E só roda para account 'oben'.
//   2. O `soRow` da action nem lia omie_pedido_id/hash_payload.
//   3. O write-back grava omie_pedido_id SEM tocar hash_payload.
//
// Por que a linha *pull* é o caso caro: a chave de dedup do Omie é `PV_<sales_order_id>`,
// DETERMINÍSTICA POR LINHA LOCAL. Retry de linha *push* bate duplicata no Omie e reconcilia
// (inofensivo). Linha pull nasceu do sync — nunca usou essa chave ⇒ o Omie NÃO deduplica e
// cria um pedido novo; o write-back grava o pid novo sobre o hash velho (`omie_oben_42` com
// pid 43); o próximo sync do pedido 42 remonta `omie_oben_42`, bate 23505 no índice parcial
// uniq_sales_orders_omie_hash e o ON CONFLICT da RPC criar_pedidos_com_itens trata como
// no-op → UM PEDIDO REAL SOME EM SILÊNCIO (positivação/OTE/comissão perdidas).
//
// O que segurava até aqui era AUSÊNCIA DE CHAMADOR apontando para linha pull, não um guard:
// nenhuma das 31.086 linhas pull da PROD tem status 'orcamento' (o filtro do SalesQuotes).
// Ausência de gatilho não é invariante.
//
// ⚠️ O guard tem de rodar ANTES do IncluirPedido: um CHECK no banco seria TARDIO — falharia
// depois de o pedido já existir no Omie. O CHECK de canonicidade
// (20260829120000_sales_orders_hash_canonico.sql) é defesa em profundidade, não substituto.

export interface LinhaPedidoParaEnvio {
  omie_pedido_id?: number | null;
  hash_payload?: string | null;
}

/** Ramos de recusa. São a MARCA testável de cada decisão (a prosa do detalhe é humana). */
export type MotivoRecusaEnvio = "linha_ausente" | "ja_enviado" | "linha_do_sync";

export interface VereditoEnvioPedido {
  permitido: boolean;
  motivo: MotivoRecusaEnvio | null;
  /** mensagem curta para o erro do edge; null quando permitido (nunca recusa opaca) */
  detalhe: string | null;
}

/** Prefixo do hash das linhas nascidas no sync do Omie (`omie_<account>_<pid>`). ANCORADO no
 *  início: um hash que só CONTÉM 'omie_' (ex.: `checkout_omie_oben_1`) não é linha pull. */
export function nascidaNoSync(hash: string | null | undefined): boolean {
  return typeof hash === "string" && hash.startsWith("omie_");
}

/**
 * Decide se a linha local pode virar um `IncluirPedido` no Omie.
 *
 * Fail-closed: linha ausente/ilegível recusa (o edge lê com `.maybeSingle()`, então "não achou"
 * e "erro de DB" chegam iguais — como `null`). Recusar deixa o pedido local INTACTO para retry;
 * seguir criaria o PV no Omie e só quebraria no write-back, deixando linha órfã.
 *
 * "Já enviado" usa o MESMO predicado do índice uniq_sales_orders_omie_pedido_id e do CHECK de
 * canonicidade — `omie_pedido_id IS NOT NULL`. Uma noção própria de "pid válido" abriria fresta
 * entre duas definições de enviado.
 *
 * Não existe retry legítimo com pid preenchido: o write-back é o ÚNICO escritor do pid neste
 * caminho e é um UPDATE único — falhou ⇒ pid NULL ⇒ o retry passa aqui e reconcilia via
 * `PV_<id>`. O "retry idempotente" do comentário do gate ATP é escopo de RESERVA ("não
 * re-reservar", não renovar TTL), não permissão de reenvio.
 */
export function classificarEnvioPedido(
  linha: LinhaPedidoParaEnvio | null | undefined,
): VereditoEnvioPedido {
  if (typeof linha !== "object" || linha === null || Array.isArray(linha)) {
    return {
      permitido: false,
      motivo: "linha_ausente",
      detalhe: "pedido local não encontrado (ou ilegível) — envio recusado antes do Omie",
    };
  }
  if (linha.omie_pedido_id !== null && linha.omie_pedido_id !== undefined) {
    return {
      permitido: false,
      motivo: "ja_enviado",
      detalhe: `pedido já enviado ao Omie (omie_pedido_id=${linha.omie_pedido_id}) — reenvio criaria duplicata`,
    };
  }
  if (nascidaNoSync(linha.hash_payload)) {
    return {
      permitido: false,
      motivo: "linha_do_sync",
      detalhe: "linha nasceu no sync do Omie (hash_payload omie_*) — nunca vira IncluirPedido",
    };
  }
  return { permitido: true, motivo: null, detalhe: null };
}
