// Comparativo de DRE anual por empresa.
// Extraído de src/pages/FinanceiroDashboard.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PieChart } from 'lucide-react';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import { fmtCompact } from '@/components/financeiro/dashboard/format';
import type { FinDRE } from '@/services/financeiroService';

export function DREComparativo({ data, ano }: { data: Record<string, FinDRE[]>; ano: number }) {
  const companies = Object.keys(data);
  if (companies.length < 2) return null;

  // Calculate annual totals per company
  const annualTotals = companies.map(co => {
    const rows = data[co] || [];
    const total = rows.reduce(
      (acc, r) => ({
        receita_liquida: acc.receita_liquida + (r.receita_liquida || 0),
        lucro_bruto: acc.lucro_bruto + (r.lucro_bruto || 0),
        resultado_operacional: acc.resultado_operacional + (r.resultado_operacional || 0),
        resultado_liquido: acc.resultado_liquido + (r.resultado_liquido || 0),
        impostos: acc.impostos + (r.impostos || 0),
      }),
      { receita_liquida: 0, lucro_bruto: 0, resultado_operacional: 0, resultado_liquido: 0, impostos: 0 }
    );
    const margemBruta = total.receita_liquida > 0 ? (total.lucro_bruto / total.receita_liquida) * 100 : 0;
    const margemLiquida = total.receita_liquida > 0 ? (total.resultado_liquido / total.receita_liquida) * 100 : 0;
    return { company: co, ...total, margemBruta, margemLiquida };
  });

  const lines: { label: string; field: 'receita_liquida' | 'lucro_bruto' | 'margemBruta' | 'resultado_operacional' | 'impostos' | 'resultado_liquido' | 'margemLiquida'; format: 'currency' | 'pct' }[] = [
    { label: 'Receita Líquida', field: 'receita_liquida', format: 'currency' },
    { label: 'Lucro Bruto', field: 'lucro_bruto', format: 'currency' },
    { label: 'Margem Bruta', field: 'margemBruta', format: 'pct' },
    { label: 'Resultado Operacional', field: 'resultado_operacional', format: 'currency' },
    { label: 'Impostos', field: 'impostos', format: 'currency' },
    { label: 'Resultado Líquido', field: 'resultado_liquido', format: 'currency' },
    { label: 'Margem Líquida', field: 'margemLiquida', format: 'pct' },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <PieChart className="w-4 h-4" />
          Comparativo por Empresa — {ano}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-background min-w-[180px]">Indicador</TableHead>
                {annualTotals.map(t => (
                  <TableHead key={t.company} className="text-right min-w-[120px]">
                    <div className="flex flex-col items-end">
                      <span>{COMPANIES[t.company as Company]?.shortName || t.company}</span>
                      <Badge variant="outline" className="text-[10px] mt-0.5">
                        {COMPANIES[t.company as Company]?.regime === 'simples' ? 'SN' : 'LP'}
                      </Badge>
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map(line => (
                <TableRow key={line.field}>
                  <TableCell className="sticky left-0 bg-background text-sm font-medium">
                    {line.label}
                  </TableCell>
                  {annualTotals.map(t => {
                    const val = t[line.field] || 0;
                    const isResult = line.field.includes('resultado') || line.field === 'margemLiquida';
                    const colorClass = isResult
                      ? val >= 0 ? 'text-status-success' : 'text-status-error'
                      : '';
                    return (
                      <TableCell key={t.company} className={`text-right text-sm font-medium ${colorClass}`}>
                        {line.format === 'pct' ? `${val.toFixed(1)}%` : fmtCompact(val)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              {/* Participação na receita total */}
              <TableRow className="border-t-2">
                <TableCell className="sticky left-0 bg-background text-sm font-medium text-muted-foreground">
                  % da Receita Total
                </TableCell>
                {(() => {
                  const totalReceita = annualTotals.reduce((s, t) => s + t.receita_liquida, 0);
                  return annualTotals.map(t => (
                    <TableCell key={t.company} className="text-right text-sm text-muted-foreground">
                      {totalReceita > 0 ? `${((t.receita_liquida / totalReceita) * 100).toFixed(1)}%` : '—'}
                    </TableCell>
                  ));
                })()}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
