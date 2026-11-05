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
import { fetchAllPages } from '@/lib/postgrest';
import {
  descreverSlots, origemPorCor,
  type CorRejeitada, type OrigemCor, type TipoRejeicao,
} from '@/lib/tint/rejeicoes';
import { JANELA_HORAS, useFormulasRejeitadas } from '@/hooks/useTintAlertas';

const ACCOUNT = 'oben';

/**
 * As métricas BARATAS do painel. A contagem de fórmulas NÃO mora aqui: ela tem leitura própria
 * (`useContagemFormulas`), para que o custo dela não segure o resto da tela.
 */
function useMetrics() {
  return useQuery({
    queryKey: ['tint-dashboard-metrics'],
    queryFn: async () => {
      const [skusAll, skusMapped, corantesAll, corantesMapped, lastImport] = await Promise.all([
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

/**
 * Quantas fórmulas há — em leitura PRÓPRIA e ESTIMADA (F9 do plano v6).
 *
 * Era um `count: 'exact'` sobre ~1 M linhas dentro do `Promise.all` de `useMetrics`: 215 ms
 * quente e 7.953 ms frio (index-only scan, psql-ro 2026-11-04), e como a chave era uma só, o
 * painel INTEIRO ficava no skeleton esperando essa contagem. Duas mudanças, que se somam:
 *  - leitura separada: SKUs, corantes e última importação aparecem sem esperar por ela;
 *  - `planned`: o PostgREST devolve a estimativa do planner (o EXPLAIN, 0,1 ms), sem varrer a
 *    tabela. Medido: 1.001.700 estimadas × 1.002.356 reais (erro de 0,07%).
 * Por ser estimativa, a tela mostra o número com "~" e diz que é aproximado (`aproximado`).
 * Mostrar o número do planner como contagem exata seria afirmar o que não foi contado.
 */
function useContagemFormulas() {
  return useQuery({
    queryKey: ['tint-dashboard-formulas-estimadas'],
    queryFn: async () => contagem(
      await supabase.from('tint_formulas').select('id', { count: 'planned', head: true }).eq('account', ACCOUNT),
      'fórmulas',
    ),
  });
}

/**
 * Uma estimativa escrita de um jeito que NÃO se lê como contagem exata: "~1,0 mi", "~995 mil".
 * A partir de 999.500 vai para "mi", senão o arredondamento daria "~1.000 mil".
 */
function aproximado(n: number): string {
  if (n >= 999_500) {
    return `~${(n / 1_000_000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} mi`;
  }
  if (n >= 1_000) return `~${Math.round(n / 1_000).toLocaleString('pt-BR')} mil`;
  return `~${n.toLocaleString('pt-BR')}`;
}

/**
 * Personalizada (balcão) ou de fábrica, por cor rejeitada — quem corrige é diferente. Leitura
 * SEPARADA de propósito: se falhar, a lista de rejeitadas continua de pé, só sem a separação
 * (e a tela diz que não leu — nunca joga tudo num lado).
 *
 * Três fontes porque a rejeitada pode nunca ter sido promovida: `tint_formulas` (atual),
 * `tint_receita_versoes` (histórico append-only) e, só para o que faltou, a staging.
 */
function useOrigemDasCores(cores: string[]) {
  return useQuery({
    queryKey: ['tint-origem-rejeitadas', cores],
    enabled: cores.length > 0,
    queryFn: async () => {
      type Marca = { cor_id: string | null; personalizada: boolean | null };
      const ler = (tabela: 'tint_formulas' | 'tint_receita_versoes' | 'tint_staging_formulas', lista: string[]) =>
        fetchAllPages<Marca>(
          (de, ate) => supabase
            .from(tabela)
            .select('cor_id, personalizada')
            .eq('account', ACCOUNT)
            .in('cor_id', lista)
            .order('id')
            .range(de, ate),
          `${tabela}/origem-rejeitadas`,
        );
      const [atuais, versoes] = await Promise.all([ler('tint_formulas', cores), ler('tint_receita_versoes', cores)]);
      const vistas = new Set([...atuais, ...versoes].map((l) => l.cor_id));
      const faltam = cores.filter((c) => !vistas.has(c));
      const staging = faltam.length > 0 ? await ler('tint_staging_formulas', faltam) : [];
      return origemPorCor([...atuais, ...versoes, ...staging]);
    },
  });
}

const ORIGENS: Array<{ chave: OrigemCor | 'nao_sei'; titulo: string; explicacao: string }> = [
  {
    chave: 'personalizada',
    titulo: 'Suas cores personalizadas',
    explicacao: 'Cores criadas no balcão. A receita é da loja — a correção é na máquina do balcão.',
  },
  {
    chave: 'fabrica',
    titulo: 'Cores de fábrica',
    explicacao: 'Cores do catálogo Sayerlack. A receita vem da fábrica — a correção é com a Sayerlack.',
  },
  {
    chave: 'nao_sei',
    titulo: 'Origem não identificada',
    explicacao: 'A cor não aparece no cadastro, ou aparece como personalizada e de fábrica ao mesmo tempo.',
  },
];

/** Ordem de leitura: o que pede AÇÃO primeiro, o resíduo que se cura sozinho por último. */
const GRUPOS: Array<{ tipo: TipoRejeicao; titulo: string; explicacao: string }> = [
  {
    tipo: 'dose_sem_corante',
    titulo: 'Dose sem corante identificado',
    explicacao:
      'A máquina tem uma dose sem dizer de qual corante. Só a Sayerlack/máquina diz se falta um corante na receita ou se é sujeira do cadastro. Até lá vale a receita anterior.',
  },
  {
    tipo: 'outro',
    titulo: 'Outros problemas na receita',
    explicacao: 'Formato que não é nenhum dos dois casos conhecidos — vale olhar a cor na máquina.',
  },
  {
    tipo: 'slot_livre',
    titulo: 'Slot vazio gravado como corante “0”',
    explicacao:
      'Não é receita errada: é como o conector antigo (até 0.2.0) gravava slot vazio de cor personalizada. Some sozinho quando o re-scan completo de domingo rodar com o balcão LIGADO. A receita anterior segue valendo.',
  },
];

const ml = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ml`;

/** O que exatamente está errado na receita da cor, em uma linha. */
function detalheDaCor(c: CorRejeitada): string {
  const slots = descreverSlots(c.linhas);
  if (c.tipo === 'dose_sem_corante') {
    const doses = c.linhas.map((l) => (l.qtdMl !== null ? ml(l.qtdMl) : '?')).join(' + ');
    return `${slots ?? 'linha'}: ${doses} sem corante`;
  }
  if (c.tipo === 'slot_livre') return slots ? `${slots} vazios` : 'slot vazio';
  return slots ? `${c.motivo} (${slots})` : c.motivo;
}

/** As cores de UM recorte, agrupadas pelo tipo de problema (a ordem de `GRUPOS`). */
function GruposPorTipo({ cores }: { cores: CorRejeitada[] }) {
  return (
    <div className="space-y-5">
      {GRUPOS.map((g) => {
        const doTipo = cores.filter((c) => c.tipo === g.tipo);
        if (doTipo.length === 0) return null;
        return (
          <section key={g.tipo} data-testid={`rejeicao-grupo-${g.tipo}`}>
            <h4 className="text-sm font-medium">
              {g.titulo} <span className="text-muted-foreground font-normal">· {doTipo.length} {doTipo.length === 1 ? 'cor' : 'cores'}</span>
            </h4>
            <p className="text-xs text-muted-foreground mt-0.5">{g.explicacao}</p>
            <ul className="divide-y mt-2">
              {doTipo.map((c) => (
                <li key={c.cor} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{c.cor}</p>
                    <p className="text-xs text-muted-foreground">{detalheDaCor(c)}</p>
                  </div>
                  <Badge variant="outline" className="shrink-0">{c.formulas} {c.formulas === 1 ? 'fórmula' : 'fórmulas'}</Badge>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
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
  const { data: formulas, status: statusF, fetchStatus: fetchF } = useContagemFormulas();
  const { data: rejeitadas, status: statusE, fetchStatus: fetchE } = useFormulasRejeitadas();

  // A contagem de fórmulas tem estado PRÓPRIO: enquanto ela não chega, o card dela mostra
  // skeleton e o resto do painel já está de pé; se ela falhar, o aviso é só dela.
  const fatiaF = { status: statusF, fetchStatus: fetchF };
  const estadoF = estadoDeLeitura(fatiaF);
  const formulasSemLeitura: EstadoSemLeitura | null =
    (naoConsegui(estadoF) && formulas === undefined ? estadoF : null)
    ?? desatualizado(fatiaF, formulas !== undefined);

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
  const haRejeicao = Boolean(rejeitadas && (rejeitadas.cores.length > 0 || rejeitadas.rejeicoesNaJanela > 0));
  const { data: origem, status: statusO, fetchStatus: fetchO } = useOrigemDasCores(
    (rejeitadas?.cores ?? []).map((c) => c.cor),
  );
  // Sem a origem a lista sai SEM separação e com o aviso — nunca tudo jogado num lado só.
  const origemFalhou = naoConsegui(estadoDeLeitura({ status: statusO, fetchStatus: fetchO })) && !origem;

  if (estadoM === 'carregando') return <div className="space-y-4"><Skeleton className="h-8 w-64" /><div className="grid grid-cols-1 md:grid-cols-4 gap-4">{[1,2,3,4].map(i=><Skeleton key={i} className="h-28"/>)}</div></div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tintométrico — Dashboard</h1>

      {metricasSemLeitura && (
        <AvisoLeituraFalhou
          oque="os números do tintométrico (SKUs, corantes e a última importação)"
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
            {formulas !== undefined ? (
              <>
                <p
                  className="text-2xl font-bold"
                  data-testid="kpi-formulas"
                  title={`Estimativa do banco: ${formulas.toLocaleString('pt-BR')} (não é contagem exata)`}
                >
                  {aproximado(formulas)}
                </p>
                <p className="text-xs text-muted-foreground">importadas · número aproximado</p>
              </>
            ) : estadoF === 'carregando' ? (
              <Skeleton className="h-8 w-24" data-testid="kpi-formulas-carregando" />
            ) : (
              <p className="text-2xl font-bold" data-testid="kpi-formulas">—</p>
            )}
            {formulasSemLeitura && (
              <AvisoLeituraFalhou
                oque="a contagem de fórmulas"
                estado={formulasSemLeitura}
                className="mt-2 mb-0"
                testId="aviso-leitura-formulas"
              />
            )}
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
          oque="as fórmulas rejeitadas nas últimas 24h"
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
              Nas {JANELA_HORAS}h até o último sync de fórmulas ({rejeitadas.runEm ? new Date(rejeitadas.runEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'})
              {' · '}{rejeitadas.cores.length} {rejeitadas.cores.length === 1 ? 'cor' : 'cores'} com receita barrada.
              {' '}O guard não importa a receita barrada e mantém a anterior; a correção é na fonte, não aqui.
            </p>
          </CardHeader>
          <CardContent>
            {rejeitadas.cores.length === 0 ? (
              <p className="text-xs text-status-warning">
                {rejeitadas.rejeicoesNaJanela} rejeições sem detalhe gravado nas últimas {JANELA_HORAS}h — a contagem é dos runs, a lista não veio.
              </p>
            ) : !origem ? (
              <div className="space-y-4">
                {origemFalhou && (
                  <p className="text-xs text-status-warning" data-testid="origem-nao-lida">
                    Não consegui ler se estas cores são personalizadas ou de fábrica — a lista abaixo está sem essa separação.
                  </p>
                )}
                <GruposPorTipo cores={rejeitadas.cores} />
              </div>
            ) : (
              <div className="space-y-6">
                {ORIGENS.map((o) => {
                  const cores = rejeitadas.cores.filter((c) => (origem.get(c.cor) ?? 'nao_sei') === o.chave);
                  // "Nenhuma de fábrica" é resposta (leu e não há); "origem não identificada" vazia não diz nada.
                  if (cores.length === 0 && o.chave === 'nao_sei') return null;
                  return (
                    <section key={o.chave} data-testid={`rejeicao-origem-${o.chave}`} className="rounded-md border p-4">
                      <h3 className="text-sm font-semibold">
                        {o.titulo} <span className="text-muted-foreground font-normal">· {cores.length} {cores.length === 1 ? 'cor' : 'cores'}</span>
                      </h3>
                      <p className="text-xs text-muted-foreground mt-0.5 mb-3">{o.explicacao}</p>
                      {cores.length === 0
                        ? <p className="text-xs text-muted-foreground">Nenhuma nas últimas {JANELA_HORAS}h.</p>
                        : <GruposPorTipo cores={cores} />}
                    </section>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
