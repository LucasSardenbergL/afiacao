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

type CorRejeitada = { cor: string; formulas: number; motivo: string };
type FormulasRejeitadas = {
  /** Quando o último run de fórmulas começou — a lista é um RETRATO dele, não histórico. */
  runEm: string | null;
  /** O que o run contou (`tint_sync_runs.errors`) — pode ser >0 com a lista vazia (detalhe faltou). */
  rejeicoesDoRun: number;
  cores: CorRejeitada[];
};

/**
 * O motivo que `tint_promote_sync_run` grava vem com o sufixo técnico e a fórmula colada:
 * "receita corrompida: corante presente sem dose válida (qtd_ml <= 0/nula/não-finita) + linha
 * inválida sob protocolo declarado (1d-E) — fórmula PRETO/0,9L". O operador precisa só da cabeça.
 */
function motivoCurto(msg: string): string {
  return msg.split(' — ')[0].split(' + ')[0].replace(/\s*\(.*$/, '').trim();
}

/**
 * Fórmulas que o guard REJEITOU no último run de fórmulas — deduplicadas por cor.
 *
 * Antes o card lia `tint_importacoes.erros_detalhe`, coluna que o writer vivo (`tint_promote_sync_run`)
 * NUNCA preenche (0 de 4.160 linhas com erro, psql-ro 2026-10-18): mostrava "5 erro(s)" sem dizer
 * quais, e uma entrada por run — o conector re-envia o mesmo lote a cada ciclo, então as MESMAS
 * 5 cores viravam 5 blocos idênticos. O detalhe vive em `tint_sync_errors`; a correção dessas
 * receitas é na máquina SayerSystem (`docs/agent/tintometrico.md`: dado da fonte, guard certo).
 */
function useFormulasRejeitadas() {
  return useQuery({
    queryKey: ['tint-formulas-rejeitadas'],
    queryFn: async (): Promise<FormulasRejeitadas | null> => {
      const run = await supabase
        .from('tint_sync_runs')
        .select('id, started_at, errors')
        .eq('account', ACCOUNT)
        .eq('sync_type', 'formulas')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (run.error) throw run.error;
      // Sem run nenhum não há o que listar — `null` aqui é "não existe", não "não li".
      if (!run.data) return null;

      // Teto do PostgREST é 1.000 linhas SILENCIOSO; o máximo visto por run foi 162. Pede mais que
      // isso explicitamente para a dedup não contar errado se a fonte piorar.
      const linhas = await supabase
        .from('tint_sync_errors')
        .select('entity_type, entity_id, error_message')
        .eq('sync_run_id', run.data.id)
        .order('entity_id')
        .range(0, 1999);
      if (linhas.error) throw linhas.error;

      const porCor = new Map<string, CorRejeitada>();
      for (const l of linhas.data ?? []) {
        const chave = `${l.entity_type}:${l.entity_id}`;
        const atual = porCor.get(chave);
        if (atual) atual.formulas += 1;
        else porCor.set(chave, { cor: l.entity_id ?? '—', formulas: 1, motivo: motivoCurto(l.error_message ?? '') });
      }
      return {
        runEm: run.data.started_at,
        rejeicoesDoRun: run.data.errors ?? 0,
        cores: [...porCor.values()].sort((a, b) => b.formulas - a.formulas || a.cor.localeCompare(b.cor)),
      };
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
  const { data: rejeitadas, status: statusE, fetchStatus: fetchE } = useFormulasRejeitadas();

  const fatiaM = { status: statusM, fetchStatus: fetchM };
  const fatiaE = { status: statusE, fetchStatus: fetchE };
  const estadoM = estadoDeLeitura(fatiaM);
  const estadoE = estadoDeLeitura(fatiaE);
  // `isLoading` era o ÚNICO gate do skeleton — e ele é FALSE no offline (`pending` + `paused`,
  // `data` undefined, `error` null). Sem rede a tela caía inteira no ramo dos zeros.
  const metricasSemLeitura: EstadoSemLeitura | null =
    naoConsegui(estadoM) && !m ? estadoM : null;
  const metricasVelhas = desatualizado(fatiaM, Boolean(m));
  // `rejeitadas` é `null` quando LEU e não há run (≠ undefined, que é "não li") — o aviso só
  // cabe no segundo caso. O `status` do react-query é o que separa os dois.
  const errosSemLeitura: EstadoSemLeitura | null =
    naoConsegui(estadoE) && rejeitadas === undefined ? estadoE : null;
  const errosVelhos = desatualizado(fatiaE, rejeitadas !== undefined);
  const haRejeicao = Boolean(rejeitadas && (rejeitadas.cores.length > 0 || rejeitadas.rejeicoesDoRun > 0));

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
          oque="as fórmulas rejeitadas no último sync"
          estado={errosSemLeitura}
          variante="bloco"
          testId="aviso-leitura-erros"
        />
      )}
      {errosVelhos && (
        <AvisoLeituraFalhou
          oque="a leitura mais recente das fórmulas rejeitadas"
          estado={errosVelhos}
          variante="bloco"
          testId="aviso-leitura-erros"
        />
      )}

      {haRejeicao && rejeitadas && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-status-warning" />
              Fórmulas rejeitadas pela fonte
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Último sync de fórmulas em {rejeitadas.runEm ? new Date(rejeitadas.runEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
              {' · '}{rejeitadas.cores.length} {rejeitadas.cores.length === 1 ? 'cor' : 'cores'} com receita incompleta no SayerSystem.
              {' '}O guard não importa a receita; a correção é na máquina, não aqui.
            </p>
          </CardHeader>
          <CardContent>
            {rejeitadas.cores.length === 0 ? (
              <p className="text-xs text-status-warning">
                {rejeitadas.rejeicoesDoRun} rejeições sem detalhe gravado neste run — a contagem é do run, a lista não veio.
              </p>
            ) : (
              <ul className="divide-y">
                {rejeitadas.cores.map((c) => (
                  <li key={c.cor} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{c.cor}</p>
                      <p className="text-xs text-muted-foreground">{c.motivo}</p>
                    </div>
                    <Badge variant="outline" className="shrink-0">{c.formulas} {c.formulas === 1 ? 'fórmula' : 'fórmulas'}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
