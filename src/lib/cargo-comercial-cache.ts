/**
 * Chave do cache react-query do cargo comercial do usuário REAL (plano v5, lote 6c).
 *
 * O `AuthContext` já lê `commercial_roles` no boot, em paralelo a `user_roles`/`profiles`. O
 * `useMyCommercialRole` lia de novo depois que o `Index` montava, e esse 2º REST era o passo
 * serial dominante da home de staff. Com a chave aqui (fora do hook, para o `AuthContext` não
 * importar o hook que importa o `useAuth`), o auth SEMEIA o cache e o hook não refaz a viagem.
 *
 * Só se semeia uma leitura que veio SEM erro: semear `null` de uma leitura que falhou fabricaria
 * "consultei e não tem cargo" (ver o comentário do `useMyCommercialRole`). Com erro, o hook segue
 * consultando sozinho, como antes.
 */
import type { QueryClient } from '@tanstack/react-query';

export const chaveMeuCargoComercial = (userId: string | undefined) => ['my-commercial-role', userId] as const;

export function semearMeuCargoComercial(
  queryClient: QueryClient,
  userId: string,
  leitura: { data: { commercial_role?: string | null } | null; error: unknown },
): void {
  if (leitura.error) return;
  queryClient.setQueryData(chaveMeuCargoComercial(userId), leitura.data?.commercial_role ?? null);
}
