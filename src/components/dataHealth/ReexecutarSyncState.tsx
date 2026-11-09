import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import type { DataHealthCheck } from '@/lib/dataHealth/types';
import { acaoDaEntidade, entidadesNaoOk, type EntidadeNaoOk } from '@/lib/dataHealth/syncState';
import { BotaoReexecucao } from './ReexecutarCheck';

const SOURCE = 'sync_state_saude';

function AcaoEntidade({ e }: { e: EntidadeNaoOk }) {
  const a = acaoDaEntidade(e);
  if (a.tipo === 'botao') return <BotaoReexecucao r={a.r} rastro={{ source: SOURCE, entidade: e.chave }} />;
  // Run vivo (running com heartbeat recente): disparar de novo só empilharia um 2º run no Omie.
  if (a.tipo === 'em_andamento') return <p className="text-xs text-status-info mt-0.5">Já em andamento — aguarde o run terminar.</p>;
  return <p className="text-xs text-muted-foreground mt-0.5">Sem botão: {a.porque}.</p>;
}

/** Lista as entidades não-ok do `sync_state_saude` vermelho, cada uma com a sua re-execução (ou o porquê de não ter). */
export function ReexecutarSyncState({ check }: { check: DataHealthCheck }) {
  const ativo = check.source === SOURCE && check.status !== 'ok';
  // Prefixo 'data-health': o invalidate pós-disparo (ReexecutarCheck) também re-lê esta lista.
  const q = useQuery({
    queryKey: ['data-health', 'sync-state'],
    enabled: ativo,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sync_state')
        .select('entity_type, account, status, last_sync_at, updated_at, created_at, error_message');
      if (error) throw error;
      return data;
    },
  });

  if (!ativo) return null;
  if (q.isPending) return <p className="text-xs text-muted-foreground mt-1.5">Lendo as entidades do sync…</p>;
  if (q.isError) {
    return <p className="text-xs text-status-error mt-1.5">Não consegui ler sync_state: {mensagemDeErro(q.error) ?? 'erro sem mensagem'}</p>;
  }

  const entidades = entidadesNaoOk(q.data, new Date());
  if (entidades.length === 0) {
    // O compute é a fonte da verdade da cor; o espelho do front pode ter ficado para trás.
    return (
      <p className="text-xs text-status-warning mt-1.5">
        O check acusa, mas a leitura do front não achou entidade não-ok — a regra do compute pode ter mudado. Siga o "Como resolver".
      </p>
    );
  }
  return (
    <ul className="mt-1.5 space-y-2">
      {entidades.map(e => (
        <li key={e.chave}>
          <p className="text-xs">
            <span className="font-mono">{e.chave}</span> — {e.motivo}
            <span className={e.grau === 'broken' ? 'text-status-error' : 'text-status-warning'}> · {e.grau}</span>
          </p>
          <AcaoEntidade e={e} />
        </li>
      ))}
    </ul>
  );
}
