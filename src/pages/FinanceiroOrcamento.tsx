import { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import { getDRE, DRE_LINHAS, type FinDRE } from '@/services/financeiroService';
import { getOrcamento, upsertOrcamento, type OrcamentoLinha } from '@/services/financeiroV2Service';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Save, Building2, Calendar, TrendingUp, TrendingDown, Target } from 'lucide-react';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtCompact = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${(v / 1_000).toFixed(1)}k`;
  return fmt(v);
};
const mesesNome = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

const dreLinhas = DRE_LINHAS.map(l => l.value);
const dreLabelMap = Object.fromEntries(DRE_LINHAS.map(l => [l.value, l.label]));

const FinanceiroOrcamento = () => {
  const { toast } = useToast();
  const [company, setCompany] = useState<Company>('oben');
  const [ano, setAno] = useState(new Date().getFullYear());
  const [orcamento, setOrcamento] = useState<OrcamentoLinha[]>([]);
  const [dre, setDre] = useState<FinDRE[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [orc, dreData] = await Promise.all([
        getOrcamento(company, ano),
        getDRE(company, ano),
      ]);
      setOrcamento(orc);
      setDre(dreData);

      // Init draft from existing orcamento
      const d: Record<string, number> = {};
      for (const o of orc) d[`${o.mes}_${o.dre_linha}`] = o.valor_orcado;
      setDraft(d);
    } catch (e: any) {
      toast({ title: 'Erro', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [company, ano]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const linhas: OrcamentoLinha[] = [];
      for (const [key, val] of Object.entries(draft)) {
        const [mesStr, ...linhaParts] = key.split('_');
        const linha = linhaParts.join('_');
        linhas.push({ company, ano, mes: Number(mesStr), dre_linha: linha, valor_orcado: val });
      }
      await upsertOrcamento(linhas);
      toast({ title: 'Orçamento salvo' });
      setEditMode(false);
      load();
    } catch (e: any) {
      toast({ title: 'Erro', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  // Build comparison data: for each DRE line × month, show orçado vs realizado
  const currentMonth = new Date().getMonth() + 1;
  const meses = Array.from({ length: 12 }, (_, i) => i + 1);

  const getReal = (linha: string, mes: number): number => {
    const d = dre.find(r => r.mes === mes);
    return d ? ((d as any)[linha] || 0) : 0;
  };

  const getOrc = (linha: string, mes: number): number => {
    return draft[`${mes}_${linha}`] || 0;
  };

  // Summary: YTD comparison
  const ytdSummary = useMemo(() => {
    return dreLinhas.map(linha => {
      let orcYtd = 0, realYtd = 0;
      for (let m = 1; m <= currentMonth; m++) {
        orcYtd += getOrc(linha, m);
        realYtd += getReal(linha, m);
      }
      const variacao = orcYtd > 0 ? ((realYtd - orcYtd) / orcYtd) * 100 : 0;
      return { linha, label: dreLabelMap[linha], orcYtd, realYtd, variacao };
    });
  }, [draft, dre, currentMonth]);

  if (loading) {
    return <div className="flex items-center justify-center py-24"><Loader2 className="w-8 h-8 animate-spin" /></div>;
  }

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Orçado vs Realizado</h1>
          <p className="text-sm text-muted-foreground mt-1">Budget por linha DRE, comparação mensal e YTD</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(ano)} onValueChange={v => setAno(Number(v))}>
            <SelectTrigger className="w-[100px]"><Calendar className="w-4 h-4 mr-2" /><SelectValue /></SelectTrigger>
            <SelectContent>
              {[2025, 2026].map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={company} onValueChange={v => setCompany(v as Company)}>
            <SelectTrigger className="w-[150px]"><Building2 className="w-4 h-4 mr-2" /><SelectValue /></SelectTrigger>
            <SelectContent>
              {ALL_COMPANIES.map(co => <SelectItem key={co} value={co}>{COMPANIES[co].shortName}</SelectItem>)}
            </SelectContent>
          </Select>
          {editMode ? (
            <>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Save className="w-4 h-4 mr-1" />}
                Salvar
              </Button>
              <Button variant="ghost" onClick={() => setEditMode(false)}>Cancelar</Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setEditMode(true)}>Editar Orçamento</Button>
          )}
        </div>
      </div>

      {/* YTD Summary */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="w-4 h-4" />
            Acumulado {ano} (Jan–{mesesNome[currentMonth - 1]})
            <Badge variant="outline" className="text-[10px]">Regime de Caixa</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 bg-background min-w-[180px]">Linha DRE</TableHead>
                  <TableHead className="text-right w-28">Orçado</TableHead>
                  <TableHead className="text-right w-28">Realizado</TableHead>
                  <TableHead className="text-right w-28">Variação</TableHead>
                  <TableHead className="w-40">Performance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ytdSummary.filter(s => s.orcYtd > 0 || s.realYtd > 0).map(s => {
                  const isGood = s.linha.includes('receita') || s.linha.includes('lucro') || s.linha === 'resultado_operacional'
                    ? s.variacao >= 0 : s.variacao <= 0;
                  return (
                    <TableRow key={s.linha}>
                      <TableCell className="sticky left-0 bg-background text-sm font-medium">{s.label}</TableCell>
                      <TableCell className="text-right text-sm">{fmtCompact(s.orcYtd)}</TableCell>
                      <TableCell className="text-right text-sm font-medium">{fmtCompact(s.realYtd)}</TableCell>
                      <TableCell className={`text-right text-sm font-bold ${isGood ? 'text-emerald-600' : 'text-red-600'}`}>
                        {s.variacao > 0 ? '+' : ''}{s.variacao.toFixed(1)}%
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {isGood
                            ? <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
                            : <TrendingDown className="w-3.5 h-3.5 text-red-600" />}
                          <span className={`text-xs ${isGood ? 'text-emerald-600' : 'text-red-600'}`}>
                            {isGood ? 'Favorável' : 'Desfavorável'}
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Monthly detail grid */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Detalhe Mensal — {editMode ? 'Editando orçamento' : 'Orçado × Realizado'}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 bg-background min-w-[160px]">Linha</TableHead>
                  {meses.map(m => (
                    <TableHead key={m} className="text-center min-w-[120px]">
                      <div>{mesesNome[m - 1]}</div>
                      {!editMode && <div className="text-[9px] font-normal">Orç / Real</div>}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {dreLinhas.map(linha => (
                  <TableRow key={linha}>
                    <TableCell className="sticky left-0 bg-background text-xs font-medium">
                      {dreLabelMap[linha]}
                    </TableCell>
                    {meses.map(m => {
                      const key = `${m}_${linha}`;
                      const orc = getOrc(linha, m);
                      const real = getReal(linha, m);

                      if (editMode) {
                        return (
                          <TableCell key={m} className="p-1">
                            <Input
                              type="number"
                              value={draft[key] || ''}
                              onChange={e => setDraft(prev => ({ ...prev, [key]: Number(e.target.value) || 0 }))}
                              className="h-7 text-xs text-right w-24"
                              placeholder="0"
                            />
                          </TableCell>
                        );
                      }

                      const diff = orc > 0 ? real - orc : 0;
                      return (
                        <TableCell key={m} className="text-center text-xs">
                          <div className="text-muted-foreground">{orc > 0 ? fmtCompact(orc) : '—'}</div>
                          <div className="font-medium">{real > 0 ? fmtCompact(real) : '—'}</div>
                          {orc > 0 && real > 0 && (
                            <div className={`text-[10px] ${diff >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                              {diff > 0 ? '+' : ''}{fmtCompact(diff)}
                            </div>
                          )}
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
    </div>
  );
};

export default FinanceiroOrcamento;
