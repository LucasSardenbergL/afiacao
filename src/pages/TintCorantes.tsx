import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';

const ACCOUNT = 'oben';

function useCorantes() {
  return useQuery({
    queryKey: ['tint-corantes-page'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_corantes')
        .select('id, id_corante_sayersystem, descricao, volume_total_ml, peso_especifico, codigo_barras, omie_product_id, ativo')
        .eq('account', ACCOUNT)
        .order('descricao');
      return data ?? [];
    },
  });
}

function useOmieMap() {
  return useQuery({
    queryKey: ['omie-concentrados-map'],
    queryFn: async () => {
      const { data } = await supabase
        .from('omie_products')
        .select('id, descricao, valor_unitario')
        .eq('account', ACCOUNT)
        .eq('is_tintometric', true)
        .eq('tint_type', 'concentrado');
      return new Map((data ?? []).map(p => [p.id, p]));
    },
  });
}

export default function TintCorantes() {
  const { data: corantes, isLoading } = useCorantes();
  const { data: omieMap } = useOmieMap();

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-60 w-full" /></div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tintométrico — Corantes</h1>
      <div className="border rounded-md overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Descrição</TableHead>
              <TableHead>Vol. Frasco</TableHead>
              <TableHead>Peso Específico</TableHead>
              <TableHead>Cód. Barras</TableHead>
              <TableHead>Produto Omie</TableHead>
              <TableHead>Custo Omie</TableHead>
              <TableHead>Custo/ml</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(corantes ?? []).map((c: any) => {
              const linked = c.omie_product_id && omieMap ? omieMap.get(c.omie_product_id) : null;
              const custoMl = linked && c.volume_total_ml > 0 ? linked.valor_unitario / c.volume_total_ml : null;
              return (
                <TableRow key={c.id}>
                  <TableCell className="text-sm font-mono">{c.id_corante_sayersystem}</TableCell>
                  <TableCell className="text-sm max-w-[300px] truncate">{c.descricao}</TableCell>
                  <TableCell className="text-sm">{c.volume_total_ml}ml</TableCell>
                  <TableCell className="text-sm">{c.peso_especifico ?? '—'}</TableCell>
                  <TableCell className="text-sm font-mono">{c.codigo_barras || '—'}</TableCell>
                  <TableCell className="text-sm max-w-[200px] truncate">{linked?.descricao || '—'}</TableCell>
                  <TableCell className="text-sm">{linked ? `R$ ${linked.valor_unitario.toFixed(2)}` : '—'}</TableCell>
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
    </div>
  );
}
