// Aba "Estatísticas" do Portal Sayerlack (gráficos + top falhas + export CSV).
// Extraída de src/pages/AdminPortalSayerlack.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Download } from 'lucide-react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { fmtDateTime, type PortalStats } from './types';

export function EstatisticasTab({ stats, onExportCSV }: { stats?: PortalStats; onExportCSV: () => void }) {
  return (
    <>
      <div className="flex justify-end">
        <Button variant="outline" onClick={onExportCSV}>
          <Download className="h-4 w-4 mr-2" />
          Exportar histórico CSV (90d)
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Envios por dia (últimos 30 dias)</CardTitle></CardHeader>
        <CardContent style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={stats?.porDia ?? []}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="dia" />
              <YAxis allowDecimals={false} />
              <RTooltip />
              <Legend />
              <Line type="monotone" dataKey="enviado" stroke="hsl(142, 70%, 45%)" name="Enviados" />
              <Line type="monotone" dataKey="falha" stroke="hsl(0, 70%, 50%)" name="Falhas" />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Tempo até envio (últimos 30 dias)</CardTitle></CardHeader>
        <CardContent style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={stats?.bins ?? []}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" />
              <YAxis allowDecimals={false} />
              <RTooltip />
              <Bar dataKey="count" fill="hsl(220, 70%, 50%)" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Top falhas (últimos 30 dias)</CardTitle></CardHeader>
        <CardContent className="p-0">
          {!stats || stats.topErros.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">Nenhuma falha no período.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Erro</TableHead>
                  <TableHead className="text-right">Ocorrências</TableHead>
                  <TableHead>Último</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.topErros.map((e) => (
                  <TableRow key={e.erro}>
                    <TableCell className="font-mono text-xs max-w-md truncate" title={e.erro}>{e.erro}</TableCell>
                    <TableCell className="text-right"><Badge variant="outline">{e.count}</Badge></TableCell>
                    <TableCell>{fmtDateTime(e.ultimo)}</TableCell>
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
