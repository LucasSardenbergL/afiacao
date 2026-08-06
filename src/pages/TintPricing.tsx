import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ilikeContainsPattern } from '@/lib/postgrest';
import { useTintPrices } from '@/hooks/useTintPricing';
import { precoSimulador } from '@/lib/tint/simulador-preco';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Search, Save, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

const ACCOUNT = 'oben';

interface TintSkuRow {
  id: string;
  omie_product_id: string | null;
  imposto_pct: number | null;
  margem_pct: number | null;
  tint_produtos?: { descricao: string | null } | null;
  tint_bases?: { descricao: string | null } | null;
  tint_embalagens?: { descricao: string | null; volume_ml: number | null } | null;
  omie_products?: { valor_unitario: number | null } | null;
}

/** Linha da CANÔNICA (v_tint_formula_canonica) — a MESMA fórmula que o balcão serve. */
interface SimFormulaRow {
  id: string;
  cor_id: string;
  nome_cor: string | null;
  sku_id: string;
  preco_csv_legado: number | null;
  is_sl: boolean | null;
  tem_receita: boolean | null;
  personalizada: boolean | null;
}

interface SimReceitaItem {
  formula_id: string;
  qtd_ml: number;
  ordem: number;
  tint_corantes: { descricao: string | null } | null;
}

function useMappedSkus() {
  return useQuery({
    queryKey: ['tint-skus-pricing'],
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_skus')
        .select(`
          id, omie_product_id, imposto_pct, margem_pct,
          tint_produtos!inner(descricao),
          tint_bases!inner(descricao),
          tint_embalagens!inner(descricao, volume_ml),
          omie_products!tint_skus_omie_product_id_fkey(valor_unitario)
        `)
        .eq('account', ACCOUNT)
        .not('omie_product_id', 'is', null)
        .order('created_at');
      return data ?? [];
    },
  });
}

// Busca na CANÔNICA: 1 fórmula por (sku, cor) — a linha que o balcão serve
// (preferência SL, fallback SAYERLACK), ordem determinística. Antes: tabela
// crua → as 2 gerações apareciam duplicadas, sem ordem estável.
function useFormulaSearch(corId: string) {
  return useQuery({
    queryKey: ['tint-sim-formula-search', corId],
    enabled: corId.length >= 2,
    queryFn: async (): Promise<SimFormulaRow[]> => {
      const pat = ilikeContainsPattern(corId);
      if (!pat) return [];
      // Erro LANÇA — lista vazia mentiria "cor não encontrada" (lição do balcão).
      const { data, error } = await supabase
        .from('v_tint_formula_canonica')
        .select('id, cor_id, nome_cor, sku_id, preco_csv_legado, is_sl, tem_receita, personalizada')
        .eq('account', ACCOUNT)
        .ilike('cor_id', pat)
        .order('cor_id', { ascending: true })
        .order('id', { ascending: true })
        .limit(20);
      if (error) throw error;
      // Tipo gerado da view é todo nullable; id/cor_id/sku_id são NOT NULL de
      // fato (a view filtra sku) — narrowing na fronteira, como no balcão.
      return (data ?? []).filter(
        (r): r is typeof r & { id: string; cor_id: string; sku_id: string } =>
          r.id != null && r.cor_id != null && r.sku_id != null,
      );
    },
  });
}

// Descrições de produto/embalagem dos SKUs das fórmulas achadas (só exibição).
function useSkuDescricoes(skuIds: string[]) {
  const ids = [...new Set(skuIds)].sort();
  return useQuery({
    queryKey: ['tint-sim-sku-desc', ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tint_skus')
        .select('id, tint_produtos!inner(descricao), tint_embalagens!inner(volume_ml)')
        .in('id', ids);
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<{
        id: string;
        tint_produtos: { descricao: string | null } | null;
        tint_embalagens: { volume_ml: number | null } | null;
      }>;
      return new Map(rows.map((s) => [s.id, {
        produto: s.tint_produtos?.descricao ?? null,
        volumeMl: s.tint_embalagens?.volume_ml ?? null,
      }]));
    },
  });
}

// Receita (informativa) das fórmulas achadas — staff lê tint_formula_itens
// direto (policy "Staff can manage"). Só a QTD; o custo vem da RPC, nunca daqui.
function useReceitas(formulaIds: string[]) {
  const ids = [...new Set(formulaIds)].sort();
  return useQuery({
    queryKey: ['tint-sim-receitas', ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tint_formula_itens')
        .select('formula_id, qtd_ml, ordem, tint_corantes(descricao)')
        .in('formula_id', ids)
        .order('formula_id')
        .order('ordem');
      if (error) throw error;
      const map = new Map<string, string[]>();
      for (const it of (data ?? []) as unknown as SimReceitaItem[]) {
        const rotulo = `${(it.tint_corantes?.descricao ?? '?').split(' - ')[0]} (${it.qtd_ml}ml)`;
        const arr = map.get(it.formula_id) ?? [];
        arr.push(rotulo);
        map.set(it.formula_id, arr);
      }
      return map;
    },
  });
}

export default function TintPricing() {
  const { data: skus, isLoading } = useMappedSkus();
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Record<string, { imposto_pct: number; margem_pct: number }>>({});
  const [corSearch, setCorSearch] = useState('');
  const { data: searchResults, isLoading: searchLoading, isError: searchError } = useFormulaSearch(corSearch);

  const resultados = searchResults ?? [];
  // Preço honesto: o MESMO motor batch do balcão (get_tint_prices) + a MESMA
  // seleção (select-price). Nada de recalcular base×imposto×margem aqui — era
  // o motor paralelo que fabricava número com receita vazia/parcial (Fase 4).
  const formulaIds = resultados.map((f) => f.id);
  const { data: priceMap, isLoading: pricesLoading } = useTintPrices(formulaIds);
  const batchCarregando = formulaIds.length > 0 && pricesLoading;
  const { data: skuDesc } = useSkuDescricoes(resultados.map((f) => f.sku_id));
  const { data: receitas } = useReceitas(formulaIds);

  const saveMutation = useMutation({
    mutationFn: async (updates: Array<{ id: string; imposto_pct: number; margem_pct: number }>) => {
      for (const u of updates) {
        const { error } = await supabase
          .from('tint_skus')
          .update({ imposto_pct: u.imposto_pct, margem_pct: u.margem_pct, updated_at: new Date().toISOString() })
          .eq('id', u.id);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      setEdits({});
      queryClient.invalidateQueries({ queryKey: ['tint-skus-pricing'] });
      toast.success('Preços salvos');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleSaveAll = () => {
    const updates = Object.entries(edits).map(([id, vals]) => ({ id, ...vals }));
    if (updates.length === 0) { toast.info('Nenhuma alteração'); return; }
    saveMutation.mutate(updates);
  };

  const getEdit = (skuId: string, sku: TintSkuRow) => {
    return edits[skuId] || { imposto_pct: sku.imposto_pct ?? 0, margem_pct: sku.margem_pct ?? 0 };
  };

  const calcPrice = (custo: number, imposto: number, margem: number) => {
    return custo * (1 + imposto / 100) * (1 + margem / 100);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tintométrico — Precificação</h1>

      {/* Section 1: Tax & Margin */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">Imposto e Margem por SKU</CardTitle>
            <p className="text-xs text-muted-foreground max-w-2xl">
              Referência interna: o preço do balcão vem da RPC honesta (custo base Omie + corantes)
              e NÃO usa estes percentuais — o sync SayerSystem usa imposto/margem do próprio SayerSystem.
            </p>
          </div>
          <Button size="sm" onClick={handleSaveAll} disabled={Object.keys(edits).length === 0}>
            <Save className="w-4 h-4 mr-2" /> Salvar Todos
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-40 w-full" /> : (
            <div className="border rounded-md overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produto</TableHead>
                    <TableHead>Base</TableHead>
                    <TableHead>Embalagem</TableHead>
                    <TableHead>Custo Base</TableHead>
                    <TableHead>Imposto %</TableHead>
                    <TableHead>Margem %</TableHead>
                    <TableHead>Referência</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {((skus ?? []) as unknown as TintSkuRow[]).map((sku) => {
                    const custo = sku.omie_products?.valor_unitario ?? 0;
                    const e = getEdit(sku.id, sku);
                    const preco = calcPrice(custo, e.imposto_pct, e.margem_pct);
                    return (
                      <TableRow key={sku.id}>
                        <TableCell className="text-sm">{sku.tint_produtos?.descricao}</TableCell>
                        <TableCell className="text-sm max-w-[180px] truncate">{sku.tint_bases?.descricao}</TableCell>
                        <TableCell className="text-sm">{sku.tint_embalagens?.volume_ml}ml</TableCell>
                        <TableCell className="text-sm">R$ {custo.toFixed(2)}</TableCell>
                        <TableCell>
                          <Input
                            type="number" step="0.1" className="h-7 w-20 text-sm"
                            value={e.imposto_pct}
                            onChange={ev => setEdits(prev => ({ ...prev, [sku.id]: { ...e, imposto_pct: parseFloat(ev.target.value) || 0 } }))}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number" step="0.1" className="h-7 w-20 text-sm"
                            value={e.margem_pct}
                            onChange={ev => setEdits(prev => ({ ...prev, [sku.id]: { ...e, margem_pct: parseFloat(ev.target.value) || 0 } }))}
                          />
                        </TableCell>
                        <TableCell className="text-sm font-medium">R$ {preco.toFixed(2)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 2: Formula Price Simulator — preço do BALCÃO (RPC + seleção), sem motor paralelo */}
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-base">Simulador de Preço por Fórmula</CardTitle>
          <p className="text-xs text-muted-foreground">
            Mostra o preço que o balcão cobraria — mesma fórmula canônica e mesmo motor de preço da
            venda. Fórmula sem receita ou sem custo aparece como "sem preço", nunca um número fabricado.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Buscar por código de cor..." value={corSearch} onChange={e => setCorSearch(e.target.value)} className="pl-9" />
          </div>

          {searchError && (
            <p className="text-sm text-status-error">Erro ao buscar fórmulas — tente novamente.</p>
          )}
          {corSearch.length >= 2 && !searchLoading && !searchError && resultados.length === 0 && (
            <p className="text-sm text-muted-foreground">Nenhuma fórmula encontrada para "{corSearch}".</p>
          )}

          {resultados.length > 0 && (
            <div className="space-y-4">
              {resultados.map((f) => {
                const view = precoSimulador({
                  precoCsv: f.preco_csv_legado,
                  pricing: priceMap?.[f.id] ?? null,
                  batchCarregando,
                  temReceita: f.tem_receita,
                });
                const desc = skuDesc?.get(f.sku_id);
                const corantesRotulo = receitas?.get(f.id);

                return (
                  <div key={f.id} className="border rounded-md p-4 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm">{f.cor_id}</span>
                      <span className="text-sm text-muted-foreground">{f.nome_cor}</span>
                      {desc?.produto && <Badge variant="outline">{desc.produto}</Badge>}
                      {desc?.volumeMl != null && <Badge variant="outline">{desc.volumeMl}ml</Badge>}
                      <Badge variant="outline">
                        {f.personalizada ? 'personalizada' : f.is_sl ? 'receita viva (SL)' : 'versão anterior'}
                      </Badge>
                    </div>

                    {view.status === 'carregando' && <Skeleton className="h-5 w-64" />}

                    {view.status === 'com-preco' && (
                      <div className="flex items-center gap-3 flex-wrap text-sm">
                        <span className="font-medium">Balcão cobra: R$ {view.preco!.toFixed(2)}</span>
                        <Badge variant="secondary">
                          {view.fonte === 'calculado' ? 'Calculado (receita viva)' : 'Tabela (versão anterior)'}
                        </Badge>
                        {view.precoCalc != null && view.fonte !== 'calculado' && (
                          <span className="text-muted-foreground">Calculado: R$ {view.precoCalc.toFixed(2)}</span>
                        )}
                        {view.precoTabela != null && view.fonte !== 'tabela' && (
                          <span className="text-muted-foreground">Tabela: R$ {view.precoTabela.toFixed(2)}</span>
                        )}
                        {view.recalculado && view.precoImportadoAnterior != null && (
                          <span className="flex items-center gap-1 text-xs text-status-warning">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            recalculado acima do importado (antes R$ {view.precoImportadoAnterior.toFixed(2)})
                          </span>
                        )}
                      </div>
                    )}

                    {view.status === 'sem-preco' && (
                      <div className="flex items-center gap-1.5 text-sm text-status-warning">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        <span>Sem preço — {view.motivo}</span>
                      </div>
                    )}

                    {corantesRotulo && corantesRotulo.length > 0 && (
                      <div className="text-xs text-muted-foreground">
                        Corantes: {corantesRotulo.join(', ')}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
