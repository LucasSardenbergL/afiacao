import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Beaker, Package, Droplets, FileUp, AlertTriangle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

const ACCOUNT = 'oben';

function useMetrics() {
  return useQuery({
    queryKey: ['tint-dashboard-metrics'],
    queryFn: async () => {
      const [formulas, skusAll, skusMapped, corantesAll, corantesMapped, lastImport] = await Promise.all([
        supabase.from('tint_formulas').select('id', { count: 'exact', head: true }).eq('account', ACCOUNT),
        supabase.from('tint_skus').select('id', { count: 'exact', head: true }).eq('account', ACCOUNT),
        supabase.from('tint_skus').select('id', { count: 'exact', head: true }).eq('account', ACCOUNT).not('omie_product_id', 'is', null),
        supabase.from('tint_corantes').select('id', { count: 'exact', head: true }).eq('account', ACCOUNT),
        supabase.from('tint_corantes').select('id', { count: 'exact', head: true }).eq('account', ACCOUNT).not('omie_product_id', 'is', null),
        supabase.from('tint_importacoes').select('*').eq('account', ACCOUNT).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      return {
        totalFormulas: formulas.count ?? 0,
        totalSkus: skusAll.count ?? 0,
        skusMapped: skusMapped.count ?? 0,
        totalCorantes: corantesAll.count ?? 0,
        corantesMapped: corantesMapped.count ?? 0,
        lastImport: lastImport.data,
      };
    },
  });
}

function useLastErrors() {
  return useQuery({
    queryKey: ['tint-dashboard-errors'],
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_importacoes')
        .select('id, tipo, arquivo_nome, registros_erro, erros_detalhe, created_at')
        .eq('account', ACCOUNT)
        .gt('registros_erro', 0)
        .order('created_at', { ascending: false })
        .limit(5);
      return data ?? [];
    },
  });
}

const statusColor: Record<string, string> = {
  concluido: 'bg-green-500/10 text-green-700 border-green-200',
  parcial: 'bg-yellow-500/10 text-yellow-700 border-yellow-200',
  erro: 'bg-red-500/10 text-red-700 border-red-200',
  processando: 'bg-blue-500/10 text-blue-700 border-blue-200',
};

export default function TintDashboard() {
  const { data: m, isLoading } = useMetrics();
  const { data: errors } = useLastErrors();

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-8 w-64" /><div className="grid grid-cols-1 md:grid-cols-4 gap-4">{[1,2,3,4].map(i=><Skeleton key={i} className="h-28"/>)}</div></div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tintométrico — Dashboard</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Fórmulas</CardTitle>
            <Beaker className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{(m?.totalFormulas ?? 0).toLocaleString('pt-BR')}</p>
            <p className="text-xs text-muted-foreground">importadas</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">SKUs</CardTitle>
            <Package className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{m?.skusMapped ?? 0} / {m?.totalSkus ?? 0}</p>
            <p className="text-xs text-muted-foreground">mapeados ao Omie</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Corantes</CardTitle>
            <Droplets className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{m?.corantesMapped ?? 0} / {m?.totalCorantes ?? 0}</p>
            <p className="text-xs text-muted-foreground">mapeados ao Omie</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Última Importação</CardTitle>
            <FileUp className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {m?.lastImport ? (
              <>
                <p className="text-sm font-medium">{m.lastImport.tipo}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(m.lastImport.created_at).toLocaleDateString('pt-BR')} — {m.lastImport.registros_importados ?? 0} importados
                </p>
                <Badge variant="outline" className={statusColor[m.lastImport.status] || ''}>
                  {m.lastImport.status}
                </Badge>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Nenhuma importação</p>
            )}
          </CardContent>
        </Card>
      </div>

      {errors && errors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-yellow-500" />
              Últimos Erros de Importação
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {errors.map((imp: any) => (
                <div key={imp.id} className="border rounded-md p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium">{imp.arquivo_nome}</span>
                    <Badge variant="outline" className={statusColor[imp.status] || ''}>{imp.tipo}</Badge>
                    <span className="text-xs text-muted-foreground">{new Date(imp.created_at).toLocaleDateString('pt-BR')}</span>
                  </div>
                  <p className="text-xs text-destructive">{imp.registros_erro} erro(s)</p>
                  {imp.erros_detalhe && Array.isArray(imp.erros_detalhe) && (
                    <ul className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      {(imp.erros_detalhe as any[]).slice(0, 3).map((e: any, i: number) => (
                        <li key={i}>Linha {e.linha}: {e.motivo}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
