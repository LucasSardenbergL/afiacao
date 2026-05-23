// Conteúdo da aba "Contas a Pagar" do dashboard financeiro.
// Extraído de src/pages/FinanceiroDashboard.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Clock, AlertTriangle, DollarSign, Download, History } from 'lucide-react';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import { type FinanceiroView } from '@/hooks/useFinanceiro';
import {
  exportContasPagarCSV, downloadCSV, type FinContaPagar,
} from '@/services/financeiroService';
import { fmt, fmtDate, statusColor } from '@/components/financeiro/dashboard/format';

export function ContasPagarTab({
  cpFilter, setCpFilter, cpDateFrom, setCpDateFrom, cpDateTo, setCpDateTo,
  contasPagar, cpTotals, view, loading, onAudit,
}: {
  cpFilter: string;
  setCpFilter: (s: string) => void;
  cpDateFrom: string;
  setCpDateFrom: (s: string) => void;
  cpDateTo: string;
  setCpDateTo: (s: string) => void;
  contasPagar: FinContaPagar[];
  cpTotals: { valor: number; pago: number; saldo: number };
  view: FinanceiroView;
  loading: boolean;
  onAudit: (t: { table: string; id: string; title: string }) => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-2 flex-wrap">
          {['ABERTO', 'VENCIDO', 'PAGO', 'PARCIAL'].map(s => (
            <Button
              key={s}
              variant={cpFilter === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCpFilter(s)}
            >
              {s === 'ABERTO' && <Clock className="w-3.5 h-3.5 mr-1" />}
              {s === 'VENCIDO' && <AlertTriangle className="w-3.5 h-3.5 mr-1" />}
              {s === 'PAGO' && <DollarSign className="w-3.5 h-3.5 mr-1" />}
              {s}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={cpDateFrom}
            onChange={e => setCpDateFrom(e.target.value)}
            className="h-8 rounded border px-2 text-xs"
          />
          <input
            type="date"
            value={cpDateTo}
            onChange={e => setCpDateTo(e.target.value)}
            className="h-8 rounded border px-2 text-xs"
          />
          {(cpDateFrom || cpDateTo) && (
            <Button variant="ghost" size="sm" onClick={() => { setCpDateFrom(''); setCpDateTo(''); }}>
              Limpar
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{contasPagar.length} títulos</Badge>
          {contasPagar.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => {
              const csv = exportContasPagarCSV(contasPagar);
              downloadCSV(csv, `contas_pagar_${view}_${cpFilter}.csv`);
            }}>
              <Download className="w-3.5 h-3.5 mr-1" />
              CSV
            </Button>
          )}
        </div>
      </div>

      {/* Totalizadores */}
      {contasPagar.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="p-3 rounded-lg bg-muted/50 text-center">
            <p className="text-xs text-muted-foreground">Valor Total</p>
            <p className="text-sm font-bold">{fmt(cpTotals.valor)}</p>
          </div>
          <div className="p-3 rounded-lg bg-status-success-bg text-center">
            <p className="text-xs text-muted-foreground">Pago</p>
            <p className="text-sm font-bold text-status-success">{fmt(cpTotals.pago)}</p>
          </div>
          <div className="p-3 rounded-lg bg-status-error-bg text-center">
            <p className="text-xs text-muted-foreground">Saldo</p>
            <p className="text-sm font-bold text-status-error">{fmt(cpTotals.saldo)}</p>
          </div>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {view === 'all' && <TableHead className="w-20">Empresa</TableHead>}
                  <TableHead>Fornecedor</TableHead>
                  <TableHead className="w-24">Vencimento</TableHead>
                  <TableHead className="text-right w-28">Valor</TableHead>
                  <TableHead className="text-right w-28">Pago</TableHead>
                  <TableHead className="text-right w-28">Saldo</TableHead>
                  <TableHead className="w-20">Status</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {contasPagar.map((cp) => (
                  <TableRow key={cp.id}>
                    {view === 'all' && (
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {COMPANIES[cp.company as Company]?.shortName || cp.company}
                        </Badge>
                      </TableCell>
                    )}
                    <TableCell>
                      <div>
                        <p className="font-medium text-sm truncate max-w-[200px]">{cp.nome_fornecedor || '—'}</p>
                        {cp.numero_documento && (
                          <p className="text-xs text-muted-foreground">{cp.numero_documento}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{fmtDate(cp.data_vencimento)}</TableCell>
                    <TableCell className="text-right font-medium">{fmt(cp.valor_documento)}</TableCell>
                    <TableCell className="text-right text-status-success">{fmt(cp.valor_pago)}</TableCell>
                    <TableCell className="text-right font-bold">{fmt(cp.saldo)}</TableCell>
                    <TableCell>
                      <Badge className={`text-xs ${statusColor(cp.status_titulo)}`}>
                        {cp.status_titulo}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground truncate max-w-[120px]">
                      {cp.categoria_descricao || cp.categoria_codigo || '—'}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAudit({
                            table: 'fin_contas_pagar',
                            id: cp.id,
                            title: `CP ${cp.nome_fornecedor || cp.numero_documento || cp.id}`,
                          });
                        }}
                        aria-label="Histórico"
                      >
                        <History className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {contasPagar.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={view === 'all' ? 9 : 8} className="text-center py-8 text-muted-foreground">
                      Nenhum título encontrado. Sincronize os dados primeiro.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
