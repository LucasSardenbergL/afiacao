// Aba "Pendentes" do Portal Sayerlack.
// Extraída de src/pages/AdminPortalSayerlack.tsx (god-component split).
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PortalStatusBadge } from '@/components/portalSayerlack/PortalStatusBadge';
import { fmtBRL, fmtDate, fmtDateTime, relTime, type PedidoRow } from './types';

export function PendentesTab({
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
            <div className="p-8 text-center text-muted-foreground">Nenhum pedido pendente.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>Data ciclo</TableHead>
                  <TableHead className="text-right">SKUs</TableHead>
                  <TableHead className="text-right">Valor total</TableHead>
                  <TableHead>Aprovado</TableHead>
                  <TableHead className="text-right">Tentativas</TableHead>
                  <TableHead>Próximo retry</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => {
                  const t = p.portal_tentativas ?? 0;
                  const tCor = t <= 1 ? 'text-status-success' : t === 2 ? 'text-status-warning' : 'text-status-error';
                  const retryFut = p.portal_proximo_retry_em && new Date(p.portal_proximo_retry_em) > new Date();
                  return (
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
                      <TableCell className={`text-right font-medium ${tCor}`}>{t}</TableCell>
                      <TableCell>{retryFut ? relTime(p.portal_proximo_retry_em) : '—'}</TableCell>
                      <TableCell>
                        <Button size="sm" variant="ghost" onClick={() => onOpenDrawer(p.id)}>
                          Ver detalhes
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
