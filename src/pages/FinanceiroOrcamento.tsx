import { Fragment, useState, useEffect, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { COMPANIES, ALL_COMPANIES, type Company } from '@/contexts/CompanyContext';
import { useQuery } from '@tanstack/react-query';
import { getDRE, DRE_LINHAS, getCategoryMappings, type FinDRE } from '@/services/financeiroService';
import { getOrcamento, upsertOrcamento, getCategoriasCompetenciaRaw, getTitulosEntidadeRaw, type OrcamentoLinha } from '@/services/financeiroV2Service';
import { projetarDRE, seedOrcamento, mesesFechados, LINHAS_INPUT, type MesDRE, type LinhaInput } from '@/lib/financeiro/orcamento-forecast-helpers';
import { drillLinha, fontesDaLinha, codigosDaLinha } from '@/lib/financeiro/orcamento-drill-helpers';
import { entidadeDaLinha, concentrarPorEntidade } from '@/lib/financeiro/orcamento-entidade-helpers';
import { DrillVarianciaPanel } from '@/components/financeiro/DrillVarianciaPanel';
import { toast } from 'sonner';
import { Loader2, Save, Building2, Calendar, TrendingUp, TrendingDown, Target, History, Plane, ChevronDown, ChevronRight } from 'lucide-react';
import { AuditTrailDrawer } from '@/components/financeiro/AuditTrailDrawer';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtCompact = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `R$ ${(v / 1_000).toFixed(1)}k`;
  return fmt(v);
};
const mesesNome = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

// Regime por empresa (espelho de REGIME_POR_EMPRESA do calcularDRE) — usado pelo drill
// para resolver os aliases fiscais (deducoes/impostos) regime-aware.
const REGIME_ORCAMENTO: Record<Company, 'simples' | 'presumido'> = {
  colacor: 'presumido',
  oben: 'presumido',
  colacor_sc: 'simples',
};

const dreLinhas = DRE_LINHAS.map(l => l.value);
const dreLabelMap = Object.fromEntries(DRE_LINHAS.map(l => [l.value, l.label]));

const DERIVADAS_LABEL: Record<string, string> = {
  receita_liquida: 'Receita Líquida',
  lucro_bruto: 'Lucro Bruto',
  resultado_operacional: 'Resultado Operacional',
  resultado_antes_impostos: 'Result. antes Impostos',
  resultado_liquido: 'Resultado Líquido',
};

function forecastLabel(linha: string): string {
  return dreLabelMap[linha] ?? DERIVADAS_LABEL[linha] ?? linha;
}

/**
 * Constrói o mapa orcado para projetarDRE.
 * Regra CRÍTICA: chave ausente = não orçado (orcado_ano null).
 * Chave presente com array = ao menos uma entrada existe → preenche os 12 meses (ausente → 0).
 */
function buildOrcadoForecast(
  draft: Record<string, number>,
): Partial<Record<LinhaInput, (number | null)[]>> {
  const result: Partial<Record<LinhaInput, (number | null)[]>> = {};
  for (const l of LINHAS_INPUT) {
    // Verifica se existe ao menos um valor salvo para essa linha
    const temEntrada = Array.from({ length: 12 }, (_, i) => i + 1).some(
      mes => `${mes}_${l}` in draft,
    );
    if (!temEntrada) continue; // ausente: não inclui a chave
    // Inclui a linha com 12 posições; meses sem entrada viram 0
    const arr: (number | null)[] = Array.from({ length: 12 }, (_, i) => {
      const key = `${i + 1}_${l}`;
      return key in draft ? (draft[key] ?? 0) : 0;
    });
    result[l] = arr;
  }
  return result;
}

const FinanceiroOrcamento = () => {
  const [company, setCompany] = useState<Company>('oben');
  const [ano, setAno] = useState(new Date().getFullYear());
  const [orcamento, setOrcamento] = useState<OrcamentoLinha[]>([]);
  const [dre, setDre] = useState<FinDRE[]>([]);
  const [dreAnoAnterior, setDreAnoAnterior] = useState<FinDRE[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [auditTarget, setAuditTarget] = useState<{ table: string; id: string; title: string } | null>(null);
  const [crescimentoPerc, setCrescimentoPerc] = useState(10);
  const [expandedLinha, setExpandedLinha] = useState<string | null>(null);

  // Fecha o drill ao trocar de empresa/ano (evita mostrar drill de outro contexto).
  useEffect(() => { setExpandedLinha(null); }, [company, ano]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [orc, dreData, dreAntData] = await Promise.all([
        getOrcamento(company, ano),
        getDRE(company, ano, undefined, 'competencia'),
        getDRE(company, ano - 1, undefined, 'competencia'),
      ]);
      setOrcamento(orc);
      setDre(dreData);
      setDreAnoAnterior(dreAntData);

      // Init draft from existing orcamento
      const d: Record<string, number> = {};
      for (const o of orc) d[`${o.mes}_${o.dre_linha}`] = o.valor_orcado;
      setDraft(d);
    } catch (e) {
      toast.error('Erro', { description: e instanceof Error ? e.message : String(e) });
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
      toast.success('Orçamento salvo');
      setEditMode(false);
      load();
    } catch (e) {
      toast.error('Erro', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  // Build comparison data: for each DRE line × month, show orçado vs realizado
  const currentMonth = new Date().getMonth() + 1;
  const meses = Array.from({ length: 12 }, (_, i) => i + 1);

  const getReal = (linha: string, mes: number): number => {
    const d = dre.find(r => r.mes === mes);
    return d ? ((d as unknown as Record<string, number>)[linha] || 0) : 0;
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

  // Adapter: constrói orcado para o forecast (ausente ≠ zero)
  const orcadoForecast = useMemo((): ReturnType<typeof buildOrcadoForecast> => {
    return buildOrcadoForecast(draft);
  }, [draft]);

  // Forecast de aterrissagem
  const dreAtualMesDRE = useMemo((): MesDRE[] => {
    return dre.map(d => {
      const row: MesDRE = { mes: d.mes };
      for (const l of LINHAS_INPUT) {
        const v = (d as unknown as Record<string, number | undefined>)[l];
        if (typeof v === 'number') row[l] = v;
      }
      return row;
    });
  }, [dre]);

  const dreAnoAnteriorMesDRE = useMemo((): MesDRE[] => {
    return dreAnoAnterior.map(d => {
      const row: MesDRE = { mes: d.mes };
      for (const l of LINHAS_INPUT) {
        const v = (d as unknown as Record<string, number | undefined>)[l];
        if (typeof v === 'number') row[l] = v;
      }
      return row;
    });
  }, [dreAnoAnterior]);

  const forecast = useMemo(
    () => projetarDRE({
      company,
      ano,
      dreAtual: dreAtualMesDRE,
      dreAnoAnterior: dreAnoAnteriorMesDRE,
      orcado: orcadoForecast,
    }),
    [company, ano, dreAtualMesDRE, dreAnoAnteriorMesDRE, orcadoForecast],
  );

  // ── Drill de variância por categoria (lazy, só ao expandir uma linha) ──
  // Fonte: fin_dre_competencia_base (competência, MESMA base do snapshot → reconcilia).
  // A query é chaveada só por company/ano (base bruta cacheável entre linhas); o drill da
  // linha expandida é calculado num useMemo a partir do forecast (que já reage a draft).
  const mesesFechadosArr = useMemo(() => mesesFechados(ano), [ano]);

  const drillBaseQuery = useQuery({
    queryKey: ['orcamento-drill-base', company, ano, mesesFechadosArr.join(',')],
    enabled: !!expandedLinha,
    queryFn: async () => {
      const [rowsAno, rowsAnoAnterior, mapping] = await Promise.all([
        getCategoriasCompetenciaRaw(company, ano, mesesFechadosArr),
        getCategoriasCompetenciaRaw(company, ano - 1, mesesFechadosArr),
        getCategoryMappings(company),
      ]);
      return { rowsAno, rowsAnoAnterior, mapping };
    },
  });

  const drillResult = useMemo(() => {
    if (!expandedLinha || !drillBaseQuery.data) return null;
    const fl = forecast.linhas.find(l => l.dre_linha === expandedLinha);
    if (!fl || fontesDaLinha(expandedLinha).length === 0) return null;
    return drillLinha({
      dreLinha: expandedLinha,
      regime: REGIME_ORCAMENTO[company],
      rowsAno: drillBaseQuery.data.rowsAno,
      rowsAnoAnterior: drillBaseQuery.data.rowsAnoAnterior,
      mesesFechados: mesesFechadosArr,
      mapping: drillBaseQuery.data.mapping,
      realizadoSnapshot: fl.realizado_fechado,
      forecastRestante: fl.forecast_restante,
      varianciaAnual: fl.variancia,
    });
  }, [expandedLinha, drillBaseQuery.data, forecast.linhas, company, mesesFechadosArr]);

  // ── Drill v2: lente "Por fornecedor·cliente" (só em linhas puras) ──
  const [drillLente, setDrillLente] = useState<'categoria' | 'entidade'>('categoria');
  useEffect(() => { setDrillLente('categoria'); }, [expandedLinha]);

  const entidadeInfo = useMemo(
    () => (expandedLinha ? entidadeDaLinha(expandedLinha) : null),
    [expandedLinha],
  );

  const drillCodigos = useMemo(() => {
    if (!expandedLinha || !drillBaseQuery.data) return [];
    return codigosDaLinha(drillBaseQuery.data.mapping, expandedLinha, REGIME_ORCAMENTO[company]);
  }, [expandedLinha, drillBaseQuery.data, company]);

  const entidadeQuery = useQuery({
    queryKey: ['orcamento-drill-entidade', company, ano, mesesFechadosArr.join(','), expandedLinha, drillCodigos.join(',')],
    enabled: !!expandedLinha && drillLente === 'entidade' && !!entidadeInfo && drillCodigos.length > 0,
    queryFn: async () => {
      const info = entidadeInfo!;
      const [ya, yb] = await Promise.all([
        getTitulosEntidadeRaw(info.fonte, company, ano, mesesFechadosArr, drillCodigos),
        getTitulosEntidadeRaw(info.fonte, company, ano - 1, mesesFechadosArr, drillCodigos),
      ]);
      return concentrarPorEntidade({
        rowsAno: ya.rows,
        rowsAnoAnterior: yb.rows,
        mesesFechados: mesesFechadosArr,
        topN: 3,
        truncado: ya.truncado || yb.truncado,
      });
    },
  });

  const handleSugerir = () => {
    if (dreAnoAnteriorMesDRE.length === 0) {
      toast.warning(`Sem realizado de ${ano - 1} para sugerir.`);
      return;
    }

    const seed = seedOrcamento({ dreBase: dreAnoAnteriorMesDRE, crescimentoPerc });

    // Não-destrutivo (Codex): preenche SÓ células vazias; mantém o que já foi digitado/salvo.
    const novo = { ...draft };
    let preenchidas = 0, mantidas = 0;
    for (const s of seed) {
      if (s.valor_sugerido === null) continue;
      const key = `${s.mes}_${s.dre_linha}`;
      const atual = novo[key];
      if (atual == null || atual === 0) { novo[key] = s.valor_sugerido; preenchidas++; }
      else mantidas++;
    }
    setDraft(novo);

    const nMesAusente = new Set(
      seed.filter(s => s.flag === 'mes_ausente_media').map(s => `${s.dre_linha}_${s.mes}`)
    ).size;
    const nWinsorizado = new Set(
      seed.filter(s => s.flag === 'winsorizado').map(s => `${s.dre_linha}_${s.mes}`)
    ).size;
    const nAmostraCurta = new Set(
      seed.filter(s => s.flag === 'amostra_curta_sem_sugestao').map(s => s.dre_linha)
    ).size;

    const partes: string[] = [`${preenchidas} célula${preenchidas !== 1 ? 's' : ''} preenchida${preenchidas !== 1 ? 's' : ''}`];
    if (mantidas > 0) partes.push(`${mantidas} já preenchida${mantidas > 1 ? 's' : ''} mantida${mantidas > 1 ? 's' : ''}`);
    if (nMesAusente > 0) partes.push(`${nMesAusente} mês${nMesAusente > 1 ? 'es' : ''} pela média`);
    if (nWinsorizado > 0) partes.push(`${nWinsorizado} ajustado${nWinsorizado > 1 ? 's' : ''} por outlier`);
    if (nAmostraCurta > 0) partes.push(`${nAmostraCurta} linha${nAmostraCurta > 1 ? 's' : ''} sem histórico (em branco)`);

    toast.success(`Orçamento sugerido a partir de ${ano - 1} (+${crescimentoPerc}%). Revise e salve.`, {
      description: partes.length > 0 ? partes.join(', ') + '.' : undefined,
    });
  };

  if (loading) {
    return <PageSkeleton variant="list" />;
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
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  value={crescimentoPerc}
                  onChange={e => setCrescimentoPerc(Number(e.target.value))}
                  className="h-9 text-sm text-right w-[70px]"
                  aria-label="Crescimento percentual"
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
              <Button variant="outline" onClick={handleSugerir}>
                Sugerir de {ano - 1}
              </Button>
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
            <Badge variant="outline" className="text-[10px]">Regime de Competência</Badge>
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
                  const isGood = s.linha.includes('receita') || s.linha.includes('lucro')
                    ? s.variacao >= 0 : s.variacao <= 0;
                  return (
                    <TableRow key={s.linha}>
                      <TableCell className="sticky left-0 bg-background text-sm font-medium">{s.label}</TableCell>
                      <TableCell className="text-right text-sm">{fmtCompact(s.orcYtd)}</TableCell>
                      <TableCell className="text-right text-sm font-medium">{fmtCompact(s.realYtd)}</TableCell>
                      <TableCell className={`text-right text-sm font-bold ${isGood ? 'text-status-success' : 'text-status-error'}`}>
                        {s.variacao > 0 ? '+' : ''}{s.variacao.toFixed(1)}%
                      </TableCell>
                      <TableCell>
                        {!s.orcYtd ? (
                          <Badge variant="secondary" className="text-xs">Sem orçamento</Badge>
                        ) : (
                          <div className="flex items-center gap-1">
                            {isGood
                              ? <TrendingUp className="w-3.5 h-3.5 text-status-success" />
                              : <TrendingDown className="w-3.5 h-3.5 text-status-error" />}
                            <span className={`text-xs ${isGood ? 'text-status-success' : 'text-status-error'}`}>
                              {isGood ? 'Favorável' : 'Desfavorável'}
                            </span>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Forecast de aterrissagem */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Plane className="w-4 h-4" />
            Forecast de aterrissagem {ano}
            <Badge
              variant="outline"
              className={`text-[10px] ${
                forecast.confianca_geral === 'alta'
                  ? 'text-status-success'
                  : forecast.confianca_geral === 'media'
                  ? 'text-muted-foreground'
                  : 'text-status-warning'
              }`}
            >
              Confiança {forecast.confianca_geral}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {forecast.meses_fechados === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">
              Aguardando o 1º mês fechado de {ano} para projetar a aterrissagem.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 bg-background min-w-[200px]">Linha DRE</TableHead>
                    <TableHead className="text-right w-28">Landing</TableHead>
                    <TableHead className="text-right w-28">Orçado</TableHead>
                    <TableHead className="text-right w-28">Variância</TableHead>
                    <TableHead className="text-right w-24">% vs Orç.</TableHead>
                    <TableHead className="w-32">Status</TableHead>
                    <TableHead className="w-36">Método / Conf.</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {forecast.linhas.map((linha, idx) => {
                    const isDerivada = idx >= LINHAS_INPUT.length;
                    const pctVsOrc =
                      linha.orcado_ano !== null && linha.orcado_ano > 0 && linha.variancia !== null
                        ? ((linha.variancia / linha.orcado_ano) * 100).toFixed(1) + '%'
                        : '—';
                    const varianciaCor =
                      linha.favoravel === true
                        ? 'text-status-success'
                        : linha.favoravel === false
                        ? 'text-status-error'
                        : 'text-muted-foreground';
                    const isDrillable = linha.fura_meta && fontesDaLinha(linha.dre_linha).length > 0;
                    const isExpanded = expandedLinha === linha.dre_linha;

                    return (
                      <Fragment key={linha.dre_linha}>
                      <TableRow
                        className={`${isDerivada ? 'bg-muted/30' : ''} ${isDrillable ? 'cursor-pointer hover:bg-muted/40' : ''}`}
                        onClick={isDrillable ? () => setExpandedLinha(isExpanded ? null : linha.dre_linha) : undefined}
                      >
                        <TableCell
                          className={`sticky left-0 bg-background text-xs ${
                            isDerivada ? 'font-medium bg-muted/30' : ''
                          }`}
                        >
                          <span className="inline-flex items-center gap-1">
                            {isDrillable && (isExpanded
                              ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                              : <ChevronRight className="h-3 w-3 text-muted-foreground" />)}
                            {forecastLabel(linha.dre_linha)}
                          </span>
                        </TableCell>
                        <TableCell className={`text-right text-sm ${isDerivada ? 'font-medium' : ''}`}>
                          {fmtCompact(linha.landing)}
                        </TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">
                          {linha.orcado_ano !== null ? fmtCompact(linha.orcado_ano) : '—'}
                        </TableCell>
                        <TableCell className={`text-right text-sm font-medium ${varianciaCor}`}>
                          {linha.variancia !== null ? fmtCompact(linha.variancia) : '—'}
                        </TableCell>
                        <TableCell className={`text-right text-xs ${varianciaCor}`}>
                          {pctVsOrc}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {linha.fura_meta && (
                              <Badge variant="outline" className="text-[10px] text-status-warning border-status-warning/50">
                                Vai furar a meta
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {!isDerivada && (
                            <div className="flex flex-wrap gap-1">
                              <Badge variant="secondary" className="text-[10px]">
                                {linha.metodo.replace(/_/g, ' ')}
                              </Badge>
                              <Badge
                                variant="outline"
                                className={`text-[10px] ${
                                  linha.confianca === 'baixa' ? 'text-status-warning' : 'text-muted-foreground'
                                }`}
                              >
                                {linha.confianca}
                              </Badge>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow className="bg-muted/10 hover:bg-muted/10">
                          <TableCell colSpan={7} className="px-4">
                            <DrillVarianciaPanel
                              result={drillResult}
                              isLoading={drillBaseQuery.isLoading}
                              isError={drillBaseQuery.isError}
                              ano={ano}
                              lente={drillLente}
                              onLente={entidadeInfo ? setDrillLente : undefined}
                              entidadeRotulo={entidadeInfo?.rotulo ?? null}
                              entidadeData={entidadeQuery.data ?? null}
                              entidadeLoading={entidadeQuery.isLoading}
                              entidadeError={entidadeQuery.isError}
                              totalCategoriaV1={drillResult?.total_decomposto ?? null}
                              realizadoSnapshot={drillResult?.realizado_snapshot ?? null}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
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
                  {!editMode && <TableHead className="w-10" />}
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
                            <div className={`text-[10px] ${diff >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                              {diff > 0 ? '+' : ''}{fmtCompact(diff)}
                            </div>
                          )}
                        </TableCell>
                      );
                    })}
                    {!editMode && (() => {
                      const rec = orcamento.find(o => o.dre_linha === linha && o.mes === currentMonth && o.id)
                        || orcamento.find(o => o.dre_linha === linha && o.id);
                      return rec?.id ? (
                        <TableCell>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              setAuditTarget({
                                table: 'fin_orcamento',
                                id: rec.id!,
                                title: `Orçamento ${rec.dre_linha} ${rec.ano}/${String(rec.mes).padStart(2, '0')}`,
                              });
                            }}
                            aria-label="Histórico"
                          >
                            <History className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      ) : <TableCell />;
                    })()}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {auditTarget && (
        <AuditTrailDrawer
          open
          onOpenChange={(open) => !open && setAuditTarget(null)}
          tableName={auditTarget.table}
          rowId={auditTarget.id}
          title={auditTarget.title}
        />
      )}
    </div>
  );
};

export default FinanceiroOrcamento;
