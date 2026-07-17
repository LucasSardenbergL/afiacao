# PR1 — Infra de run imutável (reconciliação de PO excluído) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gravar, a cada run COMPLETO do `omie-sync-pedidos-compra`, um marcador imutável do run (`run_id`, janela real, contagem de POs, `volume_ok`) e carimbar em cada PO visto um sinal single-writer `last_seen_pedidos_full_*` — a base de verdade que a reconciliação (PR2/PR3) vai usar para provar exclusão. **Não muta nenhum `pedido_compra_sugerido`.**

**Architecture:** Uma tabela insert-only `reposicao_pedidos_compra_run` (1 linha/run completo) + duas colunas single-writer em `purchase_orders_tracking`. A edge de sync computa `volume_ok` (circuit-breaker de cobertura) via helper puro espelhado e grava o marcador ao fim de um completo bem-sucedido. O sinal `last_seen` substitui o `updated_at` multi-writer como prova de "visto pelo PesquisarPedCompra neste completo".

**Tech Stack:** Postgres 17 (migration + RLS), Deno/TypeScript (edge Supabase), vitest (helper puro), PG17 harness descartável (`db/test-*.sh`).

## Global Constraints

- **Lovable = 3 deploys manuais:** merge ≠ produção. Migration custom NÃO auto-aplica → entregar bloco pro SQL Editor (skill `lovable-db-operator`). NÃO editar migrations existentes.
- **NÃO tocar o motor** `gerar_pedidos_sugeridos_ciclo` neste PR (função QUENTE; risco de colisão).
- **Money-path:** ausente ≠ zero; `volume_ok` desconhecido → `null`, nunca `true` fabricado. PG17 com falsificação obrigatório.
- **Helper replicado edge×src:** helper puro em `src/lib/…` testado com vitest, espelhado verbatim no edge entre `// MIRROR-START`/`// MIRROR-END` (paridade textual no CI; Deno não importa de `src/`).
- **RLS:** tabela nova SEMPRE com RLS. `REVOKE FROM PUBLIC` não tira `authenticated` — grant/deny explícito.
- **Idioma:** código, rotas, commits e PRs em pt-BR.

---

### Task 1: Migration — tabela `reposicao_pedidos_compra_run` + colunas `last_seen` + RLS

**Files:**
- Create: `supabase/migrations/<TIMESTAMP>_reposicao_pedidos_compra_run.sql`
- Create (teste): `db/test-reposicao-pedidos-compra-run.sh`

**Interfaces:**
- Produces: tabela `public.reposicao_pedidos_compra_run(run_id uuid PK, empresa text, modo text, janela_de date, janela_ate date, ids_distintos int, volume_baseline int, volume_ok boolean, status text, iniciado_em timestamptz, finalizado_em timestamptz)`; colunas `public.purchase_orders_tracking.last_seen_pedidos_full_run_id uuid`, `.last_seen_pedidos_full_at timestamptz`.

- [ ] **Step 1: Gerar o timestamp da migration (sem colisão)**

Run: `ls supabase/migrations/ | tail -1` e gere `TIMESTAMP=$(date +%Y%m%d%H%M%S)`. Confirme que `TIMESTAMP` > a última listada (hoje a última é `20260710012337`) e que nenhuma sessão paralela criou timestamp próximo (`git fetch origin && git log origin/main --oneline -5 -- supabase/migrations/`). Use esse `TIMESTAMP` no nome do arquivo.

- [ ] **Step 2: Escrever a migration**

```sql
-- reposicao_pedidos_compra_run — marcador IMUTÁVEL de cada run completo do omie-sync-pedidos-compra.
-- Base de verdade da reconciliação de PO excluído (PR2/PR3): run_id, janela REAL consultada (anti-timezone),
-- contagem de POs distintos e volume_ok (circuit-breaker de cobertura). Insert-only (cada run = 1 linha nova).
-- NÃO confundir com sync_state('pedidos_compra_full'), que segue só para CADÊNCIA (quando rodar completo).
CREATE TABLE IF NOT EXISTS public.reposicao_pedidos_compra_run (
  run_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa         text NOT NULL,
  modo            text NOT NULL,
  janela_de       date NOT NULL,
  janela_ate      date NOT NULL,
  ids_distintos   integer NOT NULL DEFAULT 0,
  volume_baseline integer,             -- mediana dos últimos completos; NULL no bootstrap
  volume_ok       boolean,             -- NULL = desconhecido (sem baseline) → PR2/3 tratam como não-confiável
  status          text NOT NULL DEFAULT 'ok',
  iniciado_em     timestamptz NOT NULL DEFAULT now(),
  finalizado_em   timestamptz NOT NULL DEFAULT now()
);

-- Último run completo VÁLIDO por empresa (o que a reconciliação vai ancorar).
CREATE INDEX IF NOT EXISTS idx_reposicao_pcr_empresa_fim
  ON public.reposicao_pedidos_compra_run (empresa, finalizado_em DESC);

ALTER TABLE public.reposicao_pedidos_compra_run ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reposicao_pcr_sel ON public.reposicao_pedidos_compra_run;
CREATE POLICY reposicao_pcr_sel ON public.reposicao_pedidos_compra_run
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

DROP POLICY IF EXISTS reposicao_pcr_ins ON public.reposicao_pedidos_compra_run;
CREATE POLICY reposicao_pcr_ins ON public.reposicao_pedidos_compra_run
  FOR INSERT TO authenticated WITH CHECK (true);

GRANT SELECT, INSERT ON public.reposicao_pedidos_compra_run TO authenticated;
GRANT ALL    ON public.reposicao_pedidos_compra_run TO service_role;

-- Sinal single-writer: SÓ o omie-sync-pedidos-compra (modo completo) escreve. Imune ao updated_at multi-writer.
ALTER TABLE public.purchase_orders_tracking
  ADD COLUMN IF NOT EXISTS last_seen_pedidos_full_run_id uuid,
  ADD COLUMN IF NOT EXISTS last_seen_pedidos_full_at     timestamptz;
```

- [ ] **Step 3: Escrever o harness PG17 (aplica a migration REAL + asserts + falsificação)**

Copie o arranque de `db/test-carteira-saude-eligible-efeito.sh` (linhas 14-53: initdb/pg_ctl/createdb, helpers `P/Pq/ok/bad/eq`, `db/stubs-supabase.sql`, stubs de `auth.uid()`). Depois:

```bash
SLUG="reposicao-pedidos-compra-run"   # trocar no arranque copiado

# pré-req: pode_ver_carteira_completa (stub que lê test.staff) + purchase_orders_tracking mínima
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.staff', true),'')::bool, false) $f$;
CREATE TABLE IF NOT EXISTS public.purchase_orders_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), empresa text, omie_codigo_pedido bigint, updated_at timestamptz DEFAULT now()
);
SQL

# aplica a MIGRATION REAL
P -q -f "$REPO_ROOT/supabase/migrations/<TIMESTAMP>_reposicao_pedidos_compra_run.sql"

# (+) estrutura: colunas last_seen existem
eq "coluna last_seen_run_id existe" \
  "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='purchase_orders_tracking' AND column_name='last_seen_pedidos_full_run_id'")" "1"

# (+) INSERT de um run funciona e volume_ok aceita NULL
P -q <<'SQL'
INSERT INTO public.reposicao_pedidos_compra_run (empresa,modo,janela_de,janela_ate,ids_distintos,volume_ok)
VALUES ('OBEN','completo', current_date-365, current_date+120, 404, NULL);
SQL
eq "run inserido" "$(Pq -c "SELECT count(*) FROM reposicao_pedidos_compra_run WHERE empresa='OBEN'")" "1"

# (+) RLS: staff SELECT vê; não-staff NÃO vê (SET ROLE authenticated + GUC)
P -q <<'SQL'
GRANT USAGE ON SCHEMA public TO authenticated;
SQL
STAFF=$(P -tA -c "SET ROLE authenticated; SELECT set_config('test.staff','true',true); SELECT count(*) FROM reposicao_pedidos_compra_run;" | tail -1)
eq "staff vê o run" "$STAFF" "1"
NAO=$(P -tA -c "SET ROLE authenticated; SELECT set_config('test.staff','false',true); SELECT count(*) FROM reposicao_pedidos_compra_run;" | tail -1)
eq "não-staff NÃO vê (RLS)" "$NAO" "0"

# (−/FALSIFICAÇÃO) sabota a policy (USING true) → não-staff passaria a ver → exige VERMELHO
P -q <<'SQL'
DROP POLICY reposicao_pcr_sel ON public.reposicao_pedidos_compra_run;
CREATE POLICY reposicao_pcr_sel ON public.reposicao_pedidos_compra_run FOR SELECT TO authenticated USING (true);
SQL
SAB=$(P -tA -c "SET ROLE authenticated; SELECT set_config('test.staff','false',true); SELECT count(*) FROM reposicao_pedidos_compra_run;" | tail -1)
if [ "$SAB" = "0" ]; then bad "FALSIFICAÇÃO deveria vazar (RLS sabotada) mas não vazou"; else ok "falsificação confirmada: RLS sabotada vaza ($SAB) — o assert tem dente"; fi

echo "═══ PASS=$PASS FAIL=$FAIL ═══"; [ "$FAIL" = "0" ]
```

- [ ] **Step 4: Rodar o harness — deve passar (e a falsificação confirmar dente)**

Run: `bash db/test-reposicao-pedidos-compra-run.sh > /tmp/t1.log 2>&1; echo $?`
Expected: `0` no fim, com `✅ não-staff NÃO vê (RLS)` e `✅ falsificação confirmada`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/<TIMESTAMP>_reposicao_pedidos_compra_run.sql db/test-reposicao-pedidos-compra-run.sh
git commit -m "feat(reposicao): tabela imutável de run + last_seen single-writer (PR1 reconciliação PO) [money-path]

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Helper puro `computeVolumeOk` + vitest + espelho no edge

**Files:**
- Create: `src/lib/reposicao/volume-run.ts`
- Create (teste): `src/lib/reposicao/volume-run.test.ts`
- Create (espelho): `supabase/functions/_shared/reposicao-volume-run.ts`

**Interfaces:**
- Produces: `computeVolumeOk(idsDistintos: number, historico: number[], opts?: { k?: number; minHistorico?: number }): { baseline: number | null; volumeOk: boolean | null }`. `k` default `0.9`, `minHistorico` default `3`. Sem histórico suficiente → `{ baseline: null, volumeOk: null }` (money-path: desconhecido ≠ true).

- [ ] **Step 1: Escrever o teste (falha primeiro)**

```typescript
import { describe, it, expect } from 'vitest';
import { computeVolumeOk } from './volume-run';

describe('computeVolumeOk', () => {
  it('sem histórico suficiente → volumeOk null (não fabrica true)', () => {
    expect(computeVolumeOk(404, [])).toEqual({ baseline: null, volumeOk: null });
    expect(computeVolumeOk(404, [400, 410])).toEqual({ baseline: null, volumeOk: null }); // < minHistorico=3
  });
  it('run dentro do baseline → volumeOk true', () => {
    // mediana([400,410,420]) = 410; 404 >= 0.9*410=369 → true
    expect(computeVolumeOk(404, [400, 410, 420])).toEqual({ baseline: 410, volumeOk: true });
  });
  it('run truncado (queda abrupta) → volumeOk false (circuit-breaker)', () => {
    // mediana([400,410,420]) = 410; 12 < 369 → false
    expect(computeVolumeOk(12, [400, 410, 420])).toEqual({ baseline: 410, volumeOk: false });
  });
  it('shape mudou → 0 POs → volumeOk false (o falso-fim-saudável do Codex)', () => {
    expect(computeVolumeOk(0, [400, 410, 420]).volumeOk).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste — deve falhar**

Run: `bun run test src/lib/reposicao/volume-run.test.ts`
Expected: FAIL (`computeVolumeOk is not a function`).

- [ ] **Step 3: Escrever o helper**

```typescript
// MIRROR-START computeVolumeOk
// Circuit-breaker de cobertura do run completo. baseline = mediana dos últimos completos; volumeOk =
// idsDistintos >= k*baseline. Sem baseline confiável (< minHistorico) → null (desconhecido, NUNCA true).
export function computeVolumeOk(
  idsDistintos: number,
  historico: number[],
  opts?: { k?: number; minHistorico?: number },
): { baseline: number | null; volumeOk: boolean | null } {
  const k = opts?.k ?? 0.9;
  const minHistorico = opts?.minHistorico ?? 3;
  const validos = historico.filter((n) => Number.isFinite(n) && n >= 0);
  if (validos.length < minHistorico) return { baseline: null, volumeOk: null };
  const ord = [...validos].sort((a, b) => a - b);
  const mid = Math.floor(ord.length / 2);
  const baseline = ord.length % 2 ? ord[mid] : Math.round((ord[mid - 1] + ord[mid]) / 2);
  const volumeOk = idsDistintos >= k * baseline;
  return { baseline, volumeOk };
}
// MIRROR-END computeVolumeOk
```

- [ ] **Step 4: Rodar o teste — deve passar**

Run: `bun run test src/lib/reposicao/volume-run.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Espelhar verbatim no edge**

Crie `supabase/functions/_shared/reposicao-volume-run.ts` com o MESMO bloco `// MIRROR-START computeVolumeOk` … `// MIRROR-END computeVolumeOk` (copiado byte-a-byte do `src/`), precedido de comentário `// Espelho de src/lib/reposicao/volume-run.ts — paridade textual no CI`.

- [ ] **Step 6: Rodar typecheck + deno check**

Run: `bun run typecheck && deno check supabase/functions/_shared/reposicao-volume-run.ts`
Expected: sem erros.

- [ ] **Step 7: Commit**

```bash
git add src/lib/reposicao/volume-run.ts src/lib/reposicao/volume-run.test.ts supabase/functions/_shared/reposicao-volume-run.ts
git commit -m "feat(reposicao): helper computeVolumeOk (circuit-breaker de cobertura do run) + espelho edge [money-path]

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Edge grava o marcador de run + carimba `last_seen` no completo

**Files:**
- Modify: `supabase/functions/omie-sync-pedidos-compra/index.ts` (`upsertPedidosLote` ~L292; `syncEmpresa` loop ~L389-471; nova função de gravação do run; chamada no fim do completo)

**Interfaces:**
- Consumes: `computeVolumeOk` (Task 2, via espelho `_shared/reposicao-volume-run.ts`); tabela `reposicao_pedidos_compra_run` e colunas `last_seen_pedidos_full_*` (Task 1).
- Produces: 1 linha em `reposicao_pedidos_compra_run` por completo bem-sucedido; `last_seen_pedidos_full_run_id/at` carimbados nos POs vistos.

- [ ] **Step 1: Importar o helper no topo da edge**

```typescript
import { computeVolumeOk } from "../_shared/reposicao-volume-run.ts";
```

- [ ] **Step 2: `upsertPedidosLote` aceita e carimba o `fullRunId` (só no completo)**

Modifique a assinatura para `upsertPedidosLote(supabase, rows, fullRunId?: string)`. Dentro do loop que monta `clean` (após `clean.updated_at = nowIso;`), acrescente:

```typescript
    if (fullRunId) {
      clean.last_seen_pedidos_full_run_id = fullRunId;
      clean.last_seen_pedidos_full_at = nowIso;
    }
```

- [ ] **Step 3: `syncEmpresa` gera `run_id`, conta POs distintos e passa `fullRunId` no completo**

No topo de `syncEmpresa`, antes do loop de páginas: `const fullRunId = modo === "completo" ? crypto.randomUUID() : undefined;` e `const idsVistos = new Set<number>();`. Dentro do loop, após montar `rows` (L453), antes do upsert:

```typescript
    for (const p of pedidos) {
      const nCod = Number(p?.cabecalho_consulta?.nCodPed ?? p?.cabecalho?.nCodPed);
      if (Number.isFinite(nCod) && nCod > 0) idsVistos.add(nCod);
    }
    const upsertRes = await upsertPedidosLote(supabase, rows, fullRunId);
```

Exponha `fullRunId` e `idsVistos.size` no retorno de `syncEmpresa` (adicione a `EmpresaSummary`: `full_run_id?: string; ids_distintos?: number;` e preencha antes do `return summary`).

- [ ] **Step 4: Escrever `gravarRunCompleto` (fail-closed, não engole erro como marcarCompletoOk)**

```typescript
// Grava o marcador IMUTÁVEL do run completo. Diferente de marcarCompletoOk (best-effort/cadência): aqui a
// gravação é a base de verdade da reconciliação → loga ALTO em falha (a reconciliação do PR2/3 só confia
// num run_id efetivamente persistido). Retorna o run_id gravado ou null.
async function gravarRunCompleto(
  supabase: SupabaseClient, empresa: Empresa, runId: string,
  janelaDe: string, janelaAte: string, idsDistintos: number,
): Promise<string | null> {
  const { data: hist } = await supabase
    .from("reposicao_pedidos_compra_run")
    .select("ids_distintos")
    .eq("empresa", empresa).eq("modo", "completo").eq("status", "ok")
    .order("finalizado_em", { ascending: false }).limit(10);
  const historico = (hist ?? []).map((h) => Number((h as { ids_distintos: number }).ids_distintos));
  const { baseline, volumeOk } = computeVolumeOk(idsDistintos, historico);
  const { error } = await supabase.from("reposicao_pedidos_compra_run").insert({
    run_id: runId, empresa, modo: "completo",
    janela_de: janelaDe, janela_ate: janelaAte,
    ids_distintos: idsDistintos, volume_baseline: baseline, volume_ok: volumeOk,
    status: "ok", finalizado_em: new Date().toISOString(),
  });
  if (error) {
    console.error(`[sync-pedidos] FALHA CRÍTICA gravarRunCompleto empresa=${empresa} run=${runId}: ${error.message}`);
    return null;
  }
  console.log(`[sync-pedidos] run completo gravado empresa=${empresa} run=${runId} ids=${idsDistintos} volume_ok=${volumeOk}`);
  return runId;
}
```

- [ ] **Step 5: Chamar `gravarRunCompleto` no fim do completo bem-sucedido**

No `processarTudo`, após `syncEmpresa` retornar, quando `modo === "completo"` e o run terminou bem (`s.erros === 0` e `s.full_run_id`), chame `gravarRunCompleto`. Encaixe junto de onde `marcarCompletoOk` já é chamado (grep `marcarCompletoOk` no handler): passe `dataDe`/`dataAte` (a janela real já calculada por `computeJanelaPrevisao`) e `s.ids_distintos ?? 0`.

- [ ] **Step 6: deno check + typecheck**

Run: `deno check supabase/functions/omie-sync-pedidos-compra/index.ts && bun run typecheck`
Expected: sem erros.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/omie-sync-pedidos-compra/index.ts
git commit -m "feat(reposicao): edge grava marcador imutável de run + carimba last_seen no completo (PR1) [money-path]

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (§5.1, §5.2, §8-marcador do design):**
- Tabela `reposicao_pedidos_compra_run` (run_id/janela/volume_ok) → Task 1 ✓
- Colunas single-writer `last_seen_pedidos_full_*` → Task 1 (DDL) + Task 3 (carimbo) ✓
- `volume_ok` circuit-breaker (mediana, k=90%) → Task 2 ✓
- `marcarCompletoOk` fail-closed (P1 Codex) → Task 3 Step 4 (loga alto, retorna null em falha) ✓
- Janela REAL gravada (anti-timezone, P2 Codex) → Task 3 Step 5 (passa `dataDe`/`dataAte`, não `CURRENT_DATE`) ✓
- **Fora do PR1 (PR2/3):** RPC de candidatos, `ConsultarPedCompra`, mutação, `expected_run_id`, 2-confirmações — corretamente adiados.

**2. Placeholder scan:** `<TIMESTAMP>` é instrução operacional explícita (Task 1 Step 1), não placeholder de conteúdo. Nenhum "TODO/TBD". Código completo em todos os steps. ✓

**3. Type consistency:** `computeVolumeOk` assinatura idêntica em Task 2 e uso em Task 3 Step 4 ✓; `full_run_id`/`ids_distintos` adicionados a `EmpresaSummary` (Task 3 Step 3) e consumidos no Step 5 ✓; nomes de coluna (`last_seen_pedidos_full_run_id`) idênticos entre Task 1 DDL e Task 3 Step 2 ✓.

## Rollout (Lovable) após o PR mergear
1. **Migration** (SQL Editor, skill `lovable-db-operator`): colar o bloco da Task 1 Step 2.
2. **Edge** `omie-sync-pedidos-compra` (chat do Lovable, verbatim).
3. Verificar via `psql-ro`: após 1 run completo, `SELECT * FROM reposicao_pedidos_compra_run ORDER BY finalizado_em DESC LIMIT 3` (deve ter linha OBEN com `ids_distintos ~404`, `volume_ok` null nos 3 primeiros runs, depois true) e `SELECT count(*) FROM purchase_orders_tracking WHERE last_seen_pedidos_full_run_id IS NOT NULL`.

## Próximos PRs (plano próprio na vez — ver design §12)
- **PR2:** RPC `reposicao_pos_candidatos` + edge `reposicao-reconciliar-pos-excluidos` (`ConsultarPedCompra`) + `reposicao_reconciliar_pos_excluidos(p_dry_run=true)` + tabela de candidatos. Observa ≥2 ciclos.
- **PR3:** liga mutação real (evidência CANCELADO=1 / não-encontrado=2 runs + advisory lock + `expected_run_id` + update/log atômico).
- **PR4:** UI (fila neutra).
