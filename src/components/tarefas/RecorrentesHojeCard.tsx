/**
 * RecorrentesHojeCard — card das tarefas recorrentes do operador (Fase 2, Task 8).
 *
 * Exibe as instâncias materializadas hoje (template_id not null) para o operador
 * logado. Espelha o visual do MinhasTarefasCard da Fase 1.
 *
 * Concluir:
 *   - COM comprovação (requer_comprovacao=true) → abre ComprovacaoDialog
 *     → concluirComComprovacao (RPC SECURITY DEFINER)
 *   - SEM comprovação → concluir('manual') — update direto, mesma rota da Fase 1;
 *     o trigger anti-bypass não bloqueia pois requer_comprovacao=false.
 *
 * Os limites de leitura (leituraMin/Max/Unidade) vêm da PRÓPRIA instância
 * (denormalizados do template na materialização — UI-3). Isso evita o gap de
 * RLS em cobertura/férias, onde a tarefa aparece mas o template não é visível.
 */

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useMinhasRecorrentesHoje } from '@/hooks/useTarefasFase2';
import { useTarefaMutations } from '@/hooks/useTarefas';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { ComprovacaoDialog } from './ComprovacaoDialog';
import type { TarefaInstancia } from '@/lib/tarefas/templates-types';

export function RecorrentesHojeCard() {
  const { isImpersonating } = useImpersonation();
  const { data: tarefas = [], isLoading } = useMinhasRecorrentesHoje();
  const { concluir } = useTarefaMutations();

  // Dialog de comprovação
  const [dialogAlvo, setDialogAlvo] = useState<TarefaInstancia | null>(null);

  // Estado de loading por tarefa (conclusão direta sem prova)
  const [concluidoPor, setConcluidoPor] = useState<string | null>(null);

  // Retorna null quando não há tarefas (não polui o dashboard)
  if (isLoading || tarefas.length === 0) return null;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleConcluir = async (tarefa: TarefaInstancia) => {
    if (tarefa.requer_comprovacao) {
      // Abre o dialog; a conclusão real acontece lá dentro
      setDialogAlvo(tarefa);
      return;
    }

    // Sem comprovação: conclusão direta (mesma rota do MinhasTarefasCard)
    setConcluidoPor(tarefa.id);
    try {
      await concluir(tarefa.id, 'manual');
    } finally {
      setConcluidoPor(null);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      <Card className="p-4 border-status-info/40">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-4 h-4 text-status-info" />
          <h2 className="font-display text-lg">Tarefas de hoje</h2>
          <span className="text-2xs text-muted-foreground">{tarefas.length}</span>
          {isImpersonating && (
            <span className="ml-auto text-2xs text-muted-foreground">
              Somente leitura (Ver como)
            </span>
          )}
        </div>

        <ul className="space-y-2">
          {tarefas.map((t) => {
            const atrasada = t.atrasada;
            const estaConcluidoPor = concluidoPor === t.id;

            return (
              <li
                key={t.id}
                className={
                  `rounded-md border p-3 ` +
                  (atrasada
                    ? 'border-status-error/40 bg-status-error-bg'
                    : 'border-border')
                }
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug">{t.descricao}</p>
                    <p className="text-2xs text-muted-foreground mt-0.5">
                      {atrasada && (
                        <AlertTriangle className="inline w-3 h-3 text-status-error mr-1" />
                      )}
                      {t.categoria}
                      {t.janela_fim && (
                        <span className="ml-1">
                          · até {t.janela_fim.slice(0, 5)}
                        </span>
                      )}
                      {t.requer_comprovacao && (
                        <span className="ml-1 text-muted-foreground/70">· prova exigida</span>
                      )}
                    </p>
                  </div>

                  <Button
                    size="sm"
                    variant={atrasada ? 'destructive' : 'outline'}
                    disabled={isImpersonating || estaConcluidoPor}
                    onClick={() => handleConcluir(t)}
                    className="shrink-0"
                  >
                    {estaConcluidoPor ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <>
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        Concluir
                      </>
                    )}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {/* Dialog de comprovação — montado fora da lista pra não re-renderizar */}
      {dialogAlvo && (
        <ComprovacaoDialog
          open={!!dialogAlvo}
          onOpenChange={(o) => { if (!o) setDialogAlvo(null); }}
          tarefa={dialogAlvo}
          leituraMin={dialogAlvo.leitura_min ?? null}
          leituraMax={dialogAlvo.leitura_max ?? null}
          leituraUnidade={dialogAlvo.leitura_unidade ?? null}
        />
      )}
    </>
  );
}
