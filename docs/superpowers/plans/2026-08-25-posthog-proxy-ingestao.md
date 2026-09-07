# Proxy de ingestão do PostHog — plano de implementação

> # ⛔ SUPERADO — NÃO IMPLEMENTAR
>
> **Este documento descreve trabalho que foi RECUSADO.** A decisão vigente está na `§DECISÃO` de
> [`analytics.md`](../../agent/analytics.md) (PR #2010, mergeado em 2026-08-25 13:06Z — **13 minutos
> antes** deste documento chegar à `main`).
>
> **A premissa daqui é falsa:** o proxy recuperaria a "população externa censurada", e essa
> população é **vazia** — 5.664 contas com role customer, mas **0 aprovadas** (os 5.664 são cadastro
> Omie sem `is_approved`). Some-se que `*.supabase.co` não é first-party, e que o único cliente
> bloqueado medido era o próprio founder.
>
> O proxy chegou a ser **implementado e revisado** antes da descoberta, e foi descartado. As lições
> técnicas que sobreviveram estão em
> [`proxy-posthog-descartado.md`](../../historico/proxy-posthog-descartado.md); a colisão entre
> sessões, em [`duplicata-por-objetivo.md`](../../historico/duplicata-por-objetivo.md).
>
> Mantido na `main` porque a `§DECISÃO` nomeia um **gatilho** que reabriria o assunto — se ele
> disparar, o desenho é ponto de partida, não trabalho pendente.


> **Para agentes:** SUB-SKILL OBRIGATÓRIA: use `superpowers:subagent-driven-development`
> (recomendado) ou `superpowers:executing-plans` para executar tarefa a tarefa. Os passos usam
> checkbox (`- [ ]`) para rastreio.

**Goal:** Fazer a telemetria de browser sobreviver a bloqueadores de rastreador, encaminhando a
ingestão do PostHog por uma edge do Supabase.

**Architecture:** Uma edge pública (`posthog-proxy`) recebe o tráfego do `posthog-js` e o encaminha
para **dois** upstreams fixos (`us.i.posthog.com` para ingestão, `us-assets.i.posthog.com` para
`/static/*` e `/array/*`), com allowlist de caminho e descarte de headers de entrada. A edge conta
o próprio tráfego numa tabela — contador imune ao bloqueador e ao PostHog. O cliente não muda:
`src/lib/analytics.ts:32` já lê `VITE_POSTHOG_HOST`.

**Tech Stack:** Deno (edge do Supabase) · PostgreSQL 17 (Supabase) · `posthog-js` 1.373.4 · Vite env.

**Spec:** [`2026-08-25-posthog-proxy-ingestao-design.md`](../specs/2026-08-25-posthog-proxy-ingestao-design.md)

## Global Constraints

- **`test:edges` roda `deno test --no-remote --allow-read=supabase/functions`.** Teste de edge
  **não pode ter import remoto** — nem `https://deno.land/std/...`. Escreva os asserts à mão, como
  `supabase/functions/_shared/anthropic_test.ts` já faz. **Nunca afrouxar o `--no-remote`.**
- **Três gates de edge e nenhum cobre o outro:** `bun run test:edges` (suíte Deno) ·
  `bun run edges:typecheck` (a Deno **não** type-checa sozinha) · `bun run test` (vitest, que lê
  edges como TEXTO).
- **Toda falsificação exige COMMIT antes** — `restaurar()` costuma ser `git checkout --`.
- **Migration custom NÃO auto-aplica** no Lovable Cloud. Exige o pacote de 5 itens da skill
  `lovable-db-operator`. Falha é SILENCIOSA.
- **Nada no front consome a tabela nova.** Isso é deliberado: `src/integrations/supabase/types.ts` é
  gerado pelo Lovable e não é atualizado por migration colada à mão — o primeiro PR que
  referenciasse a tabela deixaria a `main` VERMELHA. A leitura do contador é por `psql-ro`.
- **Upstreams, literais, nunca vindos da requisição:** `https://us.i.posthog.com` e
  `https://us-assets.i.posthog.com`.
- Nome da edge: **`posthog-proxy`**.

---

## Estrutura de arquivos

| arquivo | responsabilidade |
|---|---|
| `supabase/functions/_shared/posthog-proxy-rotas.ts` (criar) | Lógica **pura**: normalizar caminho, decidir upstream+classe, allowlist de headers. Sem I/O — é o que torna o teste possível sob `--no-remote`. |
| `supabase/functions/_shared/posthog-proxy-rotas_test.ts` (criar) | Suíte Deno da lógica pura, com casos negativos. |
| `supabase/functions/posthog-proxy/index.ts` (criar) | Só o I/O: CORS, teto de corpo, `fetch` upstream, contador via `waitUntil`. |
| `supabase/config.toml` (modificar) | `[functions.posthog-proxy] verify_jwt = false`. |
| `supabase/migrations/<ts>_posthog_proxy_stats.sql` (criar) | Tabela + RPC de incremento + RLS + REVOKE. |
| `docs/agent/analytics.md` (modificar) | Como ler o contador. |

---

### Task 1: Lógica pura de roteamento

**Files:**
- Create: `supabase/functions/_shared/posthog-proxy-rotas.ts`
- Test: `supabase/functions/_shared/posthog-proxy-rotas_test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `type ClasseRota = 'ingest' | 'assets' | 'flags' | 'replay'` ·
  `rotearCaminho(caminho: string): { upstream: string; classe: ClasseRota } | null` ·
  `extrairCaminho(pathname: string): string` ·
  `HEADERS_PERMITIDOS: readonly string[]`.

- [ ] **Passo 1: escrever o teste que falha**

Crie `supabase/functions/_shared/posthog-proxy-rotas_test.ts`:

```ts
// Testa o CÓDIGO REAL de _shared/posthog-proxy-rotas.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/
import { extrairCaminho, HEADERS_PERMITIDOS, rotearCaminho } from "./posthog-proxy-rotas.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`);
  }
}

const INGEST = "https://us.i.posthog.com";
const ASSETS = "https://us-assets.i.posthog.com";

Deno.test("extrairCaminho remove o prefixo da edge", () => {
  assertEquals(extrairCaminho("/functions/v1/posthog-proxy/i/v0/e/"), "/i/v0/e/");
  assertEquals(extrairCaminho("/posthog-proxy/static/surveys.js"), "/static/surveys.js");
  assertEquals(extrairCaminho("/functions/v1/posthog-proxy"), "/");
});

Deno.test("assets e config remota vão para o host de assets", () => {
  assertEquals(rotearCaminho("/static/surveys.js"), { upstream: ASSETS, classe: "assets" });
  assertEquals(rotearCaminho("/array/phc_abc/config.js"), { upstream: ASSETS, classe: "assets" });
});

Deno.test("ingestão vai para o host de ingestão, com e sem barra final", () => {
  assertEquals(rotearCaminho("/i/v0/e/"), { upstream: INGEST, classe: "ingest" });
  assertEquals(rotearCaminho("/i/v0/e"), { upstream: INGEST, classe: "ingest" });
  assertEquals(rotearCaminho("/e/"), { upstream: INGEST, classe: "ingest" });
  assertEquals(rotearCaminho("/batch/"), { upstream: INGEST, classe: "ingest" });
});

Deno.test("flags e replay têm classe própria", () => {
  assertEquals(rotearCaminho("/flags"), { upstream: INGEST, classe: "flags" });
  assertEquals(rotearCaminho("/decide/"), { upstream: INGEST, classe: "flags" });
  assertEquals(rotearCaminho("/s/"), { upstream: INGEST, classe: "replay" });
});

Deno.test("fora da allowlist devolve null — este é o teste que importa", () => {
  assertEquals(rotearCaminho("/"), null);
  assertEquals(rotearCaminho("/qualquer"), null);
  assertEquals(rotearCaminho("/api/internal"), null);
  // um caminho que só CONTÉM um termo da allowlist não passa
  assertEquals(rotearCaminho("/naoe/static/x.js"), null);
});

Deno.test("travessia de diretório é recusada mesmo sob prefixo permitido", () => {
  assertEquals(rotearCaminho("/static/../../etc/passwd"), null);
  assertEquals(rotearCaminho("/array/..%2Fx"), null);
});

Deno.test("a allowlist de headers não deixa passar auth nem cookie", () => {
  const proibidos = ["authorization", "cookie", "apikey", "x-client-info"];
  for (const p of proibidos) {
    assertEquals(HEADERS_PERMITIDOS.includes(p), false, `header ${p} NÃO pode ser encaminhado`);
  }
  assertEquals(HEADERS_PERMITIDOS.includes("content-type"), true);
});
```

- [ ] **Passo 2: rodar e confirmar que falha**

```bash
deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/posthog-proxy-rotas_test.ts
```

Esperado: **FAIL** com `Module not found` (o `posthog-proxy-rotas.ts` ainda não existe).

- [ ] **Passo 3: implementar o mínimo**

Crie `supabase/functions/_shared/posthog-proxy-rotas.ts`:

```ts
/**
 * Roteamento PURO do proxy de ingestão do PostHog.
 *
 * Puro de propósito: o `test:edges` roda com `--no-remote`, então a lógica que
 * precisa de teste não pode viver junto do I/O. O index.ts só faz fetch.
 *
 * ⚠️ Os dois upstreams são LITERAIS. Host que venha da requisição é ignorado,
 * não sanitizado — é o que separa um proxy de um open proxy.
 */
const HOST_INGESTAO = "https://us.i.posthog.com";
const HOST_ASSETS = "https://us-assets.i.posthog.com";

export type ClasseRota = "ingest" | "assets" | "flags" | "replay";

/** Headers que sobem para o PostHog. Tudo fora desta lista é DESCARTADO —
 *  em especial `authorization` (vazaria o JWT do Supabase) e `cookie`. */
export const HEADERS_PERMITIDOS: readonly string[] = ["content-type", "content-encoding"];

/** Tira o prefixo de roteamento da edge, sobrando o caminho que o PostHog espera. */
export function extrairCaminho(pathname: string): string {
  const marca = "/posthog-proxy";
  const i = pathname.indexOf(marca);
  if (i === -1) return pathname || "/";
  const resto = pathname.slice(i + marca.length);
  return resto === "" ? "/" : resto;
}

function normalizar(caminho: string): string {
  return caminho.length > 1 && caminho.endsWith("/") ? caminho.slice(0, -1) : caminho;
}

const EXATOS_INGEST = new Set(["/i/v0/e", "/e", "/batch"]);
const EXATOS_FLAGS = new Set(["/flags", "/decide"]);

export function rotearCaminho(caminho: string): { upstream: string; classe: ClasseRota } | null {
  // Travessia recusada antes de qualquer casamento de prefixo — inclusive
  // percent-encoded, que um `startsWith` sozinho deixaria passar.
  const cru = caminho.toLowerCase();
  if (cru.includes("..") || cru.includes("%2f") || cru.includes("%5c") || cru.includes("\\")) return null;

  if (caminho.startsWith("/static/") || caminho.startsWith("/array/")) {
    return { upstream: HOST_ASSETS, classe: "assets" };
  }
  if (caminho.startsWith("/s/")) return { upstream: HOST_INGESTAO, classe: "replay" };

  const n = normalizar(caminho);
  if (EXATOS_INGEST.has(n)) return { upstream: HOST_INGESTAO, classe: "ingest" };
  if (EXATOS_FLAGS.has(n)) return { upstream: HOST_INGESTAO, classe: "flags" };
  return null;
}
```

- [ ] **Passo 4: rodar e confirmar que passa**

```bash
deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/posthog-proxy-rotas_test.ts
```

Esperado: **ok | 7 passed | 0 failed**.

- [ ] **Passo 5: commitar ANTES de falsificar**

```bash
git add supabase/functions/_shared/posthog-proxy-rotas.ts supabase/functions/_shared/posthog-proxy-rotas_test.ts && git commit -m "feat(posthog-proxy): roteamento puro com allowlist de caminho e de header"
```

- [ ] **Passo 6: FALSIFICAR — sabotar a allowlist e exigir vermelho**

Um teste de allowlist que passa com a allowlist quebrada é teatro. Sabote:

```bash
# troca o `return null` final por um encaminhamento cego
perl -0pi -e 's/  if \(EXATOS_FLAGS\.has\(n\)\) return \{ upstream: HOST_INGESTAO, classe: "flags" \};\n  return null;/  if (EXATOS_FLAGS.has(n)) return { upstream: HOST_INGESTAO, classe: "flags" };\n  return { upstream: HOST_INGESTAO, classe: "ingest" };/' supabase/functions/_shared/posthog-proxy-rotas.ts
deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/posthog-proxy-rotas_test.ts
```

Esperado: **FAIL** no teste `"fora da allowlist devolve null"`. Se passar, o teste não vale nada.

Restaure e confirme verde de novo:

```bash
git checkout -- supabase/functions/_shared/posthog-proxy-rotas.ts && deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/posthog-proxy-rotas_test.ts
```

---

### Task 2: A edge `posthog-proxy` (sem contador ainda)

**Files:**
- Create: `supabase/functions/posthog-proxy/index.ts`
- Modify: `supabase/config.toml`

**Interfaces:**
- Consumes: `rotearCaminho`, `extrairCaminho`, `HEADERS_PERMITIDOS` da Task 1.
- Produces: a edge respondendo em `/functions/v1/posthog-proxy/*`. A Task 4 acrescenta o contador
  neste mesmo arquivo.

- [ ] **Passo 1: escrever a edge**

Crie `supabase/functions/posthog-proxy/index.ts`:

```ts
import {
  extrairCaminho,
  HEADERS_PERMITIDOS,
  rotearCaminho,
} from "../_shared/posthog-proxy-rotas.ts";

/**
 * Proxy de ingestão do PostHog.
 *
 * Existe porque `us.i.posthog.com` está nas listas de bloqueio comuns e a
 * telemetria de browser morria no cliente (provado no PR #1984 com par de
 * falsificação: 4 ms de `Failed to fetch` num Chrome com bloqueador contra
 * 1112 ms de `200 Ok` num Chromium limpo, mesma máquina e minuto).
 *
 * `verify_jwt = false` é obrigatório, não conveniência: o `$pageview`
 * acontece antes do login e o caminho `keepalive` não manda header de auth.
 * Por isso as travas abaixo são o que impede isto de virar um open proxy.
 */
const TETO_CORPO = 1_048_576; // 1 MB
const ORIGENS_PERMITIDAS = new Set(["https://steu.lovable.app"]);
const ORIGEM_PADRAO = "https://steu.lovable.app";

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin && ORIGENS_PERMITIDAS.has(origin) ? origin : ORIGEM_PADRAO,
    "Access-Control-Allow-Headers": "content-type, content-encoding",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "3600",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("metodo nao suportado", { status: 405, headers: cors });
  }

  const url = new URL(req.url);
  const caminho = extrairCaminho(url.pathname);
  const rota = rotearCaminho(caminho);
  if (!rota) return new Response("rota nao permitida", { status: 404, headers: cors });

  let corpo: Uint8Array | undefined;
  if (req.method === "POST") {
    corpo = new Uint8Array(await req.arrayBuffer());
    if (corpo.byteLength > TETO_CORPO) {
      return new Response("corpo grande demais", { status: 413, headers: cors });
    }
  }

  // Só a allowlist sobe. Nada de `authorization`, `cookie`, `apikey`.
  const headersUp = new Headers();
  for (const nome of HEADERS_PERMITIDOS) {
    const v = req.headers.get(nome);
    if (v) headersUp.set(nome, v);
  }

  // Encaminha o caminho ORIGINAL (não o normalizado) + a query crua.
  const alvo = `${rota.upstream}${caminho}${url.search}`;

  let resposta: Response;
  try {
    resposta = await fetch(alvo, { method: req.method, headers: headersUp, body: corpo });
  } catch (_e) {
    return new Response("upstream indisponivel", { status: 502, headers: cors });
  }

  // Devolve status e corpo do upstream; `Set-Cookie` NÃO é repassado.
  const headersDown = new Headers(cors);
  const ct = resposta.headers.get("content-type");
  if (ct) headersDown.set("content-type", ct);
  const cc = resposta.headers.get("cache-control");
  if (cc) headersDown.set("cache-control", cc);

  return new Response(resposta.body, { status: resposta.status, headers: headersDown });
});
```

- [ ] **Passo 2: declarar a edge como pública**

Acrescente ao fim de `supabase/config.toml`:

```toml
[functions.posthog-proxy]
verify_jwt = false
```

- [ ] **Passo 3: fechar a lacuna do `flagsApiHost` (a spec §6 deixou em aberto de propósito)**

No `endpointFor`, `flagsApiHost` é consultado **antes** do ramo `custom`. Se ele não herdar o
`api_host`, feature flags continuariam saindo pelo host bloqueado.

```bash
grep -ohE "flagsApiHost[^;]{0,140}" node_modules/posthog-js/dist/module.js | head -3
```

Leitura do resultado, e **registre qual dos três** foi:
- deriva de `apiHost` → nada a fazer, a allowlist já cobre `/flags`;
- host do PostHog fixo → o app **não usa feature flags** hoje, então não quebra evento. Registre
  como lacuna conhecida no PR e **não** invente correção;
- opção de config (`advanced_disable_flags` ou similar) → avalie desligar, já que o app não usa.

**Não pule este passo assumindo o primeiro caso** — foi justamente por não verificar que a spec o
deixou aberto.

- [ ] **Passo 4: rodar os TRÊS gates de edge**

```bash
bun run test:edges && bun run edges:typecheck && heavy bun run test
```

Esperado: os três com `exit 0`. **Confirme a linha de conclusão de cada um** — exit code sozinho não
prova que rodou.

- [ ] **Passo 5: commitar**

```bash
git add supabase/functions/posthog-proxy/index.ts supabase/config.toml && git commit -m "feat(posthog-proxy): edge publica com allowlist, teto de corpo e descarte de headers"
```

---

### Task 3: Tabela do contador + RPC de incremento

**Files:**
- Create: `supabase/migrations/<YYYYMMDDHHMMSS>_posthog_proxy_stats.sql`

**Interfaces:**
- Consumes: nada.
- Produces: tabela `public.posthog_proxy_stats(dia date, classe text, status smallint, n bigint)` ·
  RPC `public.posthog_proxy_registrar(p_classe text, p_status smallint) returns void`.

- [ ] **Passo 1: invocar a skill do ritual de banco**

```
Skill: lovable-db-operator
```

Ela empacota os 5 itens obrigatórios: o `.sql` idempotente, o bloco pro SQL Editor, a query de
validação read-only pós-apply, a nota "⚠️ migration manual" no PR, e o `bun run audit:migrations`
com commit dos artefatos. **Não improvise esse ritual** — migration custom não auto-aplica e a
falha é silenciosa.

- [ ] **Passo 2: o SQL (conteúdo para a skill empacotar)**

```sql
-- Contador do proxy de ingestão do PostHog.
-- Imune ao bloqueador e ao próprio PostHog: é o denominador que permite
-- distinguir "o proxy quebrou" de "ninguém usou". Sem ele os dois são zero.
create table if not exists public.posthog_proxy_stats (
  dia    date     not null,
  classe text     not null,
  status smallint not null,
  n      bigint   not null default 0,
  primary key (dia, classe, status)
);

alter table public.posthog_proxy_stats enable row level security;
-- Sem policy: só a service_role (que bypassa RLS) escreve, via o RPC abaixo.
-- Leitura de diagnóstico é por psql-ro. Nenhum caminho de cliente lê esta tabela.

create or replace function public.posthog_proxy_registrar(
  p_classe text,
  p_status smallint
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.posthog_proxy_stats (dia, classe, status, n)
  values (current_date, p_classe, p_status, 1)
  on conflict (dia, classe, status) do update set n = public.posthog_proxy_stats.n + 1;
$$;

-- REVOKE nomeando as roles: `REVOKE FROM PUBLIC` NÃO tira anon/authenticated.
revoke all on function public.posthog_proxy_registrar(text, smallint) from public;
revoke all on function public.posthog_proxy_registrar(text, smallint) from anon;
revoke all on function public.posthog_proxy_registrar(text, smallint) from authenticated;
grant execute on function public.posthog_proxy_registrar(text, smallint) to service_role;
```

- [ ] **Passo 3: query de validação pós-apply (read-only)**

```sql
select
  to_regclass('public.posthog_proxy_stats')                                is not null as tabela_existe,
  (select relrowsecurity from pg_class where oid = 'public.posthog_proxy_stats'::regclass) as rls_ligada,
  has_function_privilege('service_role', 'public.posthog_proxy_registrar(text, smallint)', 'EXECUTE') as service_pode,
  has_function_privilege('anon',          'public.posthog_proxy_registrar(text, smallint)', 'EXECUTE') as anon_pode,
  has_function_privilege('authenticated', 'public.posthog_proxy_registrar(text, smallint)', 'EXECUTE') as auth_pode;
```

Esperado: `t | t | t | f | f`. **`anon_pode` ou `auth_pode` em `t` = o REVOKE não pegou; não siga.**

- [ ] **Passo 4: confirmar que o gate de authz não exige registro**

```bash
bun run authz:check
```

Esperado: `✅ authz:check — contrato de gate ok`. O manifesto cobre funções **sensíveis**; o
contador não é uma. **Se o gate reclamar**, acrescente a entrada em `scripts/authz-manifest.ts`
com o motivo — não silencie o gate.

- [ ] **Passo 5: commitar**

```bash
git add supabase/migrations/ docs/migrations-audit.md && git commit -m "feat(posthog-proxy): tabela e RPC do contador imune ao bloqueador"
```

---

### Task 4: Ligar o contador na edge

**Files:**
- Modify: `supabase/functions/posthog-proxy/index.ts`

**Interfaces:**
- Consumes: RPC `public.posthog_proxy_registrar(p_classe text, p_status smallint)` da Task 3;
  a edge da Task 2.
- Produces: nada de novo para outras tarefas.

- [ ] **Passo 1: acrescentar o registro fire-and-forget**

No topo do arquivo, depois dos imports:

```ts
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Incremento fire-and-forget. NUNCA soma latência à resposta proxiada, e
 *  falha dele jamais derruba o proxy — o contador é diagnóstico, não caminho. */
function registrar(classe: string, status: number): Promise<unknown> {
  return fetch(`${SUPABASE_URL}/rest/v1/rpc/posthog_proxy_registrar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({ p_classe: classe, p_status: status }),
  }).catch(() => undefined);
}
```

Substitua o `return new Response("rota nao permitida", …)` por:

```ts
  if (!rota) {
    EdgeRuntime.waitUntil(registrar("recusado", 404));
    return new Response("rota nao permitida", { status: 404, headers: cors });
  }
```

E o bloco final do `fetch` por:

```ts
  let resposta: Response;
  try {
    resposta = await fetch(alvo, { method: req.method, headers: headersUp, body: corpo });
  } catch (_e) {
    EdgeRuntime.waitUntil(registrar(rota.classe, 0)); // 0 = falha de rede, não zero de uso
    return new Response("upstream indisponivel", { status: 502, headers: cors });
  }
  EdgeRuntime.waitUntil(registrar(rota.classe, resposta.status));
```

- [ ] **Passo 2: rodar os CINCO gates**

```bash
bun run test:edges && bun run edges:typecheck && heavy bun run test \
  && bun run sonda:fingerprint && bun run sonda:bump <edge>
```

Esperado: os cinco `exit 0`, com a linha de conclusão visível.

⚠️ Os três primeiros provam que a edge FUNCIONA; os dois de sonda provam que a instrumentação ainda
a DESCREVE, e não se substituem — no #2115 o `sonda:bump` passou e o `sonda:fingerprint` reprovou na
MESMA rodada. Se a fonte mudou: `bun run sonda:fingerprint -- --write` **e** edite o `VERSAO`.

- [ ] **Passo 3: commitar**

```bash
git add supabase/functions/posthog-proxy/index.ts && git commit -m "feat(posthog-proxy): contador server-side fire-and-forget por classe e status"
```

---

### Task 5: Documentar a leitura do contador

**Files:**
- Modify: `docs/agent/analytics.md`

- [ ] **Passo 1: acrescentar a seção**

Na seção de armadilhas (logo após "A amostra é CENSURADA"), acrescente:

```markdown
### Como ler o contador do proxy (a adoção NÃO se lê pelo PostHog)

Medir a adoção do proxy pelo PostHog é circular: os clientes bloqueados são justamente os que não
conseguimos ver. O sinal honesto é o contador da edge, imune ao bloqueador:

    ~/.config/afiacao/psql-ro -c "select dia, classe, status, n from posthog_proxy_stats order by dia desc, n desc limit 20;"

`status = 0` é **falha de rede ao upstream**, não zero de uso. `classe = 'recusado'` subindo
significa que o SDK está pedindo um caminho fora da allowlist — provavelmente uma versão nova do
`posthog-js` com endpoint novo, e é sinal de trabalho, não de ataque.
```

- [ ] **Passo 2: rodar os gates de docs**

```bash
bun run docs:citacoes && bun run docs:links && bun run docs:indice
```

Esperado: os três `exit 0` **com a contagem** na linha final.

- [ ] **Passo 3: commitar e abrir o PR**

```bash
git add docs/agent/analytics.md && git commit -m "docs(analytics): como ler o contador do proxy"
```

No corpo do PR, a nota **⚠️ migration manual** com o bloco SQL da Task 3 e a query de validação.

---

## Deploy — três camadas manuais, NESTA ordem

A ordem não é preferência: env antes da edge existir manda todo evento para um 404.

- [ ] **1. Migration** — founder cola o bloco da Task 3 no SQL Editor do Lovable → Run. Confirmo com
  a query de validação via `psql-ro` (esperado `t | t | t | f | f`).
- [ ] **2. Edge** — deploy manual de `posthog-proxy`. Confirmo com:
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" "https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/posthog-proxy/rota-inexistente"
  ```
  Esperado **404** (a allowlist agindo). Um **401** aqui significa que o `verify_jwt = false` não
  pegou — pare e corrija, senão nenhum evento anônimo passa.
- [ ] **2b. Casos negativos da edge, contra o deploy real.** O teto de corpo é I/O e **não** dá pra
  testar sob `--no-remote` — então a asserção vive aqui, não numa suíte que não a alcança:
  ```bash
  head -c 1200000 /dev/zero | tr '\0' 'a' > /tmp/grande.txt
  curl -s -o /dev/null -w "413 esperado -> %{http_code}\n" -X POST --data-binary @/tmp/grande.txt \
    -H 'content-type: application/json' \
    "https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/posthog-proxy/i/v0/e/"
  ```
  Esperado **413**. Um **200** aqui significa que o teto não está agindo.

- [ ] **3. Env + Publish** — `VITE_POSTHOG_HOST` =
  `https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/posthog-proxy` no Lovable, depois Publish.

## Verificação em produção — o par que provou o problema, invertido

Não basta "está no ar". A prova é a assimetria de hoje **desaparecendo**.

- [ ] **1. A edge recebe:** contador subindo em `classe='ingest'` com `status=200`.
- [ ] **2. O que nenhum outro sinal substitui:** um `$pageleave` com `$lib='web'` saindo do **Chrome
  BLOQUEADO do founder** — o cliente que hoje emite zero. Só isso fecha o argumento.
  ```bash
  bash scripts/posthog-query.sh "SELECT event, properties.\$os AS so, properties.build_id AS build, timestamp FROM events WHERE timestamp > now() - INTERVAL 30 MINUTE AND properties.\$lib='web' ORDER BY timestamp DESC LIMIT 10"
  ```
- [ ] **3. Controle negativo:** com a env revertida, o mesmo Chrome volta a não emitir. Sem ele, o
  passo 2 pode ter sido outro cliente.
- [ ] **4. Lembrar da 4ª camada:** o efeito só chega a cada cliente quando ELE aceita o SW. Adoção
  começa perto de 0% — aqui isso é o sensor funcionando, não falhando.

## Rollback

Apagar `VITE_POSTHOG_HOST` no Lovable e republicar: o `?? 'https://us.i.posthog.com'` do
`analytics.ts:32` devolve o comportamento atual. Edge e tabela ficam inertes. **Não toca banco.**
