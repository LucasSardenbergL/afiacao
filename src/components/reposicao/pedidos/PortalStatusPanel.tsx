// Painel: status de envio ao portal.
// Extraído verbatim de src/components/reposicao/pedidos/DetalhesModal.tsx (god-component split).
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { PedidoSugerido, StatusEnvioPortal } from './types';
import { portalStatusMeta } from './shared';

export function PortalStatusPanel({ pedido }: { pedido: PedidoSugerido | null }) {
  if (!pedido) return null;
  const status = (pedido.status_envio_portal ?? 'nao_aplicavel') as StatusEnvioPortal;
  const meta = portalStatusMeta[status] ?? portalStatusMeta.nao_aplicavel;
  const tentativas = pedido.portal_tentativas ?? 0;
  const fmt = (iso: string | null | undefined) => {
    if (!iso) return '—';
    try { return format(new Date(iso), "dd/MM/yyyy HH:mm", { locale: ptBR }); } catch { return '—'; }
  };
  return (
    <div className="rounded-md border bg-muted/20 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Status de envio ao portal</div>
        <span className={cn(
          'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold',
          meta.className,
        )}>{meta.label}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Enviado em</dt>
        <dd className="text-right tabular-nums">{fmt(pedido.enviado_portal_em)}</dd>
        <dt className="text-muted-foreground">Protocolo</dt>
        <dd className="text-right font-mono">{pedido.portal_protocolo ?? '—'}</dd>
        <dt className="text-muted-foreground">Tentativas</dt>
        <dd className="text-right tabular-nums">{tentativas}</dd>
        <dt className="text-muted-foreground">Próx. retry</dt>
        <dd className="text-right tabular-nums">{fmt(pedido.portal_proximo_retry_em)}</dd>
      </dl>
      {pedido.portal_erro && (
        <div className="text-xs text-destructive whitespace-pre-wrap break-words border-t pt-2">
          {pedido.portal_erro}
        </div>
      )}
    </div>
  );
}
