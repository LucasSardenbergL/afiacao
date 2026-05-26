// Teste de estresse — sensibilidade do caixa a atrasos/inadimplência.
// Extraído verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertTriangle } from 'lucide-react';
import { fmtCompact } from './format';
import { SCENARIOS, computeStressRow } from './stress';

export function StressTest({ saldoCC, entradas30, saidas30, pmr }: {
  saldoCC: number; entradas30: number; saidas30: number; totalCR: number; pmr: number;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          Teste de Estresse — Sensibilidade do Caixa
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[150px]">Cenário</TableHead>
              <TableHead className="text-right">Entradas Ajust.</TableHead>
              <TableHead className="text-right">Saldo 30d</TableHead>
              <TableHead className="text-right">Impacto</TableHead>
              <TableHead className="w-20">Risco</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SCENARIOS.map(s => {
              const { entradasAjust, saldo, impacto, risco, riskColor } = computeStressRow(s, { saldoCC, entradas30, saidas30, pmr });

              return (
                <TableRow key={s.label} className={saldo < 0 ? 'bg-status-error-bg/50' : ''}>
                  <TableCell>
                    <p className="text-sm font-medium">{s.label}</p>
                    <p className="text-[10px] text-muted-foreground">{s.desc}</p>
                  </TableCell>
                  <TableCell className="text-right text-sm">{fmtCompact(entradasAjust)}</TableCell>
                  <TableCell className={`text-right text-sm font-bold ${saldo >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                    {fmtCompact(saldo)}
                  </TableCell>
                  <TableCell className={`text-right text-sm ${impacto < 0 ? 'text-status-error' : ''}`}>
                    {fmtCompact(impacto)}
                  </TableCell>
                  <TableCell>
                    <Badge className={`text-[10px] ${riskColor}`}>{risco}</Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
