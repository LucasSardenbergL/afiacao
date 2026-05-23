// Aba "Conciliar" (conciliação manual) do Portal Sayerlack.
// Extraída de src/pages/AdminPortalSayerlack.tsx (god-component split).
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PortalStatusBadge } from '@/components/portalSayerlack/PortalStatusBadge';
import { fmtBRL, fmtDate, fmtDateTime, relTime, type PedidoRow } from './types';

export function ConciliarTab({
  loading, rows, busca, setBusca, onOpenDrawer,
}: {
  loading: boolean;
  rows: PedidoRow[];
  busca: string;
  setBusca: (v: string) => void;
  onOpenDrawer: (id: number) => void;
}) {
  return (
    <>
      <div className="rounded-md border border-status-warning/40 bg-status-warning-bg p-3 text-sm text-status-warning-foreground">
        <strong>Conciliação manual:</strong> pedidos abaixo podem ter sido recebidos pelo
        portal Sayerlack mas o sistema não confirmou o protocolo. Abra o detalhe, verifique
        no portal e informe o número do pedido para liberar o registro no Omie.
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="Buscar por ID…"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className="max-w-xs"
        />
      </div>
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">Nenhum pedido aguardando conciliação.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>Data ciclo</TableHead>
                  <TableHead className="text-right">SKUs</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead>Aprovado</TableHead>
                  <TableHead>Motivo</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell><PortalStatusBadge status={p.status_envio_portal} /></TableCell>
                    <TableCell>
                      <Link
                        to={`/admin/reposicao/pedidos?pedido=${p.id}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        #{p.id}
                      </Link>
                    </TableCell>
                    <TableCell>{fmtDate(p.data_ciclo)}</TableCell>
                    <TableCell className="text-right">{p.num_skus ?? '—'}</TableCell>
                    <TableCell className="text-right">{fmtBRL(p.valor_total)}</TableCell>
                    <TableCell title={fmtDateTime(p.aprovado_em)}>{relTime(p.aprovado_em)}</TableCell>
                    <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={p.portal_erro ?? undefined}>
                      {p.portal_erro ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="default" onClick={() => onOpenDrawer(p.id)}>
                        Conciliar
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
