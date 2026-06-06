# Sync de andamento afiação → etapa da OS no Omie (Colacor SC) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando um pedido de afiação muda de status, a etapa (`cEtapa`) da Ordem de Serviço correspondente no Omie da Colacor SC acompanha automaticamente, de forma confiável.

**Architecture:** Trigger no `orders` (AFTER UPDATE OF status) calcula a etapa-alvo e, **só se a etapa mudou**, faz upsert numa fila (`afiacao_os_sync_fila`, 1 linha/pedido). Um cron `*/5` cutuca a edge `omie-sync` (action nova `sync_os_status`, cron-authed), que drena a fila e chama `AlterarOS` **status-only** no Omie (troca só `cEtapa`, sem reenviar serviços). Idempotência via `omie_ordens_servico.last_etapa_sincronizada`; backoff no Omie flaky.

**Tech Stack:** TS puro (vitest), Postgres (pg_cron + pg_net + Vault), Supabase Edge Function (Deno), Omie REST API (`servicos/os/`).

**Pré-requisitos de leitura:** spec em `docs/superpowers/specs/2026-06-05-afiacao-os-status-sync-design.md`. Contexto do backend manual: `CLAUDE.md` §5 (Lovable SQL Editor, migration manual, redeploy de edge via chat).

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `src/lib/afiacao/os-etapa.ts` (criar) | **Fonte da verdade** do mapa status→etapa: `mapearStatusEtapa(status): string \| null`. |
| `src/lib/afiacao/__tests__/os-etapa.test.ts` (criar) | Testes vitest do mapa (oráculo do SQL e da edge). |
| `supabase/migrations/20260605120000_afiacao_os_status_sync.sql` (criar) | Fila + RLS + colunas em `omie_ordens_servico` + `mapear_status_etapa` (SQL) + trigger de enqueue + `afiacao_os_sync_kick` + cron. **Aplicada à mão pelo founder.** |
| `supabase/functions/omie-sync/index.ts` (modificar) | Adicionar `mapearStatusEtapa` (espelho), `alterarEtapaOS`, `processarItemFilaOsSync`, e o `case "sync_os_status"`. **NÃO tocar** em `alterarOrdemServicoOmie`, `update_order`, `sync_order`. |
| `data_health_watchdog` / `_data_health_compute` | **Task 5, OPCIONAL/fast-follow** — check `afiacao_os_sync`. PR separado (arquivo HOT multi-sessão, ver CLAUDE.md). |

**Regra de paridade (DRY entre 3 runtimes):** o mapa status→etapa vive em 3 lugares (TS helper, função SQL, função na edge Deno) porque cada runtime é isolado. Os três DEVEM ser idênticos. O `os-etapa.ts` (Task 1) é a fonte; Tasks 2 e 3 copiam **verbatim**.

---

## Task 1: Helper `mapearStatusEtapa` (TS puro, TDD)

**Files:**
- Create: `src/lib/afiacao/os-etapa.ts`
- Test: `src/lib/afiacao/__tests__/os-etapa.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/lib/afiacao/__tests__/os-etapa.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapearStatusEtapa } from '../os-etapa';

describe('mapearStatusEtapa', () => {
  it('status iniciais → etapa 10 (Aberta)', () => {
    expect(mapearStatusEtapa('pedido_recebido')).toBe('10');
    expect(mapearStatusEtapa('aguardando_coleta')).toBe('10');
    expect(mapearStatusEtapa('orcamento_enviado')).toBe('10');
    expect(mapearStatusEtapa('aprovado')).toBe('10');
  });

  it('status em produção → etapa 20 (Em andamento)', () => {
    expect(mapearStatusEtapa('em_triagem')).toBe('20');
    expect(mapearStatusEtapa('em_afiacao')).toBe('20');
    expect(mapearStatusEtapa('controle_qualidade')).toBe('20');
  });

  it('status de saída → etapa 30 (Aguardando faturamento)', () => {
    expect(mapearStatusEtapa('pronto_entrega')).toBe('30');
    expect(mapearStatusEtapa('em_rota')).toBe('30');
  });

  it('entregue → null (mantém a OS como está, founder é dono do faturamento)', () => {
    expect(mapearStatusEtapa('entregue')).toBeNull();
  });

  it('status desconhecido/vazio → null (fail-safe, não sincroniza)', () => {
    expect(mapearStatusEtapa('qualquer_coisa')).toBeNull();
    expect(mapearStatusEtapa('')).toBeNull();
    expect(mapearStatusEtapa('rascunho')).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `cd /Users/lucassardenberg/Projetos/afiacao-afiacao-os-status-sync && bun run test src/lib/afiacao/__tests__/os-etapa.test.ts`
Expected: FAIL — `Cannot find module '../os-etapa'` (arquivo ainda não existe).

- [ ] **Step 3: Implementar o helper**

Criar `src/lib/afiacao/os-etapa.ts`:

```ts
/**
 * Mapa status do pedido de afiação → etapa (cEtapa) da Ordem de Serviço no Omie (Colacor SC).
 *
 * FONTE DA VERDADE deste mapa. Espelhado VERBATIM em:
 *   - supabase/migrations/20260605120000_afiacao_os_status_sync.sql  (função mapear_status_etapa)
 *   - supabase/functions/omie-sync/index.ts                          (função mapearStatusEtapa)
 * Qualquer mudança aqui tem que ser replicada nos dois.
 *
 * Etapas Omie: 10 Aberta · 20 Em andamento · 30 Aguardando faturamento.
 * `null` = NÃO sincroniza (mantém a OS como está). 'entregue' e qualquer status
 * desconhecido caem em null de propósito: o app sincroniza só o andamento
 * operacional (10→20→30) e nunca sobrescreve etapa pós-entrega / faturamento manual.
 */
export function mapearStatusEtapa(status: string): string | null {
  switch (status) {
    case 'pedido_recebido':
    case 'aguardando_coleta':
    case 'orcamento_enviado':
    case 'aprovado':
      return '10';
    case 'em_triagem':
    case 'em_afiacao':
    case 'controle_qualidade':
      return '20';
    case 'pronto_entrega':
    case 'em_rota':
      return '30';
    default:
      // 'entregue' + qualquer desconhecido → mantém a OS como está
      return null;
  }
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `bun run test src/lib/afiacao/__tests__/os-etapa.test.ts`
Expected: PASS — 5 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/afiacao/os-etapa.ts src/lib/afiacao/__tests__/os-etapa.test.ts
git commit -m "feat(afiacao): helper mapearStatusEtapa (mapa status→etapa OS Omie)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Migration SQL (fila + colunas + mapa + trigger + cron)

> **Backend é manual via Lovable** (CLAUDE.md §5). Esta task **cria o arquivo** de migration (vai pro repo/histórico) e **prepara o bloco inline** que o founder cola no SQL Editor. O arquivo NÃO é aplicado automaticamente. Não há `supabase db push` aqui.

**Files:**
- Create: `supabase/migrations/20260605120000_afiacao_os_status_sync.sql`

- [ ] **Step 1: Confirmar que o timestamp não colide**

Run: `git -C /Users/lucassardenberg/Projetos/afiacao-afiacao-os-status-sync log origin/main --oneline -15 -- supabase/migrations/ && ls supabase/migrations/ | tail -5 && gh pr list --state open --json files -q '.[].files[].path' | grep -i 'migrations/' || true`
Expected: nenhuma migration `20260605120000_*` existente nem em PR aberto. Se colidir, bumpar pra `20260605130000` (e ajustar o nome do arquivo + a referência na Task 4).

- [ ] **Step 2: Criar o arquivo de migration**

Criar `supabase/migrations/20260605120000_afiacao_os_status_sync.sql`:

```sql
-- Sync de andamento: pedido de afiação (public.orders) → etapa (cEtapa) da OS no Omie (Colacor SC).
-- A integração que CRIA a OS já existe (omie-sync sync_order). Aqui ligamos a ATUALIZAÇÃO de etapa,
-- que era dormente. Abordagem B (spec 2026-06-05): trigger → fila → cron → edge cron-authed.
-- Backend aplicado À MÃO via Lovable SQL Editor (founder não tem terminal). Idempotente.

-- 1) Fila (upsert por order_id: 1 linha/pedido, sempre o alvo mais novo).
CREATE TABLE IF NOT EXISTS public.afiacao_os_sync_fila (
  order_id      uuid PRIMARY KEY,
  etapa_alvo    text NOT NULL,
  status_app    text NOT NULL,
  tentativas    int NOT NULL DEFAULT 0,
  next_retry_em timestamptz NOT NULL DEFAULT now(),
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_afiacao_os_sync_fila_retry
  ON public.afiacao_os_sync_fila (next_retry_em);

-- RLS: service_role bypassa (trigger SECURITY DEFINER + edge service_role escrevem).
-- Sem policy de write → authenticated/anon NÃO escrevem. Staff LÊ (debug).
ALTER TABLE public.afiacao_os_sync_fila ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_le_afiacao_os_sync_fila" ON public.afiacao_os_sync_fila;
CREATE POLICY "staff_le_afiacao_os_sync_fila" ON public.afiacao_os_sync_fila
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

-- 2) Colunas de observabilidade/idempotência em omie_ordens_servico.
ALTER TABLE public.omie_ordens_servico
  ADD COLUMN IF NOT EXISTS last_etapa_sincronizada text,
  ADD COLUMN IF NOT EXISTS last_status_sincronizado text,
  ADD COLUMN IF NOT EXISTS last_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sync_error text;

-- 3) Mapa status→etapa (ESPELHA verbatim src/lib/afiacao/os-etapa.ts).
CREATE OR REPLACE FUNCTION public.mapear_status_etapa(p_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_status
    WHEN 'pedido_recebido'    THEN '10'
    WHEN 'aguardando_coleta'  THEN '10'
    WHEN 'orcamento_enviado'  THEN '10'
    WHEN 'aprovado'           THEN '10'
    WHEN 'em_triagem'         THEN '20'
    WHEN 'em_afiacao'         THEN '20'
    WHEN 'controle_qualidade' THEN '20'
    WHEN 'pronto_entrega'     THEN '30'
    WHEN 'em_rota'            THEN '30'
    ELSE NULL  -- 'entregue' + desconhecido → mantém a OS como está
  END;
$$;

-- 4) Trigger de enqueue: só enfileira se a etapa-alvo mudou E não é null.
CREATE OR REPLACE FUNCTION public.afiacao_os_enqueue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_etapa_nova  text := public.mapear_status_etapa(NEW.status);
  v_etapa_velha text := public.mapear_status_etapa(OLD.status);
BEGIN
  IF v_etapa_nova IS NOT NULL AND v_etapa_nova IS DISTINCT FROM v_etapa_velha THEN
    INSERT INTO public.afiacao_os_sync_fila
      (order_id, etapa_alvo, status_app, tentativas, next_retry_em, criado_em, atualizado_em)
    VALUES (NEW.id, v_etapa_nova, NEW.status, 0, now(), now(), now())
    ON CONFLICT (order_id) DO UPDATE SET
      etapa_alvo    = EXCLUDED.etapa_alvo,
      status_app    = EXCLUDED.status_app,
      tentativas    = 0,
      next_retry_em = now(),
      atualizado_em = now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_afiacao_os_enqueue ON public.orders;
CREATE TRIGGER trg_afiacao_os_enqueue
  AFTER UPDATE OF status ON public.orders
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.afiacao_os_enqueue();

-- 5) Kick do cron: cutuca a edge se há pendentes (idle barato). Auth via x-cron-secret do Vault.
CREATE OR REPLACE FUNCTION public.afiacao_os_sync_kick()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cron_secret text;
  v_request_id  bigint;
  v_pendentes   int;
  v_url constant text := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync';
BEGIN
  SELECT count(*) INTO v_pendentes
  FROM public.afiacao_os_sync_fila
  WHERE next_retry_em <= now();

  IF v_pendentes = 0 THEN
    RETURN jsonb_build_object('pendentes', 0);
  END IF;

  SELECT decrypted_secret INTO v_cron_secret
  FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1;

  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_cron_secret),
    body := jsonb_build_object('action', 'sync_os_status'),
    timeout_milliseconds := 60000
  ) INTO v_request_id;

  RETURN jsonb_build_object('pendentes', v_pendentes, 'request_id', v_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.afiacao_os_sync_kick() FROM anon, authenticated, PUBLIC;

SELECT cron.schedule('afiacao-os-sync', '*/5 * * * *',
  $cron$ SELECT public.afiacao_os_sync_kick(); $cron$);
```

- [ ] **Step 3: Commit do arquivo de migration**

```bash
git add supabase/migrations/20260605120000_afiacao_os_status_sync.sql
git commit -m "feat(db): migration do sync de etapa da OS (fila+trigger+cron) — apply manual

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Regenerar o audit de migrations**

Run: `bun run audit:migrations`
Expected: regenera `docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql` incluindo a nova migration. Commitar se mudou:
```bash
git add docs/migrations-audit.md scripts/audit-custom-migrations.sql 2>/dev/null && git commit -m "chore: regen audit de migrations" || echo "nada a commitar"
```

- [ ] **Step 5: Preparar o bloco de validação pós-apply (pro founder, na Task 4)**

Guardar esta query (vai pro corpo do PR + entrega na conversa). É read-only, roda no SQL Editor depois do apply:

```sql
SELECT 'AFIACAO OS SYNC OK' AS status,
  (SELECT count(*) FROM information_schema.tables
     WHERE table_schema='public' AND table_name='afiacao_os_sync_fila') AS tem_fila,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='omie_ordens_servico'
       AND column_name IN ('last_etapa_sincronizada','last_status_sincronizado','last_sync_at','last_sync_error')) AS colunas_4,
  public.mapear_status_etapa('em_afiacao') AS deve_ser_20,
  public.mapear_status_etapa('entregue')   AS deve_ser_null,
  (SELECT count(*) FROM pg_trigger WHERE tgname='trg_afiacao_os_enqueue') AS tem_trigger,
  (SELECT count(*) FROM cron.job WHERE jobname='afiacao-os-sync') AS tem_cron;
-- esperado: tem_fila=1, colunas_4=4, deve_ser_20='20', deve_ser_null=NULL, tem_trigger=1, tem_cron=1
```

---

## Task 3: Edge `omie-sync` — action `sync_os_status` + `alterarEtapaOS`

> **NÃO** modificar `alterarOrdemServicoOmie`, `update_order`, `sync_order`, nem `callOmieApi`. Só **adicionar** funções novas e um `case` novo. Deploy via chat do Lovable é manual, DEPOIS do merge (Task 4).

**Files:**
- Modify: `supabase/functions/omie-sync/index.ts`

- [ ] **Step 1: Adicionar o mapa (espelho da Task 1) logo antes de `serve(`**

Localizar a linha `serve(async (req) => {` (~linha 599) e inserir ANTES dela:

```ts
// Espelho VERBATIM de src/lib/afiacao/os-etapa.ts (e da SQL mapear_status_etapa).
// 10 Aberta · 20 Em andamento · 30 Aguardando faturamento · null = mantém (não sincroniza).
function mapearStatusEtapa(status: string): string | null {
  switch (status) {
    case "pedido_recebido":
    case "aguardando_coleta":
    case "orcamento_enviado":
    case "aprovado":
      return "10";
    case "em_triagem":
    case "em_afiacao":
    case "controle_qualidade":
      return "20";
    case "pronto_entrega":
    case "em_rota":
      return "30";
    default:
      return null; // 'entregue' + desconhecido
  }
}

/**
 * AlterarOS status-only: troca SÓ a etapa da OS, sem reenviar serviços/preços do app
 * (preserva ajustes manuais feitos na OS dentro do Omie). Envia apenas o Cabecalho
 * (atualização parcial). NÃO reusa alterarOrdemServicoOmie (aquele remonta serviços).
 */
async function alterarEtapaOS(
  nCodOS: number,
  etapaAlvo: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await callOmieApi("servicos/os/", "AlterarOS", {
      Cabecalho: { nCodOS: nCodOS, cEtapa: etapaAlvo },
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Erro AlterarOS" };
  }
}

/**
 * Processa 1 item da fila de sync de etapa. Recalcula a etapa do status ATUAL
 * (não confia na fila velha), aplica idempotência e backoff. Devolve um resumo.
 */
async function processarItemFilaOsSync(
  supabaseAdmin: SupabaseClient,
  orderId: string,
  tentativas: number
): Promise<Record<string, unknown>> {
  const removerDaFila = () =>
    supabaseAdmin.from("afiacao_os_sync_fila").delete().eq("order_id", orderId);

  // 1) status atual do pedido
  const { data: ord } = await supabaseAdmin
    .from("orders").select("status").eq("id", orderId).maybeSingle();
  if (!ord) {
    await removerDaFila();
    return { order_id: orderId, skip: "pedido_inexistente" };
  }
  const etapaAtual = mapearStatusEtapa(ord.status as string);

  // 2) etapa null (ex.: entregue) → noop, sai da fila
  if (etapaAtual === null) {
    await removerDaFila();
    return { order_id: orderId, noop: "sem_etapa" };
  }

  // 3) acha a OS no Omie
  const { data: os } = await supabaseAdmin
    .from("omie_ordens_servico")
    .select("omie_codigo_os, last_etapa_sincronizada")
    .eq("order_id", orderId).maybeSingle();

  if (!os?.omie_codigo_os) {
    // OS pode estar sendo criada → erro recuperável (backoff), mantém na fila
    return await bumpRetryOsSync(supabaseAdmin, orderId, tentativas, "sem_os");
  }

  // 4) idempotência
  if (etapaAtual === os.last_etapa_sincronizada) {
    await removerDaFila();
    return { order_id: orderId, noop: "ja_sincronizado" };
  }

  // 5) AlterarOS status-only
  const r = await alterarEtapaOS(os.omie_codigo_os as number, etapaAtual);
  if (r.success) {
    await supabaseAdmin.from("omie_ordens_servico").update({
      last_etapa_sincronizada: etapaAtual,
      last_status_sincronizado: ord.status,
      last_sync_at: new Date().toISOString(),
      last_sync_error: null,
      status: "atualizado",
      updated_at: new Date().toISOString(),
    }).eq("order_id", orderId);
    await removerDaFila();
    return { order_id: orderId, ok: etapaAtual };
  }
  return await bumpRetryOsSync(supabaseAdmin, orderId, tentativas, r.error || "erro_omie");
}

/** Backoff exponencial (teto 30min). 6 tentativas → desiste e marca erro persistente. */
async function bumpRetryOsSync(
  supabaseAdmin: SupabaseClient,
  orderId: string,
  tentativas: number,
  erro: string
): Promise<Record<string, unknown>> {
  const novasTent = (tentativas ?? 0) + 1;
  if (novasTent >= 6) {
    await supabaseAdmin.from("afiacao_os_sync_fila").delete().eq("order_id", orderId);
    await supabaseAdmin.from("omie_ordens_servico").update({
      last_sync_error: erro, status: "erro_atualizacao", updated_at: new Date().toISOString(),
    }).eq("order_id", orderId);
    return { order_id: orderId, erro_persistente: erro };
  }
  const backoffMin = Math.min(Math.pow(2, novasTent), 30);
  await supabaseAdmin.from("afiacao_os_sync_fila").update({
    tentativas: novasTent,
    next_retry_em: new Date(Date.now() + backoffMin * 60000).toISOString(),
    atualizado_em: new Date().toISOString(),
  }).eq("order_id", orderId);
  await supabaseAdmin.from("omie_ordens_servico")
    .update({ last_sync_error: erro }).eq("order_id", orderId);
  return { order_id: orderId, retry: novasTent, em_min: backoffMin };
}
```

> Nota: `SupabaseClient` já é importado/tipado no arquivo (usado por `alterarOrdemServicoOmie`). Se o `deno check` reclamar do tipo, reusar o mesmo import que `alterarOrdemServicoOmie` usa.

- [ ] **Step 2: Adicionar o `case "sync_os_status"` no switch**

Localizar o `switch (action) {` (~linha 627) e adicionar este case (pode ser logo após `case "update_order":` fechar, antes de `case "sync_services":`):

```ts
      case "sync_os_status": {
        // Cron-only: drena a fila afiacao_os_sync_fila e sincroniza a etapa de cada OS.
        if (auth.via !== "cron" && auth.via !== "service_role") {
          return new Response(
            JSON.stringify({ error: "Apenas cron pode sincronizar etapas de OS" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const { data: fila } = await supabaseAdmin
          .from("afiacao_os_sync_fila")
          .select("order_id, tentativas")
          .lte("next_retry_em", new Date().toISOString())
          .order("criado_em", { ascending: true })
          .limit(25);

        const detalhes: Record<string, unknown>[] = [];
        for (const item of fila ?? []) {
          detalhes.push(
            await processarItemFilaOsSync(
              supabaseAdmin,
              item.order_id as string,
              (item.tentativas as number) ?? 0
            )
          );
        }

        result = { processados: detalhes.length, detalhes };
        break;
      }
```

- [ ] **Step 3: Type-check da edge (se o Deno estiver disponível)**

Run: `command -v deno >/dev/null && deno check supabase/functions/omie-sync/index.ts 2>&1 | tail -20 || echo "deno ausente — pular (Lovable valida no deploy)"`
Expected: sem novos erros (o erro-set tem que ficar igual ao de antes da edição; se `deno` ausente, seguir — a validação real é o deploy no Lovable + QA do founder).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/omie-sync/index.ts
git commit -m "feat(omie-sync): action sync_os_status + alterarEtapaOS (status-only)

Drena afiacao_os_sync_fila e sincroniza só a cEtapa da OS (sem reenviar serviços).
Idempotência via last_etapa_sincronizada, backoff no Omie flaky. Não toca nas
funções existentes (alterarOrdemServicoOmie/update_order/sync_order).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Validação final + PR + handoff Lovable

**Files:** nenhum novo (validação + entrega).

- [ ] **Step 1: Validação local completa**

Run (prefixar com `heavy` se houver sessões paralelas):
```bash
cd /Users/lucassardenberg/Projetos/afiacao-afiacao-os-status-sync
bun run typecheck && bun lint && bun run test && bun run build
```
Expected: typecheck EXIT=0 · lint 0 errors · suíte verde (incl. os 5 testes de `os-etapa`) · build ✓.

- [ ] **Step 2: Push + abrir PR**

```bash
git push -u origin afiacao-os-status-sync
gh pr create --base main --head afiacao-os-status-sync \
  --title "feat(afiação): sincroniza etapa da OS no Omie (Colacor SC) quando o pedido anda" \
  --body "<corpo abaixo>"
```

Corpo do PR (inclui o **handoff manual obrigatório** + o SQL inline + a validação):

```markdown
## O que faz
Quando um pedido de afiação muda de status, a **etapa (cEtapa)** da OS correspondente
no Omie da **Colacor SC** acompanha automaticamente. A integração que CRIA a OS já
existia; isto liga a ATUALIZAÇÃO de etapa (que era dormente).

Abordagem B (spec `docs/superpowers/specs/2026-06-05-afiacao-os-status-sync-design.md`):
trigger no `orders` → fila → cron `*/5` → edge `omie-sync` action `sync_os_status` →
`AlterarOS` **status-only** (troca só a etapa, preserva os serviços que estão no Omie).

Mapa: 10 Aberta · 20 Em andamento · 30 Aguardando faturamento · **entregue = mantém**
(não marca "Faturada" — faturamento é manual). Idempotência via `last_etapa_sincronizada`,
backoff no Omie flaky.

## ⚠️ ATENÇÃO: migration manual + redeploy de edge necessários
1. **SQL Editor do Lovable** → colar o bloco abaixo → Run → confirmar a query de validação.
2. **Chat do Lovable** → deployar `supabase/functions/omie-sync/index.ts` (ler da main, deploy verbatim) — DEPOIS do merge.

### BLOCO — migration (colar no SQL Editor)
\`\`\`sql
<colar aqui o conteúdo de supabase/migrations/20260605120000_afiacao_os_status_sync.sql>
\`\`\`

### Validação (rodar depois do apply)
\`\`\`sql
<colar aqui a query de validação do Step 5 da Task 2>
\`\`\`
Esperado: tem_fila=1, colunas_4=4, deve_ser_20='20', deve_ser_null=NULL, tem_trigger=1, tem_cron=1.

## QA pós-deploy (founder)
Mover um pedido de afiação de teste no kanban (ex.: `aguardando_coleta` → `em_afiacao`)
e, ~5min depois, conferir no Omie da Colacor SC que a OS foi pra "Em andamento" (etapa 20),
cruzando com `SELECT order_id, last_etapa_sincronizada, last_sync_at, last_sync_error FROM omie_ordens_servico WHERE order_id='<id>'`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 3: Armar auto-merge**

Run: `gh pr merge --squash --auto`
Expected: auto-merge armado; mergeia sozinho quando o check `validate` passar (~3min). NÃO usar `--admin`.

- [ ] **Step 4: Entregar o handoff ao founder na conversa**

Entregar, em pt-BR: (1) o **bloco SQL único** da migration pra colar no SQL Editor (fenced ```sql, fechando a tag em linha própria — preferência do founder, CLAUDE.md §5), (2) a query de validação, (3) o lembrete de **deployar a `omie-sync` via chat do Lovable depois do merge** (ler da main, verbatim), (4) o QA pós-deploy. Avisar que o sync só funciona depois dos DOIS passos manuais.

- [ ] **Step 5: Probe do `AlterarOS` (a confirmar com o founder no QA)**

O `alterarEtapaOS` manda **só `Cabecalho: { nCodOS, cEtapa }`** (atualização parcial — caminho mais limpo). Se o QA pós-deploy mostrar o Omie rejeitando com faultstring de "campo obrigatório"/"preenchimento da tag", aplicar a contingência (follow-up curto): em `alterarEtapaOS`, no catch desse erro específico, fazer `ConsultarOS(nCodOS)` e reenviar `AlterarOS` preservando `ServicosPrestados`/`InformacoesAdicionais`/`Observacoes` da resposta do Omie, com `Cabecalho.cEtapa` sobrescrito. Registrar no PR/conversa qual caminho funcionou.

---

## Task 5: (OPCIONAL — fast-follow, PR separado) Watchdog `afiacao_os_sync`

> **Não bloqueia o core.** As colunas de observabilidade (`last_sync_at`/`last_sync_error`) já entram na Task 2; este check é o push proativo. **PR separado** porque `_data_health_compute`/`data_health_watchdog` é arquivo HOT multi-sessão (CLAUDE.md: já quebrou 3× por cascata — **partir SEMPRE da migration de MAIOR timestamp** e recriar `data_health_watchdog`+`fin_sync_heartbeat` JUNTO se mexer no compute).

**Files:**
- Create: nova migration `supabase/migrations/<ts>_data_health_afiacao_os_sync.sql` (timestamp único, > o último).

- [ ] **Step 1: Ler a definição ATUAL do compute/watchdog**

Run: `git -C /Users/lucassardenberg/Projetos/afiacao-afiacao-os-status-sync log origin/main --oneline -- supabase/migrations/ | grep -iE 'data_health|_data_health_compute' | head` e ler o arquivo de MAIOR timestamp por inteiro antes de editar.

- [ ] **Step 2: Adicionar o check `afiacao_os_sync` ao `_data_health_compute`**

Acrescentar um UNION no `_data_health_compute` (mantendo o resto VERBATIM do arquivo mais recente) com um check que vira `degraded` quando existe pedido cuja etapa-mapeada diverge da sincronizada há > 30min, ou item de fila com tentativas esgotadas:

```sql
-- dentro do _data_health_compute, novo UNION (source = 'afiacao_os_sync', domain operacional)
SELECT
  'afiacao_os_sync' AS source,
  CASE WHEN cnt_stale > 0 THEN 'degraded' ELSE 'ok' END AS status,
  format('%s OS de afiação fora de sincronia há >30min', cnt_stale) AS message,
  ... (campos no MESMO shape dos outros checks do arquivo)
FROM (
  SELECT count(*) AS cnt_stale
  FROM public.orders o
  JOIN public.omie_ordens_servico s ON s.order_id = o.id
  WHERE public.mapear_status_etapa(o.status) IS NOT NULL
    AND public.mapear_status_etapa(o.status) IS DISTINCT FROM s.last_etapa_sincronizada
    AND o.updated_at < now() - interval '30 minutes'
) q;
```

- [ ] **Step 3: Incluir `afiacao_os_sync` no IN-list do `data_health_watchdog`** (push na transição ok→degraded), recriando `data_health_watchdog` + `fin_sync_heartbeat` no MESMO bloco se o conjunto de checks mudou (regra da CLAUDE.md).

- [ ] **Step 4: Commit + entregar a migration inline pro founder + validar em prod.**

> Os campos exatos (`probable_cause`/`how_to_fix`/severity) e o shape do UNION dependem da versão viva do `_data_health_compute` — por isso este passo se resolve lendo o arquivo atual (Step 1), não aqui. Mantém-se a filosofia do repo: vigiar EFEITO NO DADO (etapa divergente), não status técnico do job.

---

## Notas de execução

- **Ordem:** Task 1 → 2 → 3 → 4. Task 5 é fast-follow opcional (PR à parte).
- **Backend manual:** o sync só liga depois que o founder (a) cola a migration no SQL Editor e (b) redeploya a `omie-sync` via chat do Lovable. O PR avisa isso em destaque.
- **DRY do mapa:** se algum dia mudar o mapa status→etapa, mudar nos 3 lugares (helper TS, SQL `mapear_status_etapa`, função `mapearStatusEtapa` na edge) — o helper TS é a fonte.
- **Não tocar** no caminho de criação da OS (`sync_order`) nem nas funções staff (`update_order`/`alterarOrdemServicoOmie`).
