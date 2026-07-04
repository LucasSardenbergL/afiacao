# PCP Fase 1A — Malha Omie & Dados Mestres — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trazer a malha (estrutura de produtos) do Omie para o app, parsear as dimensões dos SKUs fabricados e destilar a BOM paramétrica por linha de abrasivo — com prova de reprodução das ~1.4k malhas e gate de amostragem do founder.

**Architecture:** Um edge function (`omie-malha-sync`) pagina `geral/malha` do Omie até página vazia e grava o payload BRUTO (jsonb) em `pcp_malha_staging` — todo o mapeamento de campos vive em UMA view SQL (`vw_pcp_malha_itens`), então incerteza de shape custa um `CREATE OR REPLACE VIEW`, nunca um redeploy de edge. Sobre o staging: parser dimensional SQL (`fn_pcp_parse_dimensoes`, golden set com falsificação) popula `pcp_itens`; a destilação (`fn_pcp_destilar_bom`) deriva coeficientes por linha (mediana robusta) e a validação (`vw_pcp_bom_validacao` + `pcp_bom_excecoes`) prova que a fórmula reproduz as malhas existentes ± tolerância. Nada downstream consome a BOM nesta fase — o gate de amostragem do founder trava a Fase 1B/2.

**Tech Stack:** Supabase (Postgres + RLS `has_role((SELECT auth.uid()),…)` InitPlan-wrap; edge Deno com `authorizeCronOrStaff`), API Omie `geral/malha` (paginar até vazio — NUNCA confiar em `total_de_paginas`), provas PG17 locais (`db/test-*.sh`, Lei de Ferro: aplicar o SQL REAL + asserts numéricos + FALSIFICAR).

**Fora deste plano (Fase 1B, plano separado):** OP com etapas, modelo corte múltiplo (rota+coproduto+rateio), apontamento event-sourced, roteiros por família + centros de trabalho (só fazem sentido com OP), telas `/producao/*`. Este plano é 100% dados — entrega valor verificável (BOM destilada provada) sem UI.

**Regras da casa que este plano obedece (não pular):**
- Escrita em prod SÓ via SQL Editor do Lovable (founder cola os arquivos `db/pcp-f1a-*.sql`); eu leio/verifico via `~/.config/afiacao/psql-ro`. NUNCA tocar `supabase/migrations/`.
- Edge deploya pelo chat do Lovable (runbook `docs/runbooks/lovable-supabase.md`). Merge na main ≠ produção.
- Money-path ethos: ausente ≠ zero — parser e destilação NUNCA fabricam número (sem match ⇒ NULL + status explícito).
- RLS em TODA tabela nova; `REVOKE` por nome (`REVOKE FROM PUBLIC` não tira `anon`/`authenticated`).
- Comandos pesados prefixados com `heavy`; `cmd | tail` engole exit code (`> log 2>&1; echo $?`).

**Fatos medidos que o código abaixo usa (psql-ro, 2026-07-04):**
- `omie_products.account = 'colacor'` (4.269 produtos; a conta Omie da edge é `OMIE_COLACOR_APP_KEY/SECRET`).
- `omie_products` tem `omie_codigo_produto bigint` (id Omie) E `codigo text` (ex.: `PRD01832`); `metadata->>'modelo'` existe mas vem **string vazia** ⇒ linha_modelo sai do 2º token da descrição (`CINTA R819 120X6750MM P50` → `R819`), com metadata como fallback se um dia for preenchido.
- Padrões reais de descrição: `CINTA 2909 75X533MM P220`, `ROLO 2909 600X2300MM P60`, `JUMBO AC768 1410X100000MM P1500` (grão até 4 dígitos), `DISCO DE LIXA 1944 180MM P80`, `DISCO DE LIXA CTN 152MM C/F P320`, `TINGIDOR MEL ESCURO TEH 3505.162FG` (sem dims), `RL SAITAC 5G GR 320 - 1600 X 050M` (fora do padrão ⇒ sem_match).
- Malha validada por print (CINTA KA169 150X6200MM P50, omie_codigo_produto 4396000531): ROLO 0,93 M2 (=área nominal exata) + A455 1,611 G + DESMODUR NE-S 0,179 G + FITA 16,9 CM.

---

## Mapa de arquivos

| Arquivo | Papel |
|---|---|
| Create: `db/pcp-f1a-m1-staging.sql` | Momento 1 de deploy (founder cola): `pcp_run_logs` + `pcp_malha_staging` + RLS |
| Create: `supabase/functions/omie-malha-sync/index.ts` | Edge: probe (lock de shape) + sync (paginar até vazio, upsert staging) |
| Create: `db/test-pcp-f1a-m1-staging.sh` | Prova PG17 do M1 (RLS fail-closed + falsificação) |
| Create: `db/pcp-f1a-m2-nucleo.sql` | Momento 2 de deploy: extração + parser + `pcp_itens` + destilação + validação + exceções + RLS |
| Create: `db/test-pcp-parser-dimensoes.sh` | Golden set do parser (casos reais) + falsificação |
| Create: `db/test-pcp-f1a-destilacao.sh` | Prova da destilação com a malha REAL do print + sabotagem obrigatória |
| Modify: `docs/historico/programas-vendas.md` (ou novo `docs/historico/pcp.md`) | Registro da entrega |

**Sequência de deploy (2 momentos do founder):** M1 (staging) + edge → probe → sync → shape conferido via psql-ro → M2 (núcleo) → refresh+destilar em prod → relatório de amostragem → gate do founder.

---

### Task 1: SQL M1 — staging da malha + run log (com RLS)

**Files:**
- Create: `db/pcp-f1a-m1-staging.sql`

- [ ] **Step 1.1: Escrever o SQL do M1**

Conteúdo COMPLETO de `db/pcp-f1a-m1-staging.sql`:

```sql
-- PCP Fase 1A — M1: staging da malha Omie + run log.
-- Aplicar no SQL Editor do Lovable (founder). NUNCA em supabase/migrations/.
-- Spec: docs/superpowers/specs/2026-07-03-pcp-colacor-blueprint-design.md (§3 Camada 0 item 2; Camada 6 item 25)
BEGIN;

CREATE TABLE IF NOT EXISTS public.pcp_run_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa     text NOT NULL DEFAULT 'colacor',
  funcao      text NOT NULL,                     -- ex.: 'omie-malha-sync'
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'rodando' CHECK (status IN ('rodando','ok','erro')),
  paginas     int,
  registros   int,
  detalhe     jsonb NOT NULL DEFAULT '{}'::jsonb -- ex.: {shape_err: 0, sample: {...}}
);

-- 1 linha por produto-pai; payload = estrutura BRUTA do Omie (mapeamento de campos fica na view do M2).
CREATE TABLE IF NOT EXISTS public.pcp_malha_staging (
  omie_codigo_produto bigint PRIMARY KEY,
  empresa     text NOT NULL DEFAULT 'colacor',
  payload     jsonb NOT NULL,
  -- NOT NULL: o edge SEMPRE grava com um run; sem isso, a limpeza `.neq(sync_run_id)` seria
  -- NULL-blind (não apagaria órfãos com sync_run_id NULL — armadilha de negação do CLAUDE.md).
  sync_run_id bigint NOT NULL REFERENCES public.pcp_run_logs(id),
  synced_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pcp_malha_staging_synced ON public.pcp_malha_staging (synced_at);

ALTER TABLE public.pcp_run_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pcp_malha_staging ENABLE ROW LEVEL SECURITY;

-- Leitura: staff (master|employee). Escrita: NENHUMA policy p/ authenticated —
-- quem escreve é a edge com service_role (bypassa RLS; gate na fronteira = authorizeCronOrStaff).
-- DROP IF EXISTS antes de cada policy: re-colar no SQL Editor é ESPERADO (database.md §re-aplicação)
-- e CREATE POLICY não tem IF NOT EXISTS — sem o guard, a 2ª colagem dá ROLLBACK na transação inteira.
DROP POLICY IF EXISTS pcp_run_logs_select_staff ON public.pcp_run_logs;
CREATE POLICY pcp_run_logs_select_staff ON public.pcp_run_logs
  FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role)
      OR has_role((SELECT auth.uid()), 'employee'::app_role));

DROP POLICY IF EXISTS pcp_malha_staging_select_staff ON public.pcp_malha_staging;
CREATE POLICY pcp_malha_staging_select_staff ON public.pcp_malha_staging
  FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role)
      OR has_role((SELECT auth.uid()), 'employee'::app_role));

-- REVOKE por NOME (REVOKE FROM PUBLIC não tira anon/authenticated — armadilha CLAUDE.md).
REVOKE ALL ON public.pcp_run_logs, public.pcp_malha_staging FROM anon;
REVOKE ALL ON public.pcp_run_logs, public.pcp_malha_staging FROM authenticated;
GRANT SELECT ON public.pcp_run_logs, public.pcp_malha_staging TO authenticated;

COMMIT;
```

- [ ] **Step 1.2: Commit**

```bash
git add db/pcp-f1a-m1-staging.sql
git commit -m "feat(pcp): F1A M1 — staging da malha Omie + run log (RLS staff-read)"
```

---

### Task 2: Prova PG17 do M1 (RLS fail-closed + falsificação)

**Files:**
- Create: `db/test-pcp-f1a-m1-staging.sh`

- [ ] **Step 2.1: Escrever o script de prova**

Conteúdo COMPLETO de `db/test-pcp-f1a-m1-staging.sh` (harness idêntico ao padrão da casa, ex. `db/test-embalagem-motor.sh`):

```bash
#!/usr/bin/env bash
# Prova PG17 — pcp F1A M1: staging da malha (RLS fail-closed).
# Rodar: bash db/test-pcp-f1a-m1-staging.sh > /tmp/t-m1.log 2>&1; echo "exit=$?"  (NÃO pipe pra tail)
# Lei de Ferro: aplica o SQL REAL; asserts; FALSIFICA (desliga RLS → não-staff passa a ver → prova que o bloqueio era do RLS).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="pcp-f1a-m1"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/db/pcp-f1a-m1-staging.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA -q "$@"; }  # -q OBRIGATÓRIO: sem ele, "SET ...; SELECT ..." vaza linhas SET na captura

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ ZONA 1: pré-requisitos (estado de PROD: roles, auth, app_role, has_role VERBATIM) ═══"
P -q <<'SQL'
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
-- has_role VERBATIM de prod (STABLE SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, anon;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
SQL

echo "═══ ZONA 2: aplica o SQL REAL do M1 (2×: re-colar no SQL Editor é esperado) ═══"
P -q -f "$MIG"
if P -q -f "$MIG" >/dev/null 2>&1; then ok "re-aplicação idempotente (2ª colagem não quebra)"; else bad "re-aplicação QUEBROU (policy sem DROP IF EXISTS?)"; fi

echo "═══ ZONA 3: fixtures (1 run + 1 staging; 1 user staff + 1 não-staff) ═══"
P -q <<'SQL'
INSERT INTO public.pcp_run_logs (funcao, status) VALUES ('omie-malha-sync','ok');
INSERT INTO public.pcp_malha_staging (omie_codigo_produto, payload, sync_run_id)
VALUES (4396000531, '{"ident":{"idProduto":4396000531}}'::jsonb, 1);
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000aaaa','employee');
-- usuário bbbb existe mas NÃO tem role (fail-closed deve dar 0 linhas)
SQL

echo "═══ ZONA 4: asserts ═══"
eq "RLS ligado em pcp_malha_staging" "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE oid='public.pcp_malha_staging'::regclass")" "t"
eq "RLS ligado em pcp_run_logs"      "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE oid='public.pcp_run_logs'::regclass")" "t"
eq "anon SEM grant de SELECT" "$(Pq -c "SELECT has_table_privilege('anon','public.pcp_malha_staging','SELECT')")" "f"
eq "staff (employee) vê staging" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; SELECT count(*) FROM public.pcp_malha_staging")" "1"
eq "não-staff vê 0 (fail-closed)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM public.pcp_malha_staging")" "0"
eq "staff vê run_logs" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; SELECT count(*) FROM public.pcp_run_logs")" "1"
eq "não-staff vê 0 em run_logs (fail-closed)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM public.pcp_run_logs")" "0"
INS_ERR=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; INSERT INTO public.pcp_malha_staging (omie_codigo_produto, payload) VALUES (1,'{}');" 2>&1 || true)
case "$INS_ERR" in *"permission denied"*|*"row-level security"*) ok "INSERT de authenticated bloqueado";; *) bad "INSERT de authenticated NÃO bloqueado: $INS_ERR";; esac

echo "═══ ZONA 5: FALSIFICAÇÃO (desliga RLS → não-staff PASSA a ver → prova que o teste detecta) ═══"
P -q -c "ALTER TABLE public.pcp_malha_staging DISABLE ROW LEVEL SECURITY;"
eq "FALSIFICAÇÃO: sem RLS, não-staff vê 1 (o bloqueio ERA do RLS)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM public.pcp_malha_staging")" "1"
P -q -c "ALTER TABLE public.pcp_malha_staging ENABLE ROW LEVEL SECURITY;"

echo ""
echo "RESULTADO: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2.2: Rodar a prova (exit code SEM pipe)**

Run: `bash db/test-pcp-f1a-m1-staging.sh > /tmp/t-m1.log 2>&1; echo "exit=$?"`
Expected: `exit=0`; no log, `PASS=10 FAIL=0` (re-aplicação idempotente + 7 asserts de ZONA 4 + INSERT bloqueado + falsificação).

- [ ] **Step 2.3: shellcheck no script novo**

Run: `shellcheck db/test-pcp-f1a-m1-staging.sh; echo "exit=$?"`
Expected: `exit=0` (warnings SC2016 sobre single-quotes em SQL são aceitáveis se surgirem — resolver só erro real).

- [ ] **Step 2.4: Commit**

```bash
git add db/test-pcp-f1a-m1-staging.sh
git commit -m "test(pcp): prova PG17 do M1 — RLS fail-closed do staging com falsificação"
```

---

### Task 3: Edge `omie-malha-sync` (probe + sync até página vazia)

**Files:**
- Create: `supabase/functions/omie-malha-sync/index.ts`

Decisões embutidas: (a) o edge NÃO mapeia campos da estrutura — grava o item inteiro como `payload` (shape lock fica no SQL); a única extração é o código do produto-pai (PK), com cadeia de candidatos e contagem de erros de shape; (b) paginar até página **vazia** com guarda de 400 páginas (armadilha Omie: `total_de_paginas` mente); (c) ação `probe` devolve as CHAVES do shape real sem escrever nada — roda ANTES do primeiro sync para travar a extração do M2.

- [ ] **Step 3.1: Escrever o edge**

Conteúdo COMPLETO de `supabase/functions/omie-malha-sync/index.ts`:

```typescript
// omie-malha-sync — espelha a ESTRUTURA de produtos (malha) do Omie Colacor para pcp_malha_staging.
// Ações: {action:"probe"} → shape da página 1 (não escreve nada); {action:"sync"} → pagina até vazio + upsert.
// Spec: docs/superpowers/specs/2026-07-03-pcp-colacor-blueprint-design.md (§3 Camada 0 item 2)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";
const REG_POR_PAGINA = 50;
const MAX_PAGINAS = 400; // guarda dura: 400×50 = 20k estruturas >> ~1.9k produtos fabricados

// O Omie sinaliza ERRO de negócio E fim-de-paginação pelo MESMO canal: HTTP 200 + `faultstring`
// (nunca por status HTTP). Checar só `resp.ok` deixaria uma faultstring do meio virar "página vazia"
// → sync para cedo e marca "ok" com malha TRUNCADA (o pior modo de falha da F1A).
// FIM_PAGINACAO = faultstrings que significam "acabou" (não é erro) → para o loop.
// TRANSITORIO = flakiness do servidor Omie/rede → re-tenta com backoff (idem omie-analytics-sync).
// Fail-safe: faultstring NÃO reconhecida como fim nem transitório → THROW (run vira "erro" VISÍVEL,
// nunca "ok" silencioso). ListarEstruturas é não-confirmado — CONFIRMAR/AJUSTAR estes marcadores no probe.
const FIM_PAGINACAO = ["não existem registros", "nao existem registros", "nenhum registro",
  "não foram encontrados", "nao foram encontrados", "consulta não retornou", "consulta nao retornou",
  "página informada", "pagina informada"];
const TRANSITORIO = ["broken response", "soap-error", "timeout", "timed out", "network",
  "connection", "fetch failed", "500", "502", "503", "504", "429", "too many", "rate limit"];

function omieCreds() {
  const key = Deno.env.get("OMIE_COLACOR_APP_KEY");
  const secret = Deno.env.get("OMIE_COLACOR_APP_SECRET");
  if (!key || !secret) throw new Error("OMIE_COLACOR_APP_KEY/SECRET ausentes no ambiente");
  return { key, secret };
}

// Retorna o objeto da malha, OU null quando o Omie sinaliza FIM de paginação (não é erro).
async function omieCall(call: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const creds = omieCreds();
  const body = { call, app_key: creds.key, app_secret: creds.secret, param: [params] };
  const MAX = 4;
  let lastErr: Error | null = null;
  for (let tentativa = 1; tentativa <= MAX; tentativa++) {
    try {
      const resp = await fetch(`${OMIE_API_URL}/geral/malha/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const fault = typeof parsed.faultstring === "string" ? parsed.faultstring : "";
      if (fault) {
        const f = fault.toLowerCase();
        if (FIM_PAGINACAO.some((m) => f.includes(m))) return null; // fim normal — NÃO é erro
        throw new Error(`Omie ${call}: ${fault}`);                 // erro de negócio (classificado no catch)
      }
      if (!resp.ok) throw new Error(`Omie ${call} HTTP ${resp.status}: ${text.slice(0, 300)}`);
      return parsed;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const m = lastErr.message.toLowerCase();
      // transitório (inclui JSON malformado/resposta cortada) re-tenta; permanente (credencial/validação) falha já
      const transitorio = TRANSITORIO.some((t) => m.includes(t)) || m.includes("json") || m.includes("unexpected");
      if (transitorio && tentativa < MAX) {
        await new Promise((r) => setTimeout(r, 800 * Math.pow(2, tentativa - 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error(`Omie ${call}: falha após ${MAX} tentativas`);
}

// A lista de estruturas pode vir sob nomes diferentes conforme a versão da API — candidatos conhecidos.
// O probe existe para TRAVAR qual é o real antes do sync completo.
function extractLista(resp: Record<string, unknown>): unknown[] | null {
  for (const k of ["listaEstruturas", "estruturas", "malhaCadastro", "cadastros", "estruturasEncontradas"]) {
    const v = resp[k];
    if (Array.isArray(v)) return v;
  }
  // fallback: primeiro valor array do objeto
  for (const v of Object.values(resp)) if (Array.isArray(v)) return v as unknown[];
  return null;
}

// Código do produto-pai: cadeia de candidatos; NaN ⇒ shape_err (nunca inventar id).
function extractPaiCodigo(item: unknown): number {
  const it = item as Record<string, unknown> | null;
  const ident = (it?.ident ?? {}) as Record<string, unknown>;
  const cand = ident.idProduto ?? ident.intCodigo ?? ident.nCodProduto ?? it?.idProduto ?? it?.codigo_produto;
  const n = Number(cand);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  // AuthResult da casa (_shared/auth.ts): no erro já traz uma Response 401 pronta (com CORS) — reusar.
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = (body.action as string) ?? "probe";

  let runId: number | null = null;
  try {
    if (action === "probe") {
      const resp = await omieCall("ListarEstruturas", { nPagina: 1, nRegPorPagina: 2 });
      if (resp === null) {
        return new Response(JSON.stringify({ aviso: "Omie sinalizou fim/vazio já na página 1 (catálogo sem estruturas?)" },
          null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const lista = extractLista(resp);
      const first = (lista?.[0] ?? null) as Record<string, unknown> | null;
      return new Response(JSON.stringify({
        topKeys: Object.keys(resp),
        listaDetectada: lista ? lista.length : null,
        itemKeys: first ? Object.keys(first) : null,
        identKeys: first?.ident ? Object.keys(first.ident as Record<string, unknown>) : null,
        sampleItem: first, // página de 2 itens: pequeno o bastante p/ inspeção
      }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (action !== "sync") throw new Error(`action desconhecida: ${String(action)}`);
    // desde_pagina (painel Gemini): retomar um sync que estourou o tempo do edge
    // (estimativa real ~40 páginas ≈ 30-40s; o resume é o seguro, não o caminho normal).
    const desdePagina = Number(body.desde_pagina) || 1;

    const { data: run, error: runErr } = await supabase
      .from("pcp_run_logs")
      .insert({ funcao: "omie-malha-sync", status: "rodando" })
      .select("id").single();
    if (runErr) throw new Error(`pcp_run_logs insert: ${runErr.message}`);
    runId = run.id; // eleva p/ o catch fechar o run se algo lançar (não deixar 'rodando' órfão)

    let paginas = 0, registros = 0, shapeErr = 0;
    let sampleErr: unknown = null;
    const syncedAt = new Date().toISOString();

    for (let pagina = desdePagina; pagina <= MAX_PAGINAS; pagina++) {
      const resp = await omieCall("ListarEstruturas", { nPagina: pagina, nRegPorPagina: REG_POR_PAGINA });
      if (resp === null) break;                  // Omie sinalizou FIM via faultstring (não é erro)
      const lista = extractLista(resp);
      if (!lista || lista.length === 0) break;   // página vazia — nunca confiar em total_de_paginas
      paginas++;

      // dedupe DENTRO da página: upsert com PK repetida no MESMO statement quebra
      // ("cannot affect row a second time"); entre páginas o upsert resolve.
      const byCod = new Map<number, Record<string, unknown>>();
      for (const item of lista) {
        const cod = extractPaiCodigo(item);
        if (Number.isNaN(cod)) { shapeErr++; sampleErr ??= item; continue; }
        byCod.set(cod, { omie_codigo_produto: cod, payload: item, sync_run_id: runId, synced_at: syncedAt });
      }
      const rows = [...byCod.values()];
      if (rows.length > 0) {
        const { error } = await supabase.from("pcp_malha_staging")
          .upsert(rows, { onConflict: "omie_codigo_produto" });
        if (error) throw new Error(`upsert staging p.${pagina}: ${error.message}`);
        registros += rows.length;
      }
      if (lista.length < REG_POR_PAGINA) break; // página incompleta = última
    }

    // Limpeza de órfãos (painel Codex P1: estrutura removida no Omie ficaria eterna no staging)
    // com guarda de plausibilidade (painel Gemini: página vazia prematura = truncamento silencioso —
    // NUNCA limpar se este run veio anormalmente menor que o último ok).
    // LIMITAÇÃO CONHECIDA (painel, Important #3): a limpeza de órfãos só roda no caminho normal
    // (desde_pagina === 1). Um sync que precisou de RESUME (raro: ~40 páginas cabem em 1 execução)
    // não limpa — estruturas removidas no Omie sobrevivem até o próximo sync completo sem resume.
    // Não corrompe (só deixa órfão a mais); a reconciliação da Fase 2 (cron + frescor) fecha isso.
    let limpos = 0, limpezaPulada = false;
    if (shapeErr === 0 && desdePagina === 1) {
      const { data: ultimoOk } = await supabase.from("pcp_run_logs")
        .select("registros").eq("funcao", "omie-malha-sync").eq("status", "ok")
        .not("registros", "is", null).order("id", { ascending: false }).limit(1).maybeSingle();
      const plausivel = !ultimoOk?.registros || registros >= 0.9 * ultimoOk.registros;
      if (plausivel) {
        // sync_run_id é NOT NULL (M1) → .neq apaga TODOS os outros runs sem furo NULL-blind.
        const { count, error: delErr } = await supabase.from("pcp_malha_staging")
          .delete({ count: "exact" }).neq("sync_run_id", runId);
        if (delErr) throw new Error(`limpeza de órfãos: ${delErr.message}`);
        limpos = count ?? 0;
      } else {
        limpezaPulada = true; // run muito menor que o histórico: manter órfãos e ACUSAR
      }
    }

    const status = shapeErr > 0 ? "erro" : "ok";
    await supabase.from("pcp_run_logs").update({
      finished_at: new Date().toISOString(), status, paginas, registros,
      // itens_vistos ≠ registros quando há shape_err: separa "volume gravado" de "volume processado"
      detalhe: { shape_err: shapeErr, sample_err: sampleErr, itens_vistos: registros + shapeErr,
        orfaos_limpos: limpos, limpeza_pulada: limpezaPulada },
    }).eq("id", runId);

    return new Response(JSON.stringify({
      ok: status === "ok", paginas, registros, shape_err: shapeErr,
      orfaos_limpos: limpos, limpeza_pulada: limpezaPulada,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // fecha o run como 'erro' (best-effort) — sem isso ele fica 'rodando' órfão e o Sentinela lê "motor travado"
    if (runId !== null) {
      await supabase.from("pcp_run_logs")
        .update({ finished_at: new Date().toISOString(), status: "erro", detalhe: { erro: msg } })
        .eq("id", runId).then(() => {}, () => {});
    }
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
```

- [ ] **Step 3.2: Lint local**

Run: `bun lint > /tmp/lint.log 2>&1; echo "exit=$?"`
Expected: `exit=0` (o eslint da casa cobre `supabase/functions/`).

- [ ] **Step 3.3: Commit**

```bash
git add supabase/functions/omie-malha-sync/index.ts
git commit -m "feat(pcp): edge omie-malha-sync — probe de shape + sync da malha até página vazia"
```

---

### Task 4: Deploy M1 + probe + sync em prod (checkpoint com o FOUNDER)

**Files:** nenhum (operação). Passos marcados **[FOUNDER]** dependem dele; o resto eu executo.

- [ ] **Step 4.1 [FOUNDER]: aplicar M1 no SQL Editor**

Founder cola `db/pcp-f1a-m1-staging.sql` no SQL Editor do Lovable (runbook `docs/runbooks/lovable-supabase.md`). Sucesso esperado: `COMMIT` sem erro.

- [ ] **Step 4.2: verificar M1 aplicado (psql-ro)**

Run:
```bash
~/.config/afiacao/psql-ro -c "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('pcp_malha_staging','pcp_run_logs');"
```
Expected: 2 linhas, ambas `relrowsecurity = t`.

- [ ] **Step 4.3 [FOUNDER]: deploy do edge pelo chat do Lovable**

Founder pede o deploy de `omie-malha-sync` no chat do Lovable (código já commitado no repo). Merge na main ≠ produção — este passo é OBRIGATÓRIO.

- [ ] **Step 4.4 [FOUNDER]: rodar o probe (travar o shape)**

Founder executa (com o secret de cron dele):
```bash
curl -sS -X POST "https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-malha-sync" \
  -H "Content-Type: application/json" -H "x-cron-secret: $CRON_SECRET" \
  -d '{"action":"probe"}'
```
Expected: JSON com `topKeys`, `itemKeys`, `identKeys`, `sampleItem`. **Colar a resposta na sessão.**

- [ ] **Step 4.5: travar o shape (decisão registrada)**

Comparar `identKeys`/`itemKeys` do probe com os candidatos usados em `extractPaiCodigo` (edge) e nas expressões jsonb de `vw_pcp_malha_itens` (Task 5). Se divergirem: ajustar SOMENTE (a) a cadeia de candidatos do edge se o código-pai não for capturado, e (b) as expressões da view no M2 — e registrar o shape real num comentário no topo de `db/pcp-f1a-m2-nucleo.sql`. Commit do ajuste se houver.

- [ ] **Step 4.6 [FOUNDER]: rodar o sync completo**

```bash
curl -sS -X POST "https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-malha-sync" \
  -H "Content-Type: application/json" -H "x-cron-secret: $CRON_SECRET" \
  -d '{"action":"sync"}'
```
Expected: `{"ok":true, "paginas":N, "registros":M, "shape_err":0, "orfaos_limpos":0, "limpeza_pulada":false}` com M ≥ ~1.400 (cintas) — provavelmente ~1.7–2.0k somando discos/tingidores/rolos (~40 páginas ≈ 30-40s, dentro do limite do edge). Se o edge estourar tempo: re-invocar com `{"action":"sync","desde_pagina":<última página do run log + 1>}`. `limpeza_pulada:true` = o run veio <90% do último ok → investigar (truncamento silencioso do Omie) antes de confiar no staging.

- [ ] **Step 4.7: verificar cobertura do staging (psql-ro)**

Run:
```bash
~/.config/afiacao/psql-ro -c "
SELECT p.familia, count(*) AS com_malha
FROM pcp_malha_staging s JOIN omie_products p
  ON p.omie_codigo_produto = s.omie_codigo_produto AND p.account='colacor'
GROUP BY p.familia ORDER BY com_malha DESC LIMIT 15;" \
-c "SELECT jsonb_pretty(payload) FROM pcp_malha_staging LIMIT 1;" \
-c "SELECT status, paginas, registros, detalhe FROM pcp_run_logs ORDER BY id DESC LIMIT 3;"
```
Expected: `Cintas Estreitas` com ~1.4k; famílias de disco e `Tingidor Tingimix` presentes (founder confirmou estrutura nas 3 famílias); run `ok` com `shape_err: 0`. Se cintas com malha << 1.4k → investigar ANTES de seguir (malha incompleta muda a destilação).

---

### Task 5: SQL M2 — extração + parser + `pcp_itens` + destilação + validação

**Files:**
- Create: `db/pcp-f1a-m2-nucleo.sql`

Contratos travados (usados também nas provas das Tasks 6–7 — manter nomes EXATOS):
- `fn_pcp_parse_dimensoes(p_descricao text) → TABLE (largura_mm int, comprimento_mm int, grao int, diametro_mm int, formato text)` com `formato ∈ ('dimensional','disco','sem_match')`.
- `fn_pcp_refresh_itens() → TABLE (total int, dimensionais int, discos int, sem_match int)`.
- `fn_pcp_papel_componente(p_descricao text, p_familia text) → text ∈ ('abrasivo_base','cola','catalisador','fita','outro')`.
- `fn_pcp_destilar_bom() → int` (nº de regras derivadas); `fn_pcp_materializar_excecoes() → int` (nº de exceções abertas).
- Escopo da destilação v1: pais `cinta` e `rolo` (dimensionais). Discos/tingidores entram no relatório da Task 8 e, se a malha deles for por área/fórmula, viram um M3 pequeno (decisão com o founder no gate).

- [ ] **Step 5.1: Escrever o SQL do M2**

Conteúdo COMPLETO de `db/pcp-f1a-m2-nucleo.sql`:

```sql
-- PCP Fase 1A — M2: extração da malha + parser dimensional + pcp_itens + destilação paramétrica.
-- Aplicar no SQL Editor do Lovable (founder), DEPOIS do M1 + sync (staging populado).
-- SHAPE LOCK: expressões jsonb abaixo assumem itens em payload->'itens' com campos
--   ident.idProdMalha / ident.codProdMalha / ident.descrProdMalha / quantProdMalha / unidProdMalha.
--   Confirmado/ajustado no probe (plano Task 4.5). Divergiu? Ajustar SÓ vw_pcp_malha_itens.
-- Spec: docs/superpowers/specs/2026-07-03-pcp-colacor-blueprint-design.md (§3 Camadas 0 e 4; Gate 0 Codex #7)
BEGIN;

-- ── 0) Config ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pcp_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.pcp_config (key, value) VALUES
  ('tolerancia_abrasivo', '0.005'),   -- área nominal deve bater quase exata (0,5%)
  ('tolerancia_insumo',   '0.05'),    -- cola/catalisador/fita: 5%
  ('min_amostras_regra',  '3'),       -- linha com menos amostras usa a regra global '*'
  ('dispersao_max_regra', '0.10')     -- regra com MAD relativa acima disto é INSTÁVEL (não valida ninguém)
ON CONFLICT (key) DO NOTHING;

-- Número tolerante (painel Codex P1): Omie pode mandar '1,611', '' ou lixo — cast direto
-- derrubaria a VIEW inteira. Inválido ⇒ NULL (nunca fabricar), o status da validação acusa.
CREATE OR REPLACE FUNCTION public.fn_pcp_num(p_raw text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
SELECT CASE
  WHEN v ~ '^-?\d+(\.\d+)?$' THEN v::numeric
END
FROM (SELECT replace(trim(coalesce(p_raw,'')), ',', '.') AS v) t
$$;

-- ── 1) Extração da malha (TODO o mapeamento de shape vive AQUI) ────────────
CREATE OR REPLACE VIEW public.vw_pcp_malha_itens
WITH (security_invoker = true) AS
SELECT
  s.omie_codigo_produto AS pai_codigo,
  NULLIF(COALESCE(i->'ident'->>'idProdMalha', i->'ident'->>'idMalha', i->>'idProdMalha'), '')::bigint
    AS componente_id,
  COALESCE(i->'ident'->>'codProdMalha', i->>'codProdMalha')       AS componente_codigo_txt,
  COALESCE(i->'ident'->>'descrProdMalha', i->>'descrProdMalha')   AS componente_descricao_omie,
  fn_pcp_num(COALESCE(i->>'quantProdMalha', i->>'quantidade'))    AS quantidade,
  upper(COALESCE(i->>'unidProdMalha', i->>'unidade'))             AS unidade,
  fn_pcp_num(i->>'percPerdaProdMalha')                            AS perc_perda
FROM public.pcp_malha_staging s
CROSS JOIN LATERAL jsonb_array_elements(
  -- array-aware (painel Codex): COALESCE pegaria 'itens' VAZIO e nunca cairia no fallback
  CASE
    WHEN jsonb_typeof(s.payload->'itens') = 'array' AND jsonb_array_length(s.payload->'itens') > 0
      THEN s.payload->'itens'
    WHEN jsonb_typeof(s.payload->'itensMalha') = 'array'
      THEN s.payload->'itensMalha'
    ELSE '[]'::jsonb
  END
) AS i;

-- Resolve o componente contra omie_products (por id Omie; fallback por codigo string).
CREATE OR REPLACE VIEW public.vw_pcp_malha_componentes
WITH (security_invoker = true) AS
SELECT
  m.pai_codigo, m.quantidade, m.unidade, m.perc_perda,
  COALESCE(byid.omie_codigo_produto, bycod.omie_codigo_produto)      AS componente_codigo,
  COALESCE(byid.descricao, bycod.descricao, m.componente_descricao_omie) AS componente_descricao,
  COALESCE(byid.familia, bycod.familia)                              AS componente_familia
FROM public.vw_pcp_malha_itens m
LEFT JOIN public.omie_products byid
  ON byid.omie_codigo_produto = m.componente_id AND byid.account = 'colacor'
-- fallback por codigo (string) SÓ quando o id Omie falta. codigo é NOT NULL mas NÃO único →
-- join simples faria fan-out (1 linha de malha × N produtos com mesmo codigo), dobrando a razão
-- na mediana/MAD (money-path). LATERAL + ORDER BY + LIMIT 1 pega 1 determinístico (guarda estrutural,
-- não depende do pré-flight manual sobreviver a syncs futuros).
LEFT JOIN LATERAL (
  SELECT bp.omie_codigo_produto, bp.descricao, bp.familia
  FROM public.omie_products bp
  WHERE m.componente_id IS NULL AND bp.codigo = m.componente_codigo_txt AND bp.account = 'colacor'
  ORDER BY bp.omie_codigo_produto
  LIMIT 1
) bycod ON true;

-- ── 2) Parser dimensional (NUNCA fabrica: sem match ⇒ NULL + formato explícito) ──
CREATE OR REPLACE FUNCTION public.fn_pcp_parse_dimensoes(p_descricao text)
RETURNS TABLE (largura_mm int, comprimento_mm int, grao int, diametro_mm int, formato text)
LANGUAGE sql IMMUTABLE AS $$
WITH d AS (SELECT upper(coalesce(p_descricao,'')) AS s),
dims AS (SELECT regexp_match((SELECT s FROM d), '\m(\d{2,4})X(\d{3,6})MM\M') AS m),
gr   AS (SELECT regexp_match((SELECT s FROM d), '\mP(\d{2,4})\M') AS m),
diam AS (SELECT regexp_match((SELECT s FROM d), '\m(\d{2,3})MM\M') AS m)
SELECT
  (SELECT m[1]::int FROM dims),
  (SELECT m[2]::int FROM dims),
  (SELECT m[1]::int FROM gr),
  CASE WHEN (SELECT m FROM dims) IS NULL AND (SELECT s FROM d) ~ '^(DISCO|BLOCO)'
       THEN (SELECT m[1]::int FROM diam) END,
  CASE WHEN (SELECT m FROM dims) IS NOT NULL THEN 'dimensional'
       WHEN (SELECT s FROM d) ~ '^(DISCO|BLOCO)' AND (SELECT m FROM diam) IS NOT NULL THEN 'disco'
       ELSE 'sem_match' END
$$;

-- ── 3) Itens PCP (dados mestres) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pcp_itens (
  omie_codigo_produto bigint PRIMARY KEY,
  empresa        text NOT NULL DEFAULT 'colacor',
  codigo         text,
  descricao      text NOT NULL,
  familia        text,
  tipo_produto   text,
  tipo_item      text NOT NULL CHECK (tipo_item IN ('cinta','rolo','jumbo','disco','tingidor','folha','outro')),
  linha_modelo   text,
  largura_mm     int,
  comprimento_mm int,
  grao           int,
  diametro_mm    int,
  formato_parse  text NOT NULL CHECK (formato_parse IN ('dimensional','disco','sem_match')),
  politica       text CHECK (politica IN ('MTS_ROLO','MTS','MTO')),  -- humano/Fase 3; refresh NÃO sobrescreve
  lote_minimo    numeric,          -- Fase 3 preenche (spec Camada 0 item 1); refresh NÃO sobrescreve
  lote_multiplo  numeric,
  leadtime_padrao_dias int,
  refreshed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pcp_itens_linha ON public.pcp_itens (linha_modelo);
CREATE INDEX IF NOT EXISTS idx_pcp_itens_tipo  ON public.pcp_itens (tipo_item);

CREATE OR REPLACE FUNCTION public.fn_pcp_refresh_itens()
RETURNS TABLE (total int, dimensionais int, discos int, sem_match int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO pcp_itens (omie_codigo_produto, empresa, codigo, descricao, familia, tipo_produto,
    tipo_item, linha_modelo, largura_mm, comprimento_mm, grao, diametro_mm, formato_parse, refreshed_at)
  SELECT p.omie_codigo_produto, 'colacor', p.codigo, p.descricao, p.familia, p.tipo_produto,
    CASE WHEN upper(p.descricao) LIKE 'CINTA %'  THEN 'cinta'
         WHEN upper(p.descricao) LIKE 'ROLO %'   THEN 'rolo'
         WHEN upper(p.descricao) LIKE 'JUMBO %'  THEN 'jumbo'
         WHEN p.familia ILIKE '%disco%'          THEN 'disco'
         WHEN p.familia = 'Tingidor Tingimix'    THEN 'tingidor'
         WHEN p.familia ILIKE '%folha%'          THEN 'folha'
         ELSE 'outro' END,
    COALESCE(NULLIF(trim(p.metadata->>'modelo'), ''),
             (regexp_match(p.descricao, '^(?:CINTA|ROLO|JUMBO)\s+(\S+)'))[1]),
    d.largura_mm, d.comprimento_mm, d.grao, d.diametro_mm, d.formato, now()
  FROM omie_products p
  CROSS JOIN LATERAL fn_pcp_parse_dimensoes(p.descricao) d
  WHERE p.account = 'colacor'
  ON CONFLICT (omie_codigo_produto) DO UPDATE SET
    codigo = EXCLUDED.codigo, descricao = EXCLUDED.descricao, familia = EXCLUDED.familia,
    tipo_produto = EXCLUDED.tipo_produto, tipo_item = EXCLUDED.tipo_item,
    linha_modelo = EXCLUDED.linha_modelo, largura_mm = EXCLUDED.largura_mm,
    comprimento_mm = EXCLUDED.comprimento_mm, grao = EXCLUDED.grao,
    diametro_mm = EXCLUDED.diametro_mm, formato_parse = EXCLUDED.formato_parse, refreshed_at = now();

  RETURN QUERY SELECT count(*)::int,
    count(*) FILTER (WHERE pcp_itens.formato_parse = 'dimensional')::int,
    count(*) FILTER (WHERE pcp_itens.formato_parse = 'disco')::int,
    count(*) FILTER (WHERE pcp_itens.formato_parse = 'sem_match')::int
  FROM pcp_itens;
END $$;

-- ── 4) Papel do componente na malha ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_pcp_papel_componente(p_descricao text, p_familia text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
SELECT CASE
  WHEN upper(coalesce(p_descricao,'')) ~ '^(ROLO|JUMBO)\s'                      THEN 'abrasivo_base'
  WHEN upper(coalesce(p_descricao,'')) ~ 'DESMODUR|CATALISADOR'
    OR coalesce(p_familia,'') ILIKE '%catalisador%'                             THEN 'catalisador'
  -- FITA antes de cola (painel Codex): "FITA ADESIVA" tem que ser fita, não cola
  WHEN upper(coalesce(p_descricao,'')) ~ '\mFITA\M'                             THEN 'fita'
  WHEN upper(coalesce(p_descricao,'')) ~ 'A455|ADESIVO|\mCOLA\M'
    OR coalesce(p_familia,'') ILIKE '%cola%' OR coalesce(p_familia,'') ILIKE '%adesivo%' THEN 'cola'
  ELSE 'outro'
END $$;

-- ── 5) Regras destiladas (BOM paramétrica) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pcp_bom_regras (
  linha_modelo text NOT NULL,   -- '*' = regra global (fallback p/ linha com poucas amostras)
  papel  text NOT NULL CHECK (papel IN ('abrasivo_base','cola','catalisador','fita')),
  metodo text NOT NULL CHECK (metodo IN ('area_nominal','g_por_mm_largura','razao_sobre_cola','cm_overlap_largura')),
  coef numeric,
  amostras int NOT NULL,
  dispersao numeric,            -- MAD relativa (mediana de |x-med|/med) — qualidade da regra
  derivado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (linha_modelo, papel)
);

CREATE OR REPLACE FUNCTION public.fn_pcp_destilar_bom()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_regras int;
  v_min int := coalesce((SELECT (value)::int FROM pcp_config WHERE key = 'min_amostras_regra'), 3);
BEGIN
  DROP TABLE IF EXISTS tmp_obs, tmp_ratio;  -- re-execução na MESMA transação não pode quebrar
  DELETE FROM pcp_bom_regras;

  -- Observações: componentes das malhas cujo PAI é cinta/rolo com dimensões parseadas.
  CREATE TEMP TABLE tmp_obs ON COMMIT DROP AS
  SELECT pai.linha_modelo, pai.omie_codigo_produto AS pai_codigo, pai.largura_mm,
         fn_pcp_papel_componente(c.componente_descricao, c.componente_familia) AS papel,
         c.quantidade, c.unidade
  FROM vw_pcp_malha_componentes c
  JOIN pcp_itens pai ON pai.omie_codigo_produto = c.pai_codigo
  WHERE pai.tipo_item IN ('cinta','rolo') AND pai.formato_parse = 'dimensional'
    AND pai.linha_modelo IS NOT NULL AND c.quantidade IS NOT NULL;

  -- Guarda (painel Codex): universo vazio NÃO pode zerar as regras boas —
  -- o RAISE reverte o DELETE acima (mesma transação).
  IF NOT EXISTS (SELECT 1 FROM tmp_obs) THEN
    RAISE EXCEPTION 'fn_pcp_destilar_bom: universo de observações VAZIO — abortando sem apagar regras (staging/refresh rodaram?)';
  END IF;

  -- Razões observadas por papel (NULL quando não se aplica — nunca inventar).
  CREATE TEMP TABLE tmp_ratio ON COMMIT DROP AS
  SELECT o.linha_modelo, o.papel,
    CASE o.papel
      WHEN 'cola'        THEN CASE WHEN o.unidade = 'G' AND o.largura_mm > 0 THEN o.quantidade / o.largura_mm END
      WHEN 'fita'        THEN CASE WHEN o.unidade = 'CM' THEN o.quantidade - o.largura_mm / 10.0 END
      WHEN 'catalisador' THEN CASE WHEN o.unidade = 'G' AND cola.quantidade > 0 THEN o.quantidade / cola.quantidade END
    END AS ratio
  FROM tmp_obs o
  LEFT JOIN LATERAL (
    -- catalisador só destila com EXATAMENTE 1 cola G no pai; 0 ou >1 (ambíguo) ⇒ NULL (não fabrica).
    -- Evita o LIMIT 1 sem ORDER BY (não-determinístico: coef mudaria entre destilações sem mudar dado).
    SELECT CASE WHEN count(*) = 1 THEN min(o2.quantidade) END AS quantidade
    FROM tmp_obs o2
    WHERE o2.pai_codigo = o.pai_codigo AND o2.papel = 'cola' AND o2.unidade = 'G'
  ) cola ON o.papel = 'catalisador'
  WHERE o.papel IN ('cola','fita','catalisador');

  -- Regras por linha (só papéis com razão) + abrasivo_base (área nominal, coef 1.0).
  INSERT INTO pcp_bom_regras (linha_modelo, papel, metodo, coef, amostras, dispersao)
  WITH med AS (
    SELECT linha_modelo, papel,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ratio) AS coef,
           count(*) AS amostras
    FROM tmp_ratio WHERE ratio IS NOT NULL
    GROUP BY linha_modelo, papel
    HAVING count(*) >= v_min
  ),
  glob AS (
    SELECT '*'::text AS linha_modelo, papel,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ratio) AS coef,
           count(*) AS amostras
    FROM tmp_ratio WHERE ratio IS NOT NULL
    GROUP BY papel
  ),
  unida AS (SELECT * FROM med UNION ALL SELECT * FROM glob)
  SELECT u.linha_modelo, u.papel,
    CASE u.papel WHEN 'cola' THEN 'g_por_mm_largura'
                 WHEN 'catalisador' THEN 'razao_sobre_cola'
                 WHEN 'fita' THEN 'cm_overlap_largura' END,
    u.coef, u.amostras,
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(r.ratio - u.coef) / NULLIF(abs(u.coef), 0))
       FROM tmp_ratio r
      WHERE r.papel = u.papel AND r.ratio IS NOT NULL
        AND (u.linha_modelo = '*' OR r.linha_modelo = u.linha_modelo))
  FROM unida u;

  INSERT INTO pcp_bom_regras (linha_modelo, papel, metodo, coef, amostras, dispersao)
  SELECT o.linha_modelo, 'abrasivo_base', 'area_nominal', 1.0, count(*), NULL::numeric
  FROM tmp_obs o WHERE o.papel = 'abrasivo_base' AND o.unidade = 'M2'
  GROUP BY o.linha_modelo
  UNION ALL
  SELECT '*', 'abrasivo_base', 'area_nominal', 1.0, count(*), NULL::numeric
  FROM tmp_obs o WHERE o.papel = 'abrasivo_base' AND o.unidade = 'M2';

  SELECT count(*) INTO v_regras FROM pcp_bom_regras;
  RETURN v_regras;
END $$;

-- ── 6) Validação: a fórmula reproduz a malha? ──────────────────────────────
CREATE OR REPLACE VIEW public.vw_pcp_bom_validacao
WITH (security_invoker = true) AS
WITH comp AS (
  SELECT c.*, pai.linha_modelo, pai.largura_mm, pai.comprimento_mm, pai.formato_parse,
         pai.descricao AS pai_descricao, pai.tipo_item AS pai_tipo,
         fn_pcp_papel_componente(c.componente_descricao, c.componente_familia) AS papel
  FROM vw_pcp_malha_componentes c
  JOIN pcp_itens pai ON pai.omie_codigo_produto = c.pai_codigo
  WHERE pai.tipo_item IN ('cinta','rolo')
),
com_regra AS (
  SELECT comp.*, r.coef, r.metodo, r.dispersao AS regra_dispersao,
    CASE WHEN r.linha_modelo = comp.linha_modelo THEN 'linha' WHEN r.linha_modelo = '*' THEN 'global' END AS regra_origem,
    -- nº de colas G no pai: >1 ⇒ base do catalisador é AMBÍGUA (não escolher às cegas — status próprio).
    (SELECT count(*) FROM comp c2
      WHERE c2.pai_codigo = comp.pai_codigo AND c2.papel = 'cola' AND c2.unidade = 'G') AS n_cola_pai,
    -- qtd_cola_pai só é definida com EXATAMENTE 1 cola (determinístico); 0 ou >1 ⇒ NULL.
    (SELECT CASE WHEN count(*) = 1 THEN min(c2.quantidade) END FROM comp c2
      WHERE c2.pai_codigo = comp.pai_codigo AND c2.papel = 'cola' AND c2.unidade = 'G') AS qtd_cola_pai
  FROM comp
  LEFT JOIN LATERAL (
    SELECT coef, metodo, dispersao, linha_modelo FROM pcp_bom_regras r
    WHERE r.papel = comp.papel AND r.linha_modelo IN (comp.linha_modelo, '*')
    ORDER BY (r.linha_modelo = comp.linha_modelo) DESC
    LIMIT 1
  ) r ON comp.papel <> 'outro'
)
SELECT pai_codigo, pai_descricao, pai_tipo, linha_modelo, largura_mm, comprimento_mm,
  componente_codigo, componente_descricao, papel, quantidade AS observado, unidade, regra_origem,
  CASE
    WHEN formato_parse <> 'dimensional' THEN NULL
    WHEN papel = 'abrasivo_base' AND unidade = 'M2' THEN largura_mm::numeric * comprimento_mm / 1e6
    WHEN papel = 'cola'        AND unidade = 'G'  AND metodo = 'g_por_mm_largura'   THEN coef * largura_mm
    WHEN papel = 'catalisador' AND unidade = 'G'  AND metodo = 'razao_sobre_cola'   THEN coef * qtd_cola_pai
    WHEN papel = 'fita'        AND unidade = 'CM' AND metodo = 'cm_overlap_largura' THEN largura_mm / 10.0 + coef
  END AS esperado,
  CASE WHEN papel = 'abrasivo_base'
       THEN coalesce((SELECT (value)::numeric FROM pcp_config WHERE key = 'tolerancia_abrasivo'), 0.005)
       ELSE coalesce((SELECT (value)::numeric FROM pcp_config WHERE key = 'tolerancia_insumo'), 0.05)
  END AS tolerancia,
  CASE
    WHEN formato_parse <> 'dimensional' THEN 'sem_dims'
    WHEN papel = 'outro' THEN 'papel_desconhecido'
    WHEN papel = 'abrasivo_base' AND unidade IS DISTINCT FROM 'M2' THEN 'unidade_inesperada'
    WHEN papel IN ('cola','catalisador') AND unidade IS DISTINCT FROM 'G' THEN 'unidade_inesperada'
    WHEN papel = 'fita' AND unidade IS DISTINCT FROM 'CM' THEN 'unidade_inesperada'
    WHEN coef IS NULL AND papel <> 'abrasivo_base' THEN 'sem_regra'
    -- >1 cola G no pai: base ambígua ANTES de sem_base_cola (que é o caso n=0) — Codex/Caminho B
    WHEN papel = 'catalisador' AND n_cola_pai > 1 THEN 'cola_ambigua'
    WHEN papel = 'catalisador' AND qtd_cola_pai IS NULL THEN 'sem_base_cola'
    -- regra instável (painel Claude P1 + Codex): dispersão alta = mediana possivelmente
    -- contaminada na 1ª destilação — NÃO valida ninguém; revisão humana.
    -- SÓ para regra de LINHA (ruído real dentro de um grupo homogêneo). Na regra GLOBAL '*'
    -- a dispersão alta é heterogeneidade LEGÍTIMA entre linhas (é o motivo de existir coef por
    -- linha) — puni-la marcaria toda linha rala como instável por construção. O fallback global
    -- valida (ou vira excecao pelo valor) e o relatório da Task 8 já reporta a % de origem global.
    WHEN papel <> 'abrasivo_base' AND regra_origem = 'linha' AND regra_dispersao >
         coalesce((SELECT (value)::numeric FROM pcp_config WHERE key = 'dispersao_max_regra'), 0.10)
      THEN 'regra_instavel'
    WHEN quantidade IS NULL THEN 'sem_quantidade'
    WHEN abs(quantidade - (CASE
        WHEN papel = 'abrasivo_base' THEN largura_mm::numeric * comprimento_mm / 1e6
        WHEN papel = 'cola' THEN coef * largura_mm
        WHEN papel = 'catalisador' THEN coef * qtd_cola_pai
        WHEN papel = 'fita' THEN largura_mm / 10.0 + coef END))
       / NULLIF((CASE
        WHEN papel = 'abrasivo_base' THEN largura_mm::numeric * comprimento_mm / 1e6
        WHEN papel = 'cola' THEN coef * largura_mm
        WHEN papel = 'catalisador' THEN coef * qtd_cola_pai
        WHEN papel = 'fita' THEN largura_mm / 10.0 + coef END), 0)
      <= (CASE WHEN papel = 'abrasivo_base'
           THEN coalesce((SELECT (value)::numeric FROM pcp_config WHERE key = 'tolerancia_abrasivo'), 0.005)
           ELSE coalesce((SELECT (value)::numeric FROM pcp_config WHERE key = 'tolerancia_insumo'), 0.05) END)
      THEN 'ok'
    ELSE 'excecao'
  END AS status
FROM com_regra;

-- ── 7) Exceções materializadas (fila de revisão do founder) ────────────────
CREATE TABLE IF NOT EXISTS public.pcp_bom_excecoes (
  pai_codigo bigint NOT NULL,
  componente_codigo bigint,
  papel text NOT NULL,
  pai_descricao text,
  componente_descricao text,
  observado numeric,
  esperado numeric,
  unidade text,
  status text NOT NULL,
  materializado_em timestamptz NOT NULL DEFAULT now(),
  disposicao text CHECK (disposicao IN ('aceitar','corrigir_omie','regra_especifica')),
  disposicao_nota text,
  PRIMARY KEY (pai_codigo, papel, componente_codigo)
);

CREATE OR REPLACE FUNCTION public.fn_pcp_materializar_excecoes()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v int;
BEGIN
  DELETE FROM pcp_bom_excecoes WHERE disposicao IS NULL;
  INSERT INTO pcp_bom_excecoes (pai_codigo, componente_codigo, papel, pai_descricao,
    componente_descricao, observado, esperado, unidade, status)
  SELECT pai_codigo, coalesce(componente_codigo, 0), papel, pai_descricao,
    componente_descricao, observado, esperado, unidade, status
  FROM vw_pcp_bom_validacao
  WHERE status IN ('excecao','sem_regra','unidade_inesperada','papel_desconhecido','sem_quantidade','sem_base_cola','regra_instavel','cola_ambigua')
  ON CONFLICT (pai_codigo, papel, componente_codigo) DO UPDATE
    SET observado = EXCLUDED.observado, esperado = EXCLUDED.esperado,
        status = EXCLUDED.status, materializado_em = now();
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END $$;

-- Helper de triagem (painel Gemini P1 — fricção do founder): 1 chamada em vez de UPDATE cru.
-- SECURITY DEFINER com gate de staff INTERNO (fail-closed); chamável por RPC do app no futuro.
CREATE OR REPLACE FUNCTION public.fn_pcp_dispor_excecao(
  p_pai bigint, p_papel text, p_componente bigint, p_disposicao text, p_nota text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Gate de staff. auth.uid() lê o GUC do JWT e funciona sob SECURITY DEFINER;
  -- current_user NÃO serve (em SECURITY DEFINER é o OWNER=postgres → furaria o gate, deixando
  -- QUALQUER authenticated dispor). auth.uid() NULL = sem JWT (postgres no SQL Editor / service_role):
  -- chamada confiável, permitida. authenticated COM uid não-staff é barrado.
  IF (SELECT auth.uid()) IS NOT NULL
     AND NOT (has_role((SELECT auth.uid()), 'master'::app_role)
           OR has_role((SELECT auth.uid()), 'employee'::app_role)) THEN
    RAISE EXCEPTION 'fn_pcp_dispor_excecao: apenas staff';
  END IF;
  UPDATE pcp_bom_excecoes
     SET disposicao = p_disposicao, disposicao_nota = p_nota
   WHERE pai_codigo = p_pai AND papel = p_papel AND componente_codigo = coalesce(p_componente, 0);
  RETURN FOUND;
END $$;

-- ── 8) RLS + grants ────────────────────────────────────────────────────────
ALTER TABLE public.pcp_config       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pcp_itens        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pcp_bom_regras   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pcp_bom_excecoes ENABLE ROW LEVEL SECURITY;

-- DROP IF EXISTS antes de cada policy: re-colar no SQL Editor é esperado (mesma regra do M1).
DROP POLICY IF EXISTS pcp_config_select_staff ON public.pcp_config;
CREATE POLICY pcp_config_select_staff ON public.pcp_config FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role));
DROP POLICY IF EXISTS pcp_itens_select_staff ON public.pcp_itens;
CREATE POLICY pcp_itens_select_staff ON public.pcp_itens FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role));
DROP POLICY IF EXISTS pcp_bom_regras_select_staff ON public.pcp_bom_regras;
CREATE POLICY pcp_bom_regras_select_staff ON public.pcp_bom_regras FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role));
DROP POLICY IF EXISTS pcp_bom_excecoes_select_staff ON public.pcp_bom_excecoes;
CREATE POLICY pcp_bom_excecoes_select_staff ON public.pcp_bom_excecoes FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role));
-- founder marca disposição pela UI futura; hoje SQL Editor. Policy de UPDATE restrita a staff:
DROP POLICY IF EXISTS pcp_bom_excecoes_update_staff ON public.pcp_bom_excecoes;
CREATE POLICY pcp_bom_excecoes_update_staff ON public.pcp_bom_excecoes FOR UPDATE TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))
  WITH CHECK (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role));

REVOKE ALL ON public.pcp_config, public.pcp_itens, public.pcp_bom_regras, public.pcp_bom_excecoes FROM anon;
REVOKE ALL ON public.pcp_config, public.pcp_itens, public.pcp_bom_regras, public.pcp_bom_excecoes FROM authenticated;
GRANT SELECT ON public.pcp_config, public.pcp_itens, public.pcp_bom_regras, public.pcp_bom_excecoes TO authenticated;
GRANT UPDATE (disposicao, disposicao_nota) ON public.pcp_bom_excecoes TO authenticated;

REVOKE ALL ON public.vw_pcp_malha_itens, public.vw_pcp_malha_componentes, public.vw_pcp_bom_validacao FROM anon;
GRANT SELECT ON public.vw_pcp_malha_itens, public.vw_pcp_malha_componentes, public.vw_pcp_bom_validacao TO authenticated;

-- Funções mutadoras: só service_role/postgres (gate na fronteira; edge/SQL Editor).
REVOKE EXECUTE ON FUNCTION public.fn_pcp_refresh_itens() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_pcp_destilar_bom() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_pcp_materializar_excecoes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pcp_parse_dimensoes(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pcp_papel_componente(text, text) TO authenticated;
-- dispor_excecao: gate de staff é INTERNO (fail-closed) — anon fora, authenticated pode chamar
REVOKE EXECUTE ON FUNCTION public.fn_pcp_dispor_excecao(bigint, text, bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_pcp_dispor_excecao(bigint, text, bigint, text, text) TO authenticated;

COMMIT;
```

- [ ] **Step 5.2: Pré-flight de colisão (regra da casa p/ CREATE OR REPLACE)**

Run (confirmar que NENHUM objeto do M2 já existe em prod — são todos novos — e que o fallback por `codigo` é seguro):
```bash
~/.config/afiacao/psql-ro -c "SELECT viewname FROM pg_views WHERE viewname LIKE 'vw_pcp_%';" \
  -c "SELECT proname FROM pg_proc WHERE proname LIKE 'fn_pcp_%';" \
  -c "SELECT tablename FROM pg_tables WHERE tablename LIKE 'pcp_%';" \
  -c "SELECT codigo, count(*) FROM omie_products WHERE account='colacor' AND codigo IS NOT NULL GROUP BY 1 HAVING count(*)>1 LIMIT 5;"
```
Expected: só os objetos do M1 (`pcp_run_logs`, `pcp_malha_staging`) — nada de `vw_pcp_*`/`fn_pcp_*` — e ZERO `codigo` duplicado (painel: dup faria o fallback do join duplicar linhas de malha; se houver, trocar o fallback por `DISTINCT ON (codigo)` antes de aplicar). Se aparecer objeto pcp novo: outra sessão/worktree tocou o namespace → PARAR e coordenar (regra multi-sessão).

- [ ] **Step 5.3: Commit**

```bash
git add db/pcp-f1a-m2-nucleo.sql
git commit -m "feat(pcp): F1A M2 — extração da malha + parser dimensional + pcp_itens + destilação paramétrica com validação"
```

---

### Task 6: Prova PG17 do parser (golden set REAL + falsificação)

**Files:**
- Create: `db/test-pcp-parser-dimensoes.sh`

- [ ] **Step 6.1: Escrever o script**

Conteúdo COMPLETO de `db/test-pcp-parser-dimensoes.sh`:

```bash
#!/usr/bin/env bash
# Prova PG17 — fn_pcp_parse_dimensoes: golden set com descrições REAIS de prod.
# Rodar: bash db/test-pcp-parser-dimensoes.sh > /tmp/t-parser.log 2>&1; echo "exit=$?"
# Lei de Ferro: aplica M1+M2 REAIS; golden asserts; FALSIFICA (sabota a regex → golden TEM que quebrar).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5472}"
SLUG="pcp-parser"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA -q "$@"; }  # -q OBRIGATÓRIO: sem ele, "SET ...; SELECT ..." vaza linhas SET na captura

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ ZONA 1: pré-requisitos + stub de omie_products (view do M2 referencia) ═══"
P -q <<'SQL'
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
CREATE TABLE public.omie_products (omie_codigo_produto bigint PRIMARY KEY, codigo text, descricao text,
  familia text, tipo_produto text, account text, metadata jsonb NOT NULL DEFAULT '{}');
SQL

echo "═══ ZONA 2: aplica M1 + M2 REAIS (ordem/dependência provadas) ═══"
P -q -f "$REPO_ROOT/db/pcp-f1a-m1-staging.sql"
P -q -f "$REPO_ROOT/db/pcp-f1a-m2-nucleo.sql"

echo "═══ ZONA 3: golden set (descrições REAIS; formato largura|comprimento|grao|diametro|formato) ═══"
gold() { # $1 descricao  $2 esperado
  local got
  got=$(Pq -c "SELECT coalesce(largura_mm::text,'-')||'|'||coalesce(comprimento_mm::text,'-')||'|'||coalesce(grao::text,'-')||'|'||coalesce(diametro_mm::text,'-')||'|'||formato FROM fn_pcp_parse_dimensoes(\$\$$1\$\$)")
  eq "parse: $1" "$got" "$2"
}
gold "CINTA KA169 150X6200MM P50"            "150|6200|50|-|dimensional"
gold "CINTA 2909 75X533MM P220"              "75|533|220|-|dimensional"
gold "CINTA XZ667 75X1000MM P50"             "75|1000|50|-|dimensional"
gold "JUMBO AC768 1410X100000MM P1500"       "1410|100000|1500|-|dimensional"
gold "ROLO 2909 600X2300MM P60"              "600|2300|60|-|dimensional"
gold "DISCO DE LIXA 1944 180MM P80"          "-|-|80|180|disco"
gold "DISCO DE LIXA CTN 152MM C/F P320"      "-|-|320|152|disco"
gold "TINGIDOR MEL ESCURO TEH 3505.162FG"    "-|-|-|-|sem_match"
gold "RL SAITAC 5G GR 320 - 1600 X 050M"     "-|-|-|-|sem_match"
gold "BLOCO DE LIXA 2988 RODA150X50X46 P100" "-|-|100|-|sem_match"
gold "DISCO DIAMANTADO CLASSIC TURBO 110X20MM" "-|-|-|-|sem_match"
gold "cinta ka169 150x6200mm p50"             "150|6200|50|-|dimensional"
eq "parse: NULL não explode" "$(Pq -c "SELECT formato FROM fn_pcp_parse_dimensoes(NULL)")" "sem_match"

echo "═══ ZONA 4: FALSIFICAÇÃO (regex sabotada ⇒ golden TEM que divergir) ═══"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fn_pcp_parse_dimensoes(p_descricao text)
RETURNS TABLE (largura_mm int, comprimento_mm int, grao int, diametro_mm int, formato text)
LANGUAGE sql IMMUTABLE AS $f$
WITH d AS (SELECT upper(coalesce(p_descricao,'')) AS s),
dims AS (SELECT regexp_match((SELECT s FROM d), '\m(\d{2,4})Y(\d{3,6})MM\M') AS m),  -- SABOTADO: X→Y
gr   AS (SELECT regexp_match((SELECT s FROM d), '\mP(\d{2,4})\M') AS m),
diam AS (SELECT regexp_match((SELECT s FROM d), '\m(\d{2,3})MM\M') AS m)
SELECT (SELECT m[1]::int FROM dims), (SELECT m[2]::int FROM dims), (SELECT m[1]::int FROM gr),
  CASE WHEN (SELECT m FROM dims) IS NULL AND (SELECT s FROM d) ~ '^(DISCO|BLOCO)' THEN (SELECT m[1]::int FROM diam) END,
  CASE WHEN (SELECT m FROM dims) IS NOT NULL THEN 'dimensional'
       WHEN (SELECT s FROM d) ~ '^(DISCO|BLOCO)' AND (SELECT m FROM diam) IS NOT NULL THEN 'disco'
       ELSE 'sem_match' END
$f$;
SQL
SAB=$(Pq -c "SELECT formato FROM fn_pcp_parse_dimensoes('CINTA KA169 150X6200MM P50')")
if [ "$SAB" = "sem_match" ]; then ok "FALSIFICAÇÃO: sabotagem detectada pelo golden (dimensional→sem_match)"; else bad "FALSIFICAÇÃO NÃO detectou sabotagem (veio $SAB)"; fi
# restaura aplicando o M2 real de novo (CREATE OR REPLACE)
P -q -f "$REPO_ROOT/db/pcp-f1a-m2-nucleo.sql"
eq "restaurado após falsificação" "$(Pq -c "SELECT formato FROM fn_pcp_parse_dimensoes('CINTA KA169 150X6200MM P50')")" "dimensional"

echo ""
echo "RESULTADO: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 6.2: Rodar (vermelho esperado ANTES do M2 existir; verde depois)**

Run: `bash db/test-pcp-parser-dimensoes.sh > /tmp/t-parser.log 2>&1; echo "exit=$?"`
Expected: `exit=0`, `PASS=15 FAIL=0` (13 golden — incluindo minúsculas, que o `upper()` interno cobre — + falsificação + restauração). Se qualquer golden divergir: ajustar a REGEX (nunca o esperado — os esperados são fatos de prod). **Decisão registrada (painel):** formato com espaços fora do padrão (`150 X 6200 MM`) fica `sem_match` de propósito — vira revisão humana, nunca chute.

- [ ] **Step 6.3: shellcheck + commit**

```bash
shellcheck db/test-pcp-parser-dimensoes.sh
git add db/test-pcp-parser-dimensoes.sh
git commit -m "test(pcp): golden set do parser dimensional (descrições reais) com falsificação"
```

---

### Task 7: Prova PG17 da destilação (malha REAL do print + sabotagem)

**Files:**
- Create: `db/test-pcp-f1a-destilacao.sh`

A fixture usa os NÚMEROS REAIS do print validado (CINTA KA169 150X6200MM P50: rolo 0,93 M2 = área nominal exata; cola A455 1,611 G; Desmodur 0,179 G ≈ 1/9; fita 16,9 CM = 15,0 + 1,9 de overlap) + 2 cintas sintéticas da MESMA linha coerentes com esses coeficientes — a prova exige que a destilação RECUPERE os coeficientes (0,01074 g/mm; razão 0,1111; overlap 1,9) e que a validação dê 100% ok. A sabotagem injeta uma 4ª cinta com cola 10× e exige exceção.

- [ ] **Step 7.1: Escrever o script**

Conteúdo COMPLETO de `db/test-pcp-f1a-destilacao.sh`:

```bash
#!/usr/bin/env bash
# Prova PG17 — destilação da BOM: recupera coeficientes da malha REAL (print KA169) e pega malha podre.
# Rodar: bash db/test-pcp-f1a-destilacao.sh > /tmp/t-dest.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="pcp-dest"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA -q "$@"; }  # -q OBRIGATÓRIO: sem ele, "SET ...; SELECT ..." vaza linhas SET na captura

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ ZONA 1: pré-requisitos + stub omie_products ═══"
P -q <<'SQL'
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, anon;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
CREATE TABLE public.omie_products (omie_codigo_produto bigint PRIMARY KEY, codigo text, descricao text,
  familia text, tipo_produto text, account text, metadata jsonb NOT NULL DEFAULT '{}');
-- staff (aaaa) e não-staff (bbbb) para a matriz RLS da ZONA 6
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000aaaa','employee');
SQL

echo "═══ ZONA 2: aplica M1 + M2 REAIS (M2 2×: re-colar no SQL Editor é esperado) ═══"
P -q -f "$REPO_ROOT/db/pcp-f1a-m1-staging.sql"
P -q -f "$REPO_ROOT/db/pcp-f1a-m2-nucleo.sql"
if P -q -f "$REPO_ROOT/db/pcp-f1a-m2-nucleo.sql" >/dev/null 2>&1; then ok "M2 re-aplicável (2ª colagem não quebra)"; else bad "M2 re-aplicação QUEBROU"; fi

echo "═══ ZONA 3: fixtures — produtos + 3 malhas KA169 (1 REAL do print + 2 sintéticas coerentes) ═══"
P -q <<'SQL'
-- sync_run_id é NOT NULL (M1): cria 1 run e dá DEFAULT temporário p/ os INSERTs de staging
-- (que omitem a coluna) não violarem a constraint — sem tocar nas tuplas de payload.
INSERT INTO public.pcp_run_logs (id, funcao, status) OVERRIDING SYSTEM VALUE VALUES (1,'omie-malha-sync','ok');
ALTER TABLE public.pcp_malha_staging ALTER COLUMN sync_run_id SET DEFAULT 1;
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, familia, tipo_produto, account) VALUES
 (4396000531,'PRD01832','CINTA KA169 150X6200MM P50','Cintas Estreitas','04','colacor'),
 (800002,'PRD80002','CINTA KA169 75X2000MM P80','Cintas Estreitas','04','colacor'),
 (800003,'PRD80003','CINTA KA169 300X3000MM P50','Cintas Estreitas','04','colacor'),
 (900001,'PRD90001','ROLO KA169 150X50000MM P50','Jumbo/Rolo de Lixa Óxido de Alumínio','03','colacor'),
 (900005,'PRD90005','ROLO KA169 75X50000MM P80','Jumbo/Rolo de Lixa Óxido de Alumínio','03','colacor'),
 (900006,'PRD90006','ROLO KA169 300X50000MM P50','Jumbo/Rolo de Lixa Óxido de Alumínio','03','colacor'),
 (900002,'PRD90002','A455 20% SHELDAHL ADESIVO','Colas','01','colacor'),
 (900003,'PRD90003','DESMODUR NE-S','Catalisadores PU','01','colacor'),
 (900004,'PRD90004','FITA SHELDAHL T188467 19MMX100M BLUE','Uso e Consumo','01','colacor');

INSERT INTO public.pcp_malha_staging (omie_codigo_produto, payload) VALUES
 (4396000531, '{"ident":{"idProduto":4396000531,"codProduto":"PRD01832"},"itens":[
   {"ident":{"idProdMalha":900001,"codProdMalha":"PRD90001","descrProdMalha":"ROLO KA169 150X50000MM P50"},"quantProdMalha":0.93,"unidProdMalha":"M2"},
   {"ident":{"idProdMalha":900002,"codProdMalha":"PRD90002","descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":1.611,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900003,"codProdMalha":"PRD90003","descrProdMalha":"DESMODUR NE-S"},"quantProdMalha":0.179,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900004,"codProdMalha":"PRD90004","descrProdMalha":"FITA SHELDAHL T188467 19MMX100M BLUE"},"quantProdMalha":16.9,"unidProdMalha":"CM"}]}'::jsonb),
 (800002, '{"ident":{"idProduto":800002,"codProduto":"PRD80002"},"itens":[
   {"ident":{"idProdMalha":900005,"codProdMalha":"PRD90005","descrProdMalha":"ROLO KA169 75X50000MM P80"},"quantProdMalha":0.15,"unidProdMalha":"M2"},
   {"ident":{"idProdMalha":900002,"codProdMalha":"PRD90002","descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":0.8055,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900003,"codProdMalha":"PRD90003","descrProdMalha":"DESMODUR NE-S"},"quantProdMalha":0.0895,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900004,"codProdMalha":"PRD90004","descrProdMalha":"FITA SHELDAHL T188467 19MMX100M BLUE"},"quantProdMalha":9.4,"unidProdMalha":"CM"}]}'::jsonb),
 (800003, '{"ident":{"idProduto":800003,"codProduto":"PRD80003"},"itens":[
   {"ident":{"idProdMalha":900006,"codProdMalha":"PRD90006","descrProdMalha":"ROLO KA169 300X50000MM P50"},"quantProdMalha":0.9,"unidProdMalha":"M2"},
   {"ident":{"idProdMalha":900002,"codProdMalha":"PRD90002","descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":3.222,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900003,"codProdMalha":"PRD90003","descrProdMalha":"DESMODUR NE-S"},"quantProdMalha":0.358,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900004,"codProdMalha":"PRD90004","descrProdMalha":"FITA SHELDAHL T188467 19MMX100M BLUE"},"quantProdMalha":31.9,"unidProdMalha":"CM"}]}'::jsonb);
SQL

echo "═══ ZONA 4: refresh + destilar + validar ═══"
eq "refresh: total|dim|disco|sem_match" "$(Pq -c "SELECT total||'|'||dimensionais||'|'||discos||'|'||sem_match FROM fn_pcp_refresh_itens()")" "9|6|0|3"
eq "linha_modelo veio do token da descrição" "$(Pq -c "SELECT linha_modelo FROM pcp_itens WHERE omie_codigo_produto=4396000531")" "KA169"
eq "destilar: nº de regras (4 papéis × [KA169 + *])" "$(Pq -c "SELECT fn_pcp_destilar_bom()")" "8"
eq "coef cola g/mm (mediana)"   "$(Pq -c "SELECT round(coef,5) FROM pcp_bom_regras WHERE linha_modelo='KA169' AND papel='cola'")" "0.01074"
eq "coef catalisador (razão)"   "$(Pq -c "SELECT round(coef,4) FROM pcp_bom_regras WHERE linha_modelo='KA169' AND papel='catalisador'")" "0.1111"
eq "coef fita (overlap cm)"     "$(Pq -c "SELECT round(coef,2) FROM pcp_bom_regras WHERE linha_modelo='KA169' AND papel='fita'")" "1.90"
eq "validação: 12/12 ok"        "$(Pq -c "SELECT count(*) FILTER (WHERE status='ok')||'/'||count(*) FROM vw_pcp_bom_validacao")" "12/12"
eq "materializar: 0 exceções"   "$(Pq -c "SELECT fn_pcp_materializar_excecoes()")" "0"

echo "═══ ZONA 5: FALSIFICAÇÃO — malha PODRE (cola 10×) TEM que virar exceção ═══"
P -q <<'SQL'
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, familia, tipo_produto, account) VALUES
 (800004,'PRD80004','CINTA KA169 100X1000MM P60','Cintas Estreitas','04','colacor'),
 (900007,'PRD90007','ROLO KA169 100X50000MM P60','Jumbo/Rolo de Lixa Óxido de Alumínio','03','colacor');
INSERT INTO public.pcp_malha_staging (omie_codigo_produto, payload) VALUES
 (800004, '{"ident":{"idProduto":800004,"codProduto":"PRD80004"},"itens":[
   {"ident":{"idProdMalha":900007,"codProdMalha":"PRD90007","descrProdMalha":"ROLO KA169 100X50000MM P60"},"quantProdMalha":0.1,"unidProdMalha":"M2"},
   {"ident":{"idProdMalha":900002,"codProdMalha":"PRD90002","descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":10.74,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900004,"codProdMalha":"PRD90004","descrProdMalha":"FITA SHELDAHL T188467 19MMX100M BLUE"},"quantProdMalha":11.9,"unidProdMalha":"CM"}]}'::jsonb);
SQL
P -q -c "SELECT fn_pcp_refresh_itens();" >/dev/null
# NÃO re-destila: as regras ficam as derivadas do conjunto limpo (fluxo incremental real).
EXC=$(Pq -c "SELECT fn_pcp_materializar_excecoes()")
eq "sabotagem materializou 1 exceção" "$EXC" "1"
eq "a exceção é a cola do pai sabotado" "$(Pq -c "SELECT pai_codigo||'|'||papel||'|'||status FROM pcp_bom_excecoes")" "800004|cola|excecao"
eq "esperado da exceção ≈ 1.074 g (0.01074×100)" "$(Pq -c "SELECT round(esperado,3) FROM pcp_bom_excecoes")" "1.074"

echo "═══ ZONA 6: endurecimentos do painel (fn_num, papel, regra instável, sem_base_cola, unidade, RLS, disposição) ═══"
eq "fn_pcp_num tolera vírgula pt-BR" "$(Pq -c "SELECT fn_pcp_num('1,611')")" "1.611"
eq "fn_pcp_num: lixo vira NULL (nunca fabrica)" "$(Pq -c "SELECT coalesce(fn_pcp_num('16,9 CM')::text,'nulo')")" "nulo"
eq "papel: FITA ADESIVA é fita (não cola)" "$(Pq -c "SELECT fn_pcp_papel_componente('FITA ADESIVA 25MM','Uso e Consumo')")" "fita"
eq "papel: COLA PU é cola" "$(Pq -c "SELECT fn_pcp_papel_componente('COLA PU BICOMPONENTE','Colas')")" "cola"

# Linha ZZ com cola DISPERSA (ratios 0.01/0.02/0.04 ⇒ MAD rel 0.5 > 0.10) — regra instável não valida ninguém.
# Pai XY: catalisador SEM cola no pai + cola em KG (unidade errada).
P -q <<'SQL'
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, familia, tipo_produto, account) VALUES
 (810001,'PRD81001','CINTA ZZ9 100X1000MM P50','Cintas Estreitas','04','colacor'),
 (810002,'PRD81002','CINTA ZZ9 100X1000MM P80','Cintas Estreitas','04','colacor'),
 (810003,'PRD81003','CINTA ZZ9 100X1000MM P120','Cintas Estreitas','04','colacor'),
 (810004,'PRD81004','CINTA XY7 100X1000MM P50','Cintas Estreitas','04','colacor');
INSERT INTO public.pcp_malha_staging (omie_codigo_produto, payload) VALUES
 (810001,'{"ident":{"idProduto":810001},"itens":[{"ident":{"idProdMalha":900002,"descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":1.0,"unidProdMalha":"G"}]}'::jsonb),
 (810002,'{"ident":{"idProduto":810002},"itens":[{"ident":{"idProdMalha":900002,"descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":2.0,"unidProdMalha":"G"}]}'::jsonb),
 (810003,'{"ident":{"idProduto":810003},"itens":[{"ident":{"idProdMalha":900002,"descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":4.0,"unidProdMalha":"G"}]}'::jsonb),
 (810004,'{"ident":{"idProduto":810004},"itens":[
   {"ident":{"idProdMalha":900003,"descrProdMalha":"DESMODUR NE-S"},"quantProdMalha":0.111,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900002,"descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":0.001,"unidProdMalha":"KG"}]}'::jsonb);
SQL
P -q -c "SELECT fn_pcp_refresh_itens();" >/dev/null
eq "re-destilar com universo maior (KA169 4 + ZZ9 cola + '*' 4)" "$(Pq -c "SELECT fn_pcp_destilar_bom()")" "9"
eq "regra ZZ9/cola nasceu INSTÁVEL (MAD rel 0.5)" "$(Pq -c "SELECT round(dispersao,2) FROM pcp_bom_regras WHERE linha_modelo='ZZ9' AND papel='cola'")" "0.50"
eq "validação marca as 3 colas ZZ9 como regra_instavel" "$(Pq -c "SELECT count(*) FROM vw_pcp_bom_validacao WHERE status='regra_instavel'")" "3"
eq "catalisador sem cola G no pai ⇒ sem_base_cola" "$(Pq -c "SELECT status FROM vw_pcp_bom_validacao WHERE pai_codigo=810004 AND papel='catalisador'")" "sem_base_cola"
eq "cola em KG ⇒ unidade_inesperada" "$(Pq -c "SELECT status FROM vw_pcp_bom_validacao WHERE pai_codigo=810004 AND papel='cola'")" "unidade_inesperada"
eq "materializar: 6 exceções (1 sabotada + 3 instáveis + 2 do XY7)" "$(Pq -c "SELECT fn_pcp_materializar_excecoes()")" "6"

echo "── item 1 (Codex/Caminho B): pai com 2 colas G ⇒ base do catalisador AMBÍGUA (não escolhe às cegas) ──"
P -q <<'SQL'
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, familia, tipo_produto, account) VALUES
 (820001,'PRD82001','CINTA KA169 120X2000MM P50','Cintas Estreitas','04','colacor'),
 (820002,'PRD82002','ROLO KA169 120X50000MM P50','Jumbo/Rolo de Lixa Óxido de Alumínio','03','colacor'),
 (820003,'PRD82003','A455 SEGUNDA COLA ADESIVO','Colas','01','colacor');
INSERT INTO public.pcp_malha_staging (omie_codigo_produto, payload) VALUES
 (820001,'{"ident":{"idProduto":820001},"itens":[
   {"ident":{"idProdMalha":820002,"descrProdMalha":"ROLO KA169 120X50000MM P50"},"quantProdMalha":0.24,"unidProdMalha":"M2"},
   {"ident":{"idProdMalha":900002,"descrProdMalha":"A455 20% SHELDAHL ADESIVO"},"quantProdMalha":1.29,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":820003,"descrProdMalha":"A455 SEGUNDA COLA ADESIVO"},"quantProdMalha":1.29,"unidProdMalha":"G"},
   {"ident":{"idProdMalha":900003,"descrProdMalha":"DESMODUR NE-S"},"quantProdMalha":0.143,"unidProdMalha":"G"}]}'::jsonb);
SQL
P -q -c "SELECT fn_pcp_refresh_itens();" >/dev/null
eq "catalisador com 2 colas G ⇒ cola_ambigua (não escolhe coef às cegas)" "$(Pq -c "SELECT status FROM vw_pcp_bom_validacao WHERE pai_codigo=820001 AND papel='catalisador'")" "cola_ambigua"
P -q -c "SELECT fn_pcp_materializar_excecoes();" >/dev/null
eq "cola_ambigua entra na fila de exceções" "$(Pq -c "SELECT count(*) FROM pcp_bom_excecoes WHERE status='cola_ambigua'")" "1"

echo "── matriz RLS (painel: TODAS as pcp_% fail-closed) ──"
eq "6 tabelas pcp_% com RLS ligado" "$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'pcp\\_%' AND c.relkind='r' AND c.relrowsecurity")" "6"
eq "staff vê pcp_bom_regras" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; SELECT count(*)>0 FROM pcp_bom_regras")" "t"
eq "não-staff vê 0 em pcp_bom_regras (fail-closed)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM pcp_bom_regras")" "0"

echo "── governança da disposição (helper staff-gated + grant de coluna) ──"
eq "staff dispõe via helper" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; SELECT fn_pcp_dispor_excecao(800004,'cola',900002,'aceitar','conferido no print')")" "t"
P -q -c "SELECT fn_pcp_materializar_excecoes();" >/dev/null
eq "re-materializar PRESERVA a disposição" "$(Pq -c "SELECT count(*) FROM pcp_bom_excecoes WHERE disposicao='aceitar'")" "1"
NS_ERR=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT fn_pcp_dispor_excecao(800004,'cola',900002,'aceitar',NULL);" 2>&1 || true)
case "$NS_ERR" in *"apenas staff"*) ok "não-staff barrado no helper (fail-closed)";; *) bad "não-staff NÃO barrado: $NS_ERR";; esac
COL_ERR=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; UPDATE pcp_bom_excecoes SET observado=1 WHERE pai_codigo=800004;" 2>&1 || true)
case "$COL_ERR" in *"permission denied"*) ok "UPDATE cru de coluna não permitida bloqueado (grant de coluna)";; *) bad "UPDATE de observado NÃO bloqueado: $COL_ERR";; esac

echo ""
echo "RESULTADO: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 7.2: Rodar**

Run: `bash db/test-pcp-f1a-destilacao.sh > /tmp/t-dest.log 2>&1; echo "exit=$?"`
Expected: `exit=0`, `PASS=31 FAIL=0` (re-aplicação do M2 + 8 da ZONA 4 + 3 da falsificação + 17 dos endurecimentos do painel + 2 do cola_ambigua da revisão de qualidade: números tolerantes, papéis ambíguos, regra instável só de linha, sem_base_cola, unidade errada, base de catalisador ambígua, matriz RLS, governança da disposição). Falhas aqui significam bug na destilação/validação (os números da fixture são FATOS do print) — corrigir o M2, nunca a fixture.

- [ ] **Step 7.3: shellcheck + commit**

```bash
shellcheck db/test-pcp-f1a-destilacao.sh
git add db/test-pcp-f1a-destilacao.sh
git commit -m "test(pcp): prova da destilação com a malha real do print (KA169) + sabotagem obrigatória"
```

---

### Task 8: Deploy M2 + destilação em PROD + relatório de amostragem (gate do founder)

**Files:**
- Create: `docs/historico/pcp-f1a-gate-amostragem.md` (relatório gerado)

- [ ] **Step 8.1 [FOUNDER]: aplicar M2 no SQL Editor**

Founder cola `db/pcp-f1a-m2-nucleo.sql`. Sucesso: `COMMIT` sem erro.

- [ ] **Step 8.2 [FOUNDER]: rodar refresh + destilação (no próprio SQL Editor)**

**Pré-condição (painel):** o último run do sync em `pcp_run_logs` deve estar `status='ok'` com `limpeza_pulada:false` — NUNCA destilar sobre staging de run com erro/truncado.

```sql
SELECT status, registros, detalhe FROM public.pcp_run_logs
 WHERE funcao='omie-malha-sync' ORDER BY id DESC LIMIT 1;  -- tem que ser 'ok'

SELECT * FROM public.fn_pcp_refresh_itens();
SELECT public.fn_pcp_destilar_bom()          AS regras;
SELECT public.fn_pcp_materializar_excecoes() AS excecoes;
```
Expected: refresh com total ≈ 4.3k (todo o catálogo colacor), dimensionais ≈ 1.7–1.9k; regras > 0; exceções = número finito (a fila de revisão).

- [ ] **Step 8.3: medir o resultado (psql-ro) — números do gate**

Run:
```bash
~/.config/afiacao/psql-ro \
 -c "SELECT tipo_item, formato_parse, count(*) FROM pcp_itens GROUP BY 1,2 ORDER BY 1,2;" \
 -c "SELECT linha_modelo, papel, metodo, round(coef,5) coef, amostras, round(dispersao,4) disp FROM pcp_bom_regras ORDER BY (linha_modelo='*') DESC, amostras DESC LIMIT 30;" \
 -c "SELECT status, count(*) FROM vw_pcp_bom_validacao GROUP BY 1 ORDER BY 2 DESC;" \
 -c "SELECT round(100.0*count(*) FILTER (WHERE status='ok')/NULLIF(count(*),0),1) AS pct_ok FROM vw_pcp_bom_validacao;" \
 -c "SELECT regra_origem, count(*) FROM vw_pcp_bom_validacao WHERE status='ok' GROUP BY 1;" \
 -c "SELECT linha_modelo, papel, round(dispersao,3) FROM pcp_bom_regras WHERE dispersao > 0.10 ORDER BY dispersao DESC;"
```
Expected: `pct_ok` alto (≥90% é saudável para v1); exceções concentradas em poucas linhas/papéis. **Métricas do painel:** % de `ok` validado por regra `global` (fallback `*`) entra no relatório — se for alto, as linhas estão ralas demais e o founder decide se aceita o global; regras com `dispersao > 0.10` são INSTÁVEIS (seus pais já caem em exceção automaticamente). **Qualquer padrão sistêmico (uma linha inteira em exceção) = regra errada, não malha errada — investigar antes do gate.**

- [ ] **Step 8.4: gerar o relatório de amostragem estratificada (Codex Gate 0 #7)**

Run (saída vira o corpo de `docs/historico/pcp-f1a-gate-amostragem.md`):
```bash
~/.config/afiacao/psql-ro \
 -c "-- 20 cintas de larguras EXTREMAS (10 mais estreitas + 10 mais largas com malha)
     (SELECT 'estreita' grupo, v.pai_descricao, v.papel, v.observado, round(v.esperado,4) esperado, v.status
      FROM vw_pcp_bom_validacao v JOIN pcp_itens i ON i.omie_codigo_produto=v.pai_codigo
      WHERE i.tipo_item='cinta' ORDER BY i.largura_mm ASC, v.pai_codigo, v.papel LIMIT 40)
     UNION ALL
     (SELECT 'larga', v.pai_descricao, v.papel, v.observado, round(v.esperado,4), v.status
      FROM vw_pcp_bom_validacao v JOIN pcp_itens i ON i.omie_codigo_produto=v.pai_codigo
      WHERE i.tipo_item='cinta' ORDER BY i.largura_mm DESC, v.pai_codigo, v.papel LIMIT 40);" \
 -c "-- shape da malha de DISCOS e TINGIDORES (papéis/unidades — decide o M3)
     SELECT i.tipo_item, fn_pcp_papel_componente(c.componente_descricao, c.componente_familia) papel,
            c.unidade, count(*)
     FROM vw_pcp_malha_componentes c JOIN pcp_itens i ON i.omie_codigo_produto=c.pai_codigo
     WHERE i.tipo_item IN ('disco','tingidor') GROUP BY 1,2,3 ORDER BY 1,4 DESC;" \
 -c "SELECT * FROM pcp_bom_excecoes ORDER BY papel, pai_codigo LIMIT 50;"
```
Escrever `docs/historico/pcp-f1a-gate-amostragem.md` com: números do Step 8.3, amostra acima, lista de exceções com leitura minha (sistêmico × pontual), e a recomendação sobre discos/tingidores (se a malha deles for por área/fórmula → M3 pequeno estendendo `fn_pcp_destilar_bom`; se for lista fixa → basta validação de presença).

- [ ] **Step 8.5 [FOUNDER]: GATE — aprovar a amostragem**

Founder revisa o relatório e as exceções (marca `disposicao` nas que reconhecer). **Sem o OK dele, a Fase 1B/2 NÃO consome esta BOM.** Registrar o OK no próprio relatório (data + escopo aprovado).

- [ ] **Step 8.6: Commit do relatório**

```bash
git add docs/historico/pcp-f1a-gate-amostragem.md
git commit -m "docs(pcp): relatório do gate de amostragem da BOM destilada (F1A)"
```

---

### Task 9: Fecho — sanidade, histórico e PR

- [ ] **Step 9.1: Sanidade do repo (nada de src/ mudou, mas o CI valida tudo)**

Run:
```bash
heavy bun run typecheck > /tmp/tc.log 2>&1; echo "tc=$?"
heavy bun run test > /tmp/test.log 2>&1; echo "test=$?"
bun lint > /tmp/lint.log 2>&1; echo "lint=$?"
```
Expected: `tc=0 test=0 lint=0`.

- [ ] **Step 9.2: Registrar a entrega no diário**

Adicionar em `docs/historico/pcp.md` (criar se não existir) uma entrada com: o que shipou (staging+edge+parser+destilação), números do gate (pct_ok, nº exceções), decisões tomadas em execução (shape real da malha, ajustes de regex) e pendências para a Fase 1B.

- [ ] **Step 9.3: Commit + PR**

```bash
git add docs/historico/pcp.md
git commit -m "docs(pcp): diário F1A — malha sincronizada + BOM destilada provada"
git push -u origin HEAD
gh pr create --title "PCP Fase 1A — malha Omie, parser dimensional e BOM paramétrica destilada" \
  --body "Spec: docs/superpowers/specs/2026-07-03-pcp-colacor-blueprint-design.md. Plano: docs/superpowers/plans/2026-07-04-pcp-fase1a-malha-dados-mestres.md. Provas: db/test-pcp-*.sh (golden + falsificação). Gate de amostragem: docs/historico/pcp-f1a-gate-amostragem.md."
```
Lembrete: PR não-draft auto-mergeia no verde do CI. Se o gate do founder (Task 8.5) ainda não saiu, abrir como `--draft`.

---

## Critério de aceite da Fase 1A (recapitulação)

1. `pcp_malha_staging` populado com shape_err=0, `limpeza_pulada=false` e cobertura ~1.4k cintas + discos + tingidores.
2. Golden do parser 100% verde COM falsificação vermelha comprovada.
3. Destilação recupera os coeficientes do print (0,01074 g/mm · 0,1111 · 1,9 cm) na prova local; regras instáveis (dispersão > 0,10) NÃO validam ninguém.
4. Em prod: `pct_ok` ≥ 90% na validação, exceções revisáveis, % de fallback global reportado e SEM padrão sistêmico não explicado.
5. Gate de amostragem aprovado pelo founder POR ESCRITO no relatório.
6. Nada downstream consome `pcp_bom_regras` ainda (trava até o gate).

---

## Painel tri-modelo sobre ESTE plano (2026-07-04 — disposições do driver)

Claude (produto, 5) + Codex (engenharia, 12) + Gemini (triagem, 8) = 25 findings; artefatos em `triagem-HPFZVP/` (claude3.json, codex3.raw, gemini3.raw).

| Achado (quem) | Sev | Disposição |
|---|---|---|
| Staging sem ciclo de vida: órfãos eternos + run parcial contamina (Codex P1+P2, Gemini P2 — CONFIRMADO 2 lentes) | P1 | **ACEITO** → limpeza de órfãos pós-run-ok com guarda de plausibilidade (≥90% do último ok) + pré-condição "último run ok" antes do refresh (Task 8.2) |
| Cast numérico cru derruba a view inteira ('1,611', '', lixo) (Codex) | P1 | **ACEITO** → `fn_pcp_num` tolerante (inválido ⇒ NULL, nunca fabrica) |
| Mediana da 1ª destilação contaminável em linha rala (Claude P1 + Codex fixture-viciada) | P1 | **ACEITO** → `dispersao_max_regra` (0,10): regra instável não valida ninguém, pais caem em exceção; provado na ZONA 6 |
| Timeout do edge em paginação longa (Gemini P1) | P1 | **ACEITO-leve** → `desde_pagina` (resume) + estimativa real ~40 páginas documentada; fila/worker = YAGNI |
| Founder marcando exceção via UPDATE cru = fricção (Gemini P1) | P1 | **ACEITO** → `fn_pcp_dispor_excecao()` staff-gated (1 chamada); UI de triagem fica p/ F1B |
| Grant de coluna sem policy UPDATE (Codex P1) | — | **JÁ NO PLANO** (policy `pcp_bom_excecoes_update_staff` existia; o alvo resumido omitiu) → adicionada PROVA na ZONA 6 (staff ok, não-staff barrado, coluna proibida barrada) |
| security_invoker não basta sem matriz RLS provada (Codex+Gemini — CONFIRMADO) | P2 | **ACEITO** → ZONA 6: 6 tabelas pcp_% com RLS + fail-closed não-staff |
| COALESCE pega array 'itens' VAZIO e não cai no fallback (Codex) | P2 | **ACEITO** → CASE array-aware com jsonb_typeof/length |
| DELETE total da destilação pode zerar regras boas (Codex) | P2 | **ACEITO** → RAISE em universo vazio (rollback preserva) |
| Página vazia prematura = truncamento silencioso (Gemini) | P3 | **ACEITO** → mesma guarda de plausibilidade (limpeza_pulada acusa) |
| 'FITA ADESIVA' classificaria como cola (Codex) | P2 | **ACEITO** → fita ANTES de cola no CASE + golden do papel |
| Fallback global '*' mistura linhas (Codex, needs_human) | P2 | **ACEITO como métrica de gate** → `regra_origem` na validação + % global no relatório; founder decide no gate |
| Regex rígida a caixa/espaços (Codex P3 + Gemini P2) | P3 | **PARCIAL** → upper() já existia (golden minúsculas adicionado); espaços fora do padrão = `sem_match` DE PROPÓSITO (revisão humana > chute) — decisão registrada |
| Drift de id de componente perde disposição (Gemini P3) | P3 | **ACEITO como limitação documentada** (disposição é triagem transitória; órfãos com disposição ficam inertes) |
| Lock/perf do DELETE+INSERT a 10k (Gemini P2) | — | **REJEITADO** — escala errada: regras são dezenas, catálogo 4.3k, run manual raro |
| Handoffs manuais do founder estagnam (Claude P2 + Gemini) | P2 | **ACEITO** → deploy em 2 momentos únicos com comandos prontos; M2 pode ir no mesmo dia se o probe não divergir |
| `codigo` duplicado no fallback do join (Claude P3) | P3 | **ACEITO** → check de dup no pré-flight da Task 5.2 |
| Sync sem recorrência = staleness (Claude P3) | P3 | **ACEITO como pendência da Fase 2** → cron + frescor no Sentinela (padrão da casa) |
