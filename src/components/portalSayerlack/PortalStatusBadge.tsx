import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type Status =
  | 'pendente_envio_portal'
  | 'enviando_portal'
  | 'enviado_portal'
  | 'sucesso_portal'
  | 'aceito_portal_sem_protocolo'
  | 'indeterminado_requer_conciliacao'
  | 'erro_retentavel'
  | 'erro_nao_retentavel'
  | 'falha_envio_portal'
  | string
  | null;

interface Props {
  status: Status;
  className?: string;
}

export function PortalStatusBadge({ status, className }: Props) {
  if (!status) return <span className="text-muted-foreground">—</span>;

  switch (status) {
    case 'pendente_envio_portal':
      return (
        <Badge
          variant="outline"
          className={cn('border-status-info/40 bg-status-info-bg text-status-info', className)}
        >
          Aguardando
        </Badge>
      );
    case 'enviando_portal':
      return (
        <Badge
          variant="outline"
          className={cn(
            'border-status-info/60 bg-status-info/15 text-status-info animate-pulse',
            className,
          )}
        >
          Enviando…
        </Badge>
      );
    case 'erro_retentavel':
      return (
        <Badge
          variant="outline"
          className={cn('border-status-info/40 bg-status-info-bg text-status-info', className)}
        >
          Retentável
        </Badge>
      );
    case 'enviado_portal':
    case 'sucesso_portal':
      return (
        <Badge
          variant="outline"
          className={cn('border-status-success/40 bg-status-success-bg text-status-success', className)}
        >
          ✓ Enviado
        </Badge>
      );
    case 'aceito_portal_sem_protocolo':
      return (
        <Badge
          variant="outline"
          className={cn('border-status-warning/40 bg-status-warning-bg text-status-warning', className)}
          title="Portal aceitou o pedido mas sem protocolo confirmado — requer conciliação manual"
        >
          Sem protocolo
        </Badge>
      );
    case 'indeterminado_requer_conciliacao':
      return (
        <Badge
          variant="outline"
          className={cn('border-status-warning/40 bg-status-warning-bg text-status-warning', className)}
          title="Resultado ambíguo — verifique o portal e confirme manualmente"
        >
          Requer conciliação
        </Badge>
      );
    case 'erro_nao_retentavel':
      return (
        <Badge
          variant="outline"
          className={cn('border-status-error/40 bg-status-error-bg text-status-error', className)}
          title="Falha definitiva — não será retentado automaticamente"
        >
          Falha definitiva
        </Badge>
      );
    case 'falha_envio_portal':
      return (
        <Badge
          variant="outline"
          className={cn('border-status-error/40 bg-status-error-bg text-status-error', className)}
        >
          Falhou
        </Badge>
      );
    default:
      return <Badge variant="outline" className={className}>{status}</Badge>;
  }
}
