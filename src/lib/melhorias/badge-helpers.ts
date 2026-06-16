// src/lib/melhorias/badge-helpers.ts
// Contagem do badge "Minhas melhorias" (toggle no topo). Puro e testável.
// NÃO é espelhado na edge (≠ triagem-helpers): é lógica de UI do cliente.
import type { MelhoriaItem, MelhoriaStatus } from './types';

/** Status que ainda exigem atenção do autor (contam no badge do topo). */
const STATUS_NAO_RESOLVIDOS: ReadonlySet<MelhoriaStatus> = new Set([
  'aberto',
  'em_andamento',
]);

export function isMelhoriaNaoResolvida(status: MelhoriaStatus): boolean {
  return STATUS_NAO_RESOLVIDOS.has(status);
}

/** Quantos itens do usuário seguem em aberto/andamento (badge do topo). */
export function contarMelhoriasNaoResolvidas(
  itens: ReadonlyArray<Pick<MelhoriaItem, 'status'>>,
): number {
  return itens.reduce((n, i) => (isMelhoriaNaoResolvida(i.status) ? n + 1 : n), 0);
}
