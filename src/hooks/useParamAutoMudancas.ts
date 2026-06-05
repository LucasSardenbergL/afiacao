// Hook: lê o run diário + log de mudanças automáticas de parâmetros de reposição.
// Mutations: reverter item, reverter tudo do run, despinar (devolver ao automático).
// Tabelas ainda fora do Database type → segue o padrão de useAplicacaoFila.ts (as never / as unknown as X).
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export interface ParamAutoRun {
  id: string;
  empresa: string;
  data_negocio_brt: string;
  total_aplicados: number | null;
  total_segurados: number | null;
  total_pinados: number | null;
  impacto_total_rs: number | null;
  impacto_desconhecido_n: number | null;
  concluido_em: string | null;
}

export interface ParamAutoLog {
  id: string;
  run_id: string;
  empresa: string;
  sku_codigo_omie: string;
  sku_descricao: string | null;
  status: string;
  ponto_pedido_antes: number | null;
  ponto_pedido_depois: number | null;
  estoque_minimo_antes: number | null;
  estoque_minimo_depois: number | null;
  estoque_maximo_antes: number | null;
  estoque_maximo_depois: number | null;
  estoque_seguranca_antes: number | null;
  estoque_seguranca_depois: number | null;
  cobertura_antes: number | null;
  cobertura_depois: number | null;
  impacto_rs: number | null;
  qtde_compra_antes: number | null;
  qtde_compra_depois: number | null;
  custo_unitario: number | null;
  demanda_media_diaria: number | null;
  classe_consolidada: string | null;
  revertido_em: string | null;
  revertido_por: string | null;
}

export function useParamAutoMudancas(empresa = 'oben') {
  const qc = useQueryClient();

  // Último run completo da empresa
  const runQuery = useQuery({
    queryKey: ['param-auto-run', empresa],
    queryFn: async (): Promise<ParamAutoRun | null> => {
      const { data, error } = await supabase
        .from('reposicao_param_auto_run' as never)
        .select('id,empresa,data_negocio_brt,total_aplicados,total_segurados,total_pinados,impacto_total_rs,impacto_desconhecido_n,concluido_em')
        .eq('empresa', empresa as never)
        .eq('status', 'completo' as never)
        .order('concluido_em', { ascending: false } as never)
        .limit(1)
        .maybeSingle() as unknown as { data: ParamAutoRun | null; error: { message: string } | null };
      if (error) throw new Error(error.message);
      return data;
    },
    staleTime: 60_000,
  });

  const runId = runQuery.data?.id;

  // Log do run mais recente (habilitado só quando temos o run.id)
  const logQuery = useQuery({
    queryKey: ['param-auto-log', runId],
    enabled: !!runId,
    queryFn: async (): Promise<ParamAutoLog[]> => {
      const { data, error } = await supabase
        .from('reposicao_param_auto_log' as never)
        .select(
          'id,run_id,empresa,sku_codigo_omie,sku_descricao,status,ponto_pedido_antes,ponto_pedido_depois,estoque_minimo_antes,estoque_minimo_depois,estoque_maximo_antes,estoque_maximo_depois,estoque_seguranca_antes,estoque_seguranca_depois,cobertura_antes,cobertura_depois,impacto_rs,qtde_compra_antes,qtde_compra_depois,custo_unitario,demanda_media_diaria,classe_consolidada,revertido_em,revertido_por',
        )
        .eq('run_id', runId! as never)
        .order('impacto_rs', { ascending: false, nullsFirst: false } as never) as unknown as {
          data: ParamAutoLog[] | null;
          error: { message: string } | null;
        };
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    staleTime: 30_000,
  });

  // Reverter item individual
  const reverter = useMutation({
    mutationFn: async (logId: string): Promise<string> => {
      const { data, error } = await supabase.rpc('reverter_parametro_auto' as never, {
        p_log_id: logId,
      } as never) as unknown as { data: string; error: { message: string } | null };
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: (res: string) => {
      if (res === 'revertido') {
        toast.success('Parâmetro revertido — o valor recusado não será re-aplicado até a sugestão mudar.');
      } else if (res === 'conflito') {
        toast.error(
          'Não foi possível reverter: o valor já foi alterado depois da automação. Confira o parâmetro na tela de Revisão.',
        );
      } else {
        toast.info('Nenhuma alteração encontrada para reverter (item já revertido ou não aplicado).');
      }
      void qc.invalidateQueries({ queryKey: ['param-auto-log'] });
    },
    onError: (e: Error) => toast.error(`Falha ao reverter: ${e.message}`),
  });

  // Reverter todos os itens do run
  const reverterTudo = useMutation({
    mutationFn: async (runIdArg: string): Promise<{ revertidos: number; conflitos: number }> => {
      const { data, error } = await supabase.rpc('reverter_run_auto' as never, {
        p_run_id: runIdArg,
      } as never) as unknown as {
        data: { revertidos: number; conflitos: number }[] | null;
        error: { message: string } | null;
      };
      if (error) throw new Error(error.message);
      // reverter_run_auto retorna TABLE → PostgREST embala em array
      return data?.[0] ?? { revertidos: 0, conflitos: 0 };
    },
    onSuccess: ({ revertidos, conflitos }: { revertidos: number; conflitos: number }) => {
      const partes: string[] = [];
      if (revertidos > 0) partes.push(`${revertidos} revertido${revertidos !== 1 ? 's' : ''}`);
      if (conflitos > 0) partes.push(`${conflitos} em conflito (valor já alterado)`);
      if (partes.length === 0) partes.push('nenhuma mudança pendente');
      toast.success(`Reversão concluída — ${partes.join(' · ')}`);
      void qc.invalidateQueries({ queryKey: ['param-auto-log'] });
      void qc.invalidateQueries({ queryKey: ['param-auto-run'] }); // totais do header mudam após reverter tudo
    },
    onError: (e: Error) => toast.error(`Falha ao reverter tudo: ${e.message}`),
  });

  // Despinar: devolve o SKU ao automático (remove o pin de reversão)
  const despinar = useMutation({
    mutationFn: async ({ skuEmpresa, sku }: { skuEmpresa: string; sku: string }): Promise<boolean> => {
      const { data, error } = await supabase.rpc('despinar_parametro' as never, {
        p_empresa: skuEmpresa,
        p_sku: sku,
      } as never) as unknown as { data: boolean; error: { message: string } | null };
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: (found: boolean) => {
      if (found) {
        toast.success('SKU devolvido ao automático — o próximo ciclo poderá re-aplicar a sugestão.');
      } else {
        toast.info('Nenhum pin encontrado para este SKU.');
      }
      void qc.invalidateQueries({ queryKey: ['param-auto-log'] });
      void qc.invalidateQueries({ queryKey: ['param-auto-run'] });
    },
    onError: (e: Error) => toast.error(`Falha ao despinar: ${e.message}`),
  });

  return {
    run: runQuery.data ?? null,
    logs: logQuery.data ?? [],
    isLoading: runQuery.isLoading || (!!runId && logQuery.isLoading),
    reverter,
    reverterTudo,
    despinar,
  };
}
