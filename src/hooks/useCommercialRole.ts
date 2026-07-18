import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useAuthzContract } from '@/hooks/useAuthzContract';

export type CommercialRole = 'operacional' | 'gerencial' | 'estrategico' | 'super_admin';

/**
 * 🔐 Contrato de autorização gerencial (E1 #1424 → E2/FU4 — spec de 2026-07-18).
 *
 * Os papéis gerenciais acionavam `pode_ver_carteira_completa`, que NÃO era o gate da carteira:
 * medido em prod 2026-07-18, gateava **64 policies em 34 tabelas** — incluindo ESCRITA em
 * `cliente_tier_preco` (tier de preço) e `venda_excecao_credito` (crédito), e LEITURA de
 * `cmc_ledger` (custo) e `markup_policy`. Conceder o papel entregava tudo isso junto.
 *
 * A E1 travou isso com uma constante `false` no código. A E2 substituiu o gate único por uma
 * matriz de capability por recurso × ação no BANCO — e esta trava virou uma PERGUNTA ao banco
 * (`useAuthzContract`) em vez de uma constante:
 *
 *   · banco em v2 (matriz aplicada) ⇒ o papel gerencial é concedido, e já não carrega
 *     preço/crédito/custo/compras — as policies dessas tabelas agora exigem capability própria.
 *   · banco em v1, RPC ausente, erro ou carregando ⇒ capability NEGADA.
 *
 * A pergunta importa porque no Lovable merge ≠ produção: a migration é aplicada à mão e falha em
 * silêncio se esquecida. Uma constante `true` publicada sem a migration reabriria o furo sem
 * nenhum sinal. Perguntando, o esquecimento vira "gestor sem acesso" — barulhento e seguro.
 */

interface UseCommercialRoleReturn {
  commercialRole: CommercialRole | null;
  isSuperAdmin: boolean;
  isEstrategico: boolean;
  isGerencial: boolean;
  isOperacional: boolean;
  /** estrategico or super_admin */
  canViewStrategic: boolean;
  /** gerencial, estrategico or super_admin */
  canViewManagerial: boolean;
  loading: boolean;
  refetch: () => Promise<void>;
}

export function useCommercialRole(): UseCommercialRoleReturn {
  const { user } = useAuth();
  const { matrizAtiva, loading: loadingContrato } = useAuthzContract();
  const [commercialRole, setCommercialRole] = useState<CommercialRole | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchRole = async () => {
    if (!user) {
      setCommercialRole(null);
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from('commercial_roles')
        .select('commercial_role')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) {
        console.error('Error fetching commercial role:', error);
        setCommercialRole(null);
      } else {
        setCommercialRole((data?.commercial_role as CommercialRole) || null);
      }
    } catch (error) {
      console.error('Error fetching commercial role:', error);
      setCommercialRole(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRole();
  }, [user?.id]);

  const isSuperAdmin = commercialRole === 'super_admin';
  const isEstrategico = commercialRole === 'estrategico';
  const isGerencial = commercialRole === 'gerencial';
  const isOperacional = commercialRole === 'operacional';

  return {
    commercialRole,
    isSuperAdmin,
    isEstrategico,
    isGerencial,
    isOperacional,
    // O papel no banco não basta: a matriz de capability (v2) precisa estar aplicada.
    // `matrizAtiva` é false enquanto carrega e em qualquer erro — fail-closed.
    canViewStrategic: matrizAtiva && (isSuperAdmin || isEstrategico),
    canViewManagerial: matrizAtiva && (isSuperAdmin || isEstrategico || isGerencial),
    // Só está "pronto" quando as DUAS perguntas responderam — senão o consumidor leria
    // `canView* = false` como decisão final e não como "ainda não sei".
    loading: loading || loadingContrato,
    refetch: fetchRole,
  };
}
