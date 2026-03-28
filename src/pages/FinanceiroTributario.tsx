import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import { getDRE, type FinDRE } from '@/services/financeiroService';
import { supabase } from '@/integrations/supabase/client';
import {
  Loader2, Building2, Calendar, BarChart3, TrendingUp, AlertTriangle, Receipt
} from 'lucide-react';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtCompact = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${(v / 1_000).toFixed(1)}k`;
  return fmt(v);
};
const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

// Simples Nacional faixas (LC 123/2006 Anexo I - Comércio)
const FAIXAS_SN_COMERCIO = [
  { limite: 180000, aliq: 4.0, deduzir: 0 },
  { limite: 360000, aliq: 7.3, deduzir: 5940 },
  { limite: 720000, aliq: 9.5, deduzir: 13860 },
  { limite: 1800000, aliq: 10.7, deduzir: 22500 },
  { limite: 3600000, aliq: 14.3, deduzir: 87300 },
  { limite: 4800000, aliq: 19.0, deduzir: 378000 },
];

function calcAliquotaEfetivaSN(rbt12: number): { aliquota: number; faixa: string } {
  if (rbt12 <= 0) return { aliquota: 0, faixa: '—' };
  for (let i = 0; i < FAIXAS_SN_COMERCIO.length; i++) {
    if (rbt12 <= FAIXAS_SN_COMERCIO[i].limite) {
      const f = FAIXAS_SN_COMERCIO[i];
      const aliqEfetiva = ((rbt12 * f.aliq / 100) - f.deduzir) / rbt12 * 100;
      return { aliquota: Math.max(aliqEfetiva, 0), faixa: `${i + 1}ª faixa` };
    }
  }
  return { aliquota: 19.0, faixa: '6ª faixa (teto)' };
}

// Lucro Presumido rates
const LP_RATES = {
  comercio: { presuncao: 8, irpj: 15, adicional_irpj_base: 60000, csll_presuncao: 12, csll: 9, pis: 0.65, cofins: 3.0 },
  servico: { presuncao: 32, irpj: 15, adicional_irpj_base: 60000, csll_presuncao: 32, csll: 9, pis: 0.65, cofins: 3.0 },
};

const FinanceiroTributario = () => {
  const [loading, setLoading] = useState(true);
  const [ano, setAno] = useState(new Date().getFullYear());
  const [dreData, setDreData] = useState<Record<string, FinDRE[]>>({});

  useEffect(() => {
    loadAll();
  }, [ano]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const result: Record<string, FinDRE[]> = {};
      for (const co of ALL_COMPANIES) {
        result[co] = await getDRE(co, ano);
      }
      setDreData(result);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-24"><Loader2 className="w-8 h-8 animate-spin" /></div>;
  }

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Painel Tributário</h1>
          <p className="text-sm text-muted-foreground mt-1">Carga efetiva por regime, composição de tributos e simulações</p>
        </div>
        <Select value={String(ano)} onValueChange={v => setAno(Number(v))}>
          <SelectTrigger className="w-[100px]"><Calendar className="w-4 h-4 mr-2" /><SelectValue /></SelectTrigger>
          <SelectContent>
            {[2025, 2026].map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {ALL_COMPANIES.map(co => {
        const dre = dreData[co] || [];
        const regime = COMPANIES[co].regime;
        const receitaAnual = dre.reduce((s, d) => s + d.receita_bruta, 0);
        const impostosAnual = dre.reduce((s, d) => s + d.impostos, 0);
        const aliqEfetiva = receitaAnual > 0 ? (impostosAnual / receitaAnual) * 100 : 0;

        // Regime-specific analysis
        let snInfo: { aliquota: number; faixa: string } | null = null;
        let lpBreakdown: any = null;

        if (regime === 'simples') {
          snInfo = calcAliquotaEfetivaSN(receitaAnual);
        } else {
          // Lucro Presumido estimate
          const rates = LP_RATES.comercio;
          const baseIRPJ = receitaAnual * rates.presuncao / 100;
          const irpj = baseIRPJ * rates.irpj / 100;
          const adicionalIRPJ = Math.max(0, baseIRPJ - rates.adicional_irpj_base * (dre.length || 1)) * 10 / 100;
          const baseCSLL = receitaAnual * rates.csll_presuncao / 100;
          const csll = baseCSLL * rates.csll / 100;
          const pis = receitaAnual * rates.pis / 100;
          const cofins = receitaAnual * rates.cofins / 100;
          lpBreakdown = { irpj, adicionalIRPJ, csll, pis, cofins, total: irpj + adicionalIRPJ + csll + pis + cofins };
        }

        return (
          <Card key={co}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Receipt className="w-4 h-4" />
                {COMPANIES[co].shortName}
                <Badge variant="outline" className="text-xs">
                  {regime === 'simples' ? 'Simples Nacional' : 'Lucro Presumido'}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* KPIs */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg bg-muted/50 text-center">
                  <p className="text-xs text-muted-foreground">Receita Bruta {ano}</p>
                  <p className="text-lg font-bold">{fmtCompact(receitaAnual)}</p>
                </div>
                <div className="p-3 rounded-lg bg-red-50 text-center">
                  <p className="text-xs text-muted-foreground">Impostos Pagos</p>
                  <p className="text-lg font-bold text-red-600">{fmtCompact(impostosAnual)}</p>
                </div>
                <div className="p-3 rounded-lg bg-amber-50 text-center">
                  <p className="text-xs text-muted-foreground">Alíquota Efetiva</p>
                  <p className={`text-lg font-bold ${aliqEfetiva > 15 ? 'text-red-600' : 'text-amber-600'}`}>
                    {aliqEfetiva.toFixed(2)}%
                  </p>
                </div>
                {snInfo && (
                  <div className="p-3 rounded-lg bg-blue-50 text-center">
                    <p className="text-xs text-muted-foreground">Faixa SN</p>
                    <p className="text-lg font-bold text-blue-600">{snInfo.faixa}</p>
                    <p className="text-xs text-muted-foreground">Alíq. nominal {snInfo.aliquota.toFixed(2)}%</p>
                  </div>
                )}
                {regime !== 'simples' && (
                  <div className="p-3 rounded-lg bg-blue-50 text-center">
                    <p className="text-xs text-muted-foreground">Regime</p>
                    <p className="text-sm font-bold text-blue-600">Lucro Presumido</p>
                    <p className="text-xs text-muted-foreground">Presunção {LP_RATES.comercio.presuncao}% (comércio)</p>
                  </div>
                )}
              </div>

              {/* LP Breakdown */}
              {lpBreakdown && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Composição estimada (LP Comércio)</p>
                  {[
                    { label: 'IRPJ', value: lpBreakdown.irpj, pct: receitaAnual > 0 ? lpBreakdown.irpj / receitaAnual * 100 : 0 },
                    { label: 'Adicional IRPJ', value: lpBreakdown.adicionalIRPJ, pct: receitaAnual > 0 ? lpBreakdown.adicionalIRPJ / receitaAnual * 100 : 0 },
                    { label: 'CSLL', value: lpBreakdown.csll, pct: receitaAnual > 0 ? lpBreakdown.csll / receitaAnual * 100 : 0 },
                    { label: 'PIS', value: lpBreakdown.pis, pct: receitaAnual > 0 ? lpBreakdown.pis / receitaAnual * 100 : 0 },
                    { label: 'COFINS', value: lpBreakdown.cofins, pct: receitaAnual > 0 ? lpBreakdown.cofins / receitaAnual * 100 : 0 },
                  ].map(item => (
                    <div key={item.label} className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground w-28">{item.label}</span>
                      <Progress value={item.pct * 5} className="h-2 flex-1" />
                      <span className="text-xs font-medium w-20 text-right">{fmtCompact(item.value)}</span>
                      <span className="text-xs text-muted-foreground w-14 text-right">{item.pct.toFixed(2)}%</span>
                    </div>
                  ))}
                  <div className="flex items-center gap-3 pt-1 border-t">
                    <span className="text-xs font-bold w-28">Total Estimado</span>
                    <div className="flex-1" />
                    <span className="text-sm font-bold text-red-600 w-20 text-right">{fmtCompact(lpBreakdown.total)}</span>
                    <span className="text-xs font-bold w-14 text-right">
                      {receitaAnual > 0 ? (lpBreakdown.total / receitaAnual * 100).toFixed(2) : '0'}%
                    </span>
                  </div>
                  {Math.abs(lpBreakdown.total - impostosAnual) > 1000 && impostosAnual > 0 && (
                    <div className="flex items-start gap-2 p-2 rounded bg-amber-50 border border-amber-200 mt-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
                      <p className="text-xs text-amber-700">
                        Diferença de {fmtCompact(Math.abs(lpBreakdown.total - impostosAnual))} entre estimado e pago.
                        Pode indicar ISS, ICMS, ou categorização incorreta.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Monthly evolution */}
              {dre.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2">Evolução mensal</p>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Mês</TableHead>
                          <TableHead className="text-right">Receita</TableHead>
                          <TableHead className="text-right">Impostos</TableHead>
                          <TableHead className="text-right">Alíq. Efetiva</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {dre.sort((a, b) => a.mes - b.mes).map(d => {
                          const aliq = d.receita_bruta > 0 ? (d.impostos / d.receita_bruta) * 100 : 0;
                          return (
                            <TableRow key={d.mes}>
                              <TableCell className="text-sm">{meses[d.mes - 1]}</TableCell>
                              <TableCell className="text-right text-sm">{fmtCompact(d.receita_bruta)}</TableCell>
                              <TableCell className="text-right text-sm text-red-600">{fmtCompact(d.impostos)}</TableCell>
                              <TableCell className={`text-right text-sm font-medium ${aliq > 15 ? 'text-red-600' : 'text-amber-600'}`}>
                                {aliq.toFixed(2)}%
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      <div className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg">
        Estimativas tributárias são baseadas em alíquotas padrão e receita bruta por caixa. 
        Para valores fiscais oficiais, consulte a contabilidade. ICMS e ISS não são discriminados no LP breakdown.
        Faixas do SN são do Anexo I (Comércio) — ajustar conforme CNAE predominante.
      </div>
    </div>
  );
};

export default FinanceiroTributario;
