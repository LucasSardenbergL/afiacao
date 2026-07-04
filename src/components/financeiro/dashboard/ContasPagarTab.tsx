// Conteúdo da aba "Contas a Pagar" do dashboard financeiro.
// Extraído de src/pages/FinanceiroDashboard.tsx (god-component split).
import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
  // Virtualização — mesmo racional da ContasReceberTab (tabs gêmeas): acima de
  // 100 linhas só as visíveis viram DOM; abaixo, renderização integral (idêntica
  // à original — inclusive em jsdom/testes, onde o container mede 0px).
  const virtualizar = contasPagar.length > 100;
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: contasPagar.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const linhas = virtualizar
    ? virtualRows.map((vr) => ({ conta: contasPagar[vr.index], index: vr.index }))
    : contasPagar.map((conta, index) => ({ conta, index }));
  const paddingTop = virtualizar && virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom = virtualizar && virtualRows.length > 0
    ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0;
  const colSpan = view === 'all' ? 9 : 8;

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
          {/* table crua (não <Table>): o wrapper interno do shadcn tem overflow
              próprio e roubaria o scroll do virtualizador. Classes idênticas. */}
          <div ref={parentRef} className="relative w-full overflow-auto rounded-md max-h-[65vh]">
            <table className="w-full caption-bottom text-sm">
              <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card">
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
                {paddingTop > 0 && (
                  <tr aria-hidden>
                    <td colSpan={colSpan} style={{ height: paddingTop, padding: 0, border: 0 }} />
                  </tr>
                )}
                {linhas.map(({ conta: cp, index }) => {
                  return (
                  <TableRow key={cp.id} data-index={index} ref={virtualizar ? rowVirtualizer.measureElement : undefined}>
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
                  );
                })}
                {paddingBottom > 0 && (
                  <tr aria-hidden>
                    <td colSpan={colSpan} style={{ height: paddingBottom, padding: 0, border: 0 }} />
                  </tr>
                )}
                {contasPagar.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={colSpan} className="text-center py-8 text-muted-foreground">
                      Nenhum título encontrado. Sincronize os dados primeiro.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
