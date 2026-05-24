// Painel: histórico de ações do pedido (timeline).
// Extraído verbatim de src/components/reposicao/pedidos/DetalhesModal.tsx (god-component split).
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { PedidoSugerido } from './types';

export function HistoricoAcoesPanel({ pedido }: { pedido: PedidoSugerido | null }) {
  if (!pedido) return null;
  type Evt = { ts: string; label: string; by?: string | null; detail?: string | null; tone: 'default' | 'success' | 'warn' | 'danger' };
  const evts: Evt[] = [];
  if (pedido.criado_em) evts.push({ ts: pedido.criado_em, label: 'Pedido gerado', tone: 'default' });
  if (pedido.aprovado_em) evts.push({ ts: pedido.aprovado_em, label: 'Aprovado', by: pedido.aprovado_por, tone: 'success' });
  if (pedido.enviado_portal_em) {
    evts.push({
      ts: pedido.enviado_portal_em,
      label: 'Enviado ao portal',
      detail: pedido.portal_protocolo ? `Protocolo ${pedido.portal_protocolo}` : null,
      tone: pedido.status_envio_portal === 'falha_envio_portal' ? 'danger' : 'success',
    });
  }
  if (pedido.horario_disparo_real) evts.push({ ts: pedido.horario_disparo_real, label: 'Disparado', tone: 'success' });
  if (pedido.omie_registrado_em) evts.push({
    ts: pedido.omie_registrado_em,
    label: 'Registrado no Omie',
    detail: pedido.omie_pedido_compra_numero ? `Nº ${pedido.omie_pedido_compra_numero}` : null,
    tone: 'success',
  });
  if (pedido.cancelado_em) evts.push({
    ts: pedido.cancelado_em,
    label: 'Cancelado',
    by: pedido.cancelado_por,
    detail: pedido.justificativa_cancelamento,
    tone: 'danger',
  });
  evts.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  const fmt = (iso: string) => {
    try { return format(new Date(iso), "dd/MM/yyyy HH:mm", { locale: ptBR }); } catch { return iso; }
  };
  const dotCls: Record<Evt['tone'], string> = {
    default: 'bg-muted-foreground',
    success: 'bg-status-success',
    warn: 'bg-status-warning',
    danger: 'bg-destructive',
  };
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="text-sm font-medium mb-2">Histórico de ações</div>
      {evts.length === 0 ? (
        <div className="text-xs text-muted-foreground py-2">Sem eventos registrados.</div>
      ) : (
        <ol className="space-y-2.5">
          {evts.map((e, i) => (
            <li key={i} className="flex gap-2.5 text-xs">
              <div className="flex flex-col items-center pt-0.5">
                <span className={cn('h-2 w-2 rounded-full', dotCls[e.tone])} />
                {i < evts.length - 1 && <span className="flex-1 w-px bg-border mt-1" />}
              </div>
              <div className="flex-1 pb-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{e.label}</span>
                  <span className="tabular-nums text-muted-foreground">{fmt(e.ts)}</span>
                </div>
                {(e.by || e.detail) && (
                  <div className="text-muted-foreground mt-0.5 break-words">
                    {e.by && <span>por {e.by}</span>}
                    {e.by && e.detail && <span> · </span>}
                    {e.detail && <span>{e.detail}</span>}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
