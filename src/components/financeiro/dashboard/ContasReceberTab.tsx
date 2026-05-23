// Conteúdo da aba "Contas a Receber" do dashboard financeiro.
// Extraído de src/pages/FinanceiroDashboard.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Clock, AlertTriangle, DollarSign, Download, History } from 'lucide-react';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import { type FinanceiroView } from '@/hooks/useFinanceiro';
import {
  exportContasReceberCSV, downloadCSV, type FinContaReceber,
} from '@/services/financeiroService';
import { fmt, fmtDate, statusColor } from '@/components/financeiro/dashboard/format';

export function ContasReceberTab({
  crFilter, setCrFilter, crDateFrom, setCrDateFrom, crDateTo, setCrDateTo,
  contasReceber, crTotals, view, loading, onAudit,
}: {
  crFilter: string;
  setCrFilter: (s: string) => void;
  crDateFrom: string;
  setCrDateFrom: (s: string) => void;
  crDateTo: string;
  setCrDateTo: (s: string) => void;
  contasReceber: FinContaReceber[];
  crTotals: { valor: number; recebido: number; saldo: number };
  view: FinanceiroView;
  loading: boolean;
  onAudit: (t: { table: string; id: string; title: string }) => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-2 flex-wrap">
          {['ABERTO', 'VENCIDO', 'RECEBIDO', 'PARCIAL'].map(s => (
            <Button
              key={s}
              variant={crFilter === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCrFilter(s)}
            >
              {s === 'ABERTO' && <Clock className="w-3.5 h-3.5 mr-1" />}
              {s === 'VENCIDO' && <AlertTriangle className="w-3.5 h-3.5 mr-1" />}
              {s === 'RECEBIDO' && <DollarSign className="w-3.5 h-3.5 mr-1" />}
              {s}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={crDateFrom}
            onChange={e => setCrDateFrom(e.target.value)}
            className="h-8 rounded border px-2 text-xs"
            placeholder="De"
          />
          <input
            type="date"
            value={crDateTo}
            onChange={e => setCrDateTo(e.target.value)}
            className="h-8 rounded border px-2 text-xs"
            placeholder="Até"
          />
          {(crDateFrom || crDateTo) && (
            <Button variant="ghost" size="sm" onClick={() => { setCrDateFrom(''); setCrDateTo(''); }}>
              Limpar
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{contasReceber.length} títulos</Badge>
          {contasReceber.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => {
              const csv = exportContasReceberCSV(contasReceber);
              downloadCSV(csv, `contas_receber_${view}_${crFilter}.csv`);
            }}>
              <Download className="w-3.5 h-3.5 mr-1" />
              CSV
            </Button>
          )}
        </div>
      </div>

      {/* Totalizadores */}
      {contasReceber.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="p-3 rounded-lg bg-muted/50 text-center">
            <p className="text-xs text-muted-foreground">Valor Total</p>
            <p className="text-sm font-bold">{fmt(crTotals.valor)}</p>
          </div>
          <div className="p-3 rounded-lg bg-status-success-bg text-center">
            <p className="text-xs text-muted-foreground">Recebido</p>
            <p className="text-sm font-bold text-status-success">{fmt(crTotals.recebido)}</p>
          </div>
          <div className="p-3 rounded-lg bg-status-info-bg text-center">
            <p className="text-xs text-muted-foreground">Saldo</p>
            <p className="text-sm font-bold text-status-info">{fmt(crTotals.saldo)}</p>
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
                  <TableHead>Cliente</TableHead>
                  <TableHead className="w-24">Vencimento</TableHead>
                  <TableHead className="text-right w-28">Valor</TableHead>
                  <TableHead className="text-right w-28">Recebido</TableHead>
                  <TableHead className="text-right w-28">Saldo</TableHead>
                  <TableHead className="w-20">Status</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {contasReceber.map((cr) => (
                  <TableRow key={cr.id}>
                    {view === 'all' && (
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {COMPANIES[cr.company as Company]?.shortName || cr.company}
                        </Badge>
                      </TableCell>
                    )}
                    <TableCell>
                      <div>
                        <p className="font-medium text-sm truncate max-w-[200px]">{cr.nome_cliente || '—'}</p>
                        {cr.numero_documento && (
                          <p className="text-xs text-muted-foreground">{cr.numero_documento}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{fmtDate(cr.data_vencimento)}</TableCell>
                    <TableCell className="text-right font-medium">{fmt(cr.valor_documento)}</TableCell>
                    <TableCell className="text-right text-status-success">{fmt(cr.valor_recebido)}</TableCell>
                    <TableCell className="text-right font-bold">{fmt(cr.saldo)}</TableCell>
                    <TableCell>
                      <Badge className={`text-xs ${statusColor(cr.status_titulo)}`}>
                        {cr.status_titulo}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground truncate max-w-[120px]">
                      {cr.categoria_descricao || cr.categoria_codigo || '—'}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={(e) => {
                          e.stopPropagation();
                          onAudit({
                            table: 'fin_contas_receber',
                            id: cr.id,
                            title: `CR ${cr.nome_cliente || cr.numero_documento || cr.id}`,
                          });
                        }}
                        aria-label="Histórico"
                      >
                        <History className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {contasReceber.length === 0 && !loading && (
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
