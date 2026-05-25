// Aba de histórico de notificações (últimos 30 dias).
// Extraída verbatim de src/pages/AdminNotificacoes.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { SeveridadeBadge, StatusBadge } from './badges';
import { fmtDate } from './format';
import type { AlertaRow } from './types';

interface HistoricoTabProps {
  loading: boolean;
  historico: AlertaRow[] | undefined;
  onSelectAlerta: (a: AlertaRow) => void;
}

export function HistoricoTab({ loading, historico, onSelectAlerta }: HistoricoTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Histórico (últimos 30 dias)</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-40 w-full" />
        ) : (historico ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Sem histórico no período.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Severidade</TableHead>
                <TableHead>Empresa</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Título</TableHead>
                <TableHead>Notificado em</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(historico ?? []).map((a) => (
                <TableRow key={a.id}>
                  <TableCell><StatusBadge s={a.status} /></TableCell>
                  <TableCell><SeveridadeBadge s={a.severidade} /></TableCell>
                  <TableCell><Badge variant="outline">{a.empresa}</Badge></TableCell>
                  <TableCell className="text-xs">{a.tipo}</TableCell>
                  <TableCell className="max-w-[320px] truncate">{a.titulo}</TableCell>
                  <TableCell className="text-xs">{fmtDate(a.notificado_em)}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => onSelectAlerta(a)}>
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
  );
}
