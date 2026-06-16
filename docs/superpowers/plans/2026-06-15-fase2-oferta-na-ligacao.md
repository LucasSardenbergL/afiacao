# Fase 2 / Fatia 1 — Oferta viva na ligação — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans pra implementar task-by-task. Steps usam checkbox (`- [ ]`).

**Goal:** Quando a vendedora abre o cliente pra ligar, a **oferta campeã + o gancho de conversa** já aparecem na tela, automaticamente — pré-gerados de madrugada pros clientes prioritários.

**Architecture:** Um cron noturno (`tactical-plans-batch`) pré-gera o plano tático pros top ~25 clientes da agenda de cada vendedora que passam no gate de R$/h, chamando a edge `generate-tactical-plan` num **modo self-contained novo** (recebe `{customerId, farmerId}`, monta o contexto com `service_role` e grava em `farmer_tactical_plans`). O front fica **intacto** (o `ActivePlanCard`, que já aparece na ligação via `getActivePlan`, ganha destaque pra oferta+gancho; cauda longa cai num fallback de "oferta crua" lendo `farmer_bundle_recommendations`).

**Tech Stack:** Supabase (Edge Deno + Postgres + pg_cron), React + TanStack Query, vitest (helpers puros). LLM via gateway Lovable (`generate-tactical-plan` existente). Contexto Lovable: migrations no SQL Editor, edges via chat, front via Publish — **nada acontece no merge**.

> **Spec:** [docs/superpowers/specs/2026-06-15-rotina-comercial-oferta-na-ligacao-design.md](../specs/2026-06-15-rotina-comercial-oferta-na-ligacao-design.md).

---

## File Structure

| Arquivo | Resp. | Ação |
|---|---|---|
| `src/lib/tactical/pregeracao.ts` | regra pura: gate de R$/h + seleção top-N (oráculo do batch) | criar |
| `src/lib/tactical/__tests__/pregeracao.test.ts` | testes vitest | criar |
| `supabase/functions/generate-tactical-plan/index.ts` | + modo self-contained `{customerId, farmerId}` (monta server-side + grava) | modificar |
| `supabase/functions/tactical-plans-batch/index.ts` | cron: itera farmers × top-25, chama o modo self-contained, idempotente | criar |
| `src/components/farmer/copilot/ActivePlanCard.tsx` | destacar OFERTA (bundle) + GANCHO (offer_transition) no topo | modificar |
| `src/components/farmer/copilot/OfertaCruaCard.tsx` | fallback (sem plano): lê `farmer_bundle_recommendations` | criar |
| `src/components/farmer/copilot/useFarmerCopilot.ts` | renderizar OfertaCruaCard quando `getActivePlan` = null | modificar |
| `supabase/migrations/20260615120000_idx_tactical_plans_lookup.sql` | índice p/ `getActivePlan`/idempotência | criar |

**Constante compartilhada:** o gate `PROFIT_PER_HOUR_THRESHOLD = 50` e a fórmula `estimatedProfitPerHour` já vivem em `src/hooks/useTacticalPlan.ts` — a Task 1 extrai a fórmula pura; a edge batch (Deno) **replica inline** (front e edge não compartilham módulo — mesma lição da Fase 1, helper em `src/lib` é o oráculo, a edge espelha).

---

## Task 1: Helper puro — gate de R$/h + seleção top-N (TDD)

**Files:** Create `src/lib/tactical/pregeracao.ts` + `src/lib/tactical/__tests__/pregeracao.test.ts`

Espelha a fórmula de `useTacticalPlan.checkEfficiency` (linha 313-318): `estimatedMarginPerCall = (revenue_potential>0 ? revenue_potential : avgSpend) × margin% × 0.1`; `profitPerHour = estimatedMarginPerCall / (15/60)`.

- [ ] **Step 1: Escrever o teste falhando** (`pregeracao.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { profitPerHora, selecionarParaPregeracao, PROFIT_PER_HOUR_THRESHOLD } from '../pregeracao';

describe('profitPerHora', () => {
  it('usa revenue_potential quando > 0', () => {
    // (1000 * 30% * 0.1) / (15/60) = 30 / 0.25 = 120
    expect(profitPerHora({ revenuePotential: 1000, avgSpend: 50, marginPct: 30 })).toBeCloseTo(120);
  });
  it('cai pra avgSpend quando revenue_potential = 0', () => {
    // (500 * 20% * 0.1) / 0.25 = 10 / 0.25 = 40
    expect(profitPerHora({ revenuePotential: 0, avgSpend: 500, marginPct: 20 })).toBeCloseTo(40);
  });
});

describe('selecionarParaPregeracao', () => {
  const base = (id: string, priority: number, rev: number, m: number) =>
    ({ customerUserId: id, priorityScore: priority, revenuePotential: rev, avgSpend: 0, marginPct: m });

  it('ordena por priority desc, filtra pelo gate, corta no topN', () => {
    const scores = [
      base('a', 90, 1000, 30), // pph 120 ✓
      base('b', 80, 100, 10),  // pph (100*10%*0.1)/0.25 = 4 ✗ (abaixo de 50)
      base('c', 70, 2000, 25), // pph (2000*25%*0.1)/0.25 = 200 ✓
      base('d', 95, 5000, 40), // pph 800 ✓
    ];
    const sel = selecionarParaPregeracao(scores, 2);
    expect(sel.map(s => s.customerUserId)).toEqual(['d', 'a']); // top-2 por priority, ambos passam o gate
  });
  it('pula quem está abaixo do gate mesmo com priority alta', () => {
    const sel = selecionarParaPregeracao([base('b', 99, 100, 10)], 25);
    expect(sel).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `heavy bun run test src/lib/tactical` → FAIL (módulo inexistente).

- [ ] **Step 3: Implementar** (`pregeracao.ts`)

```ts
/** Pré-geração noturna do plano tático: gate de eficiência + seleção dos prioritários.
 *  Oráculo puro — a edge tactical-plans-batch (Deno) replica esta lógica inline. */
export const PROFIT_PER_HOUR_THRESHOLD = 50; // R$/h — espelha useTacticalPlan.ts:198
const AVG_CALL_MINUTES = 15;

export interface ScoreParaSelecao {
  customerUserId: string;
  priorityScore: number;
  revenuePotential: number;
  avgSpend: number;
  marginPct: number;
}

/** R$/h estimado por ligação. Espelha useTacticalPlan.checkEfficiency:313-318. */
export function profitPerHora(s: Pick<ScoreParaSelecao, 'revenuePotential' | 'avgSpend' | 'marginPct'>): number {
  const base = s.revenuePotential > 0 ? s.revenuePotential : s.avgSpend;
  const marginPerCall = base * (s.marginPct / 100) * 0.1;
  return marginPerCall / (AVG_CALL_MINUTES / 60);
}

/** Top-N por priorityScore desc, filtrando quem passa no gate de R$/h. */
export function selecionarParaPregeracao(scores: ScoreParaSelecao[], topN: number): ScoreParaSelecao[] {
  return [...scores]
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .filter((s) => profitPerHora(s) >= PROFIT_PER_HOUR_THRESHOLD)
    .slice(0, topN);
}
```

- [ ] **Step 4: Rodar e ver passar** — `heavy bun run test src/lib/tactical` → PASS.
- [ ] **Step 5: Commit** — `git add src/lib/tactical && git commit -m "feat(fase2): helper puro de pré-geração (gate R\$/h + top-N, TDD)"`

---

## Task 2: Modo self-contained no `generate-tactical-plan` (montagem server-side + grava)

**Files:** Modify `supabase/functions/generate-tactical-plan/index.ts`

**Abordagem:** adicionar um ramo `selfContained` no início do handler. Se o body trouxer `{ customerId, farmerId }` (em vez de `customerContext`), a edge: (a) lê o contexto com `service_role`, (b) monta o body igual o front faz hoje, (c) chama o MESMO bloco LLM já existente, (d) faz `INSERT` em `farmer_tactical_plans`, (e) retorna `{ id, skipped? }`. O modo antigo (front, com `customerContext`) **fica intacto**. A montagem porta `useTacticalPlan.generatePlan` (src/hooks/useTacticalPlan.ts:328-467) — incluindo `classifyProfile`/`selectObjective`/`mixGap` (linhas 183-196) replicadas inline em Deno.

- [ ] **Step 1: Auth — aceitar cron sem Bearer-user no modo self-contained.** Hoje o handler exige `Authorization: Bearer` (linha 19-30). Envolver esse bloco num `if (!body.customerId)` para que o modo self-contained (autenticado por `authorizeCronOrStaff` via cron-secret, já na linha 14) não precise do user token. Ler o body uma vez no topo:

```ts
  const body = await req.json();
  const selfContained = Boolean(body.customerId && body.farmerId);

  // Modo front (legado): exige Bearer-user. Modo self-contained (cron): só cron-secret (já validado).
  if (!selfContained) {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    // ...resto do bloco de getUser permanece...
  }
```

(Remover o `await req.json()` duplicado mais abaixo — passa a usar `body`.)

- [ ] **Step 2: Montagem server-side.** Quando `selfContained`, antes do bloco LLM, montar `customerContext/bundleContext/diagnosticData/historicalObjections` com um client `service_role`. Portar de `useTacticalPlan.generatePlan`:

```ts
  let customerContext = body.customerContext;
  let bundleContext = body.bundleContext;
  let diagnosticData = body.diagnosticData;
  let historicalObjections = body.historicalObjections;
  let topBundleRow: Record<string, unknown> | null = null;
  let secondBundleRow: Record<string, unknown> | null = null;

  if (selfContained) {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { customerId, farmerId } = body;

    // Idempotência: pula se já há plano 'gerado' criado hoje (00:00 local-UTC).
    const hojeIso = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').toISOString();
    const { data: existente } = await admin.from('farmer_tactical_plans')
      .select('id').eq('farmer_id', farmerId).eq('customer_user_id', customerId)
      .eq('status', 'gerado').gte('created_at', hojeIso).limit(1);
    if (existente?.length) {
      return new Response(JSON.stringify({ id: existente[0].id, skipped: 'ja_gerado_hoje' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const [{ data: score }, { data: profile }, { data: bundles }, { data: allScores }, { data: objEvents }] = await Promise.all([
      admin.from('farmer_client_scores').select('*').eq('customer_user_id', customerId).eq('farmer_id', farmerId).maybeSingle(),
      admin.from('profiles').select('name, customer_type, cnae').eq('user_id', customerId).maybeSingle(),
      admin.from('farmer_bundle_recommendations').select('*').eq('customer_user_id', customerId).eq('farmer_id', farmerId).eq('status', 'pendente').order('lie_bundle', { ascending: false }).limit(2),
      admin.from('farmer_client_scores').select('gross_margin_pct').eq('farmer_id', farmerId),
      admin.from('farmer_copilot_events').select('event_data').eq('event_type', 'suggestion').limit(20),
    ]);
    if (!score) {
      return new Response(JSON.stringify({ skipped: 'sem_score' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const num = (v: unknown) => Number(v ?? 0);
    const healthScore = num(score.health_score), churnRisk = num(score.churn_risk), avgSpend = num(score.avg_monthly_spend_180d);
    const marginPct = num(score.gross_margin_pct), categoryCount = num(score.category_count), daysSince = num(score.days_since_last_purchase);
    const clusterMargin = allScores?.length ? allScores.reduce((s: number, r: { gross_margin_pct: unknown }) => s + num(r.gross_margin_pct), 0) / allScores.length : 25;
    const mixGap = Math.max(0, 8 - categoryCount);

    // classifyProfile/selectObjective — espelham useTacticalPlan.ts:183-196 (oráculo: src/lib/tactical se extraído).
    const customerProfile = avgSpend < 500 && marginPct < 20 ? 'sensivel_preco'
      : marginPct > 35 && categoryCount <= 3 ? 'orientado_qualidade'
      : avgSpend > 2000 && categoryCount >= 4 && healthScore > 60 ? 'orientado_produtividade' : 'misto';
    const strategicObjective = daysSince > 90 ? 'reativacao' : churnRisk > 60 ? 'recuperacao'
      : mixGap > 3 ? 'expansao_mix' : marginPct < clusterMargin * 0.8 ? 'consolidacao_margem' : 'upsell_premium';

    topBundleRow = bundles?.[0] ?? null;
    secondBundleRow = bundles?.[1] ?? null;
    historicalObjections = (objEvents ?? [])
      .map((e: { event_data: { intent?: unknown } | null }) => (e.event_data as { intent?: unknown } | null)?.intent)
      .filter((i: unknown): i is string => typeof i === 'string' && i.startsWith('objecao')).slice(0, 5);

    customerContext = { name: profile?.name, cnae: profile?.cnae, customerType: profile?.customer_type, profile: customerProfile, healthScore, churnRisk, avgMonthlySpend: avgSpend, grossMarginPct: marginPct, categoryCount, daysSinceLastPurchase: daysSince, mixGap, clusterAvgMargin: clusterMargin, expansionPotential: num(score.expansion_score), revenuePotential: num(score.revenue_potential) };
    bundleContext = topBundleRow ? { products: topBundleRow.bundle_products, lie: topBundleRow.lie_bundle, probability: topBundleRow.p_bundle, margin: topBundleRow.m_bundle } : null;
    diagnosticData = { strategicObjective };
    // payload p/ o INSERT depois:
    (body as Record<string, unknown>)._derived = { healthScore, churnRisk, mixGap, marginPct, clusterMargin, expansionPotential: num(score.expansion_score), customerProfile, strategicObjective };
  }
```

- [ ] **Step 3: O bloco LLM existente (linhas 107-183) passa a usar essas variáveis** (`customerContext`/`bundleContext`/`diagnosticData`/`historicalObjections` agora vêm do body OU da montagem). Nenhuma mudança no prompt.

- [ ] **Step 4: INSERT no modo self-contained.** Depois de parsear `plan` (linha ~166), se `selfContained`, gravar em `farmer_tactical_plans` (portar o `planData` de useTacticalPlan.ts:432-461) e retornar o id em vez do JSON cru:

```ts
    if (selfContained) {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
      const d = (body as { _derived: Record<string, number | string> })._derived;
      const { data: ins } = await admin.from('farmer_tactical_plans').insert({
        farmer_id: body.farmerId, customer_user_id: body.customerId,
        bundle_recommendation_id: (topBundleRow as { id?: string } | null)?.id ?? null,
        health_score: d.healthScore, churn_risk: d.churnRisk, mix_gap: d.mixGap,
        current_margin_pct: d.marginPct, cluster_avg_margin_pct: d.clusterMargin, expansion_potential: d.expansionPotential,
        strategic_objective: plan.strategic_objective || d.strategicObjective, customer_profile: d.customerProfile, plan_type: mode,
        top_bundle: (topBundleRow ? topBundleRow.bundle_products : {}),
        second_bundle: (secondBundleRow ? (secondBundleRow as { bundle_products: unknown }).bundle_products : {}),
        bundle_lie: Number((topBundleRow as { lie_bundle?: unknown } | null)?.lie_bundle ?? 0),
        bundle_probability: Number((topBundleRow as { p_bundle?: unknown } | null)?.p_bundle ?? 0),
        bundle_incremental_margin: Number((topBundleRow as { m_bundle?: unknown } | null)?.m_bundle ?? 0),
        best_individual_lie: 0,
        diagnostic_questions: plan.diagnostic_questions ?? [], implication_question: plan.implication_question ?? '',
        offer_transition: plan.offer_transition ?? '', probable_objections: plan.probable_objections ?? [],
        approach_strategy: plan.approach_strategy ?? '', approach_strategy_b: plan.approach_strategy_b ?? '',
        ltv_projection: plan.ltv_projection ?? null, expected_result: plan.expected_result ?? null,
        operational_risks: plan.operational_risks ?? [], status: 'gerado',
      }).select('id').single();
      return new Response(JSON.stringify({ id: ins?.id, generated: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
```

- [ ] **Step 5: Verificação manual (sem teste automatizado de edge).** Após deploy (rollout), `curl` com cron-secret + `{customerId, farmerId, planType:'estrategico'}` p/ 1 cliente conhecido → confere `{generated:true, id}` e `farmer_tactical_plans` populado com `offer_transition` preenchido. Rodar 2× → 2ª vez `{skipped:'ja_gerado_hoje'}`. Documentar no PR.
- [ ] **Step 6: Commit** — `git commit -m "feat(fase2): generate-tactical-plan ganha modo self-contained (cron) + grava"`

---

## Task 3: Edge cron `tactical-plans-batch`

**Files:** Create `supabase/functions/tactical-plans-batch/index.ts`

Molde: `supabase/functions/scoring-recalc-batch/index.ts` (auth, paginação `.range()`, fan-out concorrente com `x-cron-secret`).

- [ ] **Step 1: Implementar a edge**

```ts
import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';

// Espelha src/lib/tactical/pregeracao.ts (oráculo testado por vitest).
const PROFIT_PER_HOUR_THRESHOLD = 50;
const profitPerHora = (rev: number, avg: number, m: number) => ((rev > 0 ? rev : avg) * (m / 100) * 0.1) / (15 / 60);
const TOP_N = 25;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const selfUrl = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/generate-tactical-plan`;
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';

  // 1. Universo: farmer_client_scores elegíveis (carteira já limpa de fornecedor pela Fase 1).
  //    Pagina (a carteira tem milhares) e agrupa por farmer_id.
  const porFarmer = new Map<string, Array<{ customer: string; priority: number; rev: number; avg: number; m: number }>>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('farmer_client_scores')
      .select('farmer_id, customer_user_id, priority_score, revenue_potential, avg_monthly_spend_180d, gross_margin_pct')
      .order('farmer_id', { ascending: true }).range(from, from + 999);
    if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const rows = data ?? [];
    for (const r of rows) {
      const arr = porFarmer.get(r.farmer_id) ?? [];
      arr.push({ customer: r.customer_user_id, priority: Number(r.priority_score ?? 0), rev: Number(r.revenue_potential ?? 0), avg: Number(r.avg_monthly_spend_180d ?? 0), m: Number(r.gross_margin_pct ?? 0) });
      porFarmer.set(r.farmer_id, arr);
    }
    if (rows.length < 1000) break;
  }

  // 2. Por farmer: top-N por priority que passam no gate. Achata em alvos {farmer, customer}.
  const alvos: Array<{ farmer: string; customer: string }> = [];
  for (const [farmer, scores] of porFarmer) {
    scores.sort((a, b) => b.priority - a.priority);
    let n = 0;
    for (const s of scores) {
      if (n >= TOP_N) break;
      if (profitPerHora(s.rev, s.avg, s.m) < PROFIT_PER_HOUR_THRESHOLD) continue;
      alvos.push({ farmer, customer: s.customer }); n++;
    }
  }

  // 3. Fan-out concorrente (chunks de 5 — cada chamada faz 1 LLM, ~3-5s). Idempotência é na edge alvo.
  const CONCURRENCY = 5;
  let gerados = 0, pulados = 0, erros = 0;
  for (let i = 0; i < alvos.length; i += CONCURRENCY) {
    const chunk = alvos.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (a) => {
      try {
        const r = await fetch(selfUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
          body: JSON.stringify({ customerId: a.customer, farmerId: a.farmer, planType: 'estrategico' }),
        });
        const j = await r.json().catch(() => ({}));
        if (j.generated) gerados++; else if (j.skipped) pulados++; else erros++;
      } catch { erros++; }
    }));
  }

  return new Response(JSON.stringify({ ok: true, farmers: porFarmer.size, alvos: alvos.length, gerados, pulados, erros }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
```

- [ ] **Step 2: Verificação manual.** Após deploy: invocar `tactical-plans-batch` com `x-cron-secret` → confere `{ok:true, alvos, gerados}`; rodar 2× no mesmo dia → 2ª vez `gerados:0, pulados:N`.
- [ ] **Step 3: Commit** — `git commit -m "feat(fase2): edge cron tactical-plans-batch (top-25 por farmer, gate R\$/h)"`

---

## Task 4: `ActivePlanCard` — oferta + gancho em destaque

**Files:** Modify `src/components/farmer/copilot/ActivePlanCard.tsx`

Hoje mostra objetivo/HS/churn/approach/2 perguntas, **colapsado**. Passa a abrir num bloco de **oferta** sempre visível; a tática vai pro expandir.

- [ ] **Step 1: Helper de nomes do bundle.** O `topBundle` é `BundleSnapshot` (Record dinâmico) com `bundle_products` (array). Extrair os nomes:

```tsx
function nomesDoBundle(b: Record<string, unknown> | undefined): string[] {
  const prods = (b?.bundle_products ?? b?.products) as Array<{ name?: string; nome?: string; descricao?: string }> | undefined;
  return Array.isArray(prods) ? prods.map((p) => p.name || p.nome || p.descricao || '').filter(Boolean) : [];
}
```

- [ ] **Step 2: Renderizar a oferta no topo (sempre visível), tática no expandir.** Substituir o corpo do card:

```tsx
  const produtos = nomesDoBundle(activePlan.topBundle);
  const temOferta = produtos.length > 0 || !!activePlan.offerTransition;
  return (
    <Card className="border-dashed border-primary/30">
      <CardContent className="p-3 space-y-2">
        {temOferta && (
          <div className="space-y-1">
            {produtos.length > 0 && (
              <p className="text-[11px] font-semibold leading-tight">💡 Ofereça: {produtos.join(' + ')}</p>
            )}
            {activePlan.offerTransition && (
              <p className="text-[10px] text-muted-foreground italic">"{activePlan.offerTransition}"</p>
            )}
            <div className="flex gap-1.5">
              {activePlan.bundleIncrementalMargin > 0 && <Badge variant="outline" className="text-[7px]">+R$ {Math.round(activePlan.bundleIncrementalMargin)}/mês</Badge>}
              {activePlan.bundleProbability > 0 && <Badge variant="outline" className="text-[7px]">{Math.round(activePlan.bundleProbability * 100)}% aceite</Badge>}
            </div>
          </div>
        )}
        <div className="flex items-center justify-between" onClick={onToggle} role="button">
          <div className="flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-primary" />
            <span className="text-[10px] font-semibold">Tática — {activePlan.planType === 'estrategico' ? 'Estratégico' : 'Essencial'}</span>
          </div>
          {showPlan ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </div>
        {showPlan && (
          <div className="space-y-1.5 text-[9px]">
            <div className="flex gap-1.5">
              <Badge variant="outline" className="text-[7px]">{getObjectiveLabel(activePlan.strategicObjective)}</Badge>
              <Badge variant="outline" className="text-[7px]">HS: {Math.round(activePlan.healthScore)}</Badge>
              <Badge variant="outline" className="text-[7px]">Churn: {Math.round(activePlan.churnRisk)}%</Badge>
            </div>
            {activePlan.approachStrategy && <p className="text-muted-foreground">{activePlan.approachStrategy}</p>}
            {activePlan.diagnosticQuestions.slice(0, 2).map((q, i) => <p key={i} className="text-muted-foreground">• {q.question}</p>)}
          </div>
        )}
      </CardContent>
    </Card>
  );
```

- [ ] **Step 3: Verificação** — `heavy bun run typecheck` PASS; verificação visual no preview (oferta no topo, tática recolhe).
- [ ] **Step 4: Commit** — `git commit -m "feat(fase2): ActivePlanCard destaca oferta + gancho no topo"`

---

## Task 5: Fallback "oferta crua" (cliente sem plano pré-gerado)

**Files:** Create `src/components/farmer/copilot/OfertaCruaCard.tsx` + Modify `src/components/farmer/copilot/useFarmerCopilot.ts`

Quando `getActivePlan` retorna `null`, mostrar o top bundle de `farmer_bundle_recommendations` (sem gancho de IA).

- [ ] **Step 1: Componente** (`OfertaCruaCard.tsx`)

```tsx
import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';

export function OfertaCruaCard({ customerId, farmerId }: { customerId: string; farmerId: string }) {
  const [produtos, setProdutos] = useState<string[]>([]);
  const [margem, setMargem] = useState(0);
  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data } = await supabase.from('farmer_bundle_recommendations')
        .select('bundle_products, m_bundle').eq('customer_user_id', customerId).eq('farmer_id', farmerId)
        .eq('status', 'pendente').order('lie_bundle', { ascending: false }).limit(1).maybeSingle();
      if (!ativo || !data) return;
      const prods = (data.bundle_products as Array<{ name?: string; nome?: string }> | null) ?? [];
      setProdutos(prods.map((p) => p.name || p.nome || '').filter(Boolean));
      setMargem(Number(data.m_bundle ?? 0));
    })();
    return () => { ativo = false; };
  }, [customerId, farmerId]);
  if (produtos.length === 0) return null;
  return (
    <Card className="border-dashed border-muted-foreground/30">
      <CardContent className="p-3 space-y-1">
        <p className="text-[11px] font-semibold leading-tight">💡 Ofereça: {produtos.join(' + ')}</p>
        {margem > 0 && <Badge variant="outline" className="text-[7px]">+R$ {Math.round(margem)}/mês</Badge>}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Renderizar no copilot.** Em `useFarmerCopilot`/seu componente de exibição, onde hoje o `ActivePlanCard` só aparece com `activePlan`: quando `activePlan` for `null` e houver `selectedCustomer`, renderizar `<OfertaCruaCard customerId={selectedCustomer} farmerId={user.id} />`. (Confirmar o ponto de render no componente pai do copilot — onde `activePlan`/`ActivePlanCard` é consumido.)
- [ ] **Step 3: Verificação** — typecheck PASS; visual: cliente sem plano mostra a oferta crua.
- [ ] **Step 4: Commit** — `git commit -m "feat(fase2): fallback de oferta crua p/ cliente sem plano pré-gerado"`

---

## Task 6: Índice + Rollout (manual no Lovable)

**Files:** Create `supabase/migrations/20260615120000_idx_tactical_plans_lookup.sql`

- [ ] **Step 1: Migration do índice** (acelera `getActivePlan` + a checagem de idempotência)

```sql
CREATE INDEX IF NOT EXISTS idx_tactical_plans_lookup
  ON public.farmer_tactical_plans (farmer_id, customer_user_id, status, created_at DESC);
SELECT 'IDX OK' AS status,
  (SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_tactical_plans_lookup') AS idx;
```

- [ ] **Step 2: Commit** — `git commit -m "feat(fase2): índice de lookup de farmer_tactical_plans"`
- [ ] **Step 3 (rollout manual, NA ORDEM):**
  1. **Migration** do índice no SQL Editor → `idx = 1`.
  2. **Deploy** das edges via chat do Lovable (verbatim da main): `generate-tactical-plan` (modo self-contained) + `tactical-plans-batch` (nova).
  3. **Smoke test** (Task 2 Step 5 + Task 3 Step 2) com cron-secret.
  4. **Cron** no SQL Editor — `net.http_post` com `timeout_milliseconds` explícito (default 5s mata silencioso):
     ```sql
     SELECT cron.schedule('tactical-plans-batch-nightly', '0 4 * * *',
       $$ SELECT net.http_post(
            url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/tactical-plans-batch',
            headers := jsonb_build_object('x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
            timeout_milliseconds := 280000
          ); $$);
     ```
  5. **Publish** do front (ActivePlanCard + OfertaCruaCard).
  6. **Verificação D+1:** de manhã, abrir `/farmer/calls`, selecionar um cliente top-da-agenda → oferta+gancho aparece; selecionar um da cauda → oferta crua.

---

## Self-Review

- **Spec coverage:** §4.1 pré-geração→T2/T3; §4.2 card→T4; §4.3 fallback→T5; §6 custo (top-25+gate)→T1/T3; §7 frescor (idempotência hoje)→T2.Step2; §9 testes (helper puro)→T1; §10 rollout→T6; §12a (montagem server-side)→T2; §12b (gate por farmer server-side)→T3 (sem `user.id`, usa `farmer_id`). ✅
- **Placeholders:** helper/card/fallback/batch têm código real; o port da montagem (T2) referencia o código-fonte exato (`useTacticalPlan.ts:328-467`) com as adaptações inline. T5.Step2 pede confirmar o ponto de render no componente pai do copilot (não mapeado neste plano) — único ponto a confirmar na execução.
- **Type consistency:** `offerTransition`/`topBundle`/`bundleIncrementalMargin`/`bundleProbability` (TacticalPlan, useTacticalPlan.ts:36-41) usados idênticos no card; `farmer_tactical_plans` colunas iguais às do INSERT do front (useTacticalPlan.ts:432-461). `PROFIT_PER_HOUR_THRESHOLD=50` idêntico no helper, na edge batch e no front.
- **Risco aberto:** o modo self-contained (T2) é money-path-adjacent (gera plano, não dinheiro direto) e não tem teste de edge automatizado — mitigado pelo smoke test 2× (idempotência) + o helper puro (T1) como oráculo da seleção. Confirmar antes de deploy que `farmer_copilot_events.event_data.intent` existe (objeções históricas) — se ausente, `historicalObjections=[]` (degrada sem quebrar).
