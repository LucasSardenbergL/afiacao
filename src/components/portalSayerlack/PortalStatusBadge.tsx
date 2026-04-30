import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type Status =
  | 'pendente_envio_portal'
  | 'enviando_portal'
  | 'enviado_portal'
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
    case 'enviado_portal':
      return (
        <Badge
          variant="outline"
          className={cn('border-green-300 bg-green-50 text-green-700', className)}
        >
          ✓ Enviado
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
