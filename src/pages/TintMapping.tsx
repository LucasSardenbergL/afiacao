import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Search, EyeOff, Eye, Wand2, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { OmieBaseCombobox, type ProdutoOmieOption } from '@/components/tint/OmieBaseCombobox';
import { sugerirMapeamento, type LinhaSku } from '@/lib/tint/omie-match';

const ACCOUNT = 'oben';

interface SkuRow {
  id: string;
  omie_product_id: string | null;
  ativo: boolean | null;
  tint_produtos: { descricao: string | null; cod_produto: string | null } | null;
  tint_bases: { descricao: string | null } | null;
  tint_embalagens: { descricao: string | null; volume_ml: number | null } | null;
}

interface CoranteRow {
  id: string;
  descricao: string;
  omie_product_id: string | null;
  volume_total_ml: number;
}

type FilterStatus = 'all' | 'mapped' | 'pending';

function useOmieProducts(tintType: string) {
  return useQuery({
    queryKey: ['omie-tint-products', tintType],
    queryFn: async () => {
      const { data } = await supabase
        .from('omie_products')
        .select('id, codigo, descricao, valor_unitario, estoque')
        .eq('account', ACCOUNT)
        .eq('is_tintometric', true)
        .eq('tint_type', tintType)
        .eq('ativo', true)
        .order('descricao');
      return data ?? [];
    },
  });
}

function useSkus() {
  return useQuery({
    queryKey: ['tint-skus-mapping'],
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_skus')
        .select(`
          id, omie_product_id, ativo,
          tint_produtos!inner(descricao, cod_produto),
          tint_bases!inner(descricao),
          tint_embalagens!inner(descricao, volume_ml)
        `)
        .eq('account', ACCOUNT)
        .order('created_at');
      return data ?? [];
    },
  });
}

function useCorantes() {
  return useQuery({
    queryKey: ['tint-corantes-mapping'],
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_corantes')
        .select('id, descricao, omie_product_id, volume_total_ml')
        .eq('account', ACCOUNT)
        .order('descricao');
      return data ?? [];
    },
  });
}

function SkuTab() {
  const { data: skus, isLoading } = useSkus();
  const { data: omieProducts } = useOmieProducts('base');
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [filterStatus, setFilterStatus] = useState<'all' | 'mapped' | 'pending'>('all');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async ({ skuId, omieProductId }: { skuId: string; omieProductId: string | null }) => {
      const { error } = await supabase
        .from('tint_skus')
        .update({ omie_product_id: omieProductId, updated_at: new Date().toISOString() })
        .eq('id', skuId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tint-skus-mapping'] });
      queryClient.invalidateQueries({ queryKey: ['tint-dashboard-metrics'] });
      toast.success('SKU mapeado');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleAtivoMutation = useMutation({
    mutationFn: async ({ skuId, ativo }: { skuId: string; ativo: boolean }) => {
      const { error } = await supabase
        .from('tint_skus')
        .update({ ativo, updated_at: new Date().toISOString() })
        .eq('id', skuId);
      if (error) throw error;
    },
    onMutate: async ({ skuId, ativo }) => {
      const previous = queryClient.getQueryData<SkuRow[]>(['tint-skus-mapping']);
      queryClient.setQueryData<SkuRow[]>(['tint-skus-mapping'], (old) =>
        old?.map((s) => s.id === skuId ? { ...s, ativo } : s)
      );
      return { previous };
    },
    onSuccess: (_, vars) => {
      toast.success(vars.ativo ? 'SKU reativado' : 'SKU ocultado');
    },
    onError: (e: Error, _, context) => {
      if (context?.previous) queryClient.setQueryData(['tint-skus-mapping'], context.previous);
      toast.error(e.message);
    },
  });

  const filtered = ((skus ?? []) as SkuRow[]).filter((s) => {
    if (!showInactive && s.ativo === false) return false;
    if (filterStatus === 'mapped' && !s.omie_product_id) return false;
    if (filterStatus === 'pending' && s.omie_product_id) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.tint_produtos?.descricao?.toLowerCase().includes(q) ||
      s.tint_bases?.descricao?.toLowerCase().includes(q) ||
      s.tint_produtos?.cod_produto?.toLowerCase().includes(q)
    );
  });

  const omieMap = new Map((omieProducts ?? []).map(p => [p.id, p]));
  const omieOptions = (omieProducts ?? []) as ProdutoOmieOption[];

  // Auto-sugestão de mapeamento (eu sugiro, você aprova). As 'forte' ficam em
  // estado local até aprovar; aprovar reativa o SKU se estiver oculto.
  const [sugestoes, setSugestoes] = useState<Map<string, string>>(new Map());
  const idsJaMapeados = useMemo(
    () =>
      new Set(
        ((skus ?? []) as SkuRow[]).map((s) => s.omie_product_id).filter((x): x is string => !!x),
      ),
    [skus],
  );
  function linhaDoSku(s: SkuRow): LinhaSku {
    return {
      baseDescricao: s.tint_bases?.descricao ?? '',
      embalagemDescricao: s.tint_embalagens?.descricao ?? '',
      produtoDescricao: s.tint_produtos?.descricao ?? '',
    };
  }
  function gerarSugestoes() {
    const novas = new Map<string, string>();
    for (const s of filtered) {
      if (s.omie_product_id) continue;
      const sug = sugerirMapeamento(linhaDoSku(s), omieOptions, idsJaMapeados);
      if (sug.tipo === 'forte') novas.set(s.id, sug.produtoId);
    }
    setSugestoes(novas);
    toast[novas.size ? 'success' : 'info'](
      novas.size
        ? `${novas.size} sugestão(ões) forte(s) — revise e aprove`
        : 'Nenhuma sugestão forte encontrada (os ambíguos ficam pra você escolher no seletor)',
    );
  }
  function descartarSugestao(skuId: string) {
    setSugestoes((prev) => {
      const m = new Map(prev);
      m.delete(skuId);
      return m;
    });
  }
  async function aprovarSugestao(skuId: string, omieProductId: string) {
    const { error } = await supabase
      .from('tint_skus')
      .update({ omie_product_id: omieProductId, ativo: true, updated_at: new Date().toISOString() })
      .eq('id', skuId);
    if (error) {
      toast.error(error.message);
      return;
    }
    descartarSugestao(skuId);
    queryClient.invalidateQueries({ queryKey: ['tint-skus-mapping'] });
    queryClient.invalidateQueries({ queryKey: ['tint-dashboard-metrics'] });
    toast.success('Mapeamento aprovado');
  }
  async function aprovarTodas() {
    const entries = [...sugestoes.entries()];
    let ok = 0;
    for (const [skuId, pid] of entries) {
      const { error } = await supabase
        .from('tint_skus')
        .update({ omie_product_id: pid, ativo: true, updated_at: new Date().toISOString() })
        .eq('id', skuId);
      if (error) {
        toast.error(error.message);
        break;
      }
      ok++;
    }
    setSugestoes(new Map());
    queryClient.invalidateQueries({ queryKey: ['tint-skus-mapping'] });
    queryClient.invalidateQueries({ queryKey: ['tint-dashboard-metrics'] });
    if (ok) toast.success(`${ok} mapeamento(s) aprovado(s)`);
  }

  const totalSkus = skus?.length ?? 0;
  const activeSkus = ((skus ?? []) as SkuRow[]).filter((s) => s.ativo !== false).length;
  const inactiveSkus = totalSkus - activeSkus;

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Buscar produto ou base..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>

        <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v as FilterStatus)}>
          <SelectTrigger className="w-[160px] h-9 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="mapped">Mapeados</SelectItem>
            <SelectItem value="pending">Pendentes</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <Switch id="show-inactive" checked={showInactive} onCheckedChange={setShowInactive} />
          <Label htmlFor="show-inactive" className="text-sm cursor-pointer">
            Mostrar ocultos ({inactiveSkus})
          </Label>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={gerarSugestoes}>
            <Wand2 className="h-4 w-4" /> Sugerir mapeamentos
          </Button>
          {sugestoes.size > 0 && (
            <>
              <Button size="sm" className="h-9 gap-1.5" onClick={aprovarTodas}>
                <Check className="h-4 w-4" /> Aprovar todas ({sugestoes.size})
              </Button>
              <Button variant="ghost" size="sm" className="h-9" onClick={() => setSugestoes(new Map())}>
                Descartar
              </Button>
            </>
          )}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Exibindo {filtered.length} de {totalSkus} SKUs
      </p>

      <div className="border rounded-md overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Produto</TableHead>
              <TableHead>Base</TableHead>
              <TableHead>Embalagem</TableHead>
              <TableHead className="min-w-[250px]">Produto Omie</TableHead>
              <TableHead>Custo</TableHead>
              <TableHead>Estoque</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((sku) => {
              const linked = sku.omie_product_id ? omieMap.get(sku.omie_product_id) : null;
              const isInactive = sku.ativo === false;
              return (
                <TableRow key={sku.id} className={isInactive ? 'opacity-40 bg-muted/50 line-through decoration-muted-foreground/30' : ''}>
                  <TableCell className="text-sm">{sku.tint_produtos?.descricao}</TableCell>
                  <TableCell className="text-sm max-w-[200px] truncate">{sku.tint_bases?.descricao}</TableCell>
                  <TableCell className="text-sm">{sku.tint_embalagens?.descricao} ({sku.tint_embalagens?.volume_ml}ml)</TableCell>
                  <TableCell>
                    {(() => {
                      const sugId = sugestoes.get(sku.id);
                      const sug = sugId ? omieMap.get(sugId) : null;
                      return (
                        <div className="space-y-1.5">
                          {sug && sugId && (
                            <div className="flex items-center gap-1.5 rounded-md border border-status-warning/40 bg-status-warning-bg px-2 py-1">
                              <span className="flex-1 truncate text-xs">
                                <span className="font-medium text-status-warning">Sugestão:</span>{' '}
                                <span className="font-mono">{sug.codigo}</span> — {sug.descricao}
                              </span>
                              <Button
                                size="sm"
                                className="h-6 px-2"
                                onClick={() => aprovarSugestao(sku.id, sugId)}
                                title="Aprovar (mapeia e reativa o SKU)"
                              >
                                <Check className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2"
                                onClick={() => descartarSugestao(sku.id)}
                                title="Descartar sugestão"
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          )}
                          <OmieBaseCombobox
                            produtos={omieOptions}
                            linha={linhaDoSku(sku)}
                            value={sku.omie_product_id}
                            onChange={(id) => mutation.mutate({ skuId: sku.id, omieProductId: id })}
                          />
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="text-sm">{linked ? `R$ ${linked.valor_unitario.toFixed(2)}` : '—'}</TableCell>
                  <TableCell className="text-sm">{linked?.estoque ?? '—'}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-between gap-2 min-w-[210px]">
                      {isInactive ? (
                        <Badge variant="outline" className="bg-muted text-muted-foreground">Oculto</Badge>
                      ) : (
                        <Badge variant="outline" className={sku.omie_product_id ? 'bg-status-success-bg text-status-success' : 'bg-status-warning-bg text-status-warning'}>
                          {sku.omie_product_id ? 'Mapeado' : 'Pendente'}
                        </Badge>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 shrink-0 gap-1"
                        title={isInactive ? 'Reativar SKU' : 'Ocultar SKU'}
                        onClick={() => toggleAtivoMutation.mutate({ skuId: sku.id, ativo: isInactive })}
                      >
                        {isInactive ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                        {isInactive ? 'Reativar' : 'Ocultar'}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function CoranteTab() {
  const { data: corantes, isLoading } = useCorantes();
  const { data: omieProducts } = useOmieProducts('concentrado');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async ({ coranteId, omieProductId }: { coranteId: string; omieProductId: string | null }) => {
      const { error } = await supabase
        .from('tint_corantes')
        .update({ omie_product_id: omieProductId })
        .eq('id', coranteId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tint-corantes-mapping'] });
      queryClient.invalidateQueries({ queryKey: ['tint-dashboard-metrics'] });
      toast.success('Corante mapeado');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const omieMap = new Map((omieProducts ?? []).map(p => [p.id, p]));

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="border rounded-md overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Corante</TableHead>
            <TableHead className="min-w-[250px]">Produto Omie</TableHead>
            <TableHead>Custo Omie</TableHead>
            <TableHead>Vol. Frasco</TableHead>
            <TableHead>Custo/ml</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {((corantes ?? []) as CoranteRow[]).map((c) => {
            const linked = c.omie_product_id ? omieMap.get(c.omie_product_id) : null;
            const custoMl = linked && c.volume_total_ml > 0 ? linked.valor_unitario / c.volume_total_ml : null;
            return (
              <TableRow key={c.id}>
                <TableCell className="text-sm max-w-[300px] truncate">{c.descricao}</TableCell>
                <TableCell>
                  <Select
                    value={c.omie_product_id || ''}
                    onValueChange={val => mutation.mutate({ coranteId: c.id, omieProductId: val || null })}
                  >
                    <SelectTrigger className="text-sm h-8">
                      <SelectValue placeholder="Selecionar..." />
                    </SelectTrigger>
                    <SelectContent>
                      {(omieProducts ?? []).map(p => (
                        <SelectItem key={p.id} value={p.id} className="text-sm">
                          {p.codigo} — {p.descricao}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-sm">{linked ? `R$ ${linked.valor_unitario.toFixed(2)}` : '—'}</TableCell>
                <TableCell className="text-sm">{c.volume_total_ml}ml</TableCell>
                <TableCell className="text-sm">{custoMl ? `R$ ${custoMl.toFixed(4)}` : '—'}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={c.omie_product_id ? 'bg-status-success-bg text-status-success' : 'bg-status-warning-bg text-status-warning'}>
                    {c.omie_product_id ? 'Mapeado' : 'Pendente'}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export default function TintMapping() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tintométrico — Mapeamento Omie</h1>
      <Tabs defaultValue="bases">
        <TabsList>
          <TabsTrigger value="bases">Bases (SKUs)</TabsTrigger>
          <TabsTrigger value="corantes">Corantes</TabsTrigger>
        </TabsList>
        <TabsContent value="bases"><SkuTab /></TabsContent>
        <TabsContent value="corantes"><CoranteTab /></TabsContent>
      </Tabs>
    </div>
  );
}
