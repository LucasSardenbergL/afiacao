// supabase/functions/tactical-plans-batch/index.ts
//
// Cron noturno que, para cada vendedora (farmer) com carteira, seleciona o
// top-N dos clientes por priority_score que passam no gate de R$/h e dispara
// a pré-geração do plano tático chamando generate-tactical-plan no modo
// self-contained. Idempotência fica na edge alvo (skipped: 'ja_gerado_hoje').
//
// Gate de R$/h: _shared/tactical-margem.ts (espelho testado de src/lib/tactical/pregeracao.ts).
//   profitPerHora = ((rev > 0 ? rev : avg) * (margin / 100) * 0.1) / (15 / 60)
//   Threshold: R$ 50/h.
//
// Semântica top-N: filtra o gate E a fila aberta ANTES de cortar no TOP_N — pega os N de
// maior priority DENTRE os que passam (não os N de maior priority e filtra depois). Com
// TOP_N pequeno essa ordem deixou de ser refinamento e virou requisito: filtrar a fila
// depois do corte escolheria todo dia os mesmos N, que a idempotência pularia, e o cliente
// N+1 nunca entraria — fila congelada com aparência de funcionamento.
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

import { createClient } from 'npm:@supabase/supabase-js@2';
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
import { inicioDaJanelaFila } from '../_shared/tactical-fila.ts';
import { mensagemDeErro } from '../_shared/erro-mensagem.ts';

// TOP_N é a taxa de entrada de clientes NOVOS por vendedora por dia — não o tamanho da fila.
// Com a janela de 7 dias (tactical-fila.ts), a fila estabiliza em TOP_N × 7 por vendedora:
// 2/dia ⇒ ~14 cartões, que é o que cabe numa semana de venda consultiva B2B (calibrado com o
// founder em 2026-08-08). Era 25 — que somado à regeração diária produzia 169 planos vivos
// para 35 clientes. Para mudar o tamanho da fila, mexa AQUI, não na janela.
const TOP_N = 2;
const CONCURRENCY = 5; // cada chamada faz 1 LLM (~3-5s); 5 em paralelo ~5s/chunk

// Ausente ≠ zero (money-path): revenue_potential nunca teve writer — NULL em 6.633/6.633
// linhas de farmer_client_scores (column_default removido). `valorMedido` degrada para null em
// vez de fabricar 0 no `rev` que alimenta o gate de R$/h (profitPerHora, em _shared/tactical-
// margem.ts). Sem marcador MIRROR: a paridade textual vigiada (edge-money-path-invariants.
// test.ts) cobre só o espelho de visit-score-recalc-client/index.ts. Implementação idêntica a
// src/lib/scoring/margin.ts.
function valorMedido(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.length === 0) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

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
        // ausente ≠ zero: revenue_potential nunca teve writer. `null` mantém "não sei"
        // distinguível de "potencial zero" — profitPerHora cai pro avgSpend com guard explícito.
        rev: valorMedido(r.revenue_potential),
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

  // 1b. FILA ABERTA: quem já tem plano dentro da janela não volta a disputar vaga.
  //     Sem isto, o batch regenerava o mesmo cliente todo dia — a idempotência só cobria o DIA
  //     operacional, então na madrugada seguinte o cliente era candidato de novo. Medido em prod
  //     (2026-08-08): 23 dos 25 planos de 07/08 eram regeração; a fila viva tinha 169 planos para
  //     35 clientes, 14 deles com 7 cópias — uma por dia da janela. E dos 174 clientes que passam
  //     no gate de R$/h, 97 NUNCA tinham recebido plano: a cota diária inteira ia para repetição.
  //
  //     Chave (farmer, customer), igual à da RPC criar_plano_tatico: cliente reatribuído precisa
  //     de plano sob o dono NOVO, e uma chave só por customer o deixaria bloqueado pelo plano do
  //     dono antigo.
  //
  //     Falha ALTO, como os passos 0 e 1: seguir com a fila vazia não degrada — RESSUSCITA a
  //     duplicata que este passo existe para remover, e em silêncio.
  const filaPorFarmer = new Map<string, Set<string>>();
  try {
    const desdeIso = inicioDaJanelaFila(new Date());
    const abertos = await fetchAll<{ farmer_id: string; customer_user_id: string }>(
      (from, to) => supabase
        .from('farmer_tactical_plans')
        .select('farmer_id, customer_user_id')
        .eq('status', 'gerado')
        // `generated_at`, a MESMA coluna do recorte da tela (useTacticalPlan.ts) e do cron
        // expirar_planos_taticos. "Estar na fila" precisa ter uma definição só: filtrar por
        // created_at aqui e generated_at lá faria as pontas discordarem se as duas colunas
        // divergissem (hoje são idênticas nas 533 linhas, mas isso é acidente, não garantia).
        // O COALESCE fail-closed contra data nula vive na RPC — aqui é filtro de ECONOMIA
        // (evitar a chamada paga à IA), não a fronteira; o caso patológico que escapar daqui
        // é recusado lá e vira skip honesto.
        .gte('generated_at', desdeIso)
        .order('id', { ascending: true }) // PK ⇒ ordem total, estável entre páginas
        .range(from, to),
      'fila aberta de planos táticos',
    );
    for (const p of abertos) {
      const s = filaPorFarmer.get(p.farmer_id) ?? new Set<string>();
      s.add(p.customer_user_id);
      filaPorFarmer.set(p.farmer_id, s);
    }
  } catch (e) {
    // `mensagemDeErro`, não `instanceof Error ? … : String(e)`: o erro que chega aqui vem do
    // supabase-js, que no caminho sem `.throwOnError()` devolve um objeto PLANO — e `String()`
    // nele rende "[object Object]", apagando a mensagem que diria se foi timeout, RLS ou rede.
    // O gate estrutural erro-object-object-gate (classe #1642) vigia isso por CONTAGEM por
    // arquivo; as 2 ocorrências antigas deste arquivo são dívida baselinada, e sítio novo não
    // pode aumentá-la.
    return new Response(
      JSON.stringify({ ok: false, error: mensagemDeErro(e) ?? 'falha ao ler a fila aberta de planos táticos' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // 2. Por farmer: ordena por priority desc, tira quem já está na fila, filtra gate R$/h,
  //    corta em TOP_N. Semântica: os TOP_N de maior priority DENTRE os que passam no gate
  //    e ainda NÃO têm plano aberto.
  const carteiras: CarteiraFarmer[] = [];
  let semMargemIndecidivel = 0;
  let jaNaFila = 0;

  for (const [farmer, scores] of porFarmer) {
    const { selecionados, semMargem, naFila } = selecionarParaPregeracao(
      scores,
      TOP_N,
      filaPorFarmer.get(farmer) ?? new Set<string>(),
    );
    semMargemIndecidivel += semMargem.length;
    jaNaFila += naFila.length;
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
      // reprovação no gate. NÃO é disjunto de `ja_na_fila`: é contado sobre a carteira toda
      // de propósito, para que encher a fila não o faça "melhorar" sozinho.
      //
      // ⚠️ NÃO leia este número como "o batch está cego" — a versão anterior deste comentário
      // dizia isso, e a medição desmente. Cruzamento em prod (2026-08-08, 6.633 scores):
      //     compra nos 180d + margem: 405  |  compra sem margem:   1
      //     sem compra      + margem: 670  |  sem compra, s/margem: 5.557
      // O writer de gross_margin_pct FUNCIONA — cobre 405 dos 406 clientes com compra (99,8%).
      // O número é alto porque a carteira é ~94% INATIVA, e sem compra nos 180 dias não há
      // margem a calcular. Ausência honesta, não writer quebrado. Tratá-la como bug levaria a
      // "consertar" um writer que está certo; o que este número mede é o tamanho do pool vivo.
      sem_margem_indecidivel: semMargemIndecidivel,
      // clientes que não disputaram vaga por JÁ TEREM plano aberto na janela. Antes eram
      // regerados e viravam cópia; agora são pulados ANTES da chamada paga à IA. Publicado
      // porque um corte silencioso leria como "não havia mais ninguém" (money-path: no
      // silent caps) — e porque é este número que mostra a fila circulando: ele sobe
      // enquanto a fila enche e cai conforme os planos expiram ou são concluídos.
      ja_na_fila: jaNaFila,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
