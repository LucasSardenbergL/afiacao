// Tabela comparativa de indicadores por empresa.
// Extraída verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BarChart3 } from 'lucide-react';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import type { CapitalDeGiro } from '@/services/financeiroService';
import { fmtCompact } from './format';

export function ComparativoEmpresasCard({ data }: { data: CapitalDeGiro[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <BarChart3 className="w-4 h-4" />
          Comparativo por Empresa
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-background">Indicador</TableHead>
                {data.map(d => (
                  <TableHead key={d.company} className="text-right min-w-[120px]">
                    <div className="flex flex-col items-end">
                      <span>{COMPANIES[d.company as Company]?.shortName}</span>
                      <Badge variant="outline" className="text-[10px] mt-0.5">
                        {COMPANIES[d.company as Company]?.regime === 'simples' ? 'SN' : 'LP'}
                      </Badge>
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {[
                { label: 'CR Aberto', field: 'total_cr_aberto', fmt: 'currency' },
                { label: 'CP Aberto', field: 'total_cp_aberto', fmt: 'currency' },
                { label: 'Saldo CC', field: 'saldo_cc', fmt: 'currency' },
                { label: 'Capital de Giro', field: 'capital_giro', fmt: 'currency' },
                { label: 'CG Líquido', field: 'capital_giro_liquido', fmt: 'currency' },
                { label: 'PMR', field: 'pmr', fmt: 'days' },
                { label: 'PMP', field: 'pmp', fmt: 'days' },
                { label: 'Ciclo Financeiro', field: 'ciclo_financeiro', fmt: 'days' },
                { label: 'Concentração CR (Top 5)', field: 'top5_cr_pct', fmt: 'pct' },
                { label: 'Concentração CP (Top 5)', field: 'top5_cp_pct', fmt: 'pct' },
                { label: 'Projeção 30d', field: 'saldo_projetado_30d', fmt: 'currency' },
              ].map(line => (
                <TableRow key={line.field}>
                  <TableCell className="sticky left-0 bg-background text-sm font-medium">
                    {line.label}
                  </TableCell>
                  {data.map(d => {
                    const raw = (d as unknown as Record<string, unknown>)[line.field] as number | null;
                    const val = raw ?? 0;
                    const isResult = ['capital_giro', 'capital_giro_liquido', 'saldo_projetado_30d'].includes(line.field);
                    const color = isResult ? (val >= 0 ? 'text-status-success' : 'text-status-error') : '';
                    let display = '';
                    if (line.fmt === 'currency') display = fmtCompact(val);
                    else if (line.fmt === 'days') display = raw == null ? '—' : `${raw}d`; // null = prazo sem dado de baixa
                    else if (line.fmt === 'pct') display = `${val.toFixed(0)}%`;
                    return (
                      <TableCell key={d.company} className={`text-right text-sm font-medium ${color}`}>
                        {display}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
