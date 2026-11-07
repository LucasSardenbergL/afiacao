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
      <SituacaoNoPortal pedido={pedido} fmt={fmt} />
      {pedido.portal_erro && (
        <div className="text-xs text-destructive whitespace-pre-wrap break-words border-t pt-2">
          {pedido.portal_erro}
        </div>
      )}
    </div>
  );
}

/** Sem PO = null, vazio ou '0' (a mesma regra da varredura e do banco). */
function temPo(id: string | null | undefined): boolean {
  const v = (id ?? '').trim();
  return v !== '' && v !== '0';
}

/**
 * Onda 5A: a situação que a varredura LEU no portal (não a que o app acha). 6 = cancelado no fornecedor: sem PO, o
 * disparo está bloqueado no banco; com PO, o PO existe para um pedido que a Sayerlack cancelou.
 */
function SituacaoNoPortal({ pedido, fmt }: { pedido: PedidoSugerido; fmt: (iso: string | null | undefined) => string }) {
  if (!pedido.portal_situacao_codigo) return null;
  const doProtocoloAtual = (pedido.portal_situacao_protocolo ?? '') === (pedido.portal_protocolo ?? '').trim();
  const cancelado = pedido.portal_situacao_codigo === '6';
  return (
    <div className="border-t pt-2 space-y-1 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">Situação no portal</span>
        <span className={cn('text-right', cancelado && 'font-semibold text-status-error')}>
          {pedido.portal_situacao_texto ?? pedido.portal_situacao_codigo}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">Lida em</span>
        <span className="text-right tabular-nums">{fmt(pedido.portal_situacao_em)}</span>
      </div>
      {!doProtocoloAtual && (
        <p className="text-status-warning">
          Leitura do protocolo anterior ({pedido.portal_situacao_protocolo}); o protocolo atual ainda não foi lido.
        </p>
      )}
      {cancelado && (
        <p className="text-status-error">
          {temPo(pedido.omie_pedido_compra_id)
            ? 'Cancelado no portal, mas há pedido de compra no Omie — confira com a Sayerlack e cancele ou ajuste o PO.'
            : 'Cancelado no portal: o disparo deste pedido está bloqueado (não vira pedido de compra no Omie).'}
        </p>
      )}
    </div>
  );
}
