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
import { supabase } from '@/integrations/supabase/client';

const chaveMeuCargoComercial = (userId: string | undefined) => ['my-commercial-role', userId] as const;

/**
 * A consulta ÚNICA da chave acima. Os dois leitores do cargo do user real (`useMyCommercialRole`
 * e o legado `useCommercialRole`) dividem a chave, então dividem também esta função: dois
 * `queryFn` diferentes na mesma chave dariam resultados diferentes conforme quem buscasse 1º.
 * O `error` lança (não vira `null`): com timeout/RLS/500 o PostgREST devolve `{data:null, error}`,
 * e engoli-lo fabricaria "consultei e não tem cargo" sem disparar os retries.
 */
async function consultarMeuCargoComercial(userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const { data, error } = await supabase
    .from('commercial_roles')
    .select('commercial_role')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.commercial_role ?? null;
}

/** Opções compartilhadas: mesma chave, mesma consulta, mesma validade (60 s). */
export const opcoesMeuCargoComercial = (userId: string | undefined) => ({
  queryKey: chaveMeuCargoComercial(userId),
  queryFn: () => consultarMeuCargoComercial(userId),
  staleTime: 60_000,
});

export function semearMeuCargoComercial(
  queryClient: QueryClient,
  userId: string,
  leitura: { data: { commercial_role?: string | null } | null; error: unknown },
): void {
  if (leitura.error) return;
  queryClient.setQueryData(chaveMeuCargoComercial(userId), leitura.data?.commercial_role ?? null);
}
