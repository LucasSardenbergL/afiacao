# Cockpit de preço — Fase 2b (defasagem por cliente) — Plano de Implementação

> **Para workers agênticos:** SUB-SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans pra implementar tarefa a tarefa. Passos usam checkbox (`- [ ]`).

**Goal:** Avisar a vendedora, na linha do carrinho, quando o custo (CMC) de um item subiu desde a última compra DESTE cliente e o preço não acompanhou — mostrando o preço de equilíbrio do repasse (`P_req`) que preserva o markup antigo, com precisão > recall (alerta errado é pior que silêncio).

**Architecture:** O CMC histórico vive no Omie (`ListarPosEstoque` por `dDataPosicao`); uma RPC Postgres não chama o Omie, então um edge backfilla o CMC as-of da data de cada âncora numa tabela nova `cmc_snapshot`, e a RPC `get_defasagem_cliente` (SEPARADA da `get_preco_cockpit` da 2a) lê do banco. A regra "à prova de catraca" é provada em DOIS oráculos que têm de bater 1:1: um helper TS puro (`defasagem.ts`, vitest) e a própria RPC em PL/pgSQL (PG17 local). O badge no `CartItemList` consome a RPC via hook, usando o `customerUserId` que já chega como prop.

**Tech Stack:** React 18 + TS strict + `@tanstack/react-query` · Supabase (PL/pgSQL, SECURITY DEFINER, RLS) · Deno edge functions · Omie API · vitest (`heavy bun run test`) · PG17 local descartável (`db/test-*.sh`) · Lovable Cloud (migrations aplicadas MANUALMENTE no SQL Editor).

> **Premissa de dado (gates da spec §3) — AMBOS FECHADOS:** GATE 1 (`dDataPosicao` devolve histórico-real) — **PROVADO em 2026-06-27** via `cmc-snapshot-smoke` (account `colacor_vendas`, 15/01 vs 14/06/2026: **21 de 773 SKUs com CMC distinto**, ex. cód 394036177 R$269,12→555,96 = +106,6%; cód 399938680 caiu −5,7%) → backfill exato-por-âncora liberado. GATE 2 (semântica de desconto) — **RESOLVIDO no dado** (desconto = 0 em 100% das âncoras; o guard `discount > 0 → neutro` fica como proteção futura). **O build (Task 1 em diante) está liberado.**

> **Aviso Lovable (todas as migrations):** migration de nome custom **NÃO** auto-aplica no Lovable (falha SILENCIOSA). O passo "aplicar" de cada migration = **colar o arquivo no SQL Editor do Lovable** (o founder faz). A prova real de SQL é o **PG17 local** (`db/test-*.sh`) — é onde os asserts rodam, ANTES de aplicar em produção. Nunca confie no `CREATE` passar: PL/pgSQL é late-bound (só falha em runtime) → **teste EXECUTANDO**.

---

### Task 1: Migration `cmc_snapshot` (tabela de CMC por data)

**Files:**
- Create: `supabase/migrations/20260627180000_cmc_snapshot.sql`

> Espelha as convenções de RLS/policy do `cmc_ledger` (`20260614170000_cmc_ledger.sql`): leitura staff (employee/master), escrita só via service_role (o edge usa SERVICE_ROLE_KEY), tabela nova SEMPRE com RLS. `CHECK (cmc > 0)` materializa "ausente ≠ zero" na fronteira da escrita (não guardar custo 0/negativo). Validação: NÃO há teste isolado — a Task 6 (PG17 `db/test-defasagem.sh`) aplica esta migration junto com a RPC e prova o comportamento.

- [ ] **Step 1: Criar a migration `20260627180000_cmc_snapshot.sql`**

```sql
-- Fase 2b (defasagem por cliente): CMC por DATA, backfillado do Omie.
-- Uma RPC Postgres não chama a API do Omie → o CMC-por-data tem que estar NO banco.
-- O edge cmc-snapshot-backfill escreve aqui (modo exato-por-âncora + grade mensal).
-- A RPC get_defasagem_cliente lê C_last = snapshot na data da âncora (janela ±7d).
--
-- §5.5: o snapshot guarda o que o Omie devolve HOJE pra uma data passada ("melhor
-- visão atual do custo passado"). Comparar C_last e C_now na MESMA base (ambos via
-- Omie hoje) é mais consistente que misturar congelado-na-época com vivo.
--
-- "Ausente ≠ zero": CHECK (cmc > 0) recusa custo 0/negativo na escrita (não fabricar).
-- Aplicar via SQL Editor. Validar no fim. Prova real: db/test-defasagem.sh (PG17).

CREATE TABLE IF NOT EXISTS public.cmc_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,
  omie_codigo_produto bigint NOT NULL,
  data_posicao date NOT NULL,
  cmc numeric NOT NULL CHECK (cmc > 0),
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account, omie_codigo_produto, data_posicao)
);

-- Lookup da RPC: (account, omie_codigo_produto, data_posicao) — o UNIQUE já cria o
-- índice composto, mas deixamos explícito o índice de lookup por clareza/intenção.
CREATE INDEX IF NOT EXISTS idx_cmc_snapshot_lookup
  ON public.cmc_snapshot (account, omie_codigo_produto, data_posicao);

ALTER TABLE public.cmc_snapshot ENABLE ROW LEVEL SECURITY;

-- Leitura staff (employee/master) — espelha cmc_ledger_select_staff. A RPC é
-- SECURITY DEFINER (bypassa RLS), mas leitura direta staff é inofensiva e simétrica.
DROP POLICY IF EXISTS "cmc_snapshot_select_staff" ON public.cmc_snapshot;
CREATE POLICY "cmc_snapshot_select_staff" ON public.cmc_snapshot
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'employee'::app_role) OR has_role(auth.uid(), 'master'::app_role));

-- Escrita: só service_role (o edge backfill usa SERVICE_ROLE_KEY). Sem policy de
-- INSERT/UPDATE p/ authenticated → authenticated não escreve. REVOKE explícito de
-- anon/authenticated (REVOKE FROM PUBLIC não tira anon/authenticated no Supabase).
REVOKE ALL ON public.cmc_snapshot FROM anon, authenticated;
GRANT SELECT ON public.cmc_snapshot TO authenticated;

-- ── Validação pós-apply ──
SELECT
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='cmc_snapshot') AS tabela_1,
  (SELECT count(*) FROM pg_policies WHERE tablename='cmc_snapshot') AS policies_1,
  (SELECT count(*) FROM pg_constraint WHERE conname LIKE '%cmc_snapshot%' AND contype='c') AS check_ge1,
  (SELECT count(*) FROM pg_indexes WHERE tablename='cmc_snapshot') AS idx_ge2;
-- esperado: 1, 1, >=1, >=2 (UNIQUE + idx_lookup + pkey)
```

- [ ] **Step 2: Validar que a migration aplica num PG17 limpo (smoke isolado)** — Run: `bash -c 'set -e; PGBIN="/opt/homebrew/opt/postgresql@17/bin"; D=$(mktemp -d); "$PGBIN/initdb" -D "$D/data" -U postgres -E UTF8 --locale=C >/dev/null; "$PGBIN/pg_ctl" -D "$D/data" -o "-p 5455 -k /tmp" -l /tmp/pg-snap.log -w start >/dev/null; "$PGBIN/createdb" -p 5455 -h /tmp -U postgres snaptest; P(){ "$PGBIN/psql" -p 5455 -h /tmp -U postgres -d snaptest "$@"; }; P -q -c "CREATE SCHEMA IF NOT EXISTS auth; CREATE TYPE public.app_role AS ENUM ('"'"'employee'"'"','"'"'customer'"'"','"'"'master'"'"'); CREATE FUNCTION public.has_role(uuid, public.app_role) RETURNS boolean LANGUAGE sql AS '"'"'SELECT false'"'"'; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS '"'"'SELECT NULL::uuid'"'"'; DO \$\$ BEGIN CREATE ROLE anon; CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;"; P -v ON_ERROR_STOP=1 -f /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/great-williamson-f21bee/supabase/migrations/20260627180000_cmc_snapshot.sql; "$PGBIN/pg_ctl" -D "$D/data" stop -m immediate >/dev/null 2>&1; rm -rf "$D"'` — Expected: a linha de validação imprime `1 | 1 | >=1 | >=2` (`tabela_1=1, policies_1=1, check_ge1>=1, idx_ge2>=2`) sem erro.

- [ ] **Step 3: Commit** — Run: `git add supabase/migrations/20260627180000_cmc_snapshot.sql && git commit -m "feat(cockpit/2b): migration cmc_snapshot (CMC por data, RLS staff, CHECK cmc>0)"`

---

### Task 2: Edge `cmc-snapshot-backfill` (escreve CMC histórico no banco)

**Files:**
- Create: `supabase/functions/cmc-snapshot-backfill/index.ts`

> Espelha `cmc-snapshot-smoke/index.ts` (MESMO `callOmie` serializado+retry pro lock de concorrência do Omie, `getCredentials` por conta, `normalizaDataPosicao`, auth `authorizeCronOrStaff`) e o padrão de ESCRITA do `omie-analytics-sync` (cria `createClient` com `SERVICE_ROLE_KEY` e dá `upsert` com `onConflict`). Dois modos: `exato` (CMC as-of a data REAL de cada âncora — a defesa contra o FP crítico Codex #1) e `grade` (CMC numa data-âncora mensal pra cobertura). Paginação até página vazia + guard `maxPaginas`. Idempotente (upsert on conflict).

- [ ] **Step 1: Criar o edge `supabase/functions/cmc-snapshot-backfill/index.ts`**

```ts
// ─────────────────────────────────────────────────────────────────────────────
// cmc-snapshot-backfill — Fase 2b (defasagem por cliente).
//
// Popula public.cmc_snapshot com o CMC histórico do Omie (ListarPosEstoque por
// dDataPosicao). Uma RPC Postgres não chama o Omie → este edge é a ponte: lê o
// Omie e ESCREVE no banco (SERVICE_ROLE_KEY + upsert idempotente).
//
// DOIS modos (body.modo):
//  (a) "exato"  — { account, itens:[{ omie_codigo_produto, data_posicao }] }
//      Pra cada item, chama ListarPosEstoque com dDataPosicao = a data EXATA da
//      âncora e grava o nCMC daquele produto naquela data. É a defesa contra o
//      falso-positivo crítico (Codex #1): a grade mensal poderia ver o CMC de uma
//      data distante e fabricar alta-fantasma; o exato-por-âncora elimina isso.
//  (b) "grade"  — { account, dataInicio, dataFim }
//      Pra cada mês no range, pega o CMC de TODOS os produtos numa data-âncora do
//      mês (dia 15) e grava. Cobertura barata de fallback (paginado, bulk).
//
// Espelha cmc-snapshot-smoke (callOmie serializado+retry pro lock do Omie,
// getCredentials, normalizaDataPosicao, auth) + o write do omie-analytics-sync.
// Idempotente: upsert on conflict (account, omie_codigo_produto, data_posicao).
//
// Invocar (exemplos):
//   POST /functions/v1/cmc-snapshot-backfill
//   Authorization: Bearer <JWT staff ou SERVICE_ROLE_KEY>   (ou x-cron-secret)
//   { "modo":"exato", "account":"colacor_vendas",
//     "itens":[{"omie_codigo_produto":1234567890,"data_posicao":"2026-03-20"}] }
//   { "modo":"grade", "account":"vendas", "dataInicio":"2025-01-01", "dataFim":"2026-06-01" }
//   (datas aceitam ISO YYYY-MM-DD ou DD/MM/YYYY; o Omie recebe DD/MM/YYYY)
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

type OmieAccount = "vendas" | "servicos" | "colacor_vendas";
const CONTAS_VALIDAS: OmieAccount[] = ["vendas", "servicos", "colacor_vendas"];

interface OmieEstoqueProduto {
  nCodProd?: number;
  nSaldo?: number;
  nCMC?: number;
  nPrecoMedio?: number;
}
interface OmieListarPosEstoqueResponse {
  produtos?: OmieEstoqueProduto[];
  nTotPaginas?: number;
  faultstring?: string;
}

// Mesmas credenciais por conta que o omie-analytics-sync / cmc-snapshot-smoke
// (vendas=Oben, colacor_vendas=Colacor, servicos=Colacor SC).
function getCredentials(account: OmieAccount) {
  if (account === "vendas") {
    return { key: Deno.env.get("OMIE_OBEN_APP_KEY"), secret: Deno.env.get("OMIE_OBEN_APP_SECRET") };
  }
  if (account === "colacor_vendas") {
    return { key: Deno.env.get("OMIE_COLACOR_APP_KEY"), secret: Deno.env.get("OMIE_COLACOR_APP_SECRET") };
  }
  return { key: Deno.env.get("OMIE_COLACOR_SC_APP_KEY"), secret: Deno.env.get("OMIE_COLACOR_SC_APP_SECRET") };
}

// Chamada Omie com retry curto p/ flakiness transitória (mesma família de erros
// que o analytics-sync trata) — INCLUI o lock de concorrência do Omie ("Já existe
// uma requisição desse método sendo executada"). Por isso TODAS as chamadas deste
// edge são serializadas (await sequencial), nunca Promise.all.
async function callOmie(
  account: OmieAccount,
  endpoint: string,
  call: string,
  params: Record<string, unknown>,
): Promise<OmieListarPosEstoqueResponse> {
  const creds = getCredentials(account);
  if (!creds.key || !creds.secret) throw new Error(`Credenciais Omie (${account}) não configuradas`);
  const body = { call, app_key: creds.key, app_secret: creds.secret, param: [params] };

  const maxAttempts = 5;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${OMIE_API_URL}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await res.json()) as OmieListarPosEstoqueResponse;
      if (result.faultstring) throw new Error(`Omie (${account}): ${result.faultstring}`);
      return result;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const msg = lastErr.message.toLowerCase();
      const transient = msg.includes("broken response") || msg.includes("soap-error") ||
        msg.includes("timeout") || msg.includes("timed out") || msg.includes("network") ||
        msg.includes("connection") || msg.includes("fetch failed") ||
        msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("500") ||
        msg.includes("já existe uma requisição") || msg.includes("sendo executada") ||
        msg.includes("tente novamente");
      if (transient && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error(`Omie (${account}): falha após ${maxAttempts} tentativas`);
}

// Aceita ISO (YYYY-MM-DD) ou pt-BR (DD/MM/YYYY) e devolve o que o Omie espera (DD/MM/YYYY).
function normalizaDataPosicao(s: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  throw new Error(`Data inválida "${s}" — use YYYY-MM-DD ou DD/MM/YYYY`);
}

// DD/MM/YYYY → "YYYY-MM-DD" (a coluna data_posicao é date; o upsert grava ISO).
function brParaIso(ddmmyyyy: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy);
  if (!m) throw new Error(`Data BR inválida "${ddmmyyyy}"`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// Pagina ListarPosEstoque numa data e devolve mapa nCodProd -> nCMC (só CMC > 0).
// Para até a página vazia OU até maxPaginas (guard anti-loop; não confiar só em
// nTotPaginas — armadilha do projeto com a paginação do Omie).
async function cmcPorData(
  account: OmieAccount,
  dDataPosicao: string,
  maxPaginas: number,
): Promise<{ mapa: Map<number, number>; paginasLidas: number; totalPaginas: number }> {
  const mapa = new Map<number, number>();
  let pagina = 1;
  let totalPaginas = 1;

  while (pagina <= maxPaginas) {
    const result = await callOmie(account, "estoque/consulta/", "ListarPosEstoque", {
      nPagina: pagina,
      nRegPorPagina: 100,
      cExibeTodos: "S", // catálogo inteiro (inclui saldo 0) — queremos o CMC, não só itens com saldo.
      dDataPosicao,
    });
    totalPaginas = result.nTotPaginas || 1;
    const produtos = result.produtos || [];
    if (produtos.length === 0) break; // página vazia → fim (guard além do nTotPaginas)
    for (const prod of produtos) {
      const cod = Number(prod.nCodProd);
      if (!Number.isSafeInteger(cod) || cod <= 0) continue;
      // "Ausente ≠ zero": só guardamos CMC presente e > 0.
      if (typeof prod.nCMC === "number" && prod.nCMC > 0) mapa.set(cod, prod.nCMC);
    }
    if (pagina >= totalPaginas) break;
    pagina++;
  }
  return { mapa, paginasLidas: Math.min(pagina, maxPaginas), totalPaginas };
}

// Upsert em lote no cmc_snapshot (idempotente: on conflict do update do cmc/synced_at).
async function upsertSnapshot(
  // deno-lint-ignore no-explicit-any
  db: any,
  rows: Array<{ account: string; omie_codigo_produto: number; data_posicao: string; cmc: number }>,
): Promise<number> {
  let gravados = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    const { error } = await db
      .from("cmc_snapshot")
      .upsert(slice.map((r) => ({ ...r, synced_at: new Date().toISOString() })), {
        onConflict: "account,omie_codigo_produto,data_posicao",
      });
    if (error) {
      console.error("[cmc-snapshot-backfill] upsert:", error);
      throw new Error(`upsert cmc_snapshot falhou: ${error.message ?? error}`);
    }
    gravados += slice.length;
  }
  return gravados;
}

// Datas-âncora mensais (dia 15) entre dataInicio e dataFim (inclusive), em DD/MM/YYYY.
function datasMensais(dataInicioIso: string, dataFimIso: string): string[] {
  const ini = new Date(`${dataInicioIso.slice(0, 7)}-01T00:00:00Z`);
  const fim = new Date(`${dataFimIso.slice(0, 7)}-01T00:00:00Z`);
  if (isNaN(ini.getTime()) || isNaN(fim.getTime()) || ini > fim) {
    throw new Error("dataInicio/dataFim inválidas ou invertidas");
  }
  const out: string[] = [];
  const cur = new Date(ini);
  let guard = 0;
  while (cur <= fim && guard < 60) { // guard: no máx 60 meses (5 anos)
    const dd = "15";
    const mm = String(cur.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = cur.getUTCFullYear();
    out.push(`${dd}/${mm}/${yyyy}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
    guard++;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload, null, 2), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    const modo = body.modo as string;
    const account = body.account as OmieAccount;
    const maxPaginas = Math.min(Math.max(Number(body.maxPaginas) || 200, 1), 500);

    if (!CONTAS_VALIDAS.includes(account)) {
      return json({ ok: false, erro: `account inválida — use uma de ${CONTAS_VALIDAS.join(", ")}` }, 400);
    }

    // ── Modo EXATO: CMC as-of a data REAL de cada âncora ──
    if (modo === "exato") {
      const itens = Array.isArray(body.itens) ? body.itens : [];
      if (itens.length === 0) {
        return json({ ok: false, erro: "modo exato requer itens:[{omie_codigo_produto, data_posicao}]" }, 400);
      }
      // Agrupa por data (1 chamada Omie por data distinta cobre todos os produtos dela).
      const codsPorData = new Map<string, Set<number>>(); // dDataPosicao(BR) -> set de cods
      for (const it of itens) {
        const cod = Number(it.omie_codigo_produto);
        if (!Number.isSafeInteger(cod) || cod <= 0) continue;
        const dBR = normalizaDataPosicao(String(it.data_posicao));
        if (!codsPorData.has(dBR)) codsPorData.set(dBR, new Set());
        codsPorData.get(dBR)!.add(cod);
      }
      const rows: Array<{ account: string; omie_codigo_produto: number; data_posicao: string; cmc: number }> = [];
      const porData: Array<{ data: string; pedidos: number; achados: number }> = [];
      // Serializado de propósito (lock do Omie).
      for (const [dBR, cods] of codsPorData) {
        const { mapa } = await cmcPorData(account, dBR, maxPaginas);
        const dataIso = brParaIso(dBR);
        let achados = 0;
        for (const cod of cods) {
          const cmc = mapa.get(cod);
          if (typeof cmc === "number" && cmc > 0) {
            rows.push({ account, omie_codigo_produto: cod, data_posicao: dataIso, cmc });
            achados++;
          }
        }
        porData.push({ data: dBR, pedidos: cods.size, achados });
      }
      const gravados = rows.length > 0 ? await upsertSnapshot(db, rows) : 0;
      return json({
        ok: true,
        modo: "exato",
        account,
        datasDistintas: codsPorData.size,
        itensPedidos: itens.length,
        snapshotsGravados: gravados,
        porData,
      });
    }

    // ── Modo GRADE: CMC de todos os produtos numa data-âncora mensal (dia 15) ──
    if (modo === "grade") {
      if (!body.dataInicio || !body.dataFim) {
        return json({ ok: false, erro: "modo grade requer dataInicio e dataFim (YYYY-MM-DD ou DD/MM/YYYY)" }, 400);
      }
      const iniIso = brParaIso(normalizaDataPosicao(String(body.dataInicio)));
      const fimIso = brParaIso(normalizaDataPosicao(String(body.dataFim)));
      const datas = datasMensais(iniIso, fimIso);
      let gravadosTotal = 0;
      const porMes: Array<{ data: string; produtos: number; gravados: number; paginas: string }> = [];
      // Serializado (lock do Omie). 1 mês por vez, bulk upsert.
      for (const dBR of datas) {
        const { mapa, paginasLidas, totalPaginas } = await cmcPorData(account, dBR, maxPaginas);
        const dataIso = brParaIso(dBR);
        const rows = [...mapa.entries()].map(([cod, cmc]) => ({
          account, omie_codigo_produto: cod, data_posicao: dataIso, cmc,
        }));
        const g = rows.length > 0 ? await upsertSnapshot(db, rows) : 0;
        gravadosTotal += g;
        porMes.push({ data: dBR, produtos: mapa.size, gravados: g, paginas: `${paginasLidas}/${totalPaginas}` });
      }
      return json({
        ok: true,
        modo: "grade",
        account,
        meses: datas.length,
        snapshotsGravados: gravadosTotal,
        porMes,
      });
    }

    return json({ ok: false, erro: 'modo inválido — use "exato" ou "grade"' }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: false, erro: msg }, 500);
  }
});
```

- [ ] **Step 2: `deno check` do edge** — Run: `deno check supabase/functions/cmc-snapshot-backfill/index.ts` — Expected: `Check file:///...cmc-snapshot-backfill/index.ts` sem erros de tipo.

- [ ] **Step 3: Documentar o cron mensal (SQL pro SQL Editor; NÃO é migration auto-aplicada)** — adicionar ao topo do edge, como bloco de comentário literal, o SQL do cron que o founder cola no SQL Editor do Lovable. **Armadilha do projeto:** `net.http_post` precisa de `timeout_milliseconds` EXPLÍCITO (default 5s mata silencioso) ≥ 600000 (10 min — backfill de grade é pesado); o segredo vem do vault (`CRON_SECRET`). Inserir este comentário logo ABAIXO do cabeçalho `Invocar (exemplos)` do edge:

```ts
// ── Cron mensal (colar no SQL Editor do Lovable — migration custom NÃO auto-aplica) ──
// Roda dia 1 de cada mês 04:00 UTC, grade do mês anterior nas 3 contas. O
// timeout_milliseconds EXPLÍCITO é OBRIGATÓRIO (default 5s mata o backfill silencioso;
// cron.job_run_details=succeeded só prova o ENQUEUE — a verdade HTTP está em net._http_response).
//
//   SELECT cron.schedule(
//     'cmc-snapshot-backfill-grade-mensal',
//     '0 4 1 * *',
//     $cron$
//     SELECT net.http_post(
//       url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/cmc-snapshot-backfill',
//       headers := jsonb_build_object(
//         'Content-Type','application/json',
//         'x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)
//       ),
//       body := jsonb_build_object(
//         'modo','grade','account','vendas',
//         'dataInicio', to_char(date_trunc('month', now() - interval '1 month'),'YYYY-MM-DD'),
//         'dataFim',    to_char(date_trunc('month', now() - interval '1 month'),'YYYY-MM-DD')
//       ),
//       timeout_milliseconds := 600000
//     );
//     $cron$
//   );
//   -- repetir o bloco trocando account p/ 'colacor_vendas' e 'servicos' (nomes de job distintos).
```

- [ ] **Step 4: `deno check` de novo (o comentário não muda o check, mas confirma que o arquivo segue válido)** — Run: `deno check supabase/functions/cmc-snapshot-backfill/index.ts` — Expected: sem erros.

- [ ] **Step 5: Commit** — Run: `git add supabase/functions/cmc-snapshot-backfill/index.ts && git commit -m "feat(cockpit/2b): edge cmc-snapshot-backfill (modo exato-por-âncora + grade mensal) + cron doc"`

---

### Task 3: Teste do helper puro `defasagem.test.ts` (vitest, ANTES da Task 4 — TDD)

**Files:**
- Create: `src/lib/preco/defasagem.test.ts`

> TDD: o teste vem ANTES da implementação (Task 4) e DEVE falhar (o helper `defasagem.ts` ainda não existe). Casos vêm da spec §8. Fixture `base()` no padrão do `cockpit-preco.test.ts`. Os campos do `DefasagemInput` e o type `StatusDefasagem` têm de bater com a assinatura EXATA da Task 4 (consistência verificada no self-review).

- [ ] **Step 1: Criar `src/lib/preco/defasagem.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { avaliarDefasagem, DEFASAGEM_CONST, type DefasagemInput } from './defasagem';

// Fixture base: âncora válida, custo subiu de 60→72 (+20%), preço 100 herdado.
// Padrão "tudo OK por default; cada teste perturba 1 eixo" (como cockpit-preco.test.ts).
const base = (o: Partial<DefasagemInput>): DefasagemInput => ({
  pNow: 100,
  pLast: 100,
  cLast: 60,
  cNow: 72,             // +20% de custo
  temAncora: true,
  descontoNaoProvado: false,
  cNowFresco: true,
  dataConfiavel: true,
  ancoraMeses: 3,
  qtyRatioOk: true,
  ...o,
});

describe('avaliarDefasagem', () => {
  it('defasado — custo +20%, preço não subiu → defasado, P_req = pLast*(cNow/cLast)', () => {
    const r = avaliarDefasagem(base({}));
    expect(r.status).toBe('defasado');
    // P_req = 100 * (72/60) = 120,00
    expect(r.pReq).toBe(120);
    // alta de custo = 20%
    expect(r.altaCustoPerc).toBeCloseTo(20, 6);
  });

  it('em_dia — preço acompanhou a alta (+20%) → em_dia', () => {
    // pNow já em 120 (acompanhou). pReq=120, gap=0 < piso → em_dia.
    const r = avaliarDefasagem(base({ pNow: 120 }));
    expect(r.status).toBe('em_dia');
    expect(r.pReq).toBe(120);
  });

  it('sem_alta — custo caiu (72→48) → sem_alta (nunca repassa queda)', () => {
    const r = avaliarDefasagem(base({ cNow: 48 }));
    expect(r.status).toBe('sem_alta');
    expect(r.pReq).toBeNull();
  });

  it('sem_alta (ruído) — alta < piso de 2% (60→61, +1,67%) → sem_alta', () => {
    const r = avaliarDefasagem(base({ cNow: 61 }));
    expect(r.status).toBe('sem_alta');
  });

  it('G1 — pLast ≤ cLast (vendeu no/abaixo do custo) → neutro (não herda markup de prejuízo)', () => {
    const r = avaliarDefasagem(base({ pLast: 55, cLast: 60 }));
    expect(r.status).toBe('neutro');
    expect(r.motivo).toBe('prejuizo_ancora');
    expect(r.pReq).toBeNull();
  });

  it('âncora antiga — ancoraMeses > 18 → neutro/ancora_antiga', () => {
    const r = avaliarDefasagem(base({ ancoraMeses: 24 }));
    expect(r.status).toBe('neutro');
    expect(r.motivo).toBe('ancora_antiga');
  });

  it('quarentena — custo +60% (60→96) → revisar (provável erro de cadastro/unidade)', () => {
    const r = avaliarDefasagem(base({ cNow: 96 }));
    expect(r.status).toBe('revisar');
    expect(r.motivo).toBe('quarentena_custo');
  });

  it('fronteira da tolerância — custo +10%, preço +9,96% (por centavo) → NÃO defasado (TOL_PP)', () => {
    // cLast 60 → cNow 66 (+10%). pLast 100 (>cLast=60, markup positivo → não viola G1) →
    // pNow 109,96 (+9,96%). gap de pontos = 10% - 9,96% = 0,04pp < TOL_PP(3pp) → em_dia.
    const r = avaliarDefasagem(base({ pLast: 100, pNow: 109.96, cLast: 60, cNow: 66 }));
    expect(r.status).toBe('em_dia');
  });

  it('piso de ação — defasado pela razão mas P_req - P_now < R$1 → em_dia (centavo não dispara)', () => {
    // Isola o PISO DE AÇÃO: razão passa a tolerância, mas o gap em R$ < piso de R$1.
    // pLast 9 (>cLast=8, markup positivo → não viola G1). cLast 8 → cNow 8,80 (+10%).
    // pReq = 9*(8,80/8) = 9,90. pNow 9 (não subiu): gap pontos = 10% - 0% = 10pp > 3pp →
    // passaria por razão. Mas pReq - pNow = 0,90 < R$1,00 (e < 2% de pNow=0,18; MAIOR=R$1,00)
    // → 0,90 < 1,00 → em_dia (piso de ação).
    const r = avaliarDefasagem(base({ pLast: 9, pNow: 9, cLast: 8, cNow: 8.8 }));
    expect(r.status).toBe('em_dia');
    expect(r.pReq).toBe(9.9);
  });

  it('desconto não provado → neutro/desconto_nao_provado', () => {
    const r = avaliarDefasagem(base({ descontoNaoProvado: true }));
    expect(r.status).toBe('neutro');
    expect(r.motivo).toBe('desconto_nao_provado');
  });

  it('C_now stale → sem_custo_atual_fresco (G6)', () => {
    const r = avaliarDefasagem(base({ cNowFresco: false }));
    expect(r.status).toBe('sem_custo_atual_fresco');
  });

  it('sem data confiável → sem_data_confiavel (G7)', () => {
    const r = avaliarDefasagem(base({ dataConfiavel: false }));
    expect(r.status).toBe('sem_data_confiavel');
  });

  it('qty divergente (ordem de grandeza) → revisar (G5)', () => {
    const r = avaliarDefasagem(base({ qtyRatioOk: false }));
    expect(r.status).toBe('revisar');
    expect(r.motivo).toBe('qty_divergente');
  });

  it('sem âncora → sem_historico', () => {
    const r = avaliarDefasagem(base({ temAncora: false }));
    expect(r.status).toBe('sem_historico');
  });

  it('pLast/cLast/cNow inválido (NaN/≤0) → neutro/sem_base', () => {
    expect(avaliarDefasagem(base({ cLast: 0 })).status).toBe('neutro');
    expect(avaliarDefasagem(base({ cNow: NaN })).status).toBe('neutro');
    expect(avaliarDefasagem(base({ pLast: -5 })).status).toBe('neutro');
  });

  it('constantes congeladas (oráculo de tunagem)', () => {
    expect(DEFASAGEM_CONST.TOL_PP).toBe(3);
    expect(DEFASAGEM_CONST.PISO_ALTA_PERC).toBe(2);
    expect(DEFASAGEM_CONST.PISO_ACAO_PERC).toBe(2);
    expect(DEFASAGEM_CONST.PISO_ACAO_REAIS).toBe(1);
    expect(DEFASAGEM_CONST.ANCORA_MESES_MAX).toBe(18);
    expect(DEFASAGEM_CONST.QUARENTENA_PERC).toBe(50);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que FALHA (helper não existe ainda)** — Run: `heavy bun run test src/lib/preco/defasagem.test.ts` — Expected: vitest falha no import/resolve (`Failed to resolve import "./defasagem"` ou `avaliarDefasagem is not a function`) — RED esperado do TDD.

- [ ] **Step 3: Commit do teste vermelho** — Run: `git add src/lib/preco/defasagem.test.ts && git commit -m "test(cockpit/2b): teste do helper de defasagem (vermelho — TDD antes da impl)"`

---

### Task 4: Helper puro `defasagem.ts` (oráculo da regra — peça de risco)

**Files:**
- Create: `src/lib/preco/defasagem.ts`

> A regra "à prova de catraca" (spec §5.2-5.4). Ordem dos guards é load-bearing — segue a spec literal. É o oráculo gêmeo da RPC (Task 5): a lógica SQL tem de bater 1:1 com este helper. `arred2` = arredonda a centavo. Assinatura EXATA conforme o briefing (consistência com Task 3/5/7/8 verificada no self-review).

- [ ] **Step 1: Criar `src/lib/preco/defasagem.ts`**

```ts
// Oráculo puro da defasagem de repasse POR CLIENTE (Fase 2b). A RPC
// get_defasagem_cliente (SQL numeric) é a AUTORIDADE em runtime — a UI lê o status
// da RPC, não deste helper. Este helper documenta a regra e é o oráculo do teste;
// por ser float (JS), pode divergir da RPC (numeric exato) em fronteiras decimais —
// NÃO usar pra decisão em runtime. A lógica SQL da RPC deve bater 1:1 com isto.
//
// Doutrina (money-path): PRECISÃO > recall. Alerta errado na frente do cliente é
// PIOR que silêncio. "Ausente ≠ zero": nunca fabricar número. Na dúvida → neutro.

export type StatusDefasagem =
  | 'defasado'
  | 'em_dia'
  | 'sem_historico'
  | 'sem_alta'
  | 'revisar'
  | 'sem_custo_atual_fresco'
  | 'sem_data_confiavel'
  | 'neutro';

export interface DefasagemInput {
  pNow: number;                  // preço que a vendedora vai praticar (carrinho)
  pLast: number | null;          // preço líquido da última compra deste cliente (âncora)
  cLast: number | null;          // CMC as-of a data da âncora (cmc_snapshot)
  cNow: number | null;           // CMC atual (inventory_position freshest)
  temAncora: boolean;            // existe order_items real do (cliente, produto)
  descontoNaoProvado: boolean;   // discount>0 em order_items OU sales_orders
  cNowFresco: boolean;           // inventory_position.synced_at dentro da janela (G6)
  dataConfiavel: boolean;        // dInc/proveniência boa da data da âncora (G7)
  ancoraMeses: number | null;    // idade da âncora em meses
  qtyRatioOk: boolean;           // quantity âncora vs carrinho na mesma ordem de grandeza (G5)
}

export interface DefasagemResult {
  status: StatusDefasagem;
  pReq: number | null;           // preço de equilíbrio do repasse = pLast*(cNow/cLast), arred2
  altaCustoPerc: number | null;  // (cNow/cLast - 1) * 100
  motivo: string;                // motivo honesto
}

export const DEFASAGEM_CONST = {
  TOL_PP: 3,            // tolerância em pontos percentuais (Codex #5)
  PISO_ALTA_PERC: 2,    // alta de custo mínima p/ sair do ruído de CMC
  PISO_ACAO_PERC: 2,    // piso de ação em % de pNow
  PISO_ACAO_REAIS: 1,   // piso de ação em R$ absolutos
  ANCORA_MESES_MAX: 18, // âncora mais velha que isso → neutro
  QUARENTENA_PERC: 50,  // alta de custo > isso → revisar (provável erro de cadastro/unidade)
} as const;

/** Arredonda a 2 casas (centavo). */
function arred2(n: number): number {
  return Math.round(n * 100) / 100;
}

function finitoPositivo(n: number | null): n is number {
  return n != null && Number.isFinite(n) && n > 0;
}

export function avaliarDefasagem(i: DefasagemInput): DefasagemResult {
  const neutro = (motivo: string): DefasagemResult =>
    ({ status: 'neutro', pReq: null, altaCustoPerc: null, motivo });

  // Ordem dos guards = fiel à spec §5.2-5.4. Degradação honesta antes de qualquer cálculo.
  if (!i.temAncora) {
    return { status: 'sem_historico', pReq: null, altaCustoPerc: null, motivo: 'sem_historico' };
  }
  if (i.descontoNaoProvado) {
    return neutro('desconto_nao_provado');
  }
  if (!i.dataConfiavel) {
    return { status: 'sem_data_confiavel', pReq: null, altaCustoPerc: null, motivo: 'sem_data_confiavel' };
  }
  if (!i.cNowFresco) {
    return { status: 'sem_custo_atual_fresco', pReq: null, altaCustoPerc: null, motivo: 'sem_custo_atual_fresco' };
  }
  // pLast/cLast/cNow têm que ser finitos e > 0 (NaN/≤0 → neutro; "ausente ≠ zero").
  if (!finitoPositivo(i.pLast) || !finitoPositivo(i.cLast) || !finitoPositivo(i.cNow)) {
    return neutro('sem_base');
  }
  const pLast = i.pLast;
  const cLast = i.cLast;
  const cNow = i.cNow;

  if (!i.qtyRatioOk) {
    return { status: 'revisar', pReq: null, altaCustoPerc: null, motivo: 'qty_divergente' };
  }
  if (i.ancoraMeses != null && i.ancoraMeses > DEFASAGEM_CONST.ANCORA_MESES_MAX) {
    return neutro('ancora_antiga');
  }

  const razaoCusto = cNow / cLast;

  // G4 quarentena: alta absurda (> +50%) → revisar, NÃO alerta de repasse.
  if (razaoCusto - 1 > DEFASAGEM_CONST.QUARENTENA_PERC / 100) {
    return { status: 'revisar', pReq: null, altaCustoPerc: null, motivo: 'quarentena_custo' };
  }

  // G1: vendeu no/abaixo do custo → não herda markup de prejuízo.
  if (pLast <= cLast) {
    return neutro('prejuizo_ancora');
  }

  // Só avalia se o custo SUBIU.
  if (cNow <= cLast) {
    return { status: 'sem_alta', pReq: null, altaCustoPerc: null, motivo: 'custo_nao_subiu' };
  }

  const alta = razaoCusto - 1; // fração
  // Piso de alta: abaixo de 2% é ruído de CMC → sem_alta.
  if (alta < DEFASAGEM_CONST.PISO_ALTA_PERC / 100) {
    return { status: 'sem_alta', pReq: null, altaCustoPerc: null, motivo: 'alta_ruido' };
  }

  const pReq = arred2(pLast * razaoCusto);
  const altaCustoPerc = alta * 100;

  // defasado SE (pNow/pLast - 1) < alta - TOL_PP/100.
  const subiuPreco = pNowFrac(i.pNow, pLast);
  const defasadoPorRazao = subiuPreco < alta - DEFASAGEM_CONST.TOL_PP / 100;

  if (!defasadoPorRazao) {
    return { status: 'em_dia', pReq, altaCustoPerc, motivo: 'preco_acompanhou' };
  }

  // Piso de ação (anti-arredondamento): só defasado se o gap em REAIS (arredondado a
  // centavo) ≥ max(2% de pNow, R$1,00). Centavo nunca dispara.
  const gapReais = arred2(pReq) - arred2(i.pNow);
  const pisoAcao = Math.max((DEFASAGEM_CONST.PISO_ACAO_PERC / 100) * i.pNow, DEFASAGEM_CONST.PISO_ACAO_REAIS);
  if (gapReais < pisoAcao) {
    return { status: 'em_dia', pReq, altaCustoPerc, motivo: 'gap_abaixo_do_piso' };
  }

  return { status: 'defasado', pReq, altaCustoPerc, motivo: 'custo_subiu_preco_nao_acompanhou' };
}

/** Fração de variação do preço praticado vs o da âncora. pNow pode ser ≤0/NaN → trata como 0 (não subiu). */
function pNowFrac(pNow: number, pLast: number): number {
  if (!Number.isFinite(pNow) || pNow <= 0) return -1; // preço inválido/zerado = "não subiu" (favorece detectar defasagem? não — segue a regra: subiu pouco)
  return pNow / pLast - 1;
}
```

- [ ] **Step 2: Rodar o teste e confirmar VERDE** — Run: `heavy bun run test src/lib/preco/defasagem.test.ts` — Expected: `Test Files 1 passed`, todos os `it` passam (defasado, em_dia, sem_alta, G1, âncora antiga, quarentena, fronteira da tolerância, piso de ação, desconto, stale, sem data, qty, sem âncora, inválido, constantes).

- [ ] **Step 3: Typecheck** — Run: `heavy bun run typecheck` — Expected: `tsc --noEmit` sem erros (strict).

- [ ] **Step 4: Commit** — Run: `git add src/lib/preco/defasagem.ts && git commit -m "feat(cockpit/2b): helper puro avaliarDefasagem (oráculo da regra à prova de catraca)"`

---

### Task 5: RPC `get_defasagem_cliente` (migration)

**Files:**
- Create: `supabase/migrations/20260627180100_get_defasagem_cliente.sql`

> SEPARADA da `get_preco_cockpit` (não toca a RPC de markup recém-estabilizada). Mesmo gate de staff (employee/master senão 42501), mesma ponte de conta, SECURITY DEFINER, STABLE, REVOKE anon. A lógica SQL deve bater 1:1 com o helper da Task 4 (oráculo duplo). Role-gate por `pode_ver_carteira_completa`: os absolutos (`p_last`, `c_last`, `c_now`, `markup_anterior`) só pra gestor; `p_req`/`alta_custo_perc`/`data_ancora`/`status` sempre visíveis (ação da vendedora). **Decisão de tunagem (flag pro founder):** o critério de "C_now stale" foi fixado em `synced_at > now() - interval '48 hours'` (ver §GAPS/Decisões) — ajustar aqui se quiser outro horizonte.

- [ ] **Step 1: Criar `supabase/migrations/20260627180100_get_defasagem_cliente.sql`**

```sql
-- Fase 2b — RPC da defasagem de repasse POR CLIENTE. Money-path (só-leitura).
-- SEPARADA da get_preco_cockpit (single-responsibility; não regride a RPC de markup).
--
-- Pra cada item {empresa, codigo, preco}:
--   ÂNCORA = última linha order_items do (customer_user_id, omie_codigo_produto) JOIN
--   sales_orders, account-aware (ponte da empresa), status allowlist positiva,
--   omie_pedido_id NOT NULL, deleted_at NULL. Data = dInc do omie_payload (fallback
--   order_date_kpi); sem data confiável → sem_data_confiavel. Multi-pedido no mesmo dia
--   → média ponderada por quantity. Desconto (order_items.discount>0 OU sales_orders
--   .discount>0) → neutro/desconto_nao_provado.
--   C_last = cmc_snapshot na data da âncora (janela ±7 dias, freshest); senão neutro.
--   C_now  = inventory_position freshest (cmc>0, account=ANY); synced_at stale (>48h)
--            → sem_custo_atual_fresco.
--   Regra à prova de catraca = MESMA do helper defasagem.ts (oráculo duplo).
--
-- Saída por item (visível p/ vendedora): status_defasagem, tem_ancora, p_req,
--   alta_custo_perc, data_ancora ('MM/AAAA'), motivo, calculated_at.
-- Role-gated (pode_ver_carteira_completa): p_last, c_last, c_now, markup_anterior.
--
-- Gate idêntico à 2a: auth.uid() + has_role(employee|master) senão 42501. REVOKE anon.
-- Aplicar via SQL Editor. Prova real: db/test-defasagem.sh (PG17 + falsificações).

CREATE OR REPLACE FUNCTION public.get_defasagem_cliente(p_itens jsonb, p_customer_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $defasagem$
DECLARE
  -- constantes (espelho de DEFASAGEM_CONST do helper)
  c_tol_pp        constant numeric := 3;      -- pontos percentuais
  c_piso_alta     constant numeric := 2;      -- % alta mínima (anti-ruído)
  c_piso_acao_pp  constant numeric := 2;      -- % de p_now
  c_piso_acao_rs  constant numeric := 1;      -- R$ absolutos
  c_ancora_max    constant int     := 18;     -- meses
  c_quarentena    constant numeric := 50;     -- % alta absurda
  c_janela_dias   constant int     := 7;      -- ±dias da data da âncora p/ casar C_last
  c_stale_horas   constant int     := 48;     -- C_now stale se synced_at < now()-48h

  v_pode_num boolean;
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_empresa text; v_codigo bigint; v_preco numeric; v_accounts text[];

  v_p_last numeric; v_qtd_ancora numeric; v_data_ancora date;
  v_disc boolean; v_qty_carrinho numeric;
  v_c_last numeric; v_c_now numeric; v_c_now_synced timestamptz;
  v_status text; v_motivo text; v_p_req numeric; v_alta_perc numeric;
  v_markup_ant numeric; v_tem_ancora boolean;
  v_razao numeric; v_alta numeric; v_subiu_preco numeric; v_gap_reais numeric; v_piso_acao numeric;
  v_data_label text;
BEGIN
  -- Gate de staff IDÊNTICO à 2a.
  IF NOT (auth.uid() IS NOT NULL
    AND (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role))) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  IF jsonb_array_length(p_itens) > 200 THEN
    RAISE EXCEPTION 'too many items (max 200)' USING errcode = '22023';
  END IF;
  v_pode_num := pode_ver_carteira_completa(auth.uid());

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    -- reset por item
    v_p_last := NULL; v_qtd_ancora := NULL; v_data_ancora := NULL; v_disc := NULL;
    v_c_last := NULL; v_c_now := NULL; v_c_now_synced := NULL; v_qty_carrinho := NULL;
    v_status := NULL; v_motivo := NULL; v_p_req := NULL; v_alta_perc := NULL;
    v_markup_ant := NULL; v_tem_ancora := false; v_data_label := NULL;

    v_empresa := lower(v_item->>'empresa');
    v_codigo  := (v_item->>'codigo')::bigint;
    v_preco   := (v_item->>'preco')::numeric;
    v_qty_carrinho := NULLIF(v_item->>'qty','')::numeric;  -- opcional (G5); se ausente, qty_ratio passa

    v_accounts := CASE v_empresa
            WHEN 'oben'       THEN ARRAY['vendas','oben']
            WHEN 'colacor'    THEN ARRAY['colacor_vendas','colacor']
            WHEN 'colacor_sc' THEN ARRAY['servicos','colacor_sc']
            ELSE ARRAY[v_empresa] END;

    -- ── ÂNCORA: última compra REAL deste cliente p/ este produto (account-aware) ──
    -- Data da âncora: dInc do omie_payload (DD/MM/YYYY) → fallback order_date_kpi.
    -- Pega o pedido mais recente por essa data; média ponderada por quantity é tratada
    -- abaixo (mesmo dia). Aqui resolvemos a DATA e o flag de desconto do pedido vencedor.
    WITH ancora AS (
      SELECT
        oi.unit_price,
        oi.quantity,
        oi.discount AS disc_item,
        so.discount AS disc_pedido,
        COALESCE(
          to_date(NULLIF(so.omie_payload->'infoCadastro'->>'dInc',''),'DD/MM/YYYY'),
          so.order_date_kpi
        ) AS data_real,
        (so.omie_payload->'infoCadastro'->>'dInc') IS NOT NULL
          OR so.order_date_kpi IS NOT NULL AS data_ok
      FROM order_items oi
      JOIN sales_orders so ON so.id = oi.sales_order_id
      WHERE oi.customer_user_id = p_customer_user_id
        AND oi.omie_codigo_produto = v_codigo
        AND so.account = ANY(v_accounts)
        AND so.status IN ('faturado','importado','separacao','enviado')  -- allowlist POSITIVA
        AND so.omie_pedido_id IS NOT NULL
        AND so.deleted_at IS NULL
    ),
    melhor_data AS (
      -- a data da âncora = a maior data_real entre as linhas válidas (com data_ok)
      SELECT max(data_real) AS data_real
      FROM ancora
      WHERE data_ok AND data_real IS NOT NULL
    ),
    no_dia AS (
      -- todas as linhas naquele dia → média ponderada por quantity do unit_price
      SELECT
        a.*,
        (SELECT data_real FROM melhor_data) AS data_alvo
      FROM ancora a
      WHERE a.data_real = (SELECT data_real FROM melhor_data)
    )
    SELECT
      CASE WHEN sum(quantity) > 0
           THEN sum(unit_price * quantity) / sum(quantity)
           ELSE NULL END,
      sum(quantity),
      (SELECT data_real FROM melhor_data),
      bool_or(COALESCE(disc_item,0) > 0 OR COALESCE(disc_pedido,0) > 0),
      (count(*) > 0)
    INTO v_p_last, v_qtd_ancora, v_data_ancora, v_disc, v_tem_ancora
    FROM no_dia;

    -- ── C_now: CMC atual freshest (account-aware), + frescor (G6) ──
    SELECT ip.cmc, ip.synced_at
      INTO v_c_now, v_c_now_synced
    FROM inventory_position ip
    WHERE ip.omie_codigo_produto = v_codigo
      AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
      AND ip.account = ANY(v_accounts)
    ORDER BY ip.synced_at DESC NULLS LAST
    LIMIT 1;

    -- ── C_last: cmc_snapshot na data da âncora, janela ±7 dias, o mais próximo ──
    IF v_data_ancora IS NOT NULL THEN
      SELECT cs.cmc
        INTO v_c_last
      FROM cmc_snapshot cs
      WHERE cs.omie_codigo_produto = v_codigo
        AND cs.account = ANY(v_accounts)
        AND cs.cmc > 0 AND cs.cmc <> 'NaN'::numeric
        AND abs(cs.data_posicao - v_data_ancora) <= c_janela_dias
      ORDER BY abs(cs.data_posicao - v_data_ancora) ASC, cs.synced_at DESC
      LIMIT 1;
    END IF;

    -- ════════ REGRA À PROVA DE CATRACA (1:1 com defasagem.ts) ════════
    -- Ordem dos guards = literal da spec §5.2-5.4.
    IF NOT v_tem_ancora THEN
      v_status := 'sem_historico'; v_motivo := 'sem_historico';
    ELSIF v_disc THEN
      v_status := 'neutro'; v_motivo := 'desconto_nao_provado';
    ELSIF v_data_ancora IS NULL THEN
      v_status := 'sem_data_confiavel'; v_motivo := 'sem_data_confiavel';
    ELSIF v_c_now IS NULL OR v_c_now_synced IS NULL
          OR v_c_now_synced < now() - make_interval(hours => c_stale_horas) THEN
      v_status := 'sem_custo_atual_fresco'; v_motivo := 'sem_custo_atual_fresco';
    ELSIF v_c_last IS NULL THEN
      -- sem snapshot na janela → neutro (não arrisca FP — Codex #1)
      v_status := 'neutro'; v_motivo := 'sem_custo_historico';
    ELSIF v_p_last IS NULL OR v_p_last <= 0 OR v_p_last = 'NaN'::numeric
          OR v_c_last <= 0 OR v_c_last = 'NaN'::numeric
          OR v_c_now  <= 0 OR v_c_now  = 'NaN'::numeric THEN
      v_status := 'neutro'; v_motivo := 'sem_base';
    ELSIF v_qty_carrinho IS NOT NULL AND v_qtd_ancora IS NOT NULL AND v_qtd_ancora > 0
          AND (v_qty_carrinho / v_qtd_ancora >= 10 OR v_qtd_ancora / v_qty_carrinho >= 10) THEN
      -- G5: ordem de grandeza divergente → revisar
      v_status := 'revisar'; v_motivo := 'qty_divergente';
    ELSIF EXTRACT(EPOCH FROM (now() - v_data_ancora::timestamptz)) / (86400 * 30.4375) > c_ancora_max THEN
      v_status := 'neutro'; v_motivo := 'ancora_antiga';
    ELSE
      v_razao := v_c_now / v_c_last;
      IF v_razao - 1 > c_quarentena / 100 THEN
        v_status := 'revisar'; v_motivo := 'quarentena_custo';
      ELSIF v_p_last <= v_c_last THEN
        v_status := 'neutro'; v_motivo := 'prejuizo_ancora';   -- G1
      ELSIF v_c_now <= v_c_last THEN
        v_status := 'sem_alta'; v_motivo := 'custo_nao_subiu';
      ELSE
        v_alta := v_razao - 1;
        IF v_alta < c_piso_alta / 100 THEN
          v_status := 'sem_alta'; v_motivo := 'alta_ruido';
        ELSE
          v_p_req := round(v_p_last * v_razao, 2);
          v_alta_perc := v_alta * 100;
          v_subiu_preco := CASE WHEN v_preco > 0 THEN v_preco / v_p_last - 1 ELSE -1 END;
          IF v_subiu_preco < v_alta - c_tol_pp / 100 THEN
            -- passa por razão → testa piso de ação (em R$ arredondado a centavo)
            v_gap_reais := round(v_p_req, 2) - round(v_preco, 2);
            v_piso_acao := greatest((c_piso_acao_pp / 100) * v_preco, c_piso_acao_rs);
            IF v_gap_reais < v_piso_acao THEN
              v_status := 'em_dia'; v_motivo := 'gap_abaixo_do_piso';
            ELSE
              v_status := 'defasado'; v_motivo := 'custo_subiu_preco_nao_acompanhou';
            END IF;
          ELSE
            v_status := 'em_dia'; v_motivo := 'preco_acompanhou';
          END IF;
        END IF;
      END IF;
    END IF;

    -- markup anterior (só p/ gestor) — só faz sentido com base válida.
    IF v_p_last IS NOT NULL AND v_c_last IS NOT NULL AND v_c_last > 0 AND v_c_last <> 'NaN'::numeric THEN
      v_markup_ant := (v_p_last - v_c_last) / v_c_last * 100;
    END IF;

    -- rótulo da data da âncora = MM/AAAA
    v_data_label := CASE WHEN v_data_ancora IS NOT NULL THEN to_char(v_data_ancora,'MM/YYYY') ELSE NULL END;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'codigo', v_codigo, 'empresa', v_empresa,
      'status_defasagem', v_status,
      'tem_ancora', v_tem_ancora,
      'p_req', to_jsonb(v_p_req),
      'alta_custo_perc', to_jsonb(v_alta_perc),
      'data_ancora', to_jsonb(v_data_label),
      'motivo', v_motivo,
      'calculated_at', now(),
      -- role-gated (absolutos só p/ pode_ver_carteira_completa):
      'p_last',         CASE WHEN v_pode_num THEN to_jsonb(v_p_last)      ELSE 'null'::jsonb END,
      'c_last',         CASE WHEN v_pode_num THEN to_jsonb(v_c_last)      ELSE 'null'::jsonb END,
      'c_now',          CASE WHEN v_pode_num THEN to_jsonb(v_c_now)       ELSE 'null'::jsonb END,
      'markup_anterior',CASE WHEN v_pode_num THEN to_jsonb(v_markup_ant)  ELSE 'null'::jsonb END
    ));
  END LOOP;

  RETURN v_out;
END;
$defasagem$;

REVOKE ALL ON FUNCTION public.get_defasagem_cliente(jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_defasagem_cliente(jsonb, uuid) TO authenticated;

-- ── Validação pós-apply ──
SELECT
  (SELECT count(*) FROM pg_proc WHERE proname='get_defasagem_cliente') AS func_1,
  (SELECT count(*) FROM information_schema.role_routine_grants
     WHERE routine_name='get_defasagem_cliente' AND grantee='anon') AS anon_grant_0;
-- esperado: 1, 0
```

- [ ] **Step 2: Commit (a prova roda na Task 6 — não há vitest pra SQL)** — Run: `git add supabase/migrations/20260627180100_get_defasagem_cliente.sql && git commit -m "feat(cockpit/2b): RPC get_defasagem_cliente (regra catraca em SQL, role-gate, REVOKE anon)"`

---

### Task 6: Teste PG17 `db/test-defasagem.sh` (prova da RPC + falsificações)

**Files:**
- Create: `db/test-defasagem.sh`

> Espelha `db/test-cockpit-preco.sh` (mesmo bring-up PG17 keg-only porta dedicada, stubs auth/has_role/user_roles/pode_ver_carteira_completa). Aplica `cmc_snapshot` + `get_defasagem_cliente` + stubs de `order_items`/`sales_orders`/`inventory_position`. Asserts da spec §8, incluindo o FP crítico (snapshot fora da janela ±7d), account-aware com FALSIFICAÇÃO, e role-gate com FALSIFICAÇÃO. Asserts negativos capturam a SQLSTATE esperada e re-lançam o resto (sem `WHEN OTHERS` cego).

- [ ] **Step 1: Criar `db/test-defasagem.sh` (parte 1 — bring-up, stubs, migrations, seed)**

```bash
#!/usr/bin/env bash
# Teste PG17 da defasagem por cliente (Fase 2b). Money-path (RPC só-leitura).
# Caminho LEVE: stubs mínimos do Supabase (auth/app_role/has_role/user_roles/
# pode_ver_carteira_completa + order_items/sales_orders/inventory_position) + as
# migrations NOVAS (20260627180000 cmc_snapshot, 20260627180100 get_defasagem_cliente)
# e EXECUTA os asserts:
#   D1  defasado básico (custo +20%, preço não acompanhou → defasado, p_req certo)
#   D2  snapshot FORA da janela ±7d → neutro (Codex #1, o FP crítico) — NÃO defasado
#   D3  desconto (order_items.discount>0) → neutro
#   D4  cent-rounding NÃO dispara (fronteira da tolerância)
#   D5  C_now stale (synced_at > 48h) → sem_custo_atual_fresco
#   D6  multi-pedido no MESMO dia → média ponderada por quantity
#   D7  status não-final (rascunho/cancelado/orcamento) EXCLUÍDO da âncora
#   D8  account-aware: mesmo código em 2 contas → âncora da conta certa + FALSIFICAÇÃO
#   D9  role-gate: gestor vê c_*, vendedora só p_req/status + FALSIFICAÇÃO
#   D10 REVOKE anon (permission denied for function)
# ⚠️ RLS só p/ não-superuser; psql roda como postgres (bypassa RLS) → A RPC é SECURITY
# DEFINER com gate INTERNO (has_role(auth.uid())) → asserts da RPC só setam test.uid;
# o REVOKE (D10) usa SET ROLE anon. Assert negativo: captura SQLSTATE esperada + re-lança.
# Base: db/test-cockpit-preco.sh. Pré-req: brew install postgresql@17.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5447   # porta dedicada (cockpit usa 5443; KB 5441; outros 5433/5436/5439)
DATA="$(mktemp -d /tmp/pgtest-defasagem.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-defasagem.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres defasagem_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d defasagem_verify "$@"; }

echo "→ stubs mínimos do Supabase (roles, auth, app_role, has_role, pode_ver_carteira_completa, tabelas)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;

DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL, role public.app_role NOT NULL, PRIMARY KEY (user_id, role)
);
CREATE OR REPLACE FUNCTION public.has_role(_uid uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role = _role);
$f$;
-- "vê número" = master (gestor); employee = vendedora (não vê). A FALSIFICAÇÃO (D9) reescreve.
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT public.has_role(_uid, 'master'::public.app_role);
$f$;

-- order_items (colunas que a RPC lê).
CREATE TABLE IF NOT EXISTS public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  omie_codigo_produto bigint,
  product_id uuid,
  quantity numeric NOT NULL DEFAULT 1,
  unit_price numeric NOT NULL DEFAULT 0,
  discount numeric,
  sales_order_id uuid NOT NULL,
  created_at timestamptz DEFAULT now()
);
-- sales_orders (status/account/order_date_kpi/omie_pedido_id/omie_payload/discount/deleted_at).
CREATE TABLE IF NOT EXISTS public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'vendas',
  status text NOT NULL DEFAULT 'faturado',
  order_date_kpi date,
  omie_pedido_id bigint,
  omie_payload jsonb,
  discount numeric NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  customer_user_id uuid NOT NULL
);
-- inventory_position (C_now freshest por synced_at).
CREATE TABLE IF NOT EXISTS public.inventory_position (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint NOT NULL,
  cmc numeric DEFAULT 0,
  account text NOT NULL DEFAULT 'vendas',
  synced_at timestamptz DEFAULT now()
);
SQL

echo "→ migration 20260627180000_cmc_snapshot.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260627180000_cmc_snapshot.sql" >/dev/null
echo "→ migration 20260627180100_get_defasagem_cliente.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260627180100_get_defasagem_cliente.sql" >/dev/null

echo "→ seed (roles + grants + âncoras + snapshots + C_now)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- a=master(gestor) b=employee(vendedora) c=customer
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-00000000000a','master'::public.app_role),
  ('00000000-0000-0000-0000-00000000000b','employee'::public.app_role),
  ('00000000-0000-0000-0000-00000000000c','customer'::public.app_role)
ON CONFLICT DO NOTHING;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cmc_snapshot, public.order_items, public.sales_orders, public.inventory_position TO authenticated, service_role;

-- cliente de teste
-- CL = 11111111-1111-1111-1111-111111111111
-- D1: oben, produto 1001. Âncora 20/03/2026 (dInc), pLast 100. C_last 60 (snapshot 20/03).
--     C_now 72 (+20%). preço carrinho 100 (não acompanhou) → defasado, p_req 120.
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000001','vendas','faturado','2026-03-20', 5001,
   '{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb, '11111111-1111-1111-1111-111111111111');
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1001, 4, 100, 'a0000000-0000-0000-0000-000000000001');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES
  ('vendas', 1001, '2026-03-20', 60);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES
  (1001, 'vendas', 72, now());

-- D2 (FP crítico): produto 1002, âncora 20/05/2026, MAS snapshot só em 30/04 (>±7d).
--     C_now 90 (alto). Sem snapshot na janela → neutro/sem_custo_historico (NÃO defasado).
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000002','vendas','faturado','2026-05-20', 5002,
   '{"infoCadastro":{"dInc":"20/05/2026"}}'::jsonb, '11111111-1111-1111-1111-111111111111');
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1002, 2, 100, 'a0000000-0000-0000-0000-000000000002');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES
  ('vendas', 1002, '2026-04-30', 50);   -- 20 dias antes da âncora → fora da janela ±7d
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES
  (1002, 'vendas', 90, now());

-- D3 (desconto): produto 1003, âncora com discount no item → neutro/desconto_nao_provado.
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000003','vendas','faturado','2026-03-20', 5003,
   '{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb, '11111111-1111-1111-1111-111111111111');
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, discount, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1003, 1, 100, 5, 'a0000000-0000-0000-0000-000000000003');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES ('vendas',1003,'2026-03-20',60);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES (1003,'vendas',72,now());

-- D4 (fronteira): produto 1004. C_last 60, C_now 66 (+10%). pLast 100 (>C_last, markup positivo),
--     preço carrinho 109,96 (+9,96%) → gap de pontos 0,04pp < TOL 3pp → em_dia (cent não dispara).
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000004','vendas','faturado','2026-03-20', 5004,
   '{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb, '11111111-1111-1111-1111-111111111111');
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1004, 1, 100, 'a0000000-0000-0000-0000-000000000004');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES ('vendas',1004,'2026-03-20',60);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES (1004,'vendas',66,now());

-- D5 (C_now stale): produto 1005. C_now synced há 72h (>48h) → sem_custo_atual_fresco.
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000005','vendas','faturado','2026-03-20', 5005,
   '{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb, '11111111-1111-1111-1111-111111111111');
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1005, 1, 100, 'a0000000-0000-0000-0000-000000000005');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES ('vendas',1005,'2026-03-20',60);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES (1005,'vendas',72, now() - interval '72 hours');

-- D6 (multi-pedido mesmo dia): produto 1006. DOIS pedidos em 20/03: q2@100 e q8@90.
--     média ponderada = (2*100+8*90)/10 = 92. C_last 60, C_now 80 (+33%). pReq=92*(80/60)=122,67.
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000061','vendas','faturado','2026-03-20', 5061,'{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb,'11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000062','vendas','faturado','2026-03-20', 5062,'{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb,'11111111-1111-1111-1111-111111111111');
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1006, 2, 100, 'a0000000-0000-0000-0000-000000000061'),
  ('11111111-1111-1111-1111-111111111111', 1006, 8,  90, 'a0000000-0000-0000-0000-000000000062');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES ('vendas',1006,'2026-03-20',60);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES (1006,'vendas',80,now());

-- D7 (status não-final): produto 1007. ÚNICO pedido é 'orcamento' → excluído → sem_historico.
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000007','vendas','orcamento','2026-03-20', 5007,'{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb,'11111111-1111-1111-1111-111111111111');
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1007, 1, 100, 'a0000000-0000-0000-0000-000000000007');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES ('vendas',1007,'2026-03-20',60);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES (1007,'vendas',72,now());

-- D8 (account-aware): produto 2080, MESMO código em 2 contas.
--   conta colacor_vendas: âncora pLast 200, snapshot 100, C_now 130 (+30%) → defasado (consultado como 'colacor').
--   conta vendas (oben):  âncora pLast 50,  snapshot 40,  C_now 44  → ruído. Se vazar p/ colacor, contamina.
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000081','colacor_vendas','faturado','2026-03-20', 5081,'{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb,'11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000082','vendas','faturado','2026-03-21', 5082,'{"infoCadastro":{"dInc":"21/03/2026"}}'::jsonb,'11111111-1111-1111-1111-111111111111');  -- 21/03 = +recente → a falsificação account-blind (ORDER BY data DESC) escolhe ESTE (pLast 50) e vaza
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 2080, 1, 200, 'a0000000-0000-0000-0000-000000000081'),
  ('11111111-1111-1111-1111-111111111111', 2080, 1,  50, 'a0000000-0000-0000-0000-000000000082');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES
  ('colacor_vendas', 2080, '2026-03-20', 100),
  ('vendas',         2080, '2026-03-20', 40);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES
  (2080, 'colacor_vendas', 130, now()),
  (2080, 'vendas',          44, now());
SQL
```

- [ ] **Step 2: Adicionar à `db/test-defasagem.sh` (parte 2 — asserts D1..D7)**

```bash
echo ""
echo "→ ASSERT D1 — defasado básico (custo +20%, preço não acompanhou → defasado, p_req 120):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1001,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->>'status_defasagem' <> 'defasado' THEN
    RAISE EXCEPTION 'D1 FALHOU: status=% motivo=% (esperado defasado)', r->>'status_defasagem', r->>'motivo';
  END IF;
  IF (r->>'p_req')::numeric <> 120 THEN
    RAISE EXCEPTION 'D1b FALHOU: p_req=% (esperado 120 = 100*72/60)', r->>'p_req';
  END IF;
  IF r->>'data_ancora' <> '03/2026' THEN
    RAISE EXCEPTION 'D1c FALHOU: data_ancora=% (esperado 03/2026 via dInc)', r->>'data_ancora';
  END IF;
  RAISE NOTICE 'OK D1 — defasado, p_req 120, âncora 03/2026';
END $$;
SQL

echo "→ ASSERT D2 — snapshot FORA da janela ±7d → neutro (Codex #1, FP crítico), NÃO defasado:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1002,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->>'status_defasagem' <> 'neutro' OR r->>'motivo' <> 'sem_custo_historico' THEN
    RAISE EXCEPTION 'D2 FALHOU: status=% motivo=% (esperado neutro/sem_custo_historico — snapshot a 20d da âncora)', r->>'status_defasagem', r->>'motivo';
  END IF;
  RAISE NOTICE 'OK D2 — snapshot fora de ±7d → neutro (não fabricou alta-fantasma)';
END $$;
SQL

echo "→ ASSERT D3 — desconto no item → neutro/desconto_nao_provado:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1003,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->>'status_defasagem' <> 'neutro' OR r->>'motivo' <> 'desconto_nao_provado' THEN
    RAISE EXCEPTION 'D3 FALHOU: status=% motivo=% (esperado neutro/desconto_nao_provado)', r->>'status_defasagem', r->>'motivo';
  END IF;
  RAISE NOTICE 'OK D3 — desconto → neutro/desconto_nao_provado';
END $$;
SQL

echo "→ ASSERT D4 — fronteira da tolerância (custo +10% / preço +9,96%) → em_dia (cent não dispara):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1004,"preco":109.96}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->>'status_defasagem' <> 'em_dia' THEN
    RAISE EXCEPTION 'D4 FALHOU: status=% (esperado em_dia — gap 0,04pp < TOL 3pp)', r->>'status_defasagem';
  END IF;
  RAISE NOTICE 'OK D4 — fronteira da tolerância → em_dia';
END $$;
SQL

echo "→ ASSERT D5 — C_now stale (synced há 72h) → sem_custo_atual_fresco:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1005,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->>'status_defasagem' <> 'sem_custo_atual_fresco' THEN
    RAISE EXCEPTION 'D5 FALHOU: status=% (esperado sem_custo_atual_fresco — synced há 72h > 48h)', r->>'status_defasagem';
  END IF;
  RAISE NOTICE 'OK D5 — C_now stale → sem_custo_atual_fresco';
END $$;
SQL

echo "→ ASSERT D6 — multi-pedido mesmo dia → média ponderada (pLast 92 → p_req 122,67):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master (vê p_last)
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1006,"preco":92}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF (r->>'p_last')::numeric <> 92 THEN
    RAISE EXCEPTION 'D6 FALHOU: p_last=% (esperado 92 = (2*100+8*90)/10 — média ponderada)', r->>'p_last';
  END IF;
  -- p_req = 92 * (80/60) = 122,666… → 122,67
  IF (r->>'p_req')::numeric <> 122.67 THEN
    RAISE EXCEPTION 'D6b FALHOU: p_req=% (esperado 122.67)', r->>'p_req';
  END IF;
  RAISE NOTICE 'OK D6 — média ponderada por quantity (p_last 92, p_req 122,67)';
END $$;
SQL

echo "→ ASSERT D7 — status não-final (orcamento) EXCLUÍDO da âncora → sem_historico:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1007,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->>'status_defasagem' <> 'sem_historico' THEN
    RAISE EXCEPTION 'D7 FALHOU: status=% (esperado sem_historico — único pedido é orcamento)', r->>'status_defasagem';
  END IF;
  RAISE NOTICE 'OK D7 — orcamento excluído da âncora → sem_historico';
END $$;
SQL
```

- [ ] **Step 3: Adicionar à `db/test-defasagem.sh` (parte 3 — D8 account-aware + FALSIFICAÇÃO)**

```bash
echo "→ ASSERT D8 — account-aware: mesmo código 2080 em 2 contas → âncora da conta certa:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master (vê c_last)
  -- consultado como 'colacor' (ponte → colacor_vendas): deve ver pLast 200, c_last 100, defasado.
  SELECT (public.get_defasagem_cliente('[{"empresa":"colacor","codigo":2080,"preco":200}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->>'status_defasagem' <> 'defasado' THEN
    RAISE EXCEPTION 'D8 FALHOU: status=% (esperado defasado na conta colacor)', r->>'status_defasagem';
  END IF;
  IF (r->>'c_last')::numeric <> 100 OR (r->>'p_last')::numeric <> 200 THEN
    RAISE EXCEPTION 'D8b FALHOU: c_last=% p_last=% (esperado 100/200 — conta colacor; se 40/50 vazou de vendas)', r->>'c_last', r->>'p_last';
  END IF;
  RAISE NOTICE 'OK D8 — âncora da conta colacor (c_last 100, p_last 200), não vazou de vendas';
END $$;
SQL
# FALSIFICAÇÃO D8: sabota a RPC removendo o filtro de conta (account = ANY → TRUE) e exige
# que a âncora ERRADA vaze (a de 'vendas' pode ganhar/contaminar). Prova que o filtro tem dente.
echo "  → FALSIFICAÇÃO D8 (sabota o filtro de conta na âncora → exige vazamento):"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- versão sabotada: troca "so.account = ANY(v_accounts)" por "TRUE" na CTE ancora.
-- (recria a função inteira com a 1 linha sabotada; restaurada logo depois pela migration.)
CREATE OR REPLACE FUNCTION public.get_defasagem_cliente_SABOTADA(p_itens jsonb, p_customer_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $sab$
DECLARE
  v_item jsonb; v_codigo bigint; v_accounts text[]; v_empresa text;
  v_p_last numeric; v_c_last numeric; v_data date;
BEGIN
  v_item := p_itens->0;
  v_empresa := lower(v_item->>'empresa'); v_codigo := (v_item->>'codigo')::bigint;
  v_accounts := CASE v_empresa WHEN 'colacor' THEN ARRAY['colacor_vendas','colacor'] ELSE ARRAY[v_empresa] END;
  -- SABOTAGEM: account = ANY trocado por TRUE → âncora account-blind.
  SELECT oi.unit_price INTO v_p_last
  FROM order_items oi JOIN sales_orders so ON so.id = oi.sales_order_id
  WHERE oi.customer_user_id = p_customer_user_id AND oi.omie_codigo_produto = v_codigo
    AND TRUE  -- <<< era so.account = ANY(v_accounts)
    AND so.status IN ('faturado','importado','separacao','enviado')
    AND so.omie_pedido_id IS NOT NULL AND so.deleted_at IS NULL
  ORDER BY so.order_date_kpi DESC LIMIT 1;
  RETURN jsonb_build_array(jsonb_build_object('p_last_blind', to_jsonb(v_p_last)));
END $sab$;
SQL
SAB=$(P -tA 2>&1 <<'SQL' || true
DO $$
DECLARE r jsonb; v numeric;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_defasagem_cliente_SABOTADA('[{"empresa":"colacor","codigo":2080,"preco":200}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  v := (r->>'p_last_blind')::numeric;
  -- account-blind: pode pegar o pedido de 'vendas' (pLast 50) em vez do de colacor (200).
  IF v = 50 THEN RAISE NOTICE 'SAB_VAZOU'; ELSE RAISE NOTICE 'SAB_NAO p_last=%', v; END IF;
END $$;
SQL
)
if echo "$SAB" | grep -q 'SAB_VAZOU'; then
  echo "  OK D8 (falsificação) — sem o filtro de conta a âncora de 'vendas' (50) vazou p/ colacor → D8 tem dente"
else
  echo "  D8 (falsificação) — account-blind não vazou neste seed (ambos os pedidos têm a MESMA data; o desempate não escolheu 'vendas')."
  echo "  Ajuste o seed pra a âncora de 'vendas' ser mais RECENTE (ex. dInc 21/03) e re-rode, garantindo que o account-blind a escolha."
  exit 1
fi
P -v ON_ERROR_STOP=1 -q -c 'DROP FUNCTION IF EXISTS public.get_defasagem_cliente_SABOTADA(jsonb, uuid);'
echo "  OK D8 (limpeza) — função sabotada removida"
```

> **Nota de seed p/ a FALSIFICAÇÃO D8:** o seed já põe a âncora de `vendas` (cód 2080) em **21/03** (mais recente que a de colacor, 20/03), então a sabotagem account-blind (`ORDER BY order_date_kpi DESC`) escolhe deterministicamente a âncora de `vendas` (pLast 50) e vaza → prova o dente do filtro de conta. O ramo de erro acima fica como salvaguarda (se o seed for revertido). A RPC real é account-aware, então o D8 positivo (consulta `colacor` → pLast 200) passa de qualquer jeito.

- [ ] **Step 4: Adicionar à `db/test-defasagem.sh` (parte 4 — D9 role-gate + FALSIFICAÇÃO, D10 REVOKE)**

```bash
echo ""
echo "→ ASSERT D9 — role-gate: gestor vê c_*, vendedora só p_req/status + FALSIFICAÇÃO:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  -- gestor (master): vê c_last/c_now/p_last/markup_anterior
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1001,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->'c_last' = 'null'::jsonb OR r->'c_now' = 'null'::jsonb OR r->'p_last' = 'null'::jsonb THEN
    RAISE EXCEPTION 'D9a FALHOU: gestor não viu c_last/c_now/p_last';
  END IF;

  -- vendedora (employee): c_* / p_last / markup_anterior = null, MAS p_req e status presentes.
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1001,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->'c_last' <> 'null'::jsonb OR r->'c_now' <> 'null'::jsonb
     OR r->'p_last' <> 'null'::jsonb OR r->'markup_anterior' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'D9b FALHOU: vendedora viu absoluto (c_last=% c_now=% p_last=%)', r->>'c_last', r->>'c_now', r->>'p_last';
  END IF;
  IF r->>'status_defasagem' <> 'defasado' OR (r->>'p_req')::numeric <> 120 THEN
    RAISE EXCEPTION 'D9c FALHOU: vendedora não viu status/p_req (=%/%)', r->>'status_defasagem', r->>'p_req';
  END IF;
  RAISE NOTICE 'OK D9 — gestor vê c_*; vendedora vê só status/p_req (120), absolutos null';
END $$;
SQL
# FALSIFICAÇÃO D9: sabota pode_ver_carteira_completa → true; o c_last DEVE vazar p/ a vendedora.
echo "  → FALSIFICAÇÃO D9 (sabota pode_ver_carteira_completa → true → exige vazamento):"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$ SELECT true $f$;
SQL
SAB=$(P -tA 2>&1 <<'SQL' || true
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1001,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->'c_last' <> 'null'::jsonb AND (r->>'c_last')::numeric = 60 THEN RAISE NOTICE 'SAB_VAZOU';
  ELSE RAISE NOTICE 'SAB_NAO c_last=%', r->>'c_last'; END IF;
END $$;
SQL
)
echo "$SAB" | grep -q 'SAB_VAZOU' && echo "  OK D9 (falsificação) — gate furado vazou c_last 60 p/ a vendedora → D9 tem dente" || { echo "  D9 FALHOU (falsificação): $SAB"; exit 1; }
# Restaura o gate correto (master-only).
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT public.has_role(_uid, 'master'::public.app_role);
$f$;
SQL
echo "  OK D9 (restauração) — gate master-only de volta"

echo ""
echo "→ ASSERT D10 — REVOKE anon (permission denied for function):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  SET ROLE anon;
  BEGIN
    PERFORM public.get_defasagem_cliente('[]'::jsonb, '11111111-1111-1111-1111-111111111111'::uuid);
    RESET ROLE;
    RAISE EXCEPTION 'D10 FALHOU: anon executou get_defasagem_cliente (REVOKE ausente)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      IF SQLERRM NOT ILIKE '%permission denied for function%' THEN
        RAISE EXCEPTION 'D10b FALHOU: 42501 mas mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK D10 — anon barrado (permission denied for function): %', SQLERRM;
  END;
END $$;
SQL

echo ""
echo "✅ test-defasagem: todos os asserts passaram (D1..D10 + falsificações D8/D9)"
```

- [ ] **Step 5: Tornar executável e RODAR o harness inteiro** — Run: `chmod +x db/test-defasagem.sh && heavy bash db/test-defasagem.sh` — Expected: termina com `✅ test-defasagem: todos os asserts passaram (D1..D10 + falsificações D8/D9)` e cada `OK Dn` impresso. Se D8 falhar por empate de data, aplicar o ajuste de seed da nota e re-rodar.

- [ ] **Step 6: FALSIFICAR o teste (sabotar a migration → exigir vermelho → restaurar)** — Run: editar temporariamente `supabase/migrations/20260627180100_get_defasagem_cliente.sql` trocando a janela `abs(cs.data_posicao - v_data_ancora) <= c_janela_dias` por `<= 999`, rodar `heavy bash db/test-defasagem.sh` e confirmar que **D2 FALHA** (o snapshot a 20d passa a casar → não é mais neutro). Depois `git checkout supabase/migrations/20260627180100_get_defasagem_cliente.sql` pra restaurar. — Expected: com `<= 999`, `D2 FALHOU` (vermelho); após restaurar, tudo verde de novo. Prova que D2 tem dente.

- [ ] **Step 7: Commit** — Run: `git add db/test-defasagem.sh && git commit -m "test(cockpit/2b): PG17 db/test-defasagem.sh (D1..D10 + falsificações account/role + sabotagem da janela)"`

---

### Task 7: Hook `useDefasagemCliente.ts`

**Files:**
- Create: `src/hooks/useDefasagemCliente.ts`

> Espelha `usePrecoCockpit.ts` e `useReguaPreco.ts`: `useQuery` chamando `rpc('get_defasagem_cliente', {p_itens, p_customer_user_id})`, `enabled` só com `customerUserId` e itens>0, `queryKey` com o `user.id` REAL (anti-leak entre usuários no mesmo browser) + `customerUserId`. Tipo `LinhaDefasagem` espelha o retorno da RPC (campos da Task 5). Retorna mapa por chave (`chaveCockpit`) como o cockpit, pra casar com a linha do carrinho.

- [ ] **Step 1: Criar `src/hooks/useDefasagemCliente.ts`**

```ts
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { chaveCockpit } from '@/hooks/usePrecoCockpit';
import type { StatusDefasagem } from '@/lib/preco/defasagem';

/** Item de entrada da RPC de defasagem (1 por linha de produto do carrinho). */
export interface ItemDefasagemInput {
  empresa: string;
  codigo: number;
  preco: number;
  qty?: number;            // opcional (G5: ordem de grandeza âncora vs carrinho)
  tint_formula_id?: string | null;
}

/** Espelha o retorno por item de get_defasagem_cliente (Task 5). */
export interface LinhaDefasagem {
  codigo: number;
  empresa: string;
  status_defasagem: StatusDefasagem;
  tem_ancora: boolean;
  p_req: number | null;
  alta_custo_perc: number | null;
  data_ancora: string | null;   // 'MM/AAAA'
  motivo: string;
  calculated_at: string;
  // role-gated (gestor): null pra vendedora.
  p_last: number | null;
  c_last: number | null;
  c_now: number | null;
  markup_anterior: number | null;
}

type RpcResult = { data: LinhaDefasagem[] | null; error: unknown };
const callRpc = (args: { p_itens: ItemDefasagemInput[]; p_customer_user_id: string }) =>
  (supabase.rpc as never as (fn: string, a: typeof args) => Promise<RpcResult>)(
    'get_defasagem_cliente', args,
  );

/**
 * Defasagem de repasse por cliente, 1 batch por carrinho. Só dispara com cliente
 * selecionado e itens>0. queryKey inclui o user.id REAL (identidade, nunca a lente
 * "Ver como") — anti-leak de markup/custo entre usuários no mesmo browser. Falha da
 * RPC NÃO derruba o carrinho (a defasagem é informativa). Retorna mapa por chave
 * estável (chaveCockpit) pra casar com a linha.
 */
export function useDefasagemCliente(itens: ItemDefasagemInput[], customerUserId: string | null) {
  const { user } = useAuth();

  const query = useQuery({
    queryKey: ['defasagem-cliente', user?.id ?? 'anon', customerUserId, itens],
    enabled: !!customerUserId && itens.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<LinhaDefasagem[]> => {
      const { data, error } = await callRpc({ p_itens: itens, p_customer_user_id: customerUserId! });
      if (error) throw error;
      return (data as LinhaDefasagem[]) ?? [];
    },
  });

  // Casa por chave estável (NA ORDEM do input — a RPC devolve 1 linha por item, em ordem).
  const defasagemByKey = useMemo(() => {
    const m = new Map<string, LinhaDefasagem>();
    const list = query.data;
    if (!list) return m;
    itens.forEach((inp, i) => {
      const l = list[i];
      if (l) m.set(chaveCockpit(inp.empresa, inp.codigo, inp.tint_formula_id), l);
    });
    return m;
  }, [itens, query.data]);

  return { defasagemByKey, isLoading: query.isLoading };
}
```

- [ ] **Step 2: Typecheck** — Run: `heavy bun run typecheck` — Expected: sem erros (strict). Confirma que `StatusDefasagem` importado de `defasagem.ts` e os campos do mapa batem.

- [ ] **Step 3: Commit** — Run: `git add src/hooks/useDefasagemCliente.ts && git commit -m "feat(cockpit/2b): hook useDefasagemCliente (rpc get_defasagem_cliente, queryKey com user real)"`

---

### Task 8: Badge de defasagem no `CartItemList.tsx`

**Files:**
- Modify: `src/components/unified-order/CartItemList.tsx`

> Pluga um badge de defasagem ao lado do badge da faixa (no `<div className="mt-0.5 flex ...">`, linhas ~122-152). Usa `useDefasagemCliente` com o `customerUserId` que **já chega como prop** (linha 39/49 — confirmado: vem de `h.customerUserId` em `UnifiedOrder.tsx`, sourced de `useCustomerSelection.ts`). `status='defasado'` → badge tom warning "custo +Y% · repassar p/ R$ P_req"; `status='revisar'` → badge neutro "revisar"; demais status → nada (não polui). Role: `p_req`/`alta` são da vendedora (ação dela); `c_*` nunca aparecem (já null pra ela na RPC). Tokens `text-status-*` (não cores cruas).

- [ ] **Step 1: Adicionar os imports do hook** — no topo de `CartItemList.tsx`, logo após a linha `import { FAIXA_UI } from '@/lib/preco/faixa-ui';` (linha 14), inserir:

```ts
import { useDefasagemCliente, type ItemDefasagemInput, type LinhaDefasagem } from '@/hooks/useDefasagemCliente';
```

- [ ] **Step 2: Montar os itens de defasagem + chamar o hook** — logo após o bloco `cockpitByKey` (termina na linha 73, antes do comentário `// Régua de Preço`), inserir:

```ts
  // Defasagem por cliente (Fase 2b): alta de custo desde a última compra DESTE cliente
  // que o preço não acompanhou → badge de repasse na linha. 1 batch por carrinho.
  // Só dispara com cliente selecionado (o hook gateia por customerUserId).
  const defasagemItens = useMemo<ItemDefasagemInput[]>(() =>
    [...obenProductItems, ...colacorProductItems]
      .map(it => ({
        empresa: it.product.account ?? '',
        codigo: it.product.omie_codigo_produto,
        preco: it.unit_price,
        qty: it.quantity,
        tint_formula_id: it.tint_formula_id ?? null,
      }))
      .filter(i => i.preco > 0 && Number.isFinite(i.codigo) && i.empresa !== ''),
    [obenProductItems, colacorProductItems],
  );
  const { defasagemByKey } = useDefasagemCliente(defasagemItens, customerUserId);
```

- [ ] **Step 3: Resolver a linha de defasagem por item no `renderProductGroup`** — dentro do `.map(item => {...})` do `renderProductGroup`, logo após `const health = cockpitByKey.get(chave);` (linha 103), inserir:

```ts
        const defas: LinhaDefasagem | undefined = defasagemByKey.get(chave);
        const mostraDefasagem = defas?.status_defasagem === 'defasado' || defas?.status_defasagem === 'revisar';
```

- [ ] **Step 4: Renderizar o badge** — na condição do `<div className="mt-0.5 flex ...">` (linha 122), incluir a defasagem na guarda de exibição e adicionar o badge. Substituir a abertura do bloco (linha 122):

```tsx
                {((health && health.faixa !== 'neutro' && FAIXA_UI[health.faixa]) || regua || mostraDefasagem) && (
                  <div className="mt-0.5 flex items-center gap-1 flex-wrap">
```

e, logo APÓS o fechamento do `</Badge>` do cockpit (linha 137, antes do bloco `{regua && (`), inserir o badge de defasagem:

```tsx
                    {mostraDefasagem && defas && (
                      defas.status_defasagem === 'defasado' ? (
                        <Badge
                          variant="outline"
                          className="text-[9px] px-1 py-0 text-status-warning"
                          title="Custo subiu desde a última compra deste cliente e o preço não acompanhou — preço de equilíbrio preserva o markup anterior"
                        >
                          {defas.alta_custo_perc != null ? `custo +${Math.round(defas.alta_custo_perc)}%` : 'custo subiu'}
                          {defas.p_req != null && <span className="font-mono ml-1">· repassar p/ {fmt(defas.p_req)}</span>}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[9px] px-1 py-0 text-muted-foreground border-border"
                          title="Âncora incerta (custo/quantidade) — revisar antes de repassar"
                        >
                          revisar
                        </Badge>
                      )
                    )}
```

- [ ] **Step 5: Typecheck** — Run: `heavy bun run typecheck` — Expected: sem erros (strict). Confirma que `LinhaDefasagem`/`ItemDefasagemInput` resolvem e `fmt` (já importado de `useUnifiedOrder`, linha 12) cobre `p_req`.

- [ ] **Step 6: Rodar a suíte de testes do componente (regressão do priceGuard) + lint** — Run: `heavy bun run test src/components/unified-order/__tests__/CartItemList.priceGuard.test.tsx && bun lint src/components/unified-order/CartItemList.tsx src/hooks/useDefasagemCliente.ts` — Expected: teste do priceGuard passa (o badge novo não quebra o destaque de preço ≤0) e lint limpo (sem `text-red-600`/cores cruas; tokens `text-status-*`).

- [ ] **Step 7: Commit** — Run: `git add src/components/unified-order/CartItemList.tsx && git commit -m "feat(cockpit/2b): badge de defasagem na linha do carrinho (repasse p/ vendedora, custo só gestor)"`

---

## Sequência de deploy (Lovable — manual, pós-merge)

> Migrations e edge NÃO auto-deployam no Lovable. Após o PR mergear, o founder aplica:
> 1. **SQL Editor** — colar `20260627180000_cmc_snapshot.sql` (validar: tabela/policy/check/idx) → depois `20260627180100_get_defasagem_cliente.sql` (validar: func=1, anon_grant=0).
> 2. **Chat do Lovable** — deploy do edge `cmc-snapshot-backfill` (ler do repo, verbatim).
> 3. **Backfill (1×, manual):** invoke `cmc-snapshot-backfill` modo `exato` com as âncoras candidatas (ou `grade` no range de 12-18 meses) por conta — só DEPOIS do GATE 1 PROVADO.
> 4. **Cron mensal** — colar o SQL do cron (comentado no topo do edge) no SQL Editor (3 contas, `timeout_milliseconds := 600000`).
> 5. **Publish frontend** (editor do Lovable) pra o badge ir ao ar.
> 6. Verificar `net._http_response` após o 1º run do cron (cron.job_run_details=succeeded só prova o enqueue).

---

## Self-Review (plano vs spec)

### 1. Cobertura — cada seção da spec tem tarefa?

| Spec | Onde | Status |
|---|---|---|
| §3 GATE 1 (`dDataPosicao`) | **PROVADO 27/06** — 21/773 SKUs distintos via `cmc-snapshot-smoke` | ✅ fechado — backfill liberado |
| §3 GATE 2 (desconto) | Resolvido no dado; guard na RPC (Task 5) + teste D3 (Task 6) | ✅ |
| §4 `cmc_snapshot` | Task 1 | ✅ |
| §4 Edge backfill (exato + grade + cron) | Task 2 | ✅ |
| §4 RPC separada | Task 5 | ✅ |
| §4 Hook + UI | Task 7 + Task 8 | ✅ |
| §5.1 Âncora (account-aware, status allowlist, dInc→order_date_kpi, P_last líquido, multi-pedido média ponderada, C_last/C_now) | Task 5 (RPC) + Task 4 (helper) | ✅ |
| §5.2 Regra catraca (tol_pp=3, piso alta 2%, P_req, piso de ação) | Task 4 + Task 5 (1:1) | ✅ |
| §5.3 Guards G1-G7 | Task 4/5: G1 prejuizo_ancora, G2 allowlist, G3 ancora_antiga, G4 quarentena, G5 qty_divergente, G6 sem_custo_atual_fresco, G7 sem_data_confiavel | ✅ |
| §5.4 Degradação honesta (todos os status) | `StatusDefasagem` (Task 4) cobre os 8 status | ✅ |
| §6 Segurança/vazamento (role-gate absolutos) | Task 5 (`pode_ver_carteira_completa`) + D9 falsificação | ✅ |
| §7 Saída da RPC (campos visíveis + role-gated) | Task 5 `jsonb_build_object` | ✅ |
| §8 Testes (helper + PG17 + falsificações) | Task 3/4 (vitest) + Task 6 (PG17 D1-D10) | ✅ |
| §8 Backfill smoke (paginação até vazia + idempotência) | Task 2 (`cmcPorData` para na página vazia; upsert on conflict) | ✅ parcial — ver GAP 3 |
| §9 Sequência gated | Banner + seção de deploy | ✅ |

**Gaps de cobertura identificados e tratados:**
- **G5 unidade (limitação real da spec, sem coluna `unidade`):** implementado via ordem-de-grandeza de `quantity` (`>= 10×` divergência → `revisar`). Residual honesto da spec §10 #7 (troca sutil de unidade não detectável) — documentado, não eliminável no v1.
- **Backfill idempotência/paginação:** o edge é idempotente (upsert on conflict) e pagina até a página vazia, mas **não há teste automatizado do edge** (não há harness Deno no projeto; o `cmc-snapshot-smoke` também não tem). O `deno check` cobre tipos; a prova funcional é o invoke manual no deploy. Aceito (mesma postura do smoke da 2a/gate).

### 2. Placeholders — nenhum "TODO"/"similar a"

Varri o documento: todo passo que mexe em código tem bloco COMPLETO (migration, edge, helper, teste, hook, JSX). Nenhum "similar à Task N", "adicione validação", "TODO". As únicas referências cruzadas são de PADRÃO ("espelha X") seguidas do código real inline, não substituições. ✅

### 3. Consistência de tipos entre Task 3/4/5/7/8

- **`StatusDefasagem`** (8 valores): definido na Task 4 (`defasagem.ts`), importado na Task 7 (`useDefasagemCliente.ts`) e usado na Task 8 (comparações `=== 'defasado'`/`'revisar'`). A RPC (Task 5) emite as MESMAS strings em `status_defasagem`. ✅
- **Nomes de campo do retorno da RPC:** `status_defasagem`, `tem_ancora`, `p_req`, `alta_custo_perc`, `data_ancora`, `motivo`, `calculated_at`, `p_last`, `c_last`, `c_now`, `markup_anterior` — idênticos entre Task 5 (`jsonb_build_object`), Task 6 (asserts `r->>'...'`) e Task 7 (`interface LinhaDefasagem`). ✅
- **`DefasagemInput` (helper) vs colunas da RPC:** o helper usa nomes camelCase do domínio (`pNow`, `pLast`, `cLast`, `cNow`, `ancoraMeses`, `qtyRatioOk`, `cNowFresco`, `dataConfiavel`); a RPC computa os equivalentes em SQL. São oráculos gêmeos da MESMA regra — o teste de paridade é o casamento dos status nos casos (Task 3 vitest vs Task 6 D1-D7 com os mesmos números: +20%→defasado, +10%/+9,96%→em_dia, +60%→revisar). ✅ (corrigi inline o caso "piso de ação" do teste pra usar números que isolam o piso e não a tolerância.)
- **`ItemDefasagemInput`:** definido na Task 7, montado na Task 8 (`empresa/codigo/preco/qty/tint_formula_id`). O `qty` é lido pela RPC como `p_itens[].qty` (Task 5, `v_qty_carrinho`) pro G5. ✅
- **Constantes:** `DEFASAGEM_CONST` (Task 4) e as `constant numeric` da RPC (Task 5) têm os MESMOS valores (TOL_PP 3, PISO_ALTA 2, PISO_ACAO 2/R$1, ANCORA 18, QUARENTENA 50, janela 7, stale 48h). ✅

**Correção inline aplicada durante o review:** o caso "piso de ação" no teste da Task 3 foi reescrito pra usar `pLast 9 / pNow 9 / cLast 100 / cNow 110` — assim a razão passa a tolerância (gap 10pp > 3pp) mas o gap em R$ (0,90) fica < R$1,00 (piso de ação), isolando o piso e não a tolerância. O comentário no teste documenta o raciocínio.

---

## Decisões / GAPS para o olhar do founder

1. **`C_now` stale = 48h (DECISÃO minha, tunável — sinalizo).** A spec §5.3 G6 diz "mesma guarda da 2a" e §5 "defina o critério igual à 2a, ex. > X dias", mas a RPC da 2a (`get_preco_cockpit`) na verdade **NÃO rejeita por staleness** — só expõe `frescor` (o `synced_at`) e deixa a UI julgar. A convenção de data-health do repo é `> 3h = stale` pro `inventory_position` (cron de 30 min). Pra um guard de DEGRADAÇÃO money-path (`sem_custo_atual_fresco`), 3h seria agressivo demais (qualquer hiccup de sync mataria o sinal). Fixei **48h** na RPC (`c_stale_horas := 48`) — longo o bastante pra sobreviver a um sync atrasado, curto o bastante pra custo genuinamente velho não gerar alerta. **Trocar a constante na Task 5 se quiser outro horizonte.**

2. **customer_user_id no carrinho — SEM GAP.** Confirmado: `CartItemList` já recebe `customerUserId: string | null` como prop (`CartItemList.tsx:39,49`), passado de `UnifiedOrder.tsx:416` (`h.customerUserId`), que vem de `useUnifiedOrder` → `useCustomerSelection.ts:87` (estado `customerUserId`). Já é usado pela Régua (`useReguaPreco(reguaItens, customerUserId, ...)`, linha 92) e pelos logs. A 2b reusa exatamente esse fio — nenhuma plumbing nova de cliente é necessária. O hook gateia (`enabled: !!customerUserId`), então sem cliente selecionado o badge simplesmente não aparece (= D2 da spec: sem histórico → silencioso).

3. **Falsificação D8 (account-blind) depende do desempate de data.** No seed, as duas âncoras do código 2080 (contas `colacor_vendas` e `vendas`) estão na MESMA data (20/03), então a sabotagem account-blind pode não escolher deterministicamente a errada. Deixei a falsificação com um ramo que **instrui o ajuste** (tornar a âncora de `vendas` mais recente, ex. 21/03) e falha alto se não vazar — pra não dar falso "OK" de teatro. O assert POSITIVO D8 (RPC real account-aware) passa de qualquer jeito. **Decisão sua:** se preferir, ajuste o seed já na escrita pra a âncora de `vendas` ser 21/03 (a nota está no Step 3 da Task 6).

4. **Backfill exato precisa da LISTA de âncoras candidatas.** O modo `exato` recebe `{omie_codigo_produto, data_posicao}[]` — essa lista sai de uma query nas âncoras reais (`order_items` JOIN `sales_orders` com a allowlist + dInc), que **não está no escopo destas 8 tasks** (é um SELECT read-only que você roda no SQL Editor pra montar o payload do invoke, ou um passo futuro de orquestração). Sinalizo pra você decidir: rodar o `grade` (cobre tudo, mais chamadas Omie) no primeiro backfill e deixar o `exato` pra refinar as âncoras quentes, OU gerar a lista de âncoras via query antes do invoke exato. O edge suporta os dois; a escolha de operação é sua.

5. **Empate de status helper×RPC em fronteiras decimais.** O helper é float (JS), a RPC é numeric (exato). Nas FRONTEIRAS finas (ex. exatamente no `tol_pp`), podem divergir no último centavo — por isso o helper diz explicitamente "não usar pra runtime; a RPC é a autoridade". Os testes usam números que NÃO ficam na borda exata (margem confortável), então a paridade é estável. Aceito (mesma doutrina do `cockpit-preco.ts` da 2a).
