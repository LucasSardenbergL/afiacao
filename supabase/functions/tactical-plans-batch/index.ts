// supabase/functions/tactical-plans-batch/index.ts
//
// Cron noturno que, para cada vendedora (farmer) com carteira, seleciona o
// top-25 dos clientes por priority_score que passam no gate de R$/h e dispara
// a pré-geração do plano tático chamando generate-tactical-plan no modo
// self-contained. Idempotência fica na edge alvo (skipped: 'ja_gerado_hoje').
//
// Gate de R$/h: _shared/tactical-margem.ts (espelho testado de src/lib/tactical/pregeracao.ts).
//   profitPerHora = ((rev > 0 ? rev : avg) * (margin / 100) * 0.1) / (15 / 60)
//   Threshold: R$ 50/h.
//
// Semântica top-N: filtra o gate ANTES de cortar no TOP_25 — pega os 25 de
// maior priority DENTRE os que passam (não os 25 de maior priority e filtra depois).
//
// Ordem de EXECUÇÃO: round-robin entre farmers (_shared/tactical-ordem.ts), não a
// concatenação dos grupos. Cobertura parcial é rotina (timeout/429/402) e sempre come o
// SUFIXO — com a concatenação, o último farmer ficava zerado (9/15/0 em 30/07, 9/16/0 em
// 31/07, o mesmo farmer). Intercalado, um prefixo de 24 sobre 9/25/25 dá 8/8/8.
//
// Margem AUSENTE não é margem zero (money-path princípio 2): sem margem o gate de R$/h
// não é decidível, então o cliente sai do ranking e é CONTADO em `sem_margem_indecidivel`.
// Antes, `Number(null ?? 0)` fabricava R$ 0/h — indistinguível de um cliente de margem
// genuinamente ruim, e reprovado em silêncio.
//
// Setup pg_cron (manual depois do merge) — padrão copiado do `daily-calculate-scores` EM PRODUÇÃO:
//   SELECT cron.schedule('tactical-plans-batch-nightly', '0 8 * * *',
//     $$ SELECT net.http_post(
//       url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/tactical-plans-batch',
//       headers := jsonb_build_object('Content-Type','application/json',
//         'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
//       body := '{"triggered_by":"cron"}'::jsonb,
//       timeout_milliseconds := 150000
//     ); $$
//   );
//
// O secret vem do VAULT, não de `current_setting('app.cron_shared_key', true)`: essa GUC não
// existe no projeto, o `true` (missing_ok) devolve NULL em silêncio, e o header sai nulo →
// `authorizeCron` responde 401. E `cron.job_run_details` marca `succeeded` mesmo assim, porque
// só registra o ENQUEUE do net.http_post — a verdade HTTP está em `net._http_response`.
// Falha silenciosa clássica (docs/agent/sync.md). Nenhum dos crons vivos usa a GUC.
//
// `timeout_milliseconds` explícito é obrigatório: o default do pg_net é 5s e mataria o batch no
// meio, em silêncio. 150000 é o teto padrão da casa (docs/agent/sync.md).
//
// ⚠️ SCHEDULE É UTC, não BRT — `cron.timezone` está vazio no banco (#1510). `'0 8 * * *'` dispara
// às 05:00 BRT. Ao mexer, converta explícito: BRT = UTC−3.
//
// 08:00 UTC é o primeiro slot DEPOIS de todas as dependências do batch — não mexer sem refazer
// esta conta (o `'0 5 * * *'` que este bloco sugeria antes é 02:00 BRT, ANTES de todas elas: leria
// a margem e a carteira do dia anterior):
//   06:00 UTC `daily-calculate-scores`           → grava os scores que o gate de R$/h consome
//   06:00 UTC `scoring-recalc-batch-nightly`     → recalcula priority_score
//   07:00 UTC `visit-score-recalc-batch-nightly` → recalcula o score de visita
//   07:30 UTC `carteira-rebuild-nightly`         → reconstrói `carteira_assignments`, a allowlist
//                                                  de elegíveis lida no passo 0 abaixo
//
// Depois de criar: versione o cron numa migration — cron que vive só no banco some sem rastro
// (docs/agent/sync.md; o de vendas ficou 8 dias morto por isso).

import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCron, corsHeaders } from '../_shared/auth.ts';
import { fetchAll } from '../_shared/paginate.ts';
import {
  type LinhaSelecao,
  margemConhecida,
  selecionarParaPregeracao,
} from '../_shared/tactical-margem.ts';
import {
  agregar,
  type Classificacao,
  classificarAlvo,
} from '../_shared/tactical-batch-resultado.ts';
import {
  type CarteiraFarmer,
  intercalarPorFarmer,
  rotacaoDoDia,
} from '../_shared/tactical-ordem.ts';
import { inicioDiaOperacional } from '../_shared/dia-operacional.ts';

const TOP_N = 25;
const CONCURRENCY = 5; // cada chamada faz 1 LLM (~3-5s); 5 em paralelo ~5s/chunk

// ── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // [Codex #2] cron-only: o batch varre TODAS as carteiras e dispara geração via service_role —
  // staff não pode acioná-lo (usaria o modo front da edge, escopado à própria carteira).
  const auth = authorizeCron(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const selfUrl = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/generate-tactical-plan`;
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';
  if (!cronSecret) {
    console.warn('[tactical-plans-batch] CRON_SECRET not set; downstream calls will be rejected');
  }

  // 0. ALLOWLIST de clientes elegíveis (máscara `eligible` — #1398/#1416).
  //    farmer_client_scores é lido via service_role (bypassa RLS) e NÃO tem coluna de
  //    elegibilidade: sem este passo, o batch geraria plano tático de cliente mascarado
  //    (fornecedor excluído / clone de identidade) — 1459 dos 6256 scores em 2026-07-18.
  //    ALLOWLIST, não denylist: se esta leitura truncar, o efeito é gerar de MENOS
  //    (fail-closed); uma denylist truncada deixaria mascarado PASSAR (fail-open).
  //    A RPC criar_plano_tatico recusa mascarado de qualquer forma (fronteira fail-closed);
  //    este filtro evita ~1459 chamadas de LLM inúteis e mantém honesto o contador de erros.
  let elegiveis: Set<string>;
  try {
    const linhas = await fetchAll<{ customer_user_id: string }>(
      (from, to) => supabase
        .from('carteira_assignments')
        .select('customer_user_id')
        .eq('eligible', true)
        .order('customer_user_id', { ascending: true }) // UNIQUE ⇒ estável entre páginas
        .range(from, to),
      'allowlist de clientes elegíveis',
    );
    elegiveis = new Set(linhas.map((l) => l.customer_user_id));
  } catch (e) {
    // Falhar ALTO: seguir com allowlist parcial geraria menos planos em silêncio, e
    // seguir sem allowlist reabriria o furo. Nenhum dos dois é aceitável.
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // 1. Pagina farmer_client_scores (fetchAll: LANÇA em error E em data:null sem error — o
  //    `?? []` de antes lia resposta malformada como fim e o batch seguia com seleção PARCIAL)
  //    e agrupa por farmer_id. A carteira já está limpa de fornecedor pela Fase 1 (classificacao).
  let mascaradosIgnorados = 0;
  const porFarmer = new Map<string, LinhaSelecao[]>();

  try {
    const linhas = await fetchAll<{
      farmer_id: string;
      customer_user_id: string;
      priority_score: number | null;
      revenue_potential: number | null;
      avg_monthly_spend_180d: number | null;
      gross_margin_pct: number | null;
    }>(
      (from, to) => supabase
        .from('farmer_client_scores')
        .select('farmer_id, customer_user_id, priority_score, revenue_potential, avg_monthly_spend_180d, gross_margin_pct')
        // Chave de ordenação = `customer_user_id` SOZINHO: UNIQUE (ordem total) e IMUTÁVEL.
        // Não basta ser total — tem de ser ESTÁVEL sob escrita concorrente. Ordenar por
        // (farmer_id, customer_user_id) é total, mas `farmer_id` MUDA no meio da paginação: o
        // trigger trg_carteira_reconcile_score_owner (confirmado em prod) faz
        // `SET farmer_id = EXCLUDED.farmer_id` a cada mudança de dono, e o carteira-rebuild roda
        // 07:30 UTC — 30min antes deste batch. Uma linha que troca de farmer entre dois offsets
        // MUDA DE POSIÇÃO: some (fica sem plano naquela noite) ou duplica (disputa o TOP_N duas
        // vezes). O agrupamento por farmer é em MEMÓRIA (porFarmer), então a ordem por farmer_id
        // nunca foi necessária. (Achado do challenge /codex.)
        .order('customer_user_id', { ascending: true })
        .range(from, to),
      'farmer_client_scores (seleção do batch)',
    );

    for (const r of linhas) {
      // Máscara na INGESTÃO (não no corte): um mascarado nem chega a disputar vaga no TOP_N.
      if (!elegiveis.has(r.customer_user_id)) { mascaradosIgnorados++; continue; }
      const arr = porFarmer.get(r.farmer_id) ?? [];
      arr.push({
        customer: r.customer_user_id,
        priority: Number(r.priority_score ?? 0),
        rev: Number(r.revenue_potential ?? 0),
        avg: Number(r.avg_monthly_spend_180d ?? 0),
        // ausente ≠ zero: `null` mantém "não sei" distinguível de "margem 0".
        marginPct: margemConhecida(r.gross_margin_pct),
      });
      porFarmer.set(r.farmer_id, arr);
    }
  } catch (e) {
    // Mesma política do passo 0 (falhar ALTO): seguir com seleção parcial geraria menos
    // planos em silêncio.
    return new Response(
      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // 2. Por farmer: ordena por priority desc, filtra gate R$/h, corta em TOP_N.
  //    Semântica: pega os 25 de maior priority DENTRE os que passam no gate.
  const carteiras: CarteiraFarmer[] = [];
  let semMargemIndecidivel = 0;

  for (const [farmer, scores] of porFarmer) {
    const { selecionados, semMargem } = selecionarParaPregeracao(scores, TOP_N);
    semMargemIndecidivel += semMargem.length;
    carteiras.push({ farmer, clientes: selecionados.map((s) => s.customer) });
  }

  // 2b. ORDEM DE EXECUÇÃO em round-robin entre farmers (_shared/tactical-ordem.ts, testado).
  //     Antes: concatenação dos grupos do Map (`[A...A, B...B, C...C]`), com a ordem vindo
  //     da 1ª ocorrência de cada farmer na paginação por customer_user_id — acidental.
  //     Como toda cobertura parcial come o SUFIXO, o último farmer da concatenação ficava
  //     ZERADO: medido 9/15/0 em 30/07 e 9/16/0 em 31/07, o MESMO farmer nos dois dias
  //     (e o precedente de 2026-07-21, "uma vendedora inteira sem plano").
  //     Isto NÃO conserta o volume — o batch continua podendo truncar por timeout/429/402.
  //     Conserta a DISTRIBUIÇÃO: um prefixo de 24 sobre 9/25/25 agora dá 8/8/8.
  //     O dia operacional é BRT (mesma régua da idempotência): 00:00 BRT = 03:00 UTC do
  //     mesmo dia, então o slice(0,10) do instante devolvido é o dia BRT correto.
  const diaOperacional = inicioDiaOperacional(new Date()).slice(0, 10);
  const alvos = intercalarPorFarmer(carteiras, rotacaoDoDia(diaOperacional));

  // 3. Fan-out concorrente em chunks de 5. Idempotência é na edge alvo.
  //    A classificação/agregação vive em _shared/tactical-batch-resultado.ts (testada):
  //    aqui só coletamos. Antes, três contadores soltos com `else erros++` perdiam o
  //    MOTIVO — ver o incidente no cabeçalho daquele módulo.
  const classificacoes: Classificacao[] = [];

  for (let i = 0; i < alvos.length; i += CONCURRENCY) {
    const chunk = alvos.slice(i, i + CONCURRENCY);
    classificacoes.push(...await Promise.all(
      chunk.map(async (a): Promise<Classificacao> => {
        try {
          const r = await fetch(selfUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-cron-secret': cronSecret,
            },
            body: JSON.stringify({
              customerId: a.customer,
              farmerId: a.farmer,
              planType: 'estrategico',
            }),
          });
          const j = await r.json().catch(() => ({})) as Record<string, unknown>;
          return classificarAlvo(r.status, j);
        } catch {
          // fetch nem chegou a responder (rede/timeout). Reusa a MESMA função testada
          // com status 0 em vez de um ramo de erro solto e não coberto aqui.
          return classificarAlvo(0, {});
        }
      }),
    ));
  }

  const resumo = agregar(classificacoes);

  return new Response(
    JSON.stringify({
      // `ok` vem do AGREGADO: falso se qualquer alvo falhou. Antes era `true` fixo —
      // em 2026-07-21 devolveu ok:true com 28 de 58 alvos quebrados e uma vendedora
      // inteira sem plano, e o cron marcou `succeeded`.
      ...resumo,
      farmers: porFarmer.size,
      alvos: alvos.length,
      // transparência do que foi DESCARTADO pela máscara: um corte silencioso leria como
      // "cobri todo mundo" sem ter coberto (money-path — no silent caps).
      mascarados_ignorados: mascaradosIgnorados,
      // clientes que saíram do ranking por FALTA DE MARGEM (gate indecidível), não por
      // reprovação no gate. Enquanto nenhum writer calcular gross_margin_pct, este número
      // tende ao total da carteira — e é o sinal de que o batch está cego, não ocioso.
      sem_margem_indecidivel: semMargemIndecidivel,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
