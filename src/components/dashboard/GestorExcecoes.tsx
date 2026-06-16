// src/components/dashboard/GestorExcecoes.tsx
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { track } from '@/lib/analytics';
import { useExcecoesGestor } from '@/hooks/useExcecoesGestor';
import { useTarefaMutations } from '@/hooks/useTarefas';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { LinhaExcecao, Severidade } from '@/lib/gestor/excecoes/types';

const SEV_CLS: Record<Severidade, string> = {
  critico: 'text-status-error', aviso: 'text-status-warning', info: 'text-status-info',
};

function LinhaItem({ linha, onRodarAgente }: { linha: LinhaExcecao; onRodarAgente: () => void }) {
  const { resolverSugestao } = useTarefaMutations();
  const a = linha.acao;
  return (
    <div className="p-2.5 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className={`text-sm font-medium ${SEV_CLS[linha.severidade]}`}>{linha.titulo}</div>
        <div className="text-2xs text-muted-foreground flex flex-wrap gap-2 items-center mt-0.5">
          {linha.detalhe && <span className="truncate">{linha.detalhe}</span>}
          {linha.donoNome && <span className="font-tabular">{linha.donoNome}</span>}
          <span className="opacity-70">{linha.reciboFonte}{linha.reciboFrescor ? ` · ${linha.reciboFrescor}` : ''}</span>
          {linha.badges.map(b => <Badge key={b} variant="outline" className="text-2xs">{b}</Badge>)}
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-1">
        {a.tipo === 'abrir_cliente' && (
          <Button asChild size="sm" variant="outline">
            <Link to={`/admin/customers/${a.clienteUserId}/360`} onClick={() => track('gestor.excecoes_acted', { tipo: 'abrir_cliente' })}>Abrir</Link>
          </Button>
        )}
        {a.tipo === 'tarefa' && (
          <>
            {a.candidatoId && (
              <Button size="sm" variant="outline" onClick={() => { track('gestor.excecoes_acted', { tipo: 'confirmar_tarefa' }); resolverSugestao(a.candidatoId!, a.tarefaId, true); }}>Confirmar</Button>
            )}
            <Button asChild size="sm" variant="ghost">
              <Link to="/tarefas" onClick={() => track('gestor.excecoes_acted', { tipo: 'abrir_tarefa' })}>Abrir</Link>
            </Button>
          </>
        )}
        {a.tipo === 'rodar_agente' && (
          <Button size="sm" variant="outline" onClick={onRodarAgente}>Atualizar análise da carteira</Button>
        )}
      </div>
    </div>
  );
}

/** Console de exceções do founder (Buddy v2). Determinístico, master-only. */
export function GestorExcecoes() {
  const { data, isLoading, refetchAll } = useExcecoesGestor();
  const shownRef = useRef(false);

  useEffect(() => {
    if (!data || shownRef.current) return;
    shownRef.current = true;
    track('gestor.excecoes_shown', {
      total: data.totalLinhas,
      grupos: data.grupos.map(g => g.key),
      excedente: data.excedente,
    });
  }, [data]);

  const onRodarAgente = async () => {
    track('gestor.excecoes_run_agent', {});
    const { error } = await supabase.functions.invoke('ai-ops-agent');
    if (error) { toast.error('Erro ao atualizar análise'); return; }
    toast.success('Análise atualizada');
    refetchAll();
  };

  if (isLoading) {
    return <Card className="p-3 space-y-2"><Skeleton className="h-4 w-40" />{[0, 1].map(i => <Skeleton key={i} className="h-10 w-full" />)}</Card>;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <h2 className="text-base font-medium">Exceções — o que está fora do lugar</h2>
        <p className="text-2xs text-muted-foreground">Só o que precisa de atenção hoje. Cada linha mostra a fonte e o frescor.</p>
      </CardHeader>
      {!data || data.vazio ? (
        <div className="p-6 text-2xs text-muted-foreground">Tudo no lugar hoje 🎯</div>
      ) : (
        <div className="divide-y divide-border">
          {data.grupos.map(g => (
            <div key={g.key}>
              <div className="px-2.5 pt-2 pb-1 text-2xs uppercase tracking-wide text-muted-foreground">{g.titulo}</div>
              <div className="divide-y divide-border/50">
                {g.linhas.map(l => <LinhaItem key={l.id} linha={l} onRodarAgente={onRodarAgente} />)}
              </div>
            </div>
          ))}
          {data.excedente > 0 && (
            <div className="px-2.5 py-2 text-2xs text-muted-foreground">+{data.excedente} exceções não exibidas (teto do resumo).</div>
          )}
        </div>
      )}
    </Card>
  );
}
