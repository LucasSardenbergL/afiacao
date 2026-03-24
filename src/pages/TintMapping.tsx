import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Search, EyeOff, Eye } from 'lucide-react';
import { toast } from 'sonner';

const ACCOUNT = 'oben';

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
    onError: (e: any) => toast.error(e.message),
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
      await queryClient.cancelQueries({ queryKey: ['tint-skus-mapping'] });
      const previous = queryClient.getQueryData(['tint-skus-mapping']);
      queryClient.setQueryData(['tint-skus-mapping'], (old: any) =>
        old?.map((s: any) => s.id === skuId ? { ...s, ativo } : s)
      );
      return { previous };
    },
    onSuccess: (_, vars) => {
      toast.success(vars.ativo ? 'SKU reativado' : 'SKU ocultado');
    },
    onError: (e: any, _, context) => {
      if (context?.previous) queryClient.setQueryData(['tint-skus-mapping'], context.previous);
      toast.error(e.message);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['tint-skus-mapping'] });
    },
  });

  const filtered = (skus ?? []).filter((s: any) => {
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

  const totalSkus = skus?.length ?? 0;
  const activeSkus = (skus ?? []).filter((s: any) => s.ativo !== false).length;
  const inactiveSkus = totalSkus - activeSkus;

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Buscar produto ou base..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>

        <Select value={filterStatus} onValueChange={(v: any) => setFilterStatus(v)}>
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
            {filtered.map((sku: any) => {
              const linked = sku.omie_product_id ? omieMap.get(sku.omie_product_id) : null;
              const isInactive = sku.ativo === false;
              return (
                <TableRow key={sku.id} className={isInactive ? 'opacity-40 bg-muted/50 line-through decoration-muted-foreground/30' : ''}>
                  <TableCell className="text-sm">{sku.tint_produtos?.descricao}</TableCell>
                  <TableCell className="text-sm max-w-[200px] truncate">{sku.tint_bases?.descricao}</TableCell>
                  <TableCell className="text-sm">{sku.tint_embalagens?.descricao} ({sku.tint_embalagens?.volume_ml}ml)</TableCell>
                  <TableCell>
                    <Select
                      value={sku.omie_product_id || ''}
                      onValueChange={val => mutation.mutate({ skuId: sku.id, omieProductId: val || null })}
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
                  <TableCell className="text-sm">{linked?.estoque ?? '—'}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-between gap-2 min-w-[210px]">
                      {isInactive ? (
                        <Badge variant="outline" className="bg-muted text-muted-foreground">Oculto</Badge>
                      ) : (
                        <Badge variant="outline" className={sku.omie_product_id ? 'bg-green-500/10 text-green-700' : 'bg-yellow-500/10 text-yellow-700'}>
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
    onError: (e: any) => toast.error(e.message),
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
          {(corantes ?? []).map((c: any) => {
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
                  <Badge variant="outline" className={c.omie_product_id ? 'bg-green-500/10 text-green-700' : 'bg-yellow-500/10 text-yellow-700'}>
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
