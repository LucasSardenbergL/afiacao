import { useState } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { useCashflowProjection, type Cenario } from '@/hooks/useCashflowProjection';
import { CenarioToggle } from './CenarioToggle';
import { AlertasStack } from './AlertasStack';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Bar, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import { formatBRL, formatSemana } from '@/lib/financeiro/cashflow-format';

export function Fluxo13Semanas() {
  const { activeCompany } = useCompany();
  const [cenario, setCenario] = useState<Cenario>('realista');
  const { data, isLoading, error } = useCashflowProjection(activeCompany, cenario);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (error) return <div className="text-status-error">Erro: {String((error as Error).message ?? error)}</div>;
  if (!data) return null;

  const chartData = data.semanas.map(s => ({
    semana: formatSemana(s.inicio),
    entradas: Math.round(s.total_entradas),
    saidas: Math.round(s.total_saidas),
    saldo_final: Math.round(s.saldo_final),
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <CenarioToggle value={cenario} onChange={setCenario} />
        <div className="text-xs text-muted-foreground">
          Horizonte: 13 semanas · Cenário: <strong>{cenario}</strong>
        </div>
      </div>

      <AlertasStack />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Projeção 13 semanas — {cenario}</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={360}>
            <ComposedChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="semana" />
              <YAxis />
              <Tooltip formatter={(v: number) => formatBRL(v)} />
              <Legend />
              <Bar dataKey="entradas" fill="hsl(var(--status-success-bold))" name="Entradas" />
              <Bar dataKey="saidas" fill="hsl(var(--status-error-bold))" name="Saídas" />
              <Line type="monotone" dataKey="saldo_final" stroke="hsl(var(--foreground))" strokeWidth={2} name="Saldo acumulado" />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Detalhe semana a semana</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Semana</TableHead>
                <TableHead className="text-right">Saldo inicial</TableHead>
                <TableHead className="text-right">Entradas</TableHead>
                <TableHead className="text-right">Saídas</TableHead>
                <TableHead className="text-right">Saldo final</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.semanas.map((s, i) => (
                <TableRow key={i} className={s.saldo_final < 0 ? 'bg-status-error-bg' : ''}>
                  <TableCell className="font-mono text-xs">{formatSemana(s.inicio)} → {formatSemana(s.fim)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBRL(s.saldo_inicial)}</TableCell>
                  <TableCell className="text-right tabular-nums text-status-success">+{formatBRL(s.total_entradas)}</TableCell>
                  <TableCell className="text-right tabular-nums text-status-error">-{formatBRL(s.total_saidas)}</TableCell>
                  <TableCell className="text-right tabular-nums font-bold">{formatBRL(s.saldo_final)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
