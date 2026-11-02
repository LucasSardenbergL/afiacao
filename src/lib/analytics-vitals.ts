import type { Metric } from 'web-vitals';
import { supabase } from '@/integrations/supabase/client';
import { track, telemetriaAtiva } from '@/lib/analytics';
import { canonicalizarRota } from '@/lib/analytics-rota-canonica';
import { resolverBuildId } from '@/lib/build-id';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { logger } from '@/lib/logger';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { obterDeviceId } from '@/lib/telemetria-probe';

/**
 * Core Web Vitals no aparelho do usuário (RUM) → evento `app.vitals`.
 *
 * EXCEÇÃO AUTORIZADA à regra de máquina meta: o founder aprovou este sensor em
 * 2026-11-01 no plano de melhoria v4 (PR #3502, item C0) — os lotes de app do
 * plano precisam de linha de base de velocidade REAL antes de mexer, e até aqui
 * não existia nenhuma (zero `PerformanceObserver` em `src/`).
 *
 * Uma linha por métrica por carga de página: LCP, INP, CLS, FCP e TTFB. O
 * `build_id` (adoção) e `$device_type`/`$browser`/`$os` já vão em TODO evento —
 * o primeiro como super property do `analytics.ts`, os outros pelo próprio
 * PostHog —, então não são repetidos aqui.
 *
 * POR QUE a lib `web-vitals` e não `PerformanceObserver` cru: LCP, FCP e TTFB
 * caberiam em 20 linhas, mas INP e CLS não. INP agrupa eventos por
 * `interactionId` e pega o p98 das interações da página; CLS soma deslocamentos
 * em janelas de sessão (1s de folga, 5s de teto) e fica com a pior; os dois
 * ainda precisam tratar prerender, aba aberta em segundo plano e restauração do
 * bfcache. Reescrever isso é reescrever a lib de referência do Chrome com bug
 * nosso — e um número de RUM errado é pior que nenhum, porque vira linha de
 * base. Ela já vem no `bun.lock` como dependência do posthog-js; aqui sai do
 * caminho crítico por import dinâmico (~2 KB gzip, chunk próprio), e os
 * observers usam `buffered: true`, então o que aconteceu antes do chunk chegar
 * não se perde.
 *
 * POR QUE não o web vitals nativo do PostHog (`capture_performance`): ele manda
 * `$current_url` CRU — `/pedido/<id>`, `?cliente=<uuid>` — e baixa o script do
 * host do PostHog, o mesmo que as listas de bloqueio cortam. Aqui a rota é a
 * CANÔNICA do ledger (`canonicalizarRota`, máscara fail-closed).
 */

type NomeMetrica = Metric['name'];

/** O mínimo de uma `Metric` que o coletor lê — o tipo da lib é atribuível a ele. */
export type MetricaVital = Pick<Metric, 'name' | 'value' | 'rating' | 'id' | 'navigationType'> & {
  readonly entries: ReadonlyArray<{ readonly startTime: number; readonly value?: number }>;
};

/**
 * Vocabulário da série em snake_case. A lib fala kebab-case (`needs-improvement`,
 * `back-forward-cache`), e o `SemHifen` do `track()` recusa esse literal — a
 * tabela é a saída que ele pede, não um contorno.
 */
const CLASSIFICACAO_NA_SERIE = {
  good: 'bom',
  'needs-improvement': 'melhorar',
  poor: 'ruim',
} as const satisfies Record<Metric['rating'], string>;

const NAVEGACAO_NA_SERIE = {
  navigate: 'navegacao',
  reload: 'recarga',
  'back-forward': 'voltar_avancar',
  'back-forward-cache': 'bfcache',
  prerender: 'prerender',
  restore: 'restauracao',
} as const satisfies Record<Metric['navigationType'], string>;

const METRICA_NA_SERIE = {
  CLS: 'cls',
  FCP: 'fcp',
  INP: 'inp',
  LCP: 'lcp',
  TTFB: 'ttfb',
} as const satisfies Record<NomeMetrica, string>;

export type EventoVital = {
  metrica: (typeof METRICA_NA_SERIE)[NomeMetrica];
  /** ms inteiros; CLS é adimensional (4 casas). */
  valor: number;
  classificacao: (typeof CLASSIFICACAO_NA_SERIE)[Metric['rating']];
  rota: string;
  navegacao: (typeof NAVEGACAO_NA_SERIE)[Metric['navigationType']];
  /**
   * Id da INSTÂNCIA da métrica. INP e CLS podem sair mais de uma vez por carga
   * (a aba esconde, volta, piora) — a query deduplica por ele com
   * `argMax(valor, timestamp)`.
   */
  metrica_id: string;
  /** `effectiveType` (Chrome/Android); `null` onde o navegador não expõe. */
  conexao: string | null;
};

// ─── Linha do tempo de rotas ────────────────────────────────────────────────

/**
 * A rota de uma métrica é a que estava na tela NO INSTANTE do que ela mede, não
 * a da hora em que a lib reporta: o LCP fecha na 1ª interação, o INP só é
 * processado no idle seguinte — e a interação pior costuma ser justamente o
 * clique que navegou. Ler `location` no callback culparia a tela de DESTINO.
 */
export type MarcoDeRota = { readonly t: number; readonly rota: string };

const MAX_MARCOS = 100;

export function anotarRota(linha: MarcoDeRota[], t: number, pathname: string): void {
  const rota = canonicalizarRota(pathname);
  if (linha.length > 0 && linha[linha.length - 1].rota === rota) return;
  linha.push({ t, rota });
  if (linha.length > MAX_MARCOS) linha.splice(0, linha.length - MAX_MARCOS);
}

/** Rota vigente em `t` (último marco com `t` ≤ instante). Antes do 1º marco, o 1º. */
export function rotaNoInstante(linha: readonly MarcoDeRota[], t: number): string | null {
  if (linha.length === 0) return null;
  let vigente = linha[0].rota;
  for (const marco of linha) {
    if (marco.t > t) break;
    vigente = marco.rota;
  }
  return vigente;
}

/**
 * O instante que a métrica descreve. CLS: o MAIOR deslocamento da pior janela
 * (é ele que a tela precisa consertar). Os outros: a última entrada — LCP é o
 * maior elemento pintado, INP tem as entradas de UMA interação, FCP/TTFB têm
 * uma só. Sem entrada (restauração do bfcache, que mede por rAF) → `null`, e
 * quem chama usa a rota atual.
 */
function instanteDaMetrica(metrica: MetricaVital): number | null {
  const { entries } = metrica;
  if (entries.length === 0) return null;
  if (metrica.name === 'CLS') {
    let maior = entries[0];
    for (const e of entries) if ((e.value ?? 0) > (maior.value ?? 0)) maior = e;
    return maior.startTime;
  }
  return entries[entries.length - 1].startTime;
}

export function montarEvento(metrica: MetricaVital, rota: string, conexao: string | null): EventoVital {
  return {
    metrica: METRICA_NA_SERIE[metrica.name],
    valor: metrica.name === 'CLS' ? Math.round(metrica.value * 10_000) / 10_000 : Math.round(metrica.value),
    classificacao: CLASSIFICACAO_NA_SERIE[metrica.rating],
    rota,
    navegacao: NAVEGACAO_NA_SERIE[metrica.navigationType],
    metrica_id: metrica.id,
    conexao,
  };
}

// ─── Coletor ────────────────────────────────────────────────────────────────

/**
 * INP e CLS são observados com `reportAllChanges` (para o instante — e logo a
 * rota — acompanhar a pior interação/janela), mas só SAEM quando a aba
 * esconde: mandar a cada piora seria um evento por clique. LCP/FCP/TTFB saem
 * quando a lib reporta, que já é o valor final.
 */
const ACUMULADAS: ReadonlySet<NomeMetrica> = new Set(['INP', 'CLS']);

export type DepsColetor = {
  enviar: (evento: EventoVital) => void;
  linha: readonly MarcoDeRota[];
  rotaAtual: () => string;
  conexao: () => string | null;
};

export function criarColetor(deps: DepsColetor) {
  const pendentes = new Map<NomeMetrica, EventoVital>();

  return {
    aoMedir(metrica: MetricaVital): void {
      const t = instanteDaMetrica(metrica);
      const rota = (t === null ? null : rotaNoInstante(deps.linha, t)) ?? deps.rotaAtual();
      const evento = montarEvento(metrica, rota, deps.conexao());
      if (ACUMULADAS.has(metrica.name)) pendentes.set(metrica.name, evento);
      else deps.enviar(evento);
    },
    /**
     * Chamar quando a aba esconde (inclui fechar/trocar de app no celular).
     * Esvaziar é o que impede esconder 2× sem piora de repetir a linha: a lib
     * só chama `aoMedir` de novo quando o valor MUDA. (Houve aqui um dedupe por
     * `metrica_id`+valor; a falsificação provou-o inalcançável e ele saiu.)
     */
    descarregar(): void {
      for (const evento of pendentes.values()) deps.enviar(evento);
      pendentes.clear();
    },
  };
}

// ─── 2º cano: o nosso banco ─────────────────────────────────────────────────

/**
 * Cada evento sai TAMBÉM para `telemetria_vitals`, pelo PostgREST — domínio do
 * app, imune às listas que cortam o PostHog. Medido em 2026-11-02: o aparelho
 * mais usado (103 de 155 boots em 7 dias) tem o PostHog bloqueado, então a linha
 * de base só pelo PostHog sairia da minoria do uso. O PostHog continua: é ele
 * que traz `$device_type`/`$browser` de quem chega.
 *
 * UPSERT por (`user_id`, `metrica_id`): INP/CLS podem sair 2× na mesma carga e a
 * linha fica com o último valor — o mesmo `argMax` da query do PostHog.
 *
 * Pelo client OFICIAL, não por `fetch keepalive`: INP/CLS saem no
 * `visibilitychange → hidden`, quando a página ainda está viva — o mesmo caminho
 * que o `useLastVisit` mediu entregando em produção, e o keepalive cru mediu não
 * entregando. O client embrulhado também respeita o write-guard da lente.
 */
export type LinhaVital = EventoVital & {
  user_id: string;
  device_id: string | null;
  build_id: string | null;
};

export type MotivoCanoBanco = 'gravou' | 'lente_ativa' | 'sem_usuario' | 'falhou';

export type DepsCanoBanco = {
  usuario: () => Promise<string | null>;
  lenteAtiva: () => boolean;
  deviceId: () => string | null;
  buildId: () => string | null;
  gravar: (linha: LinhaVital) => PromiseLike<{ error: unknown }>;
};

/**
 * Telemetria nunca quebra tela: toda falha vira `logger.warn` e o motivo
 * devolvido — nada lança para quem chamou.
 */
export function criarCanoBanco(deps: DepsCanoBanco): (evento: EventoVital) => Promise<MotivoCanoBanco> {
  return async (evento) => {
    // A lente "ver como" barra a escrita no client; desistir aqui evita um warn
    // por métrica enquanto ela estiver ligada.
    if (deps.lenteAtiva()) return 'lente_ativa';
    try {
      const userId = await deps.usuario();
      // A RLS só aceita a linha do próprio usuário: na tela de login não há dono.
      if (!userId) return 'sem_usuario';
      const { error } = await deps.gravar({
        ...evento,
        user_id: userId,
        device_id: deps.deviceId(),
        build_id: deps.buildId(),
      });
      if (!error) return 'gravou';
      logger.warn('app.vitals não gravou no banco', { error: mensagemDeErro(error) ?? '(sem mensagem)' });
    } catch (e) {
      logger.warn('app.vitals não gravou no banco', { error: mensagemDeErro(e) ?? '(sem mensagem)' });
    }
    return 'falhou';
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O aparelho do `telemetria_probes`; `null` se o localStorage não responder (a coluna é uuid). */
function deviceIdOuNull(): string | null {
  try {
    const id = obterDeviceId();
    return UUID.test(id) ? id : null;
  } catch {
    return null;
  }
}

const gravarNoBanco = criarCanoBanco({
  usuario: async () => (await supabase.auth.getSession()).data.session?.user.id ?? null,
  lenteAtiva: isLensActive,
  deviceId: deviceIdOuNull,
  buildId: () => resolverBuildId(),
  // `.then()` implícito no `await` de quem chama: o builder do PostgREST é
  // preguiçoso e só manda a request quando alguém o consome.
  gravar: (linha) => supabase.from('telemetria_vitals').upsert(linha, { onConflict: 'user_id,metrica_id' }),
});

// ─── Ligação com o browser ──────────────────────────────────────────────────

const linhaDoTempo: MarcoDeRota[] = [];
let iniciado = false;

function lerConexao(): string | null {
  const nav = navigator as Navigator & { connection?: { effectiveType?: unknown } };
  const tipo = nav.connection?.effectiveType;
  // `slow-2g` → `slow_2g`: a série é snake_case (ver `CLASSIFICACAO_NA_SERIE`).
  return typeof tipo === 'string' ? tipo.replace(/-/g, '_') : null;
}

/** Chamar a cada troca de `pathname` (o `MedidorVitals` faz). */
export function registrarRotaVitals(pathname: string): void {
  if (typeof performance === 'undefined') return;
  anotarRota(linhaDoTempo, performance.now(), pathname);
}

/**
 * Liga a medição uma vez por carga. Respeita o mesmo gate da telemetria: sem
 * `VITE_POSTHOG_KEY` nem baixa a lib; em DEV mede e só LOGA (o `track()` cai
 * no opt-out do `analytics.ts`, então nada sai para a rede).
 */
export function iniciarVitals(): void {
  if (iniciado || typeof window === 'undefined' || typeof document === 'undefined') return;
  const emDev = import.meta.env.DEV === true;
  if (!telemetriaAtiva() && !emDev) return;
  iniciado = true;

  // Marco zero: a rota em que a página carregou vale desde a navegação (t=0),
  // que é de onde o TTFB e o FCP contam.
  if (linhaDoTempo.length === 0) anotarRota(linhaDoTempo, 0, window.location.pathname);

  const coletor = criarColetor({
    enviar: (evento) => {
      track('app.vitals', evento);
      // Mesmo gate do `track()`: em DEV o `.env` aponta para o banco de PRODUÇÃO.
      if (telemetriaAtiva()) void gravarNoBanco(evento);
      if (emDev) logger.debug('[vitals] app.vitals', evento);
    },
    linha: linhaDoTempo,
    rotaAtual: () => canonicalizarRota(window.location.pathname),
    conexao: lerConexao,
  });

  import('web-vitals')
    .then(({ onCLS, onINP, onLCP, onFCP, onTTFB }) => {
      onTTFB(coletor.aoMedir);
      onFCP(coletor.aoMedir);
      onLCP(coletor.aoMedir);
      onINP(coletor.aoMedir, { reportAllChanges: true });
      onCLS(coletor.aoMedir, { reportAllChanges: true });
      // ⚠️ No `document`, fase de bolha: a lib escuta o mesmo evento na
      // `window` em CAPTURA e fecha o INP/CLS ali — o dela roda antes do nosso
      // independentemente da ordem de registro, então descarregamos o valor final.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') coletor.descarregar();
      });
    })
    .catch((e) => {
      iniciado = false;
      logger.warn('Falha ao carregar web-vitals', { error: mensagemDeErro(e) ?? '(sem mensagem)' });
      // Mesmo critério do `initAnalytics`: chunk que falhou no Wi-Fi instável
      // re-tenta quando a rede volta — os observers são `buffered`, o LCP/FCP
      // da carga ainda são lidos.
      window.addEventListener('online', () => iniciarVitals(), { once: true });
    });
}
