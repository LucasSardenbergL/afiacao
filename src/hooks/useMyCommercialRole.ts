import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useImpersonatedAccessProfile } from '@/hooks/useImpersonatedAccessProfile';
import { estadoDeLeitura, type EstadoLeitura } from '@/lib/leitura/estado-de-leitura';
import { opcoesMeuCargoComercial } from '@/lib/cargo-comercial-cache';

/**
 * Role comercial do "eu efetivo": o user real, ou o ALVO na lente "Ver como".
 * Os 4 novos (farmer/hunter/closer/master) convivem com os legados.
 * Read-only + display-only (escolhe dashboard em /meu-dia; isHunter em FarmerCalls).
 *
 * ⚠️ `isLoading` NÃO responde "o papel já é conhecido?" — e quem o usou como se respondesse
 * fabricou rótulo (`carteira.positivacao_vista`, medido na revisão retroativa do #1896). Com
 * `networkMode:'online'` (o default do repo) a query PAUSADA tem `isLoading === false` (v5 define
 * `isLoading = isPending && isFetching`) e `data` undefined ⇒ `data ?? null` devolve `null`, que é
 * indistinguível de "consultei e este user não tem papel". Por isso o `estado` sai junto: ele é o
 * mapeamento EXAUSTIVO de (status × fetchStatus), e só `'pronta'` autoriza tratar `data` como fato.
 * Quem só escolhe tela pode continuar com `isLoading`; quem ROTULA precisa do `estado`.
 */
export type MyCommercialRole =
  | 'farmer'
  | 'hunter'
  | 'closer'
  | 'master'
  | 'operacional'
  | 'gerencial'
  | 'estrategico'
  | 'super_admin'
  | null;

export function useMyCommercialRole(): { data: MyCommercialRole; isLoading: boolean; estado: EstadoLeitura } {
  const { user } = useAuth();
  const { isImpersonating } = useImpersonation();
  const perfilAlvo = useImpersonatedAccessProfile();

  // Sem lente: consulta o role do master. Na lente, `enabled:false` evita consultar
  // o role do master (que renderizaria o dashboard ERRADO — o do master).
  const realQuery = useQuery({
    ...opcoesMeuCargoComercial(user?.id),
    enabled: !!user && !isImpersonating,
    // ⚠️ A consulta (`consultarMeuCargoComercial`) LANÇA no `error` em vez de devolver `null`.
    // Descartá-lo era a assinatura literal da classe "silêncio afirmativo"
    // (`docs/agent/money-path.md`): com timeout/RLS/500 a query resolveria com SUCESSO e `null`, e
    // quem lê o `estado` como "consultei e este user não tem papel" fabricaria `is_hunter:false`
    // para todo hunter atingido, sem nem disparar os retries. Achado do /codex sobre o fix do #1896.
  });

  // Na lente: role do ALVO. Vem do RPC master-only get_user_access_profile_for, que o
  // useImpersonatedAccessProfile já buscou — sem query nova, sem depender de RLS de
  // commercial_roles cross-user. É o mesmo perfil que alimenta o useDisplayAccess.
  // O `estado` acompanha a query que de fato responde nesta volta — sob a lente é a do ALVO.
  if (isImpersonating) {
    return {
      data: (perfilAlvo.data?.commercialRole ?? null) as MyCommercialRole,
      isLoading: perfilAlvo.isLoading,
      estado: estadoDeLeitura(perfilAlvo),
    };
  }
  return { data: (realQuery.data ?? null) as MyCommercialRole, isLoading: realQuery.isLoading, estado: estadoDeLeitura(realQuery) };
}
