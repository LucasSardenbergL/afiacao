import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Beaker, Package, Droplets, FileUp, AlertTriangle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { RecorrentesHojeCard } from '@/components/tarefas/RecorrentesHojeCard';
import {
  estadoDeLeitura, naoConsegui, desatualizado, type EstadoSemLeitura,
} from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';

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
      // `count ?? 0` é a fabricação do §2 do money-path (ausente ≠ zero) em 5 KPIs de uma vez:
      // sem olhar `error`, uma leitura que falhou virava "0 fórmulas" sobre 994.882 linhas
      // (psql-ro, 2026-09-07). Ausência de contagem NÃO é contagem zero — LANÇA.
      if (lastImport.error) throw lastImport.error;
      return {
        totalFormulas: contagem(formulas, 'fórmulas'),
        totalSkus: contagem(skusAll, 'SKUs'),
        skusMapped: contagem(skusMapped, 'SKUs mapeados'),
        totalCorantes: contagem(corantesAll, 'corantes'),
        corantesMapped: contagem(corantesMapped, 'corantes mapeados'),
        lastImport: lastImport.data,
      };
    },
  });
}

/**
 * A contagem de UMA das leituras do `Promise.all` — ou uma exceção.
 *
 * `count` nulo SEM erro é ausência de dado igual (o PostgREST não devolveu a contagem pedida),
 * e devolver 0 ali seria a mesma fabricação por outra porta. Fail-closed nos dois eixos.
 */
function contagem(r: { count: number | null; error: { message: string } | null }, oque: string): number {
  if (r.error) throw r.error;
  if (r.count == null) throw new Error(`contagem de ${oque} não veio na resposta`);
  return r.count;
}

function useLastErrors() {
  return useQuery({
    queryKey: ['tint-dashboard-errors'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tint_importacoes')
        .select('id, tipo, arquivo_nome, registros_erro, erros_detalhe, created_at')
        .eq('account', ACCOUNT)
        .gt('registros_erro', 0)
        .order('created_at', { ascending: false })
        .limit(5);
      // Sem desestruturar `error`, `data ?? []` fazia a query terminar em `success` com `[]` e o
      // card "Últimos Erros de Importação" sumir CALADO — 2.124 importações com erro na fonte
      // (psql-ro, 2026-09-07). O `error` do react-query nunca populava: o aviso era inalcançável.
      if (error) throw error;
      return data ?? [];
    },
  });
}

const statusColor: Record<string, string> = {
  concluido: 'bg-status-success-bg text-status-success border-status-success/40',
  parcial: 'bg-status-warning-bg text-status-warning border-status-warning/40',
  erro: 'bg-status-error-bg text-status-error border-status-error/40',
  processando: 'bg-status-info-bg text-status-info border-status-info/40',
};

/** Um KPI que a leitura não trouxe mostra travessão, nunca "0" — o zero aqui seria inventado. */
function kpi(v: number | undefined): string {
  return v === undefined ? '—' : v.toLocaleString('pt-BR');
}

export default function TintDashboard() {
  // A DESESTRUTURAÇÃO com `status`/`fetchStatus` é o que dá acesso ao estado da leitura; trocá-la
  // por `const q = useMetrics()` + `q.data` some com o sítio do detector do gate sem corrigir nada
  // (docs/historico/a-forma-que-some-e-a-forma-que-mente.md, achado da fatia #2).
  const { data: m, status: statusM, fetchStatus: fetchM } = useMetrics();
  const { data: errors, status: statusE, fetchStatus: fetchE } = useLastErrors();

  const fatiaM = { status: statusM, fetchStatus: fetchM };
  const fatiaE = { status: statusE, fetchStatus: fetchE };
  const estadoM = estadoDeLeitura(fatiaM);
  const estadoE = estadoDeLeitura(fatiaE);
  // `isLoading` era o ÚNICO gate do skeleton — e ele é FALSE no offline (`pending` + `paused`,
  // `data` undefined, `error` null). Sem rede a tela caía inteira no ramo dos zeros.
  const metricasSemLeitura: EstadoSemLeitura | null =
    naoConsegui(estadoM) && !m ? estadoM : null;
  const metricasVelhas = desatualizado(fatiaM, Boolean(m));
  const errosSemLeitura: EstadoSemLeitura | null =
    naoConsegui(estadoE) && !errors ? estadoE : null;
  const errosVelhos = desatualizado(fatiaE, Boolean(errors));

  if (estadoM === 'carregando') return <div className="space-y-4"><Skeleton className="h-8 w-64" /><div className="grid grid-cols-1 md:grid-cols-4 gap-4">{[1,2,3,4].map(i=><Skeleton key={i} className="h-28"/>)}</div></div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tintométrico — Dashboard</h1>

      {metricasSemLeitura && (
        <AvisoLeituraFalhou
          oque="os números do tintométrico (fórmulas, SKUs, corantes e a última importação)"
          estado={metricasSemLeitura}
          variante="bloco"
          testId="aviso-leitura-metricas"
        />
      )}
      {metricasVelhas && (
        <AvisoLeituraFalhou
          oque="a leitura mais recente dos números do tintométrico"
          estado={metricasVelhas}
          variante="bloco"
          testId="aviso-leitura-metricas"
        />
      )}

      {/* Tarefas recorrentes do operador — exibe só se houver instâncias abertas hoje */}
      <RecorrentesHojeCard />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Fórmulas</CardTitle>
            <Beaker className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{kpi(m?.totalFormulas)}</p>
            <p className="text-xs text-muted-foreground">importadas</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">SKUs</CardTitle>
            <Package className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{kpi(m?.skusMapped)} / {kpi(m?.totalSkus)}</p>
            <p className="text-xs text-muted-foreground">mapeados ao Omie</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Corantes</CardTitle>
            <Droplets className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{kpi(m?.corantesMapped)} / {kpi(m?.totalCorantes)}</p>
            <p className="text-xs text-muted-foreground">mapeados ao Omie</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Última Importação</CardTitle>
            <FileUp className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {/* `m === undefined` (erro/offline) dizia "Nenhuma importação" sobre 64.175 linhas
                em `tint_importacoes` — a mesma tela do vazio real. Terceiro sítio que MENTE
                neste arquivo, confirmado por medição em 2026-09-07. */}
            {m === undefined ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : m.lastImport ? (
              <>
                <p className="text-sm font-medium">{m.lastImport.tipo}</p>
                <p className="text-xs text-muted-foreground">
                  {m.lastImport.created_at ? new Date(m.lastImport.created_at).toLocaleDateString('pt-BR') : '—'} — {m.lastImport.registros_importados ?? 0} importados
                </p>
                <Badge variant="outline" className={(m.lastImport.status && statusColor[m.lastImport.status]) || ''}>
                  {m.lastImport.status}
                </Badge>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Nenhuma importação</p>
            )}
          </CardContent>
        </Card>
      </div>

      {errosSemLeitura && (
        <AvisoLeituraFalhou
          oque="os últimos erros de importação"
          estado={errosSemLeitura}
          variante="bloco"
          testId="aviso-leitura-erros"
        />
      )}
      {errosVelhos && (
        <AvisoLeituraFalhou
          oque="a leitura mais recente dos erros de importação"
          estado={errosVelhos}
          variante="bloco"
          testId="aviso-leitura-erros"
        />
      )}

      {errors && errors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-status-warning" />
              Últimos Erros de Importação
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {errors.map((imp) => (
                <div key={imp.id} className="border rounded-md p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium">{imp.arquivo_nome}</span>
                    <Badge variant="outline">{imp.tipo}</Badge>
                    <span className="text-xs text-muted-foreground">{imp.created_at ? new Date(imp.created_at).toLocaleDateString('pt-BR') : '—'}</span>
                  </div>
                  <p className="text-xs text-destructive">{imp.registros_erro} erro(s)</p>
                  {imp.erros_detalhe && Array.isArray(imp.erros_detalhe) && (
                    <ul className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      {(imp.erros_detalhe as Array<{ linha?: number; motivo?: string }>).slice(0, 3).map((e, i: number) => (
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
