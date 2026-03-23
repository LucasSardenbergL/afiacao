import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Search, Save, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

const ACCOUNT = 'oben';

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

function useFormulaSearch(corId: string) {
  return useQuery({
    queryKey: ['tint-formula-search', corId],
    enabled: corId.length >= 2,
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_formulas')
        .select(`
          id, cor_id, nome_cor, volume_final_ml, preco_final_sayersystem,
          tint_produtos!inner(descricao),
          tint_bases!inner(descricao),
          tint_embalagens!inner(descricao, volume_ml),
          tint_skus(id, omie_product_id, imposto_pct, margem_pct),
          tint_formula_itens(
            qtd_ml, ordem,
            tint_corantes!inner(id, descricao, omie_product_id, volume_total_ml)
          )
        `)
        .eq('account', ACCOUNT)
        .ilike('cor_id', `%${corId}%`)
        .limit(20);
      return data ?? [];
    },
  });
}

function useOmieProductMap() {
  return useQuery({
    queryKey: ['omie-tint-products-all'],
    queryFn: async () => {
      const { data } = await supabase
        .from('omie_products')
        .select('id, valor_unitario')
        .eq('account', ACCOUNT)
        .eq('is_tintometric', true);
      return new Map((data ?? []).map(p => [p.id, p.valor_unitario]));
    },
  });
}

export default function TintPricing() {
  const { data: skus, isLoading } = useMappedSkus();
  const { data: omieMap } = useOmieProductMap();
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Record<string, { imposto_pct: number; margem_pct: number }>>({});
  const [corSearch, setCorSearch] = useState('');
  const { data: searchResults } = useFormulaSearch(corSearch);

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
    onError: (e: any) => toast.error(e.message),
  });

  const handleSaveAll = () => {
    const updates = Object.entries(edits).map(([id, vals]) => ({ id, ...vals }));
    if (updates.length === 0) { toast.info('Nenhuma alteração'); return; }
    saveMutation.mutate(updates);
  };

  const getEdit = (skuId: string, sku: any) => {
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
          <CardTitle className="text-base">Imposto e Margem por SKU</CardTitle>
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
                    <TableHead>Preço Venda</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(skus ?? []).map((sku: any) => {
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

      {/* Section 2: Formula Price Simulator */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Simulador de Preço por Fórmula</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Buscar por código de cor..." value={corSearch} onChange={e => setCorSearch(e.target.value)} className="pl-9" />
          </div>

          {searchResults && searchResults.length > 0 && (
            <div className="space-y-4">
              {searchResults.map((f: any) => {
                const baseCusto = f.tint_skus?.omie_product_id && omieMap ? (omieMap.get(f.tint_skus.omie_product_id) ?? 0) : 0;
                const impostoP = f.tint_skus?.imposto_pct ?? 0;
                const margemP = f.tint_skus?.margem_pct ?? 0;
                const precoBase = calcPrice(baseCusto, impostoP, margemP);

                let custoCorantes = 0;
                const itens = f.tint_formula_itens ?? [];
                for (const item of itens) {
                  const cor = item.tint_corantes;
                  if (cor?.omie_product_id && omieMap) {
                    const custoConc = omieMap.get(cor.omie_product_id) ?? 0;
                    const custoMl = cor.volume_total_ml > 0 ? custoConc / cor.volume_total_ml : 0;
                    custoCorantes += custoMl * item.qtd_ml;
                  }
                }
                const precoFinal = precoBase + custoCorantes;
                const precoCsv = f.preco_final_sayersystem ?? 0;
                const divergence = precoCsv > 0 ? Math.abs(precoFinal - precoCsv) / precoCsv * 100 : 0;

                return (
                  <div key={f.id} className="border rounded-md p-4 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm">{f.cor_id}</span>
                      <span className="text-sm text-muted-foreground">{f.nome_cor}</span>
                      <Badge variant="outline">{f.tint_produtos?.descricao}</Badge>
                      <Badge variant="outline">{f.tint_embalagens?.volume_ml}ml</Badge>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                      <div><span className="text-muted-foreground">Preço Base:</span> R$ {precoBase.toFixed(2)}</div>
                      <div><span className="text-muted-foreground">Corantes:</span> R$ {custoCorantes.toFixed(2)}</div>
                      <div className="font-medium"><span className="text-muted-foreground">Final Calc:</span> R$ {precoFinal.toFixed(2)}</div>
                      <div className="flex items-center gap-1">
                        <span className="text-muted-foreground">CSV:</span> R$ {precoCsv.toFixed(2)}
                        {divergence > 5 && <AlertTriangle className="w-3.5 h-3.5 text-yellow-500" />}
                      </div>
                    </div>
                    {itens.length > 0 && (
                      <div className="text-xs text-muted-foreground">
                        Corantes: {itens.map((it: any) => `${it.tint_corantes?.descricao?.split(' - ')[0]} (${it.qtd_ml}ml)`).join(', ')}
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
