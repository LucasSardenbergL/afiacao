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
          className={cn('border-blue-300 bg-blue-50 text-blue-700', className)}
        >
          Aguardando
        </Badge>
      );
    case 'enviando_portal':
      return (
        <Badge
          variant="outline"
          className={cn(
            'border-blue-400 bg-blue-100 text-blue-800 animate-pulse',
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
          className={cn('border-blue-300 bg-blue-50 text-blue-700', className)}
        >
          Retentável
        </Badge>
      );
    case 'enviado_portal':
    case 'sucesso_portal':
      return (
        <Badge
          variant="outline"
          className={cn('border-green-300 bg-green-50 text-green-700', className)}
        >
          ✓ Enviado
        </Badge>
      );
    case 'aceito_portal_sem_protocolo':
      return (
        <Badge
          variant="outline"
          className={cn('border-amber-300 bg-amber-50 text-amber-800', className)}
          title="Portal aceitou o pedido mas sem protocolo confirmado — requer conciliação manual"
        >
          Sem protocolo
        </Badge>
      );
    case 'indeterminado_requer_conciliacao':
      return (
        <Badge
          variant="outline"
          className={cn('border-amber-300 bg-amber-50 text-amber-800', className)}
          title="Resultado ambíguo — verifique o portal e confirme manualmente"
        >
          Requer conciliação
        </Badge>
      );
    case 'erro_nao_retentavel':
      return (
        <Badge
          variant="outline"
          className={cn('border-red-300 bg-red-50 text-red-700', className)}
          title="Falha definitiva — não será retentado automaticamente"
        >
          Falha definitiva
        </Badge>
      );
    case 'falha_envio_portal':
      return (
        <Badge
          variant="outline"
          className={cn('border-red-300 bg-red-50 text-red-700', className)}
        >
          Falhou
        </Badge>
      );
    default:
      return <Badge variant="outline" className={className}>{status}</Badge>;
  }
}
