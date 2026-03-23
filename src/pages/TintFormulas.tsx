import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Search, ChevronDown, ChevronUp } from 'lucide-react';

const ACCOUNT = 'oben';
const PAGE_SIZE = 50;

function useProdutos() {
  return useQuery({
    queryKey: ['tint-produtos-list'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase.from('tint_produtos').select('id, cod_produto, descricao').eq('account', ACCOUNT).order('descricao');
      return data ?? [];
    },
  });
}

function useBases(produtoId: string) {
  return useQuery({
    queryKey: ['tint-bases-for-produto', produtoId],
    enabled: !!produtoId,
    queryFn: async () => {
      // Get distinct bases used in SKUs for this product
      const { data } = await supabase
        .from('tint_skus')
        .select('base_id, tint_bases!inner(id, descricao)')
        .eq('account', ACCOUNT)
        .eq('produto_id', produtoId);
      const seen = new Set<string>();
      return (data ?? []).filter((d: any) => {
        if (seen.has(d.base_id)) return false;
        seen.add(d.base_id);
        return true;
      }).map((d: any) => ({ id: d.base_id, descricao: d.tint_bases?.descricao }));
    },
  });
}

function useOmieMap() {
  return useQuery({
    queryKey: ['omie-tint-cost-map'],
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

export default function TintFormulas() {
  const [search, setSearch] = useState('');
  const [produtoFilter, setProdutoFilter] = useState('');
  const [baseFilter, setBaseFilter] = useState('');
  const [onlyPersonalizada, setOnlyPersonalizada] = useState(false);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: produtos } = useProdutos();
  const { data: bases } = useBases(produtoFilter);
  const { data: omieMap } = useOmieMap();

  const { data, isLoading } = useQuery({
    queryKey: ['tint-formulas', search, produtoFilter, baseFilter, onlyPersonalizada, page],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      let q = supabase
        .from('tint_formulas')
        .select(`
          id, cor_id, nome_cor, volume_final_ml, preco_final_sayersystem, personalizada,
          tint_produtos!inner(descricao),
          tint_bases!inner(descricao),
          tint_embalagens!inner(descricao, volume_ml)
        `, { count: 'exact' })
        .eq('account', ACCOUNT)
        .order('cor_id')
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (search) q = q.or(`cor_id.ilike.%${search}%,nome_cor.ilike.%${search}%`);
      if (produtoFilter) q = q.eq('produto_id', produtoFilter);
      if (baseFilter) q = q.eq('base_id', baseFilter);
      if (onlyPersonalizada) q = q.eq('personalizada', true);

      const { data: rows, count } = await q;
      return { rows: rows ?? [], total: count ?? 0 };
    },
  });

  const { data: expandedDetail } = useQuery({
    queryKey: ['tint-formula-detail', expanded],
    enabled: !!expanded,
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_formula_itens')
        .select(`
          qtd_ml, ordem,
          tint_corantes!inner(id, descricao, omie_product_id, volume_total_ml)
        `)
        .eq('formula_id', expanded!)
        .order('ordem');
      return data ?? [];
    },
  });

  const totalPages = Math.ceil((data?.total ?? 0) / PAGE_SIZE);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tintométrico — Catálogo de Fórmulas</h1>

      {/* Filters */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input placeholder="Código ou nome da cor..." value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} className="pl-9" />
            </div>
            <div className="w-48">
              <Select value={produtoFilter} onValueChange={v => { setProdutoFilter(v); setBaseFilter(''); setPage(0); }}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Produto" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Todos</SelectItem>
                  {(produtos ?? []).map(p => <SelectItem key={p.id} value={p.id}>{p.descricao}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {produtoFilter && (
              <div className="w-56">
                <Select value={baseFilter} onValueChange={v => { setBaseFilter(v); setPage(0); }}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Base" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Todas</SelectItem>
                    {(bases ?? []).map((b: any) => <SelectItem key={b.id} value={b.id}>{b.descricao}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Switch id="personalizada" checked={onlyPersonalizada} onCheckedChange={v => { setOnlyPersonalizada(v); setPage(0); }} />
              <Label htmlFor="personalizada" className="text-sm">Personalizadas</Label>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      {isLoading ? <Skeleton className="h-60 w-full" /> : (
        <Card>
          <CardContent className="pt-4">
            <div className="border rounded-md overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Cor ID</TableHead>
                    <TableHead>Nome Cor</TableHead>
                    <TableHead>Produto</TableHead>
                    <TableHead>Base</TableHead>
                    <TableHead>Embalagem</TableHead>
                    <TableHead>Volume</TableHead>
                    <TableHead>Preço CSV</TableHead>
                    <TableHead>Tipo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.rows ?? []).map((f: any) => (
                    <>
                      <TableRow key={f.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setExpanded(expanded === f.id ? null : f.id)}>
                        <TableCell>
                          {expanded === f.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </TableCell>
                        <TableCell className="text-sm font-mono">{f.cor_id}</TableCell>
                        <TableCell className="text-sm">{f.nome_cor}</TableCell>
                        <TableCell className="text-sm">{f.tint_produtos?.descricao}</TableCell>
                        <TableCell className="text-sm max-w-[150px] truncate">{f.tint_bases?.descricao}</TableCell>
                        <TableCell className="text-sm">{f.tint_embalagens?.descricao}</TableCell>
                        <TableCell className="text-sm">{f.volume_final_ml ? `${f.volume_final_ml}ml` : '—'}</TableCell>
                        <TableCell className="text-sm">{f.preco_final_sayersystem ? `R$ ${Number(f.preco_final_sayersystem).toFixed(2)}` : '—'}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={f.personalizada ? 'bg-purple-500/10 text-purple-700' : 'bg-blue-500/10 text-blue-700'}>
                            {f.personalizada ? 'Personalizada' : 'Padrão'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                      {expanded === f.id && expandedDetail && (
                        <TableRow key={`${f.id}-detail`}>
                          <TableCell colSpan={9} className="bg-muted/30 p-4">
                            <div className="space-y-2">
                              <h4 className="text-sm font-semibold">Corantes utilizados</h4>
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>#</TableHead>
                                    <TableHead>Corante</TableHead>
                                    <TableHead>Qtd (ml)</TableHead>
                                    <TableHead>Custo/ml</TableHead>
                                    <TableHead>Custo Item</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {expandedDetail.map((it: any, idx: number) => {
                                    const cor = it.tint_corantes;
                                    const custoConc = cor?.omie_product_id && omieMap ? (omieMap.get(cor.omie_product_id) ?? 0) : 0;
                                    const custoMl = cor?.volume_total_ml > 0 ? custoConc / cor.volume_total_ml : 0;
                                    const custoItem = custoMl * it.qtd_ml;
                                    return (
                                      <TableRow key={idx}>
                                        <TableCell className="text-sm">{it.ordem}</TableCell>
                                        <TableCell className="text-sm">{cor?.descricao}</TableCell>
                                        <TableCell className="text-sm">{it.qtd_ml}</TableCell>
                                        <TableCell className="text-sm">{custoMl > 0 ? `R$ ${custoMl.toFixed(4)}` : '—'}</TableCell>
                                        <TableCell className="text-sm">{custoItem > 0 ? `R$ ${custoItem.toFixed(4)}` : '—'}</TableCell>
                                      </TableRow>
                                    );
                                  })}
                                </TableBody>
                              </Table>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between mt-4">
              <span className="text-sm text-muted-foreground">{data?.total.toLocaleString('pt-BR')} fórmulas</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Anterior</Button>
                <span className="text-sm py-1 px-2">{page + 1} / {totalPages || 1}</span>
                <Button size="sm" variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Próxima</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
