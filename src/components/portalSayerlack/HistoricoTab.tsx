// Aba "Histórico" do Portal Sayerlack.
// Extraída de src/pages/AdminPortalSayerlack.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ExternalLink } from 'lucide-react';
import { PortalStatusBadge } from '@/components/portalSayerlack/PortalStatusBadge';
import { fmtBRL, fmtDate, fmtDateTime, type PedidoRow } from './types';

export function HistoricoTab({
  loading, rows, histStatus, setHistStatus, histRange, setHistRange, histBusca, setHistBusca, onOpenDrawer,
}: {
  loading: boolean;
  rows: PedidoRow[];
  histStatus: 'todos' | 'enviados' | 'falhas';
  setHistStatus: (v: 'todos' | 'enviados' | 'falhas') => void;
  histRange: '7' | '30' | '90';
  setHistRange: (v: '7' | '30' | '90') => void;
  histBusca: string;
  setHistBusca: (v: string) => void;
  onOpenDrawer: (id: number) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Select value={histStatus} onValueChange={(v) => setHistStatus(v as 'todos' | 'enviados' | 'falhas')}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos</SelectItem>
            <SelectItem value="enviados">Enviados</SelectItem>
            <SelectItem value="falhas">Falhas</SelectItem>
          </SelectContent>
        </Select>
        <Select value={histRange} onValueChange={(v) => setHistRange(v as '7' | '30' | '90')}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Últimos 7 dias</SelectItem>
            <SelectItem value="30">Últimos 30 dias</SelectItem>
            <SelectItem value="90">Últimos 90 dias</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Buscar por ID ou protocolo…"
          value={histBusca}
          onChange={(e) => setHistBusca(e.target.value)}
          className="max-w-xs"
        />
      </div>
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">Sem registros no período.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>Protocolo</TableHead>
                  <TableHead>Data ciclo</TableHead>
                  <TableHead className="text-right">SKUs</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead>Enviado em</TableHead>
                  <TableHead className="text-right">Tent.</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell><PortalStatusBadge status={p.status_envio_portal} /></TableCell>
                    <TableCell>#{p.id}</TableCell>
                    <TableCell>
                      {p.portal_protocolo
                        ? p.portal_screenshot_url
                          ? <a href={p.portal_screenshot_url} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline inline-flex items-center gap-1">
                              {p.portal_protocolo}<ExternalLink className="h-3 w-3" />
                            </a>
                          : <span className="font-mono text-xs">{p.portal_protocolo}</span>
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>{fmtDate(p.data_ciclo)}</TableCell>
                    <TableCell className="text-right">{p.num_skus ?? '—'}</TableCell>
                    <TableCell className="text-right">{fmtBRL(p.valor_total)}</TableCell>
                    <TableCell>{fmtDateTime(p.enviado_portal_em)}</TableCell>
                    <TableCell className="text-right">{p.portal_tentativas ?? 0}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="ghost" onClick={() => onOpenDrawer(p.id)}>
                        Ver detalhes
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
