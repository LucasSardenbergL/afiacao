// Tabela "Histórico de Importações" da Importação Tintométrica.
// Extraída de src/pages/TintImport.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RotateCcw, Loader2 } from 'lucide-react';
import { statusColor, type TintImportacaoRow } from './types';

export function HistoryTable({
  history, histLoading, importing, resumingId, onResume,
}: {
  history: TintImportacaoRow[];
  histLoading: boolean;
  importing: boolean;
  resumingId: string | null;
  onResume: (imp: TintImportacaoRow) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Histórico de Importações</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Arquivo</TableHead>
              <TableHead>Registros</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {histLoading ? (
              <TableRow><TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
            ) : history.map((imp) => (
              <TableRow key={imp.id}>
                <TableCell className="text-sm">{new Date(imp.created_at).toLocaleDateString('pt-BR')}</TableCell>
                <TableCell className="text-sm">{imp.tipo}</TableCell>
                <TableCell className="text-sm max-w-[200px] truncate">{imp.arquivo_nome}</TableCell>
                <TableCell className="text-sm">{(imp.registros_importados ?? 0) + (imp.registros_atualizados ?? 0)} / {imp.total_registros ?? 0}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={statusColor[imp.status] || ''}>{imp.status}</Badge>
                </TableCell>
                <TableCell>
                  {(imp.status === 'processando' || imp.status === 'concluido_parcial') && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={importing || resumingId === imp.id}
                      onClick={() => onResume(imp)}
                    >
                      {resumingId === imp.id ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RotateCcw className="w-3 h-3 mr-1" />}
                      Retomar
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
