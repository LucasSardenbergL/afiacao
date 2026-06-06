import { Button } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';
import { Eye, ExternalLink, Loader2, XCircle, Zap } from 'lucide-react';
import { format } from 'date-fns';
import { PedidoSugerido } from './types';
import { formatBRL } from './shared';
import { StatusComMotivo, SplitInfo, PortalBadge } from './badges';

export function PedidoRow({
  p,
  onVerDetalhes,
  onCancelar,
  onVerPortal,
  onDisparar,
  disparando,
}: {
  p: PedidoSugerido;
  onVerDetalhes: () => void;
  onCancelar: () => void;
  onVerPortal: () => void;
  onDisparar: () => void;
  disparando: boolean;
}) {
  const podeAprovar = p.status === 'pendente_aprovacao' || p.status === 'bloqueado_guardrail';
  const podeCancelar = ['pendente_aprovacao', 'bloqueado_guardrail', 'aprovado_aguardando_disparo'].includes(p.status);
  // Re-disparo: a edge disparar-pedidos-aprovados aceita pedido em falha_envio via
  // pedido_id (index.ts:1005). Sem isso, falha_envio só tinha "Detalhes" — não havia
  // como re-disparar pela UI (precisava flip de status no banco).
  const podeReDisparar = p.status === 'falha_envio';
  const podeDisparar = p.status === 'aprovado_aguardando_disparo' || podeReDisparar;
  // Guard de concorrência: enquanto o envio ao portal está em voo (após "aprovar e
  // disparar" ou um disparo manual), trava o botão pra não abrir uma 2ª sessão no
  // Browserless e gerar PO duplicado no fornecedor.
  const enviandoPortal = p.status_envio_portal === 'enviando_portal';

  const showAprovacao = p.status === 'aprovado_aguardando_disparo' || p.status === 'disparado';

  return (
    <TableRow className={p.status === 'bloqueado_guardrail' ? 'bg-destructive/5' : ''}>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1">
          <StatusComMotivo pedido={p} />
          <SplitInfo pedido={p} />
        </div>
      </TableCell>
      <TableCell>
        <div className="font-medium">{p.fornecedor_nome}</div>
        <div className="text-xs text-muted-foreground">{p.grupo_codigo ?? '—'}</div>
      </TableCell>
      <TableCell className="text-right tabular-nums">{p.num_skus}</TableCell>
      <TableCell className="text-right tabular-nums font-medium">{formatBRL(p.valor_total)}</TableCell>
      <TableCell>
        <PortalBadge pedido={p} onClick={onVerPortal} />
      </TableCell>
      <TableCell className="text-xs">
        {showAprovacao && p.aprovado_em ? (
          <div className="font-medium tabular-nums">{format(new Date(p.aprovado_em), 'dd/MM HH:mm')}</div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={onVerDetalhes}>
            <Eye className="w-4 h-4 mr-1" />Detalhes
          </Button>
          {podeAprovar && (
            <Button size="sm" variant="default" onClick={onVerDetalhes}>Aprovar</Button>
          )}
          {podeDisparar && (
            <Button size="sm" variant={podeReDisparar ? 'outline' : 'default'} onClick={onDisparar} disabled={disparando || enviandoPortal}>
              {(disparando || enviandoPortal) ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Zap className="w-4 h-4 mr-1" />}
              {enviandoPortal ? 'Enviando…' : (podeReDisparar ? 'Re-disparar' : 'Disparar')}
            </Button>
          )}
          {podeCancelar && (
            <Button size="sm" variant="outline" onClick={onCancelar}>
              <XCircle className="w-4 h-4" />
            </Button>
          )}
          {p.status === 'disparado' && p.omie_pedido_compra_numero && (
            <Button size="sm" variant="ghost" asChild>
              <a href={`https://app.omie.com.br/`} target="_blank" rel="noreferrer">
                <ExternalLink className="w-4 h-4 mr-1" />Omie
              </a>
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
