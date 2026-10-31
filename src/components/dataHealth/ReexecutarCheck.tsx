import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { UltimaExecucao } from '@/components/execucoes/UltimaExecucao';
import { useMutationComRegistro } from '@/components/execucoes/useMutationComRegistro';
import { ULTIMA_EXECUCAO_QUERY_KEY } from '@/components/execucoes/tipos';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { invokeFunction } from '@/lib/invoke-function';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import type { DataHealthCheck } from '@/lib/dataHealth/types';
import {
  desfechoDaResposta, desfechoDoErro, reexecucaoDoCheck,
  type DesfechoReexecucao, type Reexecucao,
} from '@/lib/dataHealth/reexecutar';

async function disparar(r: Reexecucao): Promise<DesfechoReexecucao> {
  try {
    if (r.alvo.tipo === 'rpc') {
      const { error } = await supabase.rpc(r.alvo.nome);
      if (error) throw error;
      return 'disparado';
    }
    return desfechoDaResposta(await invokeFunction(r.alvo.nome, r.alvo.body));
  } catch (e) {
    const desfecho = desfechoDoErro(e);
    if (desfecho) return desfecho;
    throw e;
  }
}

function useAoTerminar(source: string) {
  const queryClient = useQueryClient();
  return {
    onSuccess: (desfecho: DesfechoReexecucao) => {
      track('saude_dados.reexecutar', { source, desfecho });
      if (desfecho === 'em_andamento') {
        toast.info('Já há uma execução em andamento — este clique não rodou nada.');
        return;
      }
      // Não diz "resolvido": o check só volta a verde quando o compute ler a fonte fresca.
      toast.success('Disparado. O check volta a verde quando a próxima leitura confirmar.');
      queryClient.invalidateQueries({ queryKey: ['data-health'] });
    },
    onError: (e: Error) => {
      track('saude_dados.reexecutar', { source, desfecho: 'erro' });
      toast.error('Re-execução falhou', { description: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.' });
    },
  };
}

function Painel({ r, pendente, onClick }: { r: Reexecucao; pendente: boolean; onClick: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mt-1.5">
      <Button size="sm" variant="outline" disabled={pendente || isLensActive()} onClick={onClick}>
        <RotateCw className={`h-3.5 w-3.5 mr-1.5 ${pendente ? 'animate-spin' : ''}`} />
        {r.rotulo}
      </Button>
      <UltimaExecucao acao={r.acao} />
    </div>
  );
}

/** Front é o escritor do slug: registra a execução em acoes_execucoes. */
function ReexecutarRegistrandoNoFront({ r, source }: { r: Reexecucao; source: string }) {
  const m = useMutationComRegistro<DesfechoReexecucao>({
    acao: r.acao,
    mutationFn: () => disparar(r),
    detalhes: desfecho => ({ source, desfecho }),
    ...useAoTerminar(source),
  });
  return <Painel r={r} pendente={m.isPending} onClick={() => m.mutate()} />;
}

/** A edge já grava o slug (comRegistro server-side): o front só dispara e re-lê a caption. */
function ReexecutarRegistradoPelaEdge({ r, source }: { r: Reexecucao; source: string }) {
  const queryClient = useQueryClient();
  const m = useMutation<DesfechoReexecucao, Error>({
    mutationFn: () => disparar(r),
    ...useAoTerminar(source),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [ULTIMA_EXECUCAO_QUERY_KEY] }),
  });
  return <Painel r={r} pendente={m.isPending} onClick={() => m.mutate()} />;
}

export function ReexecutarCheck({ check }: { check: DataHealthCheck }) {
  const r = reexecucaoDoCheck(check);
  if (!r) return null;
  return r.escritor === 'front'
    ? <ReexecutarRegistrandoNoFront r={r} source={check.source} />
    : <ReexecutarRegistradoPelaEdge r={r} source={check.source} />;
}
