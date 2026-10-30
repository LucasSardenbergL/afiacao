import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { ErroSituacaoReceita, interpretarRespostaSituacao } from './situacao-cliente';

/**
 * Situação na Receita do cliente (RPC `cliente_situacao_receita`, escopo de carteira).
 * A chave carrega o usuário REAL (o gate do banco é `auth.uid()`) e o cliente: trocar de cliente
 * troca de chave e, sem `placeholderData`, o dado do cliente anterior nunca aparece no novo.
 * Erro de contrato não tem retry (repetir não conserta a forma da resposta).
 */
export function useSituacaoReceitaCliente(customerUserId: string | null | undefined, habilitado = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['situacao-receita-cliente', user?.id ?? null, customerUserId ?? null],
    enabled: habilitado && !!user?.id && !!customerUserId,
    staleTime: 5 * 60_000,
    retry: (falhas, erro) => !(erro instanceof ErroSituacaoReceita && erro.motivo === 'contrato') && falhas < 2,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('cliente_situacao_receita', {
        p_customer_user_id: customerUserId as string,
      });
      return interpretarRespostaSituacao(data, error);
    },
  });
}
