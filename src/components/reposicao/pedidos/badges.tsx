import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Status, StatusEnvioPortal, PedidoSugerido } from './types';
import { statusMeta, portalStatusMeta } from './shared';

export function StatusBadge({ status }: { status: Status }) {
  const meta = statusMeta[status] ?? { label: status, variant: 'outline' as const };
  return (
    <Badge variant={meta.variant} className={meta.className}>
      {meta.label}
    </Badge>
  );
}

// Piloto N3: marca pedido aprovado pela MÁQUINA (tick de auto-aprovação Sayerlack,
// aprovado_por = 'auto:<estrato>'). Visibilidade de qual compra foi decidida sem humano.
export function AutoBadge({ pedido }: { pedido: PedidoSugerido }) {
  if (!pedido.aprovado_por?.startsWith('auto:')) return null;
  return (
    <Badge
      variant="outline"
      className="bg-status-info-bg text-status-info border-status-info/30 ml-1"
      title={`Aprovado automaticamente (${pedido.aprovado_por})`}
    >
      auto
    </Badge>
  );
}

// Ícone de info com tooltip ao lado do status — revela o MOTIVO (bloqueio do
// guardrail / falha do disparo) sem precisar abrir os detalhes. Renderiza null
// quando o motivo é vazio. Compartilhado entre PedidoRow e a fila de atenção.
function MotivoTooltip({ motivo, label }: { motivo: string | null | undefined; label: string }) {
  if (!motivo) return null;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="inline-flex items-center text-status-error hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
          >
            <Info className="w-3.5 h-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs whitespace-pre-wrap break-words">{motivo}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Status do pedido + ícone de motivo (bloqueio/falha) quando houver. Centraliza a
// regra para PedidoRow e a fila de atenção exibirem o mesmo "porquê" inline.
export function StatusComMotivo({ pedido }: { pedido: PedidoSugerido }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <StatusBadge status={pedido.status} />
      <AutoBadge pedido={pedido} />
      {pedido.status === 'bloqueado_guardrail' && (
        <MotivoTooltip motivo={pedido.mensagem_bloqueio} label="Motivo do bloqueio" />
      )}
      {pedido.status === 'falha_envio' && (
        <MotivoTooltip motivo={pedido.resposta_canal?.erro} label="Motivo da falha no disparo" />
      )}
    </div>
  );
}

// PR5: indica visualmente o split. Renderiza algo só quando o pedido
// participa de um split (pai ou filho); senão é null e não polui a UI.
export function SplitInfo({ pedido }: { pedido: PedidoSugerido }) {
  // Pai (status_em_filhos): mostra "em N partes"
  if (pedido.status === 'split_em_filhos' && pedido.split_total) {
    return (
      <Badge variant="outline" className="bg-status-purple-bg text-status-purple border-status-purple/30 ml-1">
        em {pedido.split_total} partes
      </Badge>
    );
  }
  // Filho (split_parent_id preenchido): mostra "Lote X/N"
  if (pedido.split_parent_id && pedido.split_lote && pedido.split_total) {
    return (
      <Badge
        variant="outline"
        className="bg-status-purple-bg text-status-purple border-status-purple/30 ml-1"
        title={`Filho do pedido #${pedido.split_parent_id}`}
      >
        Lote {pedido.split_lote}/{pedido.split_total}
      </Badge>
    );
  }
  return null;
}

export function PortalBadge({
  pedido,
  onClick,
}: {
  pedido: PedidoSugerido;
  onClick: () => void;
}) {
  const status = (pedido.status_envio_portal ?? 'nao_aplicavel') as StatusEnvioPortal;
  const meta = portalStatusMeta[status] ?? portalStatusMeta.nao_aplicavel;

  const tooltipText =
    (status === 'enviado_portal' || status === 'sucesso_portal') && pedido.portal_protocolo
      ? `Protocolo: ${pedido.portal_protocolo}`
      : (status === 'falha_envio_portal' || status === 'erro_nao_retentavel') && pedido.portal_erro
        ? pedido.portal_erro
        : (status === 'aceito_portal_sem_protocolo' || status === 'indeterminado_requer_conciliacao')
          ? 'Portal pode ter recebido — verifique e concilie manualmente'
          : status === 'erro_retentavel' && pedido.portal_erro
            ? `Retentável: ${pedido.portal_erro}`
            : null;

  const badge = (
    <button
      type="button"
      onClick={onClick}
      disabled={status === 'nao_aplicavel'}
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
        meta.className,
        status === 'nao_aplicavel' ? 'cursor-default' : 'cursor-pointer hover:opacity-80',
      )}
    >
      {meta.label}
    </button>
  );

  if (!tooltipText) return badge;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent className="max-w-xs whitespace-pre-wrap break-words">{tooltipText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
