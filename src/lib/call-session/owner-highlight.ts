export type RealceDono = 'meu' | 'outro' | 'sem_dono' | 'desconhecido';

/**
 * Decide como destacar uma chamada entrante pra o usuário logado (Frente 1 degradada).
 * - desconhecido: cliente não identificado por telefone.
 * - sem_dono: cliente identificado mas sem dono efetivo na carteira (qualquer um atende).
 * - meu: o dono efetivo do cliente é o próprio usuário logado → destaque forte.
 * - outro: o cliente tem dono, e não sou eu → realce discreto ("cliente de X").
 */
export function classificarRealceDono(input: {
  ownerUserId: string | null;
  currentUserId: string | null;
  customerUserId: string | null;
}): RealceDono {
  if (!input.customerUserId) return 'desconhecido';
  if (!input.ownerUserId) return 'sem_dono';
  if (input.currentUserId && input.ownerUserId === input.currentUserId) return 'meu';
  return 'outro';
}
