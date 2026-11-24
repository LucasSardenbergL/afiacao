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
