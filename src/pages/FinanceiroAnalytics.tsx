import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import { getAnaliseDimensional, type Dimensao, type AnaliseDimensional } from '@/services/financeiroV2Service';
import { downloadCSV } from '@/services/financeiroService';
import {
  Building2, BarChart3, PieChart, Download, Info,
  ArrowDownCircle, ArrowUpCircle
} from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtCompact = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${(v / 1_000).toFixed(1)}k`;
  return fmt(v);
};

/**
 * Valores de BAIXA (pago/recebido) e o saldo derivado deles chegam `null` quando a fonte não os
 * ingere (#396 — ver `@/lib/financeiro/procedencia-baixa`). "—" é a única saída honesta: exibir
 * `R$ 0,00` afirmaria "nada foi recebido" sobre R$ 27,8M de títulos com status RECEBIDO.
 *
 * ⚠️ O gatilho é o `null` que o service marcou pela FONTE — nunca `v === 0`. Zero que chega como
 * NÚMERO é um fato medido e continua sendo exibido como `R$ 0,00`.
 */
const fmtBaixa = (v: number | null) => (v === null ? '—' : fmtCompact(v));

/**
 * O CSV é montado por `join(',')` sem quoting — texto livre (motivo, nome de cliente) entra em
 * célula e deslocaria as colunas. Escapa conforme RFC 4180.
 */
const campoCsv = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

  // Qualquer linha degradada CONTAMINA o agregado: somar só as linhas que têm valor devolveria um
  // parcial com cara de total — a mesma fabricação, um nível acima.
  const totalPagoRecebido = data.reduce<number | null>(
    (s, d) => (s === null || d.total_pago_recebido === null ? null : s + d.total_pago_recebido),
    0,
  );
  const motivoBaixa = data.find(d => d.motivo_baixa !== null)?.motivo_baixa ?? null;
  const baixaIndisponivel = motivoBaixa !== null;
  const rotuloBaixa = tipo === 'cr' ? 'Recebido' : 'Pago';

  const exportCSV = () => {
    // A degradação alcança o CSV pelo MESMO gatilho da tela: sem isto, `toFixed(2)` reimprimiria o
    // "0.00" fabricado num arquivo que sai daqui e vira anexo de e-mail, planilha e decisão.
    const rotuloCsv = tipo === 'cr' ? 'Total Recebido' : 'Total Pago';
    const sufixo = baixaIndisponivel ? ` (${motivoBaixa})` : '';
    const header = [
      'Dimensão', 'Qtd Títulos', 'Total Documento',
      rotuloCsv + sufixo, 'Saldo' + sufixo, '% do Total',
    ];
    const celula = (v: number | null) => (v === null ? '—' : v.toFixed(2));
    const rows = data.map(d => [
      d.valor_dimensao,
      d.qtd_titulos,
      d.total_documento.toFixed(2),
      celula(d.total_pago_recebido),
      celula(d.total_saldo),
      total > 0 ? ((d.total_documento / total) * 100).toFixed(1) + '%' : '0%',
    ].map(campoCsv).join(','));
    const csv = [header.map(campoCsv).join(','), ...rows].join('\n');
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
            <Select value={tipo} onValueChange={v => setTipo(v as 'cr' | 'cp')}>
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

            <Select value={company} onValueChange={v => setCompany(v as Company | 'all')}>
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
          <div
            className={`p-3 rounded-lg text-center ${
              baixaIndisponivel ? 'bg-muted/50' : tipo === 'cr' ? 'bg-status-success-bg' : 'bg-status-error-bg'
            }`}
          >
            <p className="text-xs text-muted-foreground">{rotuloBaixa}</p>
            <p
              className={`text-sm font-bold ${
                baixaIndisponivel
                  ? 'text-muted-foreground'
                  : tipo === 'cr'
                    ? 'text-status-success'
                    : 'text-status-error'
              }`}
            >
              {fmtBaixa(totalPagoRecebido)}
            </p>
          </div>
        </div>
      )}

      {/* A degradação precisa DIZER por quê: um "—" mudo é lido como bug da tela, e quem precisa do
          número vai buscá-lo no CSV — que também degrada, pelo mesmo gatilho. */}
      {!loading && baixaIndisponivel && data.length > 0 && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground px-1">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            <strong className="font-medium">{rotuloBaixa}</strong> e <strong className="font-medium">Saldo</strong>:{' '}
            {motivoBaixa}. Exibidos como “—” — <strong className="font-medium">não são R$ 0,00</strong>.
            Total e Qtd seguem medidos.
          </span>
        </p>
      )}

      {/* Results table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <PageSkeleton variant="list" className="p-4" />
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
                    <TableHead className="text-right w-32">{rotuloBaixa}</TableHead>
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
                        <TableCell
                          className={`text-right text-sm ${
                            row.total_pago_recebido === null
                              ? 'text-muted-foreground'
                              : tipo === 'cr'
                                ? 'text-status-success'
                                : 'text-status-error'
                          }`}
                          title={row.motivo_baixa ?? undefined}
                        >
                          {fmtBaixa(row.total_pago_recebido)}
                        </TableCell>
                        <TableCell
                          className={`text-right text-sm ${
                            row.total_saldo === null ? 'text-muted-foreground' : 'font-bold'
                          }`}
                          title={row.motivo_baixa ?? undefined}
                        >
                          {fmtBaixa(row.total_saldo)}
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
