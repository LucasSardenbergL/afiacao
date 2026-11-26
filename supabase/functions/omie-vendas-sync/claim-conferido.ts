// Claim do envio CONFERIDO (edge v1.53, migration 20261126190127) — o lado TS da comparação.
//
// A autoridade é a RPC `sales_order_reivindicar_envio_conferido`, atômica no lock de linha: só
// carimba se a linha não mudou desde a leitura da edge (updated_at) E os itens dela são os que vão
// ao Omie. Esta pré-checagem roda ANTES do gate ATP com a MESMA regra, para que a foto velha de uma
// tela aberta antes de outra salvar seja recusada sem reservar estoque. Divergir desta função da
// projeção SQL só pode custar recusa (a RPC decide), nunca um PV com itens velhos.

/** Marca estável da recusa — a tela de orçamentos a procura na mensagem. */
export const MARCA_PEDIDO_ALTERADO = "[pedido_alterado]";

type ItemComparavel = {
  omie_codigo_produto?: unknown;
  quantidade?: unknown;
  valor_unitario?: unknown;
  tint_cor_id?: unknown;
};

type Tupla = [number, number, number, string | null];

function numero(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** Ordem por unidade de código (a collation "C" do SQL), nunca `localeCompare` — que empata
 * composições Unicode diferentes e faria a pré-checagem recusar um multiconjunto que a RPC aceita. */
function porCodigo(a: string | null, b: string | null): number {
  const x = a ?? "", y = b ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Projeção [código, quantidade, valor unitário, cor] de cada item, ORDENADA pelo conteúdo (a ordem
 * da lista não é dado comercial — um retry que relê os itens noutra ordem é o mesmo pedido).
 * `null` quando a entrada não é lista ou algum item não tem código/quantidade/valor numéricos.
 */
export function projecaoItensEnvio(itens: unknown): Tupla[] | null {
  if (!Array.isArray(itens)) return null;
  const tuplas: Tupla[] = [];
  for (const it of itens as ItemComparavel[]) {
    if (it === null || typeof it !== "object") return null;
    const c = numero(it.omie_codigo_produto);
    const q = numero(it.quantidade);
    const v = numero(it.valor_unitario);
    if (c === null || q === null || v === null) return null;
    const cor = it.tint_cor_id === undefined || it.tint_cor_id === null ? null : String(it.tint_cor_id);
    tuplas.push([c, q, v, cor]);
  }
  return tuplas.sort((a, b) =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || porCodigo(a[3], b[3])
  );
}

/** Os itens da LINHA são os que vão ao Omie? Projeção ausente de qualquer lado ⇒ `false`. */
export function mesmosItensDeEnvio(daLinha: unknown, doEnvio: unknown): boolean {
  const a = projecaoItensEnvio(daLinha);
  const b = projecaoItensEnvio(doEnvio);
  if (a === null || b === null || a.length === 0 || a.length !== b.length) return false;
  return a.every((t, i) => t.every((x, j) => x === b[i][j]));
}

/** Mensagem da recusa (lançada: caller antigo lê `blocked` desconhecido como sucesso). */
export function mensagemPedidoAlterado(salesOrderId: string): string {
  return `Envio recusado ${MARCA_PEDIDO_ALTERADO}: o pedido ${salesOrderId} foi alterado (em outra aba ou por ` +
    "outra pessoa) depois que esta tela o abriu — recarregue e confira os itens e o status antes de enviar " +
    "(outra tela pode já tê-lo enviado). Esta tentativa NÃO enviou nada ao Omie.";
}
