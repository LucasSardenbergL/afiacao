// Tabela do DRE (regime de caixa) por mês.
// Extraída de src/pages/FinanceiroDashboard.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertTriangle, FileText } from 'lucide-react';
import { type FinanceiroView } from '@/hooks/useFinanceiro';
import { fmtCompact } from '@/components/financeiro/dashboard/format';
import { PontoEquilibrioCard } from '@/components/financeiro/dashboard/PontoEquilibrioCard';
import type { FinDRE } from '@/services/financeiroService';

export function DRETab({ data, view, ano }: { data: FinDRE[]; view: FinanceiroView; ano: number }) {
  // F3 — PE operacional (v1 OBEN-only, spec §5; o card é master-only por dentro). Base TTM própria.
  const peCard = view === 'oben' ? <PontoEquilibrioCard company="oben" /> : null;

  if (!data || data.length === 0) {
    return (
      <div className="space-y-3">
        {peCard}
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
            Nenhum DRE calculado para {ano}. Clique em "Recalcular" para gerar.
          </CardContent>
        </Card>
      </div>
    );
  }

  // Data already comes consolidated from hook (dreConsolidado) — no re-consolidation needed
  const rows = [...data].sort((a, b) => a.mes - b.mes);

  // Ponto 5: check for unmapped categories
  const unmappedCats = rows.flatMap((r) =>
    r.detalhamento?.categorias_nao_mapeadas || []
  );
  const uniqueUnmapped = [...new Set(unmappedCats)];

  const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

  const dreLines: { label: string; field: keyof FinDRE & ('receita_bruta' | 'deducoes' | 'receita_liquida' | 'cmv' | 'lucro_bruto' | 'despesas_operacionais' | 'despesas_administrativas' | 'despesas_comerciais' | 'despesas_financeiras' | 'receitas_financeiras' | 'resultado_operacional' | 'impostos' | 'resultado_liquido'); bold: boolean; color: string }[] = [
    { label: 'Receita Bruta', field: 'receita_bruta', bold: true, color: '' },
    { label: '(-) Deduções', field: 'deducoes', bold: false, color: 'text-status-error' },
    { label: '= Receita Líquida', field: 'receita_liquida', bold: true, color: '' },
    { label: '(-) CMV', field: 'cmv', bold: false, color: 'text-status-error' },
    { label: '= Lucro Bruto', field: 'lucro_bruto', bold: true, color: 'text-status-success' },
    { label: '(-) Desp. Operacionais', field: 'despesas_operacionais', bold: false, color: 'text-status-error' },
    { label: '(-) Desp. Administrativas', field: 'despesas_administrativas', bold: false, color: 'text-status-error' },
    { label: '(-) Desp. Comerciais', field: 'despesas_comerciais', bold: false, color: 'text-status-error' },
    { label: '(-) Desp. Financeiras', field: 'despesas_financeiras', bold: false, color: 'text-status-error' },
    { label: '(+) Rec. Financeiras', field: 'receitas_financeiras', bold: false, color: 'text-status-success' },
    { label: '= Resultado Operacional', field: 'resultado_operacional', bold: true, color: '' },
    { label: '(-) Impostos', field: 'impostos', bold: false, color: 'text-status-error' },
    { label: '= RESULTADO LÍQUIDO', field: 'resultado_liquido', bold: true, color: '' },
  ];

  return (
    <div className="space-y-3">
      {peCard}
      {/* Ponto 5: unmapped warning */}
      {uniqueUnmapped.length > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-status-warning-bg border border-status-warning/30">
          <AlertTriangle className="w-4 h-4 text-status-warning mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-status-warning-fg">
              {uniqueUnmapped.length} categoria(s) classificadas por heurística
            </p>
            <p className="text-xs text-status-warning mt-1">
              Estas categorias não têm mapeamento explícito — os valores podem estar em linhas incorretas.
              Configure em <span className="font-medium">Mapeamento DRE</span>.
            </p>
            <p className="text-xs text-status-warning mt-1 font-mono">
              {uniqueUnmapped.slice(0, 8).join(', ')}{uniqueUnmapped.length > 8 ? ` (+${uniqueUnmapped.length - 8})` : ''}
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            DRE Regime de Caixa — {ano}
            {view === 'all' && <Badge variant="secondary" className="ml-2">Consolidado</Badge>}
            <Badge variant="outline" className="ml-2 text-[10px]">Regime de Caixa</Badge>
          </CardTitle>
        </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-background min-w-[180px]">Linha</TableHead>
                {rows.map((r) => (
                  <TableHead key={r.mes} className="text-right min-w-[100px]">
                    {meses[r.mes - 1]}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {dreLines.map(line => (
                <TableRow key={line.field} className={line.bold ? 'bg-muted/30' : ''}>
                  <TableCell className={`sticky left-0 bg-background text-sm ${line.bold ? 'font-bold' : ''}`}>
                    {line.label}
                  </TableCell>
                  {rows.map((r) => {
                    const val = r[line.field] || 0;
                    const colorClass = line.color || (line.bold && line.field.includes('resultado')
                      ? (val >= 0 ? 'text-status-success' : 'text-status-error')
                      : '');
                    return (
                      <TableCell key={r.mes} className={`text-right text-sm ${line.bold ? 'font-bold' : ''} ${colorClass}`}>
                        {fmtCompact(val)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              {/* Margem bruta % */}
              <TableRow className="border-t-2">
                <TableCell className="sticky left-0 bg-background text-sm font-medium text-muted-foreground">
                  Margem Bruta %
                </TableCell>
                {rows.map((r) => {
                  const pct = r.receita_liquida > 0 ? (r.lucro_bruto / r.receita_liquida) * 100 : 0;
                  return (
                    <TableCell key={r.mes} className="text-right text-sm text-muted-foreground">
                      {pct.toFixed(1)}%
                    </TableCell>
                  );
                })}
              </TableRow>
              {/* Margem líquida % */}
              <TableRow>
                <TableCell className="sticky left-0 bg-background text-sm font-medium text-muted-foreground">
                  Margem Líquida %
                </TableCell>
                {rows.map((r) => {
                  const pct = r.receita_liquida > 0 ? (r.resultado_liquido / r.receita_liquida) * 100 : 0;
                  return (
                    <TableCell key={r.mes} className={`text-right text-sm font-medium ${pct >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                      {pct.toFixed(1)}%
                    </TableCell>
                  );
                })}
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
    </div>
  );
}
