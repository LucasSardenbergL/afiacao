import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

export type CommercialRole = 'operacional' | 'gerencial' | 'estrategico' | 'super_admin';

/**
 * 🔐 Trava do contrato de autorização gerencial (E1 do FU4 — ver spec de 2026-07-18).
 *
 * Os papéis gerenciais acionam `pode_ver_carteira_completa` no banco, que NÃO é o gate da
 * carteira: medido em prod 2026-07-18, ele gateia **64 policies em 34 tabelas** — incluindo
 * ESCRITA em `cliente_tier_preco` (tier de preço do cliente) e `venda_excecao_credito`
 * (aprovação de crédito), e LEITURA de `cmc_ledger` (custo médio) e `markup_policy`.
 * Conceder um papel gerencial hoje entrega preço + crédito + custo junto, de uma vez.
 *
 * Enquanto a matriz de capability por recurso×ação (E2) não existir no BANCO, o app trata
 * esses papéis como NÃO concedidos, mesmo que a linha exista em `commercial_roles` — o dado
 * é preservado, a capability não. Fail-closed por construção.
 *
 * A E2 vira isto para `true` na MESMA migration que habilita o papel no banco. Não vire
 * antes: sem a migration aplicada, isto reabre o furo silenciosamente.
 */
const CONTRATO_GERENCIAL_ATIVO: boolean = false;

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
    // Gateados pela trava acima: o papel no banco não basta enquanto a E2 não existir.
    canViewStrategic: CONTRATO_GERENCIAL_ATIVO && (isSuperAdmin || isEstrategico),
    canViewManagerial: CONTRATO_GERENCIAL_ATIVO && (isSuperAdmin || isEstrategico || isGerencial),
    loading,
    refetch: fetchRole,
  };
}
