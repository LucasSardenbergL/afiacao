// Card de projeção de caixa — 13 semanas.
// Extraído verbatim de src/pages/FinanceiroCockpit.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Target, AlertTriangle } from 'lucide-react';
import { fmtCompact } from './format';
import type { FinProjecaoSemana } from './types';

interface Projecao13CardProps {
  projecao13: FinProjecaoSemana[];
}

export function Projecao13Card({ projecao13 }: Projecao13CardProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Target className="w-4 h-4" />
          Projeção de Caixa — 13 Semanas
          <Badge variant="outline" className="text-[10px]">Consolidado · Baseado em CR/CP abertos</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[90px]">Semana</TableHead>
                <TableHead className="text-right">Entradas</TableHead>
                <TableHead className="text-right">Saídas</TableHead>
                <TableHead className="text-right">Fluxo</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projecao13.map((w, i) => (
                <TableRow key={i} className={w.saldo_projetado < 0 ? 'bg-status-error-bg' : ''}>
                  <TableCell className="text-xs">{w.semana_label}</TableCell>
                  <TableCell className="text-right text-sm text-status-success">{fmtCompact(w.entradas_previstas)}</TableCell>
                  <TableCell className="text-right text-sm text-status-error">{fmtCompact(w.saidas_previstas)}</TableCell>
                  <TableCell className={`text-right text-sm font-medium ${w.fluxo_liquido >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                    {fmtCompact(w.fluxo_liquido)}
                  </TableCell>
                  <TableCell className={`text-right text-sm font-bold ${w.saldo_projetado >= 0 ? 'text-status-info' : 'text-status-error'}`}>
                    {fmtCompact(w.saldo_projetado)}
                    {w.saldo_projetado < 0 && <AlertTriangle className="inline w-3 h-3 ml-1 text-status-error" />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {projecao13.some((w) => w.saldo_projetado < 0) && (
          <div className="mt-3 p-3 rounded-lg bg-status-error-bg border border-status-error/20 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-status-error mt-0.5 shrink-0" />
            <p className="text-sm text-status-error-fg">
              Projeção indica saldo negativo em {projecao13.filter((w) => w.saldo_projetado < 0).length} semana(s).
              Ação necessária antes de {projecao13.find((w) => w.saldo_projetado < 0)?.semana_label}.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
