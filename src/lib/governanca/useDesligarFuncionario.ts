import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { mensagemDoErroEdge } from '@/lib/invoke-function';
import { track } from '@/lib/analytics';

export type ResultadoDesligamento = {
  status: 'desligado' | 'ja_desligado';
  desligamento_id: string | null;
  resumo: Record<string, unknown> | null;
  ban: 'aplicado' | 'falhou';
  mensagem: string;
};

export type PedidoDesligamento = { userId: string; novoDonoUserId: string; motivo: string };

/**
 * Desliga um funcionário pela edge `desligar-funcionario` (RPC atômica + ban no Auth).
 * Ação sobre UM registro ⇒ `useMutation` direto (o estado e a auditoria vivem em
 * `funcionario_desligamentos`, não em `acoes_execucoes` — ver docstring de useMutationComRegistro).
 * Retry é seguro: a RPC é idempotente e o ban também.
 */
export function useDesligarFuncionario() {
  const queryClient = useQueryClient();
  return useMutation<ResultadoDesligamento, Error, PedidoDesligamento>({
    mutationFn: async ({ userId, novoDonoUserId, motivo }) => {
      const { data, error } = await supabase.functions.invoke('desligar-funcionario', {
        body: { user_id: userId, novo_dono_user_id: novoDonoUserId, motivo },
      });
      if (error) {
        throw new Error((await mensagemDoErroEdge(error)) ?? 'Falha ao desligar o funcionário.');
      }
      const r = data as ResultadoDesligamento | null;
      if (!r || (r.status !== 'desligado' && r.status !== 'ja_desligado')) {
        throw new Error('Resposta inesperada do servidor ao desligar.');
      }
      return r;
    },
    onSuccess: (r) => {
      track('equipe.desligamento_concluido', { status: r.status });
      queryClient.invalidateQueries({ queryKey: ['governance-employees'] });
      queryClient.invalidateQueries({ queryKey: ['governance-log'] });
    },
  });
}
