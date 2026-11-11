import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Activity, Zap, AlertTriangle } from 'lucide-react';
import { ResponsiveContainer, PieChart as RechartsPie, Pie, Cell, Tooltip as RechartsTooltip } from 'recharts';
import { estadoDeLeitura, naoConsegui, desatualizado } from '@/lib/leitura/estado-de-leitura';
import { KpiCard } from './KpiCard';

interface OperationalTabProps {
  farmerId?: string;
}

/**
 * O corte da leitura: as 50 maiores prioridades. É uma FILA, não a carteira — `farmer_client_scores`
 * tem 17.002 linhas. Plano v9, C17 (fatia 1): os agregados abaixo dizem que são deste recorte. Tirar
 * o `.limit` não resolve (troca o corte de 50 pelo de 1.000 do PostgREST); o KPI da carteira de
 * verdade é um agregado no servidor (fatia 2, decisão do founder).
 */
const LIMITE_PRIORIDADE = 50;

/** Média só dos valores conhecidos: score ausente não é score 0 (ausente ≠ zero). */
function mediaConhecida(valores: Array<number | null | undefined>): number | null {
  const conhecidos = valores.filter((v): v is number => v != null && Number.isFinite(Number(v))).map(Number);
  return conhecidos.length ? conhecidos.reduce((a, v) => a + v, 0) / conhecidos.length : null;
}

/** Legenda do recorte: abaixo do limite a leitura trouxe tudo o que havia; no limite, é o top-N. */
function legendaDoRecorte(lidos: number): string {
  return lidos >= LIMITE_PRIORIDADE
    ? `${LIMITE_PRIORIDADE} clientes de maior prioridade`
    : `${lidos} clientes com score`;
}

export function IntelligenceOperationalTab({ farmerId }: OperationalTabProps) {
  const scoresQ = useQuery({
    queryKey: ['intel-client-scores', farmerId],
    queryFn: async () => {
      let query = supabase
        .from('farmer_client_scores')
        // Lista explícita: `select('*')` inclui gross_margin_pct, fechada para authenticated (FU4-F).
        .select('id, customer_user_id, health_score, health_class, priority_score, sales_history_status')
        .order('priority_score', { ascending: false })
        .limit(LIMITE_PRIORIDADE);
      if (farmerId) query = query.eq('farmer_id', farmerId);
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
  });
  const clientScores = scoresQ.data;

  // Plano v9, C17: não há "Margem Própria" nem "Ticket Médio" aqui. Os dois somavam `farmer_calls`
  // com `Number(x || 0)`, e a tabela tem 0 linhas em prod (telefonia congelada): os cards afirmavam
  // R$ 0 como fato. E o componente só olhava `isLoading`, então a falha da query também virava R$ 0.
  // Nenhum dos dois é medido hoje; voltam quando houver ligação registrada com receita.

  const perfQ = useQuery({
    queryKey: ['intel-performance', farmerId],
    queryFn: async () => {
      let query = supabase
        .from('farmer_performance_scores')
        .select('*')
        .order('calculated_at', { ascending: false })
        .limit(1);
      if (farmerId) query = query.eq('farmer_id', farmerId);
      const { data, error } = await query;
      if (error) throw error;
      return data?.[0] || null;
    },
  });
  const performanceScores = perfQ.data;

  const { data: clientProfiles } = useQuery({
    queryKey: ['intel-client-profiles'],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('user_id, name').eq('is_employee', false);
      if (error) throw error;
      return data || [];
    },
  });

  const clientNameMap = (clientProfiles || []).reduce((acc, p) => {
    if (p.user_id) acc[p.user_id] = p.name || '';
    return acc;
  }, {} as Record<string, string>);

  if (scoresQ.isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}><CardContent className="p-4"><Skeleton className="h-16 w-full" /></CardContent></Card>
        ))}
      </div>
    );
  }

  // `naoConsegui` cobre erro E sem-rede (offline sem cache fica pending/paused, sem `isError`).
  // Sem leitura e sem cache: "—" e o motivo, nunca "0 clientes em risco". Com cache: o último dado
  // bom e o aviso de que pode estar velho.
  const scoresIndisponivel = naoConsegui(estadoDeLeitura(scoresQ)) && !clientScores;
  const scoresDesatualizados = desatualizado(scoresQ, !!clientScores) != null;
  const ieeIndisponivel = naoConsegui(estadoDeLeitura(perfQ)) && performanceScores === undefined;

  const lidos = clientScores ?? [];
  const recorte = scoresIndisponivel ? 'base indisponível' : legendaDoRecorte(lidos.length);
  const fmt = (v: number | null) => (v == null ? '—' : v.toFixed(1));
  const avgHealthScore = scoresIndisponivel ? '—' : fmt(mediaConhecida(lidos.map(c => c.health_score)));
  const avgPriority = scoresIndisponivel ? '—' : fmt(mediaConhecida(lidos.map(c => c.priority_score)));

  const isRealRisk = (c: { health_class?: string | null; sales_history_status?: string | null }) =>
    (c.health_class === 'critico' || c.health_class === 'atencao') && c.sales_history_status !== 'sem_historico';

  const emRisco = lidos.filter(isRealRisk);

  const healthDistribution = [
    { name: 'Saudável', value: lidos.filter(c => c.health_class === 'saudavel').length, color: '#10b981' },
    { name: 'Estável', value: lidos.filter(c => c.health_class === 'estavel').length, color: '#3b82f6' },
    { name: 'Atenção', value: lidos.filter(c => c.health_class === 'atencao').length, color: '#f59e0b' },
    { name: 'Crítico', value: lidos.filter(c => c.health_class === 'critico').length, color: '#ef4444' },
  ].filter(d => d.value > 0);

  return (
    <div className="space-y-4">
      {scoresIndisponivel && (
        <div role="alert" className="rounded-lg border border-status-error/30 bg-status-error/5 p-3 text-xs text-status-error">
          Indicadores de saúde indisponíveis: a base de scores não pôde ser lida. Health Score, Priority
          Score, distribuição e clientes em risco ficam em “—”; nada foi contado.
        </div>
      )}
      {scoresDesatualizados && (
        <div role="alert" className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-xs text-status-warning">
          Exibindo a última leitura bem-sucedida da base de scores: a atualização mais recente não
          chegou (falha ou sem conexão). Os indicadores podem estar desatualizados.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <KpiCard title="Health Score Médio" value={avgHealthScore} icon={Activity} subtitle={recorte} />
        <KpiCard title="Priority Score Médio" value={avgPriority} icon={Zap} subtitle={recorte} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Distribuição de Saúde</CardTitle>
            <CardDescription className="text-xs" data-testid="recorte-distribuicao">{recorte}</CardDescription>
          </CardHeader>
          <CardContent>
            {scoresIndisponivel ? (
              <p className="text-sm text-muted-foreground text-center py-8">—</p>
            ) : healthDistribution.length > 0 ? (
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <RechartsPie>
                    <Pie data={healthDistribution} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name, value }) => `${name}: ${value}`}>
                      {healthDistribution.map((entry, idx) => <Cell key={idx} fill={entry.color} />)}
                    </Pie>
                    <RechartsTooltip />
                  </RechartsPie>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">Sem dados de saúde</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-status-warning" />
              Clientes em Risco
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold mb-2" data-testid="clientes-em-risco">{scoresIndisponivel ? '—' : emRisco.length}</div>
            <p className="text-xs text-muted-foreground mb-3">
              {scoresIndisponivel ? 'Base de scores indisponível' : `Atenção ou Crítico, entre os ${recorte}`}
            </p>
            <div className="space-y-2">
              {emRisco
                .slice(0, 5)
                .map(c => (
                  <div key={c.id} className="flex items-center justify-between text-xs">
                    <span className="truncate">{clientNameMap[c.customer_user_id] ?? `${c.customer_user_id.slice(0, 8)}...`}</span>
                    <div className="flex items-center gap-2">
                      <Badge variant={c.health_class === 'critico' ? 'destructive' : 'secondary'} className="text-2xs">{c.health_class}</Badge>
                      <span className="text-muted-foreground">HS: {c.health_score == null ? '—' : Number(c.health_score).toFixed(0)}</span>
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {ieeIndisponivel && (
        <div role="alert" className="rounded-lg border border-status-error/30 bg-status-error/5 p-3 text-xs text-status-error">
          Índice de Execução Estratégica indisponível: a última pontuação não pôde ser lida.
        </div>
      )}
      {performanceScores && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Índice de Execução Estratégica (IEE)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: 'PTPL', value: performanceScores.iee_ptpl_usage },
                { label: 'Aderência Obj.', value: performanceScores.iee_objective_adherence },
                { label: 'Perguntas', value: performanceScores.iee_questions_usage },
                { label: 'Bundle Oferecido', value: performanceScores.iee_bundle_offered },
                { label: 'Registro Pós-Call', value: performanceScores.iee_post_call_registration },
              ].map(item => (
                <div key={item.label} className="text-center">
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                  {/* componente sem valor não é 0%: "—" */}
                  <p className="text-lg font-bold">{item.value == null ? '—' : `${Number(item.value).toFixed(0)}%`}</p>
                  {item.value != null && <Progress value={Number(item.value)} className="h-1.5 mt-1" />}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
