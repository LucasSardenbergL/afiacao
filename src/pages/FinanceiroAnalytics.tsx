import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import { getAnaliseDimensional, type Dimensao, type AnaliseDimensional } from '@/services/financeiroV2Service';
import { downloadCSV, exportContasPagarCSV, exportContasReceberCSV } from '@/services/financeiroService';
import {
  Loader2, Building2, BarChart3, PieChart, Download, Filter,
  ArrowDownCircle, ArrowUpCircle, TrendingUp
} from 'lucide-react';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtCompact = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${(v / 1_000).toFixed(1)}k`;
  return fmt(v);
};

const dimensoes: { value: Dimensao; label: string; tipos: ('cr' | 'cp')[] }[] = [
  { value: 'categoria', label: 'Categoria', tipos: ['cr', 'cp'] },
  { value: 'departamento', label: 'Departamento', tipos: ['cr', 'cp'] },
  { value: 'centro_custo', label: 'Centro de Custo', tipos: ['cr', 'cp'] },
  { value: 'cliente', label: 'Cliente', tipos: ['cr'] },
  { value: 'fornecedor', label: 'Fornecedor', tipos: ['cp'] },
  { value: 'vendedor', label: 'Vendedor', tipos: ['cr'] },
];

const mesesNome = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

const FinanceiroAnalytics = () => {
  const [tipo, setTipo] = useState<'cr' | 'cp'>('cr');
  const [dimensao, setDimensao] = useState<Dimensao>('categoria');
  const [company, setCompany] = useState<Company | 'all'>('all');
  const [ano, setAno] = useState(new Date().getFullYear());
  const [mes, setMes] = useState<number | null>(null);
  const [data, setData] = useState<AnaliseDimensional[]>([]);
  const [loading, setLoading] = useState(false);

  const filteredDimensoes = dimensoes.filter(d => d.tipos.includes(tipo));

  useEffect(() => {
    if (!filteredDimensoes.find(d => d.value === dimensao)) {
      setDimensao(filteredDimensoes[0]?.value || 'categoria');
    }
  }, [tipo]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getAnaliseDimensional(tipo, company, dimensao, ano, mes || undefined);
      setData(result);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [tipo, company, dimensao, ano, mes]);

  useEffect(() => { load(); }, [load]);

  const total = data.reduce((s, d) => s + d.total_documento, 0);
  const totalPagoRecebido = data.reduce((s, d) => s + d.total_pago_recebido, 0);

  const exportCSV = () => {
    const header = ['Dimensão', 'Qtd Títulos', 'Total Documento', tipo === 'cr' ? 'Total Recebido' : 'Total Pago', 'Saldo', '% do Total'];
    const rows = data.map(d => [
      d.valor_dimensao,
      d.qtd_titulos,
      d.total_documento.toFixed(2),
      d.total_pago_recebido.toFixed(2),
      d.total_saldo.toFixed(2),
      total > 0 ? ((d.total_documento / total) * 100).toFixed(1) + '%' : '0%',
    ].join(','));
    const csv = [header.join(','), ...rows].join('\n');
    downloadCSV(csv, `analise_${tipo}_${dimensao}_${company}_${ano}${mes ? '_' + mes : ''}.csv`);
  };

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Exploração Analítica</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Análise dimensional de recebíveis e payables
          </p>
        </div>
        {data.length > 0 && (
          <Button variant="outline" size="sm" onClick={exportCSV}>
            <Download className="w-4 h-4 mr-1" /> CSV
          </Button>
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={tipo} onValueChange={v => setTipo(v as any)}>
              <SelectTrigger className="w-[140px]">
                {tipo === 'cr' ? <ArrowDownCircle className="w-4 h-4 mr-2" /> : <ArrowUpCircle className="w-4 h-4 mr-2" />}
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cr">Recebíveis</SelectItem>
                <SelectItem value="cp">Payables</SelectItem>
              </SelectContent>
            </Select>

            <Select value={dimensao} onValueChange={v => setDimensao(v as Dimensao)}>
              <SelectTrigger className="w-[160px]">
                <PieChart className="w-4 h-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {filteredDimensoes.map(d => (
                  <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={company} onValueChange={v => setCompany(v as any)}>
              <SelectTrigger className="w-[150px]">
                <Building2 className="w-4 h-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Consolidado</SelectItem>
                {ALL_COMPANIES.map(co => (
                  <SelectItem key={co} value={co}>{COMPANIES[co].shortName}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={String(ano)} onValueChange={v => setAno(Number(v))}>
              <SelectTrigger className="w-[100px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[2024, 2025, 2026].map(y => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={mes ? String(mes) : 'todos'} onValueChange={v => setMes(v === 'todos' ? null : Number(v))}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Ano todo</SelectItem>
                {mesesNome.map((m, i) => (
                  <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Summary */}
      {!loading && data.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="p-3 rounded-lg bg-muted/50 text-center">
            <p className="text-xs text-muted-foreground">{data.length} {dimensao}(s)</p>
            <p className="text-sm font-bold">{data.reduce((s, d) => s + d.qtd_titulos, 0)} títulos</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/50 text-center">
            <p className="text-xs text-muted-foreground">Total Documento</p>
            <p className="text-sm font-bold">{fmtCompact(total)}</p>
          </div>
          <div className={`p-3 rounded-lg text-center ${tipo === 'cr' ? 'bg-emerald-50' : 'bg-red-50'}`}>
            <p className="text-xs text-muted-foreground">{tipo === 'cr' ? 'Recebido' : 'Pago'}</p>
            <p className={`text-sm font-bold ${tipo === 'cr' ? 'text-emerald-600' : 'text-red-600'}`}>
              {fmtCompact(totalPagoRecebido)}
            </p>
          </div>
        </div>
      )}

      {/* Results table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : data.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <BarChart3 className="w-10 h-10 mx-auto mb-3 opacity-40" />
              Sem dados. Sincronize e refresh as views analíticas.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[200px]">{dimensoes.find(d => d.value === dimensao)?.label}</TableHead>
                    <TableHead className="text-right w-20">Qtd</TableHead>
                    <TableHead className="text-right w-32">Total</TableHead>
                    <TableHead className="text-right w-32">{tipo === 'cr' ? 'Recebido' : 'Pago'}</TableHead>
                    <TableHead className="text-right w-28">Saldo</TableHead>
                    <TableHead className="w-40">% do Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.slice(0, 50).map((row, i) => {
                    const pct = total > 0 ? (row.total_documento / total) * 100 : 0;
                    return (
                      <TableRow key={i}>
                        <TableCell>
                          <p className="font-medium text-sm truncate max-w-[250px]">{row.valor_dimensao}</p>
                        </TableCell>
                        <TableCell className="text-right text-sm">{row.qtd_titulos}</TableCell>
                        <TableCell className="text-right text-sm font-medium">{fmtCompact(row.total_documento)}</TableCell>
                        <TableCell className={`text-right text-sm ${tipo === 'cr' ? 'text-emerald-600' : 'text-red-600'}`}>
                          {fmtCompact(row.total_pago_recebido)}
                        </TableCell>
                        <TableCell className="text-right text-sm font-bold">
                          {fmtCompact(row.total_saldo)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Progress value={pct} className="h-2 flex-1" />
                            <span className="text-xs text-muted-foreground w-12 text-right">{pct.toFixed(1)}%</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default FinanceiroAnalytics;
