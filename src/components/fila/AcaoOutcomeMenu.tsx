// src/components/fila/AcaoOutcomeMenu.tsx
// Menu de "outcome" de um item da fila do Meu Dia (G2). Despacha por payload.kind
// e escreve no MOTOR DE ORIGEM — zero migration nova: tarefa→concluir,
// rota→OutcomeMenu (registrar_contato_rota), mixgap→markFeedback,
// recompra→BotoesContato (venda_registrar_contato).
// "Não é pra agora" só esconde na sessão atual + emite telemetria.

import { MoreHorizontal, CheckCircle2, EyeOff, Tag, ShoppingCart, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { track } from '@/lib/analytics';
import { useTarefaMutations } from '@/hooks/useTarefas';
import { useMarkMixGapFeedback } from '@/hooks/useMarkMixGapFeedback';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { OutcomeMenu } from '@/components/call/OutcomeMenu';
import { BotoesContato } from '@/components/venda-cliente/BotoesContato';
import type { AcaoSugerida } from '@/lib/fila/types';

interface Props {
  acao: AcaoSugerida;
  /** Esconde o item na sessão (a fonte real continua dona do estado de negócio). */
  onNaoUtilAgora: (dedupeKey: string) => void;
}

/**
 * Menu de "outcome" de um item da fila. Despacha por payload.kind e escreve no
 * MOTOR DE ORIGEM (zero migration): tarefa→concluir, rota→OutcomeMenu (registrar_contato_rota),
 * mixgap→markFeedback. "Não é pra agora" só esconde na sessão + track (fricção medida).
 */
export function AcaoOutcomeMenu({ acao, onNaoUtilAgora }: Props) {
  const tarefas = useTarefaMutations();
  const markGap = useMarkMixGapFeedback();
  const { isImpersonating } = useImpersonation();
  const p = acao.payload;

  const naoUtil = () => {
    onNaoUtilAgora(acao.dedupeKey);
    track('fila.nao_util_agora', { fonte: acao.fonte, dedupeKey: acao.dedupeKey });
  };

  // Recompra: o desfecho é o da LIGAÇÃO, por cliente/dia (escritor único venda_registrar_contato).
  if (p.kind === 'recompra') {
    return <BotoesContato compradorId={p.compradorId} variante="menu" />;
  }

  if (p.kind === 'tarefa') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={isImpersonating}
            title={isImpersonating ? 'Indisponível em modo Ver como' : 'Opções'}
          >
            <MoreHorizontal className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={async () => {
              try {
                await tarefas.concluir(p.tarefaId, 'manual');
                track('fila.outcome', {
                  fonte: 'tarefa',
                  tipo: 'concluir',
                  dedupeKey: acao.dedupeKey,
                });
              } catch {
                /* concluir() já dá toast de erro */
              }
            }}
          >
            <CheckCircle2 className="w-4 h-4 mr-2 text-status-success-bold" /> Concluir
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={naoUtil}>
            <EyeOff className="w-4 h-4 mr-2" /> Não é pra agora
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (p.kind === 'rota') {
    // Reutiliza o OutcomeMenu do PR2c — registra em route_contact_log via RPC.
    // bucket/valor são string|null e number|null, compatíveis com as props opcionais do OutcomeMenu.
    return (
      <OutcomeMenu
        customerUserId={p.customerUserId}
        customerName={acao.clienteNome ?? 'cliente'}
        dataRota={p.dataRota}
        bucket={p.bucket}
        valor={p.valor}
      />
    );
  }

  if (p.kind === 'mixgap') {
    const mark = (status: 'ofertado' | 'convertido' | 'recusado', tipo: string) => {
      markGap.mutate({ customerUserId: p.customerUserId, familia: p.familia, status });
      track('fila.outcome', { fonte: 'mixgap', tipo, dedupeKey: acao.dedupeKey });
    };
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={isImpersonating}
            title={isImpersonating ? 'Indisponível em modo Ver como' : 'Opções'}
          >
            <MoreHorizontal className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => mark('ofertado', 'ofertado')}>
            <Tag className="w-4 h-4 mr-2" /> Já ofereci
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => mark('convertido', 'convertido')}>
            <ShoppingCart className="w-4 h-4 mr-2 text-status-success-bold" /> Cliente comprou
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => mark('recusado', 'recusado')}>
            <XCircle className="w-4 h-4 mr-2" /> Não tem fit
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={naoUtil}>
            <EyeOff className="w-4 h-4 mr-2" /> Não é pra agora
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // 'whatsapp' (ligada no PR-2): o outcome real é RESPONDER — o item sai da fila
  // sozinho quando a mensagem out entra (trigger last_outbound_at). O menu só
  // oferece esconder na sessão.
  if (p.kind === 'whatsapp') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={isImpersonating}
            title={isImpersonating ? 'Indisponível em modo Ver como' : 'Opções'}
          >
            <MoreHorizontal className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={naoUtil}>
            <EyeOff className="w-4 h-4 mr-2" /> Não é pra agora
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return null;
}
