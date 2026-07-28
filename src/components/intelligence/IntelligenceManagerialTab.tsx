import { memo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Users, AlertTriangle, Layers } from 'lucide-react';
import { mediaMargensConhecidas, coberturaMargem, legendaCobertura } from '@/lib/scoring/margin';
import { fetchAllPages } from '@/lib/postgrest';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts';
import { KpiCard } from './KpiCard';

interface ScoreLinha {
  customer_user_id: string;
  farmer_id: string;
  health_score: number | null;
  health_class: string | null;
  /** PERCENTUAL (0–100, negativo válido). `null` = não apurada. Ver @/lib/scoring/margin. */
  gross_margin_pct: number | null;
  category_count: number | null;
  sales_history_status: string | null;
}

interface RecoLinha {
  farmer_id: string;
  status: string | null;
}

/**
 * Único rótulo de aceitação que `farmer_recommendations.status` permite — o CHECK da tabela é
 * ('pendente','ofertado','aceito','rejeitado','expirado'). O código comparava com `'aceita'`,
 * valor que o banco REJEITA: o predicado nunca casava e a taxa era estruturalmente 0%, medisse
 * o que medisse. Hoje as 3.659 linhas de prod são 100% `pendente` (nenhum writer registra
 * desfecho desde que `markAsAccepted` saiu), então a correção é DEFESA DO FUTURO — mas é
 * exatamente no dia em que o loop de feedback existir que a coluna passaria a mentir em silêncio.
 */
const STATUS_ACEITO = 'aceito';

function IntelligenceManagerialTabImpl() {
  const { data: allScores, isLoading, isError } = useQuery({
    queryKey: ['intel-all-scores'],
    // Base COMPLETA, paginada. Era `.limit(500)` de 6.632 ordenado por `priority_score` desc —
    // ou seja, os 500 de MAIOR prioridade, uma amostra enviesada apresentada como comparativo
    // ENTRE VENDEDORES. Não dá para declarar a cobertura da margem em cima disso sem mentir
    // sobre o denominador. Ordem por `customer_user_id` (UNIQUE): paginação sem ordem estável
    // pula e repete linha entre páginas.
    queryFn: () =>
      fetchAllPages<ScoreLinha>((de, ate) =>
        supabase
          .from('farmer_client_scores')
          .select('customer_user_id, farmer_id, health_score, health_class, gross_margin_pct, category_count, sales_history_status')
          .order('customer_user_id', { ascending: true })
          .range(de, ate) as unknown as PromiseLike<{ data: ScoreLinha[] | null; error: unknown }>,
        'farmer_client_scores/intel-gerencial',
      ),
  });

  const { data: allPerformance } = useQuery({
    queryKey: ['intel-all-performance'],
    queryFn: async () => {
      const { data, error } = await supabase.from('farmer_performance_scores').select('*').order('calculated_at', { ascending: false }).limit(50);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: profiles } = useQuery({
    queryKey: ['intel-profiles-names'],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('user_id, name');
      if (error) throw error;
      return data || [];
    },
  });

  const farmerNameMap = (profiles || []).reduce((acc, p) => {
    if (p.user_id) acc[p.user_id] = p.name || '';
    return acc;
  }, {} as Record<string, string>);

  const { data: recommendations, isError: recoErro } = useQuery({
    queryKey: ['intel-reco-adoption'],
    // Base COMPLETA, paginada. Era `.limit(500)` de 3.659 linhas e SEM `.order()`: sem ORDER BY
    // o Postgres não garante ordem, então a fatia de 13,7% mudava entre carregamentos — dois
    // pedidos idênticos podiam render taxas de adoção diferentes, sem nada na tela indicando
    // que o denominador era amostral. `id` é a PK: ordem estável para paginar.
    queryFn: () =>
      fetchAllPages<RecoLinha>((de, ate) =>
        supabase
          .from('farmer_recommendations')
          .select('farmer_id, status')
          .order('id', { ascending: true })
          .range(de, ate) as unknown as PromiseLike<{ data: RecoLinha[] | null; error: unknown }>,
        'farmer_recommendations/intel-adocao',
      ),
  });

  const farmerGroups = allScores?.reduce((acc, score) => {
    const fid = score.farmer_id;
    if (!acc[fid]) acc[fid] = [];
    acc[fid].push(score);
    return acc;
  }, {} as Record<string, typeof allScores>) || {};

  const recoAdoption = recommendations?.reduce((acc, r) => {
    if (!acc[r.farmer_id]) acc[r.farmer_id] = { total: 0, accepted: 0 };
    acc[r.farmer_id].total++;
    if (r.status === STATUS_ACEITO) acc[r.farmer_id].accepted++;
    return acc;
  }, {} as Record<string, { total: number; accepted: number }>) || {};

  // A falha desta query virava `recommendations === undefined` → adoção 0% para TODO vendedor.
  // Num comparativo ENTRE vendedores, "não seguiu nenhuma recomendação" é uma acusação — e era
  // fabricada por uma falha de transporte nossa.
  const adocaoIndisponivel = recoErro && !recommendations;
  const adocaoDesatualizada = recoErro && !!recommendations;

  const farmerMetrics = Object.entries(farmerGroups).map(([farmerId, clients]) => {
    const avgHealth = clients.reduce((a, c) => a + Number(c.health_score || 0), 0) / clients.length;
    const atRisk = clients.filter(c => (c.health_class === 'critico' || c.health_class === 'atencao') && c.sales_history_status !== 'sem_historico').length;
    // Só quem TEM margem entra — numerador e denominador. Com `|| 0` cada cliente sem margem
    // medida entrava como 0 e puxava a média do farmer para baixo; desde o cálculo server-side
    // isso valeria para a maioria da base, e o gestor compararia farmers por um número que mede
    // cobertura de custo, não desempenho. `null` → a coluna mostra "—".
    const avgMargin = mediaMargensConhecidas(clients.map(c => c.gross_margin_pct));
    const cobertura = coberturaMargem(clients.map(c => c.gross_margin_pct));
    const avgCategories = clients.reduce((a, c) => a + Number(c.category_count || 0), 0) / clients.length;
    const adoption = recoAdoption[farmerId];
    // `null` = taxa NÃO APURÁVEL → a coluna mostra "—". `!adoption` cobre as duas origens de
    // ausência, ambas "ausente ≠ zero":
    // (a) a leitura falhou — `recommendations` vira `undefined`, `recoAdoption` sai vazio e
    //     TODO vendedor cai aqui; 0% afirmaria que ninguém seguiu sugestão alguma;
    // (b) o vendedor não tem recomendação — sem denominador não existe taxa, e "0%" o puniria
    //     no comparativo por um dado que não existe.
    // Nada de `|| adoption.total === 0` nem de `adocaoIndisponivel ||` aqui: o primeiro é
    // INALCANÇÁVEL (o objeto só nasce no `acc[...] = {total:0}` imediatamente seguido do
    // `total++`, então existir implica `total >= 1`) e o segundo é uma segunda camada para o
    // caso (a). Guard que não pode disparar não protege — só faz a falsificação passar verde e
    // dar a impressão de cobertura que não existe (foi o que a sabotagem S4 revelou).
    const adoptionPct = !adoption
      ? null
      : (adoption.accepted / adoption.total) * 100;
    return { farmerId, clientCount: clients.length, avgHealth, atRisk, avgMargin, cobertura, avgCategories, adoptionPct };
  });

  const globalAvgCategories = allScores?.length
    ? allScores.reduce((a, c) => a + Number(c.category_count || 0), 0) / allScores.length
    : 0;

  if (isLoading) {
    return <div className="grid grid-cols-1 gap-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>;
  }

  // Desde o #1545 o `fetchAllPages` LANÇA quando uma página falha, em vez de devolver o
  // prefixo parcial. Isso conserta a mentira do NÚMERO — e torna ESTE caminho alcançável:
  // a exceção vira `allScores === undefined`, e cada `|| 0` abaixo afirma "0 clientes",
  // "0 em risco". Uma falha de transporte apresentada como fato sobre a base, que é a mesma
  // troca de "não consegui ler" por "não existe" que o helper acabou de eliminar uma camada
  // antes. Nunca zero: "—" e o motivo.
  // Com dado em cache o react-query preserva `data` através do erro — aí mostramos os números
  // com aviso de desatualização, em vez de descartar o último estado bom. `retry` já é global
  // (App.tsx: 2 tentativas + backoff), então aqui só resta o estado FINAL.
  const scoresIndisponivel = isError && !allScores;
  const scoresDesatualizados = isError && !!allScores;
  const ou = (v: string) => (scoresIndisponivel ? '—' : v);

  return (
    <div className="space-y-4">
      {scoresIndisponivel && (
        <div role="alert" className="rounded-lg border border-status-error/30 bg-status-error/5 p-3 text-xs text-status-error">
          Comparativo indisponível — a base de clientes não pôde ser lida. Os indicadores ficam
          em “—” até a próxima tentativa; nenhum número abaixo foi estimado.
        </div>
      )}
      {scoresDesatualizados && (
        <div role="alert" className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-xs text-status-warning">
          Exibindo a última leitura bem-sucedida — a atualização mais recente falhou. Os números
          podem estar desatualizados.
        </div>
      )}
      {adocaoIndisponivel && (
        <div role="alert" className="rounded-lg border border-status-error/30 bg-status-error/5 p-3 text-xs text-status-error">
          Adoção de recomendações indisponível — a base de recomendações não pôde ser lida. A
          coluna fica em “—”; 0% seria afirmar que os vendedores não seguiram nenhuma sugestão.
        </div>
      )}
      {adocaoDesatualizada && (
        <div role="alert" className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-xs text-status-warning">
          Exibindo a última leitura bem-sucedida da adoção de recomendações — a atualização mais
          recente falhou. A coluna “Adoção Reco” pode estar desatualizada.
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard title="Vendedores Ativos" value={ou(String(farmerMetrics.length))} icon={Users} />
        <KpiCard title="Total Clientes" value={ou(String(allScores?.length ?? 0))} icon={Users} />
        <KpiCard title="Clientes em Risco" value={ou(String(allScores?.filter(c => (c.health_class === 'critico' || c.health_class === 'atencao') && c.sales_history_status !== 'sem_historico').length ?? 0))} icon={AlertTriangle} trend="down" />
        <KpiCard title="Mix Médio" value={ou(globalAvgCategories.toFixed(1))} icon={Layers} subtitle="categorias/cliente" />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Comparativo por Vendedor</CardTitle>
          <CardDescription className="text-xs">Saúde, risco, margem, mix e adoção de recomendações</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 font-medium text-muted-foreground">Vendedor</th>
                  <th className="text-center py-2 font-medium text-muted-foreground">Clientes</th>
                  <th className="text-center py-2 font-medium text-muted-foreground">HS Médio</th>
                  <th className="text-center py-2 font-medium text-muted-foreground">Em Risco</th>
                  <th className="text-center py-2 font-medium text-muted-foreground">Margem %</th>
                  <th className="text-center py-2 font-medium text-muted-foreground">Mix</th>
                  <th className="text-center py-2 font-medium text-muted-foreground">Desvio Mix</th>
                  <th className="text-center py-2 font-medium text-muted-foreground">Adoção Reco</th>
                </tr>
              </thead>
              <tbody>
                {farmerMetrics.map(fm => (
                  <tr key={fm.farmerId} className="border-b border-border/50 hover:bg-muted/50">
                    <td className="py-2 font-mono">{farmerNameMap[fm.farmerId] ?? `${fm.farmerId.slice(0, 8)}...`}</td>
                    <td className="text-center py-2">{fm.clientCount}</td>
                    <td className="text-center py-2">
                      <Badge variant={fm.avgHealth > 60 ? 'default' : 'destructive'} className="text-2xs">{fm.avgHealth.toFixed(0)}</Badge>
                    </td>
                    <td className="text-center py-2">{fm.atRisk}</td>
                    {/* title carrega a COBERTURA: sem ela, a coluna compara vendedores como se
                        as médias falassem da carteira inteira de cada um — e elas falam de
                        fatias diferentes, porque a apuração de custo não é uniforme. */}
                    <td className="text-center py-2" title={legendaCobertura(fm.cobertura)}>
                      {fm.avgMargin == null
                        ? <span className="text-muted-foreground">—</span>
                        : `${fm.avgMargin.toFixed(1)}%`}
                    </td>
                    <td className="text-center py-2">{fm.avgCategories.toFixed(1)}</td>
                    <td className="text-center py-2">
                      <span className={fm.avgCategories < globalAvgCategories ? 'text-destructive' : 'text-status-success'}>
                        {(fm.avgCategories - globalAvgCategories).toFixed(1)}
                      </span>
                    </td>
                    <td className="text-center py-2">
                      {fm.adoptionPct == null
                        ? <span className="text-muted-foreground">—</span>
                        : `${fm.adoptionPct.toFixed(0)}%`}
                    </td>
                  </tr>
                ))}
                {farmerMetrics.length === 0 && (
                  <tr><td colSpan={8} className="text-center py-6 text-muted-foreground">
                    {/* "Sem dados" sob falha afirmaria que não há vendedor na base — a mesma
                        troca de "não consegui ler" por "não existe" que o helper eliminou. */}
                    {scoresIndisponivel ? 'Não foi possível carregar o comparativo' : 'Sem dados'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {allPerformance && allPerformance.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">IEE vs IPF por Vendedor</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={allPerformance.slice(0, 10).map(p => ({
                  name: farmerNameMap[p.farmer_id] ?? p.farmer_id.slice(0, 6),
                  iee: Number(p.iee_total || 0),
                  ipf: Number(p.ipf_total || 0),
                }))}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="name" className="text-xs" />
                  <YAxis className="text-xs" />
                  <RechartsTooltip />
                  <Bar dataKey="iee" fill="hsl(var(--primary))" name="IEE" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="ipf" fill="hsl(var(--muted-foreground))" name="IPF" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export const IntelligenceManagerialTab = memo(IntelligenceManagerialTabImpl);
