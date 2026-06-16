import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { EMPRESA, formatBRL, ehPaiSplit } from './shared';

export function CiclosAnteriores({ data, onChange }: { data: string; onChange: (v: string) => void }) {
  const { data: historico, isLoading } = useQuery({
    queryKey: ['historico-ciclos', data],
    queryFn: async () => {
      // últimos 30 dias agregados
      const desde = new Date();
      desde.setDate(desde.getDate() - 30);
      const { data: rows, error } = await supabase
        .from('pedido_compra_sugerido')
        .select('data_ciclo,fornecedor_nome,status,valor_total')
        .eq('empresa', EMPRESA)
        .gte('data_ciclo', format(desde, 'yyyy-MM-dd'))
        .order('data_ciclo', { ascending: false });
      if (error) throw error;
      // agrupa por dia — exclui os pais de split (status='split_em_filhos'): o
      // valor_total do pai é a SOMA dos filhos, então contá-lo junto dos filhos
      // dobraria o valor/contagem do dia. Os filhos (status normal) entram normal.
      const grupos = new Map<string, { fornecedores: Set<string>; pedidos: number; valor: number; disparados: number; cancelados: number }>();
      for (const r of rows ?? []) {
        if (ehPaiSplit({ status: r.status as string })) continue;
        const k = r.data_ciclo as string;
        if (!grupos.has(k)) grupos.set(k, { fornecedores: new Set(), pedidos: 0, valor: 0, disparados: 0, cancelados: 0 });
        const g = grupos.get(k)!;
        g.fornecedores.add(r.fornecedor_nome ?? '');
        g.pedidos += 1;
        g.valor += Number(r.valor_total ?? 0);
        if (r.status === 'disparado') g.disparados += 1;
        if (r.status === 'cancelado') g.cancelados += 1;
      }
      return Array.from(grupos.entries()).map(([dia, g]) => ({
        dia,
        fornecedores: g.fornecedores.size,
        pedidos: g.pedidos,
        valor: g.valor,
        disparados: g.disparados,
        cancelados: g.cancelados,
      }));
    },
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">Últimos 30 dias</CardTitle>
        <Input type="date" value={data} onChange={(e) => onChange(e.target.value)} className="w-44" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (historico ?? []).length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">Sem ciclos no período.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead className="text-right">Fornecedores</TableHead>
                <TableHead className="text-right">Pedidos</TableHead>
                <TableHead className="text-right">Valor total</TableHead>
                <TableHead className="text-right">Disparados</TableHead>
                <TableHead className="text-right">Cancelados</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {historico!.map((h) => (
                <TableRow key={h.dia}>
                  <TableCell className="font-medium">{format(new Date(h.dia + 'T12:00:00'), 'dd/MM/yyyy')}</TableCell>
                  <TableCell className="text-right tabular-nums">{h.fornecedores}</TableCell>
                  <TableCell className="text-right tabular-nums">{h.pedidos}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBRL(h.valor)}</TableCell>
                  <TableCell className="text-right tabular-nums text-status-success">{h.disparados}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{h.cancelados}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
