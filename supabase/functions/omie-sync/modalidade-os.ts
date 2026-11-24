// Modalidade de entrega da OS de afiação gravada em `orders.delivery_option` — PR 2.3 da rodada 3.
// Antes era SEMPRE 'retirada', qualquer que fosse a escolha no Novo Pedido: o roteirizador
// (src/hooks/useRoutePlanner.ts) só busca coleta/entrega, então nenhuma OS do app entrava em rota.
//
// Vocabulário = `DeliveryOption` de src/types/index.ts (a edge não importa de src/; manter em par).
// 'retirada' é o valor LEGADO que esta edge gravava: fica só para o front ANTIGO (antes do Publish,
// que não envia a modalidade) — a coluna é NOT NULL, e é o mesmo valor que já ia. Valor presente e
// fora do vocabulário também cai nele, mas o chamador loga (é defeito do front, não escolha).

export const MODALIDADES_OS = ["coleta_entrega", "somente_coleta", "somente_entrega", "balcao"] as const;
export type ModalidadeOS = (typeof MODALIDADES_OS)[number];
export const MODALIDADE_LEGADA = "retirada";

export function modalidadeDaOs(
  v: unknown,
): { valor: ModalidadeOS | typeof MODALIDADE_LEGADA; invalida: boolean } {
  if (typeof v === "string" && (MODALIDADES_OS as readonly string[]).includes(v)) {
    return { valor: v as ModalidadeOS, invalida: false };
  }
  const ausente = v === undefined || v === null || v === "";
  return { valor: MODALIDADE_LEGADA, invalida: !ausente };
}

// Com a modalidade real a OS entra no roteirizador, que lê `orders.address` (jsonb) e `orders.time_slot`.
// Sem eles a parada caía no endereço PADRÃO do cliente e perdia o turno (Codex, PR 2.3). Só há rota em
// coleta/entrega: balcão e o legado não guardam endereço nem turno.
const CAMPOS_ENDERECO = ["street", "number", "complement", "neighborhood", "city", "state", "zip_code"] as const;

function temRota(modalidade: string): boolean {
  return modalidade !== "balcao" && modalidade !== MODALIDADE_LEGADA;
}

/** O endereço escolhido no Novo Pedido, só com os campos de texto que o roteirizador lê; null sem rota/sem dado. */
export function enderecoDaOs(modalidade: string, endereco: unknown): Record<string, string> | null {
  if (!temRota(modalidade) || !endereco || typeof endereco !== "object" || Array.isArray(endereco)) return null;
  const out: Record<string, string> = {};
  for (const c of CAMPOS_ENDERECO) {
    const v = (endereco as Record<string, unknown>)[c];
    if (typeof v === "string" && v.trim()) out[c] = v.trim();
  }
  return out.street || out.zip_code || out.city ? out : null;
}

/** O turno (id de TIME_SLOTS do front) quando há rota; null sem rota/sem dado. */
export function turnoDaOs(modalidade: string, turno: unknown): string | null {
  if (!temRota(modalidade)) return null;
  return typeof turno === "string" && turno.trim() ? turno.trim() : null;
}
