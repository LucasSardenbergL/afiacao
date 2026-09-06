# Sonda de deploy por cron, fail-closed no bundle velho — `OPTIONS` via relé, credencial que só atesta, prova por EXECUÇÃO de cada closure histórico

> 2026-09-05 · spec **v4** (brainstorm → challenge Codex rodadas 1 e 2 → revisões) · money-path · depende de #2199 (ledger `deploy_atestacoes`, **já aplicado em prod** em 2026-09-05; o PR segue aberto).
> Pedido: *"desenhar um mecanismo de atestação que o bundle PRÉ-sensor REJEITE antes de qualquer efeito; allowlist positiva e versionada; o cron escreve no ledger existente via `net._http_response` → `deploy_atestacoes_colher`; teste decisivo de rollback; nada implementado antes do challenge do Codex passar."*
> Histórico da spec: v1 propôs credencial num header de POST (bundle velho → 401 no gate). O Codex (rodada 1, `gpt-5.6-sol`/xhigh) derrubou: **existem closures históricos SEM gate nenhum** (`monthly-report@ef08dddd2` manda e-mail sem autenticar; `calculate-scores@45a80118b` faz upserts) — um header não protege bundle sem auth. v2 trocou a prova textual por execução. v3 trocou o transporte para o único que o bundle velho interrompe **estruturalmente**. A rodada 2 confirmou o transporte nos contraexemplos e derrubou o RIGOR da prova (exceção `historicoDesde`, redirect no relé, controle por época de auth, enumeração, cache, falsificações do `OPTIONS`); v4 fecha cada item (§9).

## 0. Resumo

A sonda humana continua sendo a única via de atestação porque um cron que mande `{"probe":true}` com `x-cron-secret` para as 54 edges instrumentadas **executa o fluxo real em qualquer bundle que não conheça o classificador**. Um header novo (v1) não resolve: há bundles históricos que **não autenticam nada** e executam o fluxo real para qualquer POST. O que TODO bundle interrompe antes de qualquer efeito é o **`OPTIONS`** — o preflight de CORS, tratado como primeira instrução do handler no template Supabase desde a primeira versão de cada edge. `pg_net` não emite `OPTIONS` (0.19.5: só GET/POST/DELETE), então o cron chama uma **edge-relé** minúscula (`sonda-relay`, gated por `x-cron-secret` como todo cron), que faz `OPTIONS` na edge-alvo com o header `x-sonda-credencial` = HMAC-SHA256(`SONDA_HMAC_KEY`, `"sonda-de-versao:v1:<edge>"`) — chave **dedicada** às edges (≥ 256 bits), que o banco nunca vê e devolve **verbatim** o corpo `{ok, probe:true, versao, edge, fonte}` quando a alvo o produz — e um corpo **sem** `edge`/`versao` quando ela devolve só o CORS de sempre. Uma resposta por alvo cai em `net._http_response`; o coletor existente leva ao ledger. **Nenhuma segunda via.** O bundle velho da alvo (pré-sensor, intermediário, pré-auth, rollback, restauração) recebe um `OPTIONS` e responde o CORS que sempre respondeu: **zero efeito, estruturalmente**. O bundle novo responde a sonda dentro do bloco `OPTIONS`, sem IO, só com a credencial válida; sem ela, o preflight do browser recebe **byte a byte** a resposta de hoje. A allowlist é **positiva, versionada, default-deny** — e uma edge só entra depois de a prova **executar cada closure histórico distinto** dela — **sem recorte de história**: closure que não dá para executar = edge fora — (~3,2 k nas 54, cacheados por identidade do closure **e** do harness) com o `OPTIONS` do relé e contar **zero efeito**, tendo o controle positivo (por época de autenticação) mostrado que o contador enxerga o fluxo real daquele mesmo bundle. Cada disparo grava `(tick, edge, request_id)` na mesma transação, e a atestação é atribuída por `request_id`, nunca por janela de tempo.

## 1. Fatos medidos que fecham o espaço de desenho (2026-09-05, prod `fzvklzpomgnyikkfkzai`)

| fato | valor | consequência |
|---|---|---|
| `pg_net` em prod | **0.19.5**, só `http_get` / `http_post` / `http_delete` | o cron não emite `OPTIONS`: precisa de relé |
| gateway do Supabase com `OPTIONS` | **repassa à function e devolve o CORPO** (`curl -X OPTIONS …/carteira-positivacao-snapshot` → HTTP 200, corpo `ok`, `sb-project-ref` presente; preflight inócuo) | o corpo da sonda atravessa o gateway em `OPTIONS` — premissa da implementação de 2026-08-28 (nunca deployada) agora **medida** |
| ledger `public.deploy_atestacoes` + cron `deploy-atestacoes-colher` | **aplicados** (tabela existe, 1 job) | o coletor já é a via única; este desenho só ALIMENTA `net._http_response` |
| crons em prod | 94, todos como `postgres`; os que chamam edge usam `x-cron-secret` do vault (`CRON_SECRET`) | o transporte SQL + vault já existe |
| `SUPABASE_URL` | injetada pelo runtime; 89 edges já a usam | o relé chama alvos **do próprio projeto** — sem URL de prod hardcoded no relé |
| edges instrumentadas (`EDGES` do gate de contrato) | 54 | universo da allowlist |
| `OPTIONS` como 1ª instrução do handler (versão atual) | 54/54 | candidatas; a história é o que a prova executa |
| closures históricos distintos (commits que tocam o fecho de cada edge) | **~3,2 k** (35–216 por edge; spike 2026-09-05) | backfill executado ≈ 20–30 min uma vez; cache por identidade |
| **closures SEM gate na história** (achado Codex) | `monthly-report@ef08dddd2`, `calculate-scores@45a80118b`, `omie-sync-estoque@e04b50518`, `omie-sync-metadados@1dd5d8565` — e a varredura textual sugere mais | qualquer transporte por POST/GET/DELETE com credencial é inseguro nesses bundles; só `OPTIONS` os interrompe |
| `_shared/auth.ts` | 5 versões, `authorizeCron` idêntico (fail-closed) | irrelevante quando o helper não é chamado (Codex) — deixa de ser pilar |
| implementação de `OPTIONS` de 2026-08-28 | commits `41adc32eb` / `82eb70765` alcançáveis; descartada por competir com o relógio do orquestrador (não se aplica a um cron) | forma do ramo e dos gates reaproveitável |
| psql-ro | `claude_ro` **sem USAGE** em `extensions` | pré-voo de `extensions.hmac` impossível pelo wrapper — v3/v4 não usam pgcrypto: o HMAC é do relé, com chave que o banco nem tem |

## 2. Objetivo, não-objetivos, critério de sucesso

**Objetivo.** Um cron que atesta o `(versao, fonte)` servido pelas edges da allowlist, com **zero efeito real em qualquer bundle que não conheça o mecanismo** — inclusive bundles históricos **sem autenticação** —, escrevendo no ledger pela via que já existe, com atribuição exata por `request_id`.

**Não-objetivos.** (i) Bundle que não descende da história da `main`: limite nomeado. (ii) Substituir a matriz `(versao, fonte)` de `pendencias:deploy` — ela ganha estados. (iii) Sondar fora da allowlist. (iv) Health-check de disponibilidade.

**Sucesso (mensurável).**
1. Prova executada: para as 3 edges-piloto, **100 % dos closures históricos** respondem ao `OPTIONS` do relé com efeito **0** (contador de client Supabase + `fetch` + SDKs) e status 2xx sem `probe`, enquanto o controle positivo do mesmo bundle produz efeito > 0 — **incluindo os closures sem gate** que o Codex nomeou.
2. Teste sempre-on verde com falsificações vermelhas nomeando o assert; o relé provado a nunca emitir outro método além de `OPTIONS` nem outro header além da credencial.
3. Em prod, após o 1º tick: uma linha `via='sonda'` por edge deployada com a **mesma `request_id`** do disparo, corpo CORS-only (sem linha) para as não deployadas, e as tabelas/serviços de efeito sem escrita nova.
4. `pendencias:deploy` distingue "atestou por este tick" de "este tick ficou sem resposta" por `request_id`, e dá o motivo (CORS-sem-sonda, 401 do relé, timeout) enquanto a janela de 6 h dura — e depois pela tabela de resultados (F3).

## 3. Abordagens consideradas

### A — credencial num header de POST (v1/v2) — **rejeitada pelo challenge**

Cron → POST `{"probe":true}` + `x-sonda-credencial`, sem `x-cron-secret`. Bundle velho → 401 no gate. **Falsa** para bundles sem gate (≥ 4 closures nomeados; possivelmente mais): o request vira fluxo real. Nenhuma credencial protege quem não pede credencial. Registrada para ninguém redesenhar.

### B — `OPTIONS` via edge-relé (v3, recomendada)

Cron → POST `sonda-relay {"alvo","tick"}` com `x-cron-secret` → relé faz `OPTIONS` na alvo com `x-sonda-credencial` → alvo nova responde a sonda; alvo velha responde CORS. Estrutural: o `OPTIONS` é interceptado **antes** de auth, corpo e IO em todo template Supabase, e a prova executa cada closure histórico para confirmar em vez de supor.

- ✅ Cobre bundles sem gate, webhooks, tudo que trata `OPTIONS` primeiro — e a prova executada reprova o que não trata.
- ✅ Nada de pgcrypto/HMAC no SQL: o relé deriva a credencial de uma chave dedicada (`SONDA_HMAC_KEY`, só nas edges); a migration fica no vocabulário dos 94 crons.
- ✅ Vínculo de ambiente de graça: o relé só alcança alvos do **seu** projeto (`SUPABASE_URL`), e um banco de outro ambiente que dispare o relé de prod leva 401 no relé (segredo diferente) — pior caso é um 401.
- ⚠️ Uma edge a mais (~80 linhas) no caminho: **é o único componente cujo bug é catastrófico** (mandar POST em vez de `OPTIONS`) — tratado com método e headers em constantes, teste que inspeciona o `Request` real passado ao `fetch` stubado, gate de texto e falsificação (§5).
- ⚠️ Toca o bloco `OPTIONS` de cada edge da allowlist (2 linhas + bump) ⇒ um P1 por edge, em ondas; o preflight do browser continua idêntico (testado byte a byte).

### C — só a sonda humana pelo relé, sem cron (subconjunto de B)

`sonda:sql` passa a disparar o relé; nada de cron. Torna a sonda humana fail-closed em **todo** bundle (hoje ela é o risco das tabelas da 8ª/9ª leva). É a **fatia 1 de B** e fica de pé sozinha.

**Decisão: B**, entregue em fatias em que **C é a primeira**.

## 4. Desenho de B

### 4.1 A credencial (chave dedicada, por edge, só atesta)

```
x-sonda-credencial = lowercase-hex( HMAC-SHA256( key = SONDA_HMAC_KEY, message = "sonda-de-versao:v1:" + <slug da edge> ) )
```

- **`SONDA_HMAC_KEY` é um segredo DEDICADO das edges** (Supabase secrets, provisionado UMA vez pelo founder: `openssl rand -base64 32` → 256 bits aleatórios; procedimento e rotação documentados no handoff de F1). O banco **não** o tem e não precisa: quem deriva é o relé, quem verifica é a alvo. Consequências (Codex, rodadas 1 e 2): credencial observada **não** é verificador offline do `CRON_SECRET`; `CRON_SECRET` fraco ou compartilhado entre ambientes não afeta a sonda; comprimento deixa de ser proxy de entropia porque a geração é prescrita.
- Calculada **pelo relé** por alvo; verificada **pela alvo** com `crypto.subtle.verify` (tempo constante) a partir do slug que ela mesma declara (`respostaSonda(VERSAO).edge`).
- Por edge: credencial vazada de uma edge não sonda outra. Só atesta: o único ramo que a lê é o de `OPTIONS`, sem IO; nenhum gate a aceita como autorização.
- **Fail-closed**: `SONDA_HMAC_KEY` ausente/vazia → relé responde `500 {"ok":false,"classe":"sem-chave"}` sem chamar ninguém; alvo devolve o CORS de hoje. Chave com < 32 bytes decodificados → mesmo tratamento (`chave-fraca`) — é checagem de FORMA, não prova de entropia; a entropia vem do procedimento.
- Vetores fixos para os testes: RFC 4231 #2 = `5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843`; `sonda-de-versao:v1:monthly-report` sob a chave de teste `Jefe` — literal calculado uma vez no Deno e asserido no relé e na alvo.

### 4.2 O ramo na edge — dentro do bloco `OPTIONS`

```ts
// _shared/sonda-cron.ts
export async function atenderSondaOptions(
  req: Request,
  respostaSonda: (versao: string) => RespostaSonda,
  versao: string,
  chave = Deno.env.get("SONDA_HMAC_KEY"),
): Promise<Response | null>
```

| método | `x-sonda-credencial` | resultado | efeito |
|---|---|---|---|
| ≠ `OPTIONS` | qualquer | `null` (a função nem é chamada fora do bloco `OPTIONS`) | — |
| `OPTIONS` | **ausente** | `null` → a edge devolve **a mesma `Response` de CORS de hoje** (preflight do browser: idêntico) | nenhum |
| `OPTIONS` | presente, **≠ esperada** (hex inválido, valor errado, credencial de OUTRA edge, ou `SONDA_HMAC_KEY` ausente/vazia/curta) | `null` → CORS de hoje. *Na dúvida, preflight* — nunca 4xx aqui, para não tocar o CORS do app | nenhum |
| `OPTIONS` | presente, = esperada | **200** `respostaSonda(versao)` = `{ok:true, probe:true, versao, edge, fonte}` | nenhum (sem client, sem fetch, sem corpo lido) |

Qualquer exceção dentro de `atenderSondaOptions` é capturada e vira `null` (CORS de hoje). O browser nunca cai no ramo: o preflight **anuncia** headers em `Access-Control-Request-Headers`, não os envia.

Posição no `index.ts` (o bloco `OPTIONS` já existe em 54/54):

```ts
if (req.method === "OPTIONS") {
  const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);
  if (sonda) return sonda;
  return new Response(null, { headers: corsHeaders });   // inalterado
}
```

O caminho humano de hoje (`x-cron-secret` + `{"probe":true}` por POST → gate → `classificarSonda`) continua existindo até a última onda; o `sonda:sql` passa a preferir o relé (§4.6).

### 4.3 A edge-relé `sonda-relay`

Entrada: `POST` com `x-cron-secret` (gate `authorizeCron`, como todo cron) e corpo `{"alvo": "<slug>", "tick": "<uuid>"}`. Saída: **uma** resposta por chamada. `verify_jwt = false` **versionado** em `supabase/config.toml` para o relé (mesmo regime das edges de cron; Codex P2) e smoke test em prod sem `Authorization`/`apikey`.

1. `alvo` fora de `SONDA_CRON_ALVOS` (a allowlist do repo, importada de `_shared/`) → `400 {"ok":false,"alvo":…,"classe":"fora-da-allowlist"}` e **zero** `fetch`. Default-deny no relé também.
2. Deriva a credencial (§4.1) e constrói o request por `montarRequestSonda(baseUrl, alvo, cred)` — função pura de `_shared/sonda-cron.ts` **sem parâmetro de método**: dentro dela `method: METODO_SONDA` (`"OPTIONS" as const`), `headers` exatamente `{[HEADER_SONDA]: cred}`, `body: null`, `redirect: "manual"`, `signal: AbortSignal.timeout(8_000)`, e URL = `new URL(\`/functions/v1/${alvo}\`, baseUrl)` com `baseUrl = Deno.env.get("SUPABASE_URL")`.
3. **Segunda barreira, em runtime, imediatamente antes do único `fetch`** (Codex P2 da rodada 2): assere `req.method === "OPTIONS"`, `req.body === null`, `[...req.headers.keys()]` ⊆ `{x-sonda-credencial}`, `new URL(req.url).origin === new URL(SUPABASE_URL).origin`, `pathname === "/functions/v1/" + alvo` com `alvo` allowlisted — qualquer violação → `500 {"classe":"barreira"}` **sem** chamar. O relé tem **exatamente um** call site de `fetch` (gate estrutural de texto) e nenhum outro IO.
4. **Redirect nunca é seguido** (`redirect: "manual"`): o `fetch` padrão seguiria um 303 como `GET`, e `GET` num bundle velho é o fluxo real (Codex P1). Todo 3xx → `classe: "redirect"`; testes para 301/302/303/307/308.
5. Classifica a resposta da alvo com o **contrato completo** da atestação: `200`, `content-type` JSON, corpo ≤ 4 KB, **objeto** JSON com `ok === true`, `probe === true` (booleano), `edge === alvo`, `versao` string 1–120, `fonte` SHA-256 hex ou `"nao-mapeada"` — só então devolve o corpo **verbatim** com 200 (é exatamente o que a janela viva aceita; nada mais fraco passa pelo relé — Codex P2). Senão → `200 {"ok":false,"alvo":…,"classe":…,"status":…}` com `classe ∈ {"cors-sem-sonda","contrato-invalido","identidade-divergente","redirect","timeout","erro-http"}` — corpo **sem** chaves `edge`/`versao` no topo, invisível à janela viva, legível pela tabela de resultados (F3).
6. O relé também está na allowlist e se atesta pelo mesmo caminho (`OPTIONS` em si mesmo).

Gates do relé (§5): método/header por constante e construção sem parâmetro de método; teste que captura o `Request` real passado ao `fetch` stubado e assere método, headers, `body === null`, `redirect === "manual"`, origem e pathname; gate de texto exige as constantes, **um** `fetch`, `redirect: "manual"`, e a ausência de `"POST"`/`x-cron-secret`/`Authorization` no request de saída; falsificações: trocar o método → vermelho; seguir redirect → vermelho (alvo stub que responde 303 para `/functions/v1/monthly-report` e um `GET` que contaria efeito).

### 4.4 Allowlist positiva, versionada, default-deny — e a prova por EXECUÇÃO de cada closure histórico

`supabase/functions/_shared/sonda-cron-alvos.ts` exporta `SONDA_CRON_ALVOS: readonly AlvoSondaCron[]` — por edge: `edge`, `desde` (sha que introduziu o ramo) e `controles: ControlePositivo[]` (cada um: `metodo`, `headers` — com valores tirados da env **stub**, ex.: `{"x-cron-secret": "$CRON_SECRET"}`, `{"x-webhook-secret": "$OMIE_WEBHOOK_SECRET"}`, `{"Authorization": "Bearer $SUPABASE_SERVICE_ROLE_KEY"}` — e `corpo`), cobrindo **toda época de autenticação** da edge (Codex P1: `omie-webhook` exige `x-webhook-secret`; `calculate-scores` teve 6 closures só por JWT/service role). **Não existe recorte de história**: `historicoDesde` foi removido (Codex P1 — furava o quantificador); o único "desde" é o nascimento da edge no repo. Única fonte: o relé a importa, o banco espelha (§4.5), o CLI exige `banco ⊆ repo`.

**Por que a prova não pode ser textual.** Spike (2026-09-05): critério textual "gate antes de IO" sobre as 1.164 versões dos 54 `index.ts` reprovou 37 edges — parte ruído (helper de auth com nome próprio, comentário com `Deno.serve(`), parte **ausência real de auth** (Codex). Texto ou reprova o seguro ou aprova o que não leu. Para money-path, prova é **executar o bundle velho com o request real e contar o efeito**.

**A prova (`bun run sonda:cron-prova`, `scripts/sonda-cron-prova.ts`)**, por edge da allowlist:
1. **Enumeração por ponto fixo** (Codex P1): `F ← fecho da edge no HEAD`; repete { `C ← commits de git log --follow -- F` (renames incluídos); para cada `c ∈ C` calcula o fecho **naquele sha** (parse de imports locais em `git show c:path`, recursivo); `F ← F ∪ (arquivos de todos os fechos)` } até `F` estabilizar. Dependência removida da main (ex.: um `_shared/helper-antigo.ts` que só um `index.ts` velho importava) entra porque aparece no fecho do sha antigo. Identidade do closure = hash dos conteúdos do fecho naquele sha (o cálculo do `sonda:fingerprint`). Medido: ~3,2 k closures (aprox. pré-ponto-fixo) nas 54 edges.
2. **Materializa** cada closure (`git archive <sha> …`) e gera o import map: locais resolvem sozinhos; todo especificador remoto mapeado para um stub do **catálogo** (`supabase/harness-sonda-rollback/stubs/`), casado por família, versão-agnóstico. Medido (3.226 closures): **16 especificadores remotos distintos em 5 famílias** — `@supabase/supabase-js` (8 variantes `npm:`/`esm.sh`), `deno.land/std@*/http/server.ts` (2), `npm:@anthropic-ai/sdk`, `npm:web-push`, `resend` (4). Especificador fora do catálogo = closure **`INVERIFICAVEL`** — e **`INVERIFICAVEL` = edge fora**, até o catálogo ganhar o stub. O que os stubs provam e não provam está no §7 (dependência remota não é reproduzível historicamente — limite nomeado).
3. Executa `deno run --no-remote --import-map=<gerado> runner.ts` com `Deno.serve`/`Deno.env.get`/`globalThis.fetch`/`EdgeRuntime.waitUntil` substituídos ANTES do `import()`. **Contador que suba durante o `import()` = `FALHA`** (IO top-level), mesmo que o import lance; só erro de import com contadores zerados é `INVERIFICAVEL` (Codex P2). Depois de cada chamada, o runner **drena a microtask/macrotask** (`waitUntil` stubado aguarda a promessa; dois `setTimeout(0)`) antes de ler os contadores — trabalho assíncrono agendado antes do `return` conta. Chamadas ao handler:
   (a) **o `OPTIONS` do relé** (`montarRequestSonda`, a MESMA função do relé, com credencial válida para a edge) → `efeitos = 0`, `fetches = 0`, status 2xx; corpo sem `probe` em closures anteriores a `desde`; a partir de `desde`, corpo = contrato completo da atestação com `edge` = a edge;
   (b) **negativos da credencial**, em **toda** closure (Codex P2): header ausente (preflight do browser, com `Access-Control-Request-Headers: x-sonda-credencial`), hex inválido, valor errado, credencial de **outra** edge → efeitos 0 e resposta **idêntica** (status, headers, corpo) à de header ausente. Em closures ≥ `desde`, isso prova que o ramo verifica; antes, que nada muda;
   (c) **controle positivo** com a **escada** de `controles` da entrada (sem credencial primeiro — registra `classe: "sem-gate"` se produzir efeito — depois cada controle declarado) → exige que **algum** produza `efeitos > 0` ou `fetches > 0`. Inconclusivo = **`INVERIFICAVEL`** (edge fora), nunca exceção declarativa (Codex P1). Medido no spike: 6 closures antigos de `calculate-scores` só destravam pelo Bearer.
4. Veredito por edge: `APROVADA` só se **100 % dos closures** são `PASSA` em (a) e (b) com (c) positivo. Um `INVERIFICAVEL`/`FALHA` = edge fora, relatório nomeando sha, closure e motivo.
5. **Cache** em `supabase/functions/_shared/sonda-cron-prova.json`, chave = `(identidade do closure, identidade do harness)`, onde a identidade do harness é o hash de `runner.ts` + `stubs/*` + gerador do import map + `montarRequestSonda` + política de asserts + versão exata do Deno (Codex P1). Mudou o harness → **todos** os vereditos caducam e são re-executados.

**Gates de CI (blocking, `sonda:cron-prova`):**
- **G1 (posição, textual sobre o código ATUAL):** `atenderSondaOptions(` dentro do bloco `OPTIONS`, antes do `return` de CORS; nenhum outro `return` no bloco; a edge está em `EDGES`; `desde` é ancestral do `HEAD`; a resposta de CORS do bloco é a mesma expressão de antes do `desde`.
- **G2 (cobertura da prova):** o manifesto cobre **todos** os closures enumerados de cada edge da allowlist, na identidade de harness **atual**, e todos são `PASSA`; no PR, **re-executa deterministicamente** toda entrada nova ou cuja chave mudou e todas as entradas das edges tocadas pelo PR (não amostra — Codex P5: 3/216 é 1,4 %); um **workflow noturno** re-executa o conjunto inteiro (shardado, ~18 min) e grava o resultado; `pendencias:deploy` sai com exit 2 se o noturno estiver vermelho ou parado > 48 h. História rasa / `git`/`deno` ausentes = **exit 2**.
- **G3 (o relé):** os asserts de §4.3.
- **G4 (o espelho):** todo `INSERT INTO public.deploy_sonda_alvos` nas migrations só nomeia slugs da allowlist (gate de texto no vitest).
- Falsificações registradas no PR: inserir `omie-webhook` sem prova → G2 vermelho; remover o ramo de `monthly-report` → G1; trocar o método do relé ou seguir redirect → G3; adulterar um veredito → a chave/hash não bate → re-execução → vermelho; e os closures **sintéticos do `OPTIONS`** (Codex P1): IO top-level no import · IO **antes** da comparação de método · helper com IO chamado dentro/antes do ramo `OPTIONS` · `OPTIONS` sem `return` (fallthrough) · trabalho assíncrono agendado antes do `return` (`waitUntil`/promessa solta) · ramo que responde a sonda para qualquer valor de header — cada um tem de sair `FALHA` em (a)/(b).

### 4.5 Banco — alvos, disparos, dispatcher, cron (uma via só para o ledger)

Migration `supabase/migrations/<ts>_deploy_sonda_cron_fail_closed.sql` (ritual `lovable-db-operator`; ordena DEPOIS de `20260905183314`), idempotente, com postcondição:

1. **`public.deploy_sonda_alvos`** — `edge text PRIMARY KEY CHECK (edge ~ '^[a-z0-9-]{1,80}$')`, `ativo boolean NOT NULL DEFAULT true`, `habilitado_em timestamptz NOT NULL DEFAULT now()`, `motivo text NOT NULL`. RLS; `REVOKE ALL` de `PUBLIC`, `anon`, `authenticated` **e `service_role`** por nome (Codex P2: edge comprometida não desativa sondas nem amplia fan-out); `GRANT SELECT` a `authenticated` com policy de staff; escreve só `postgres` (dono, que é quem roda o cron). Kill switch por edge: `UPDATE … SET ativo = false`.
2. **`public.deploy_sonda_disparos`** — `request_id bigint PRIMARY KEY`, `tick_id uuid NOT NULL`, `edge text NOT NULL`, `enfileirado_em timestamptz NOT NULL DEFAULT now()`. Mesma ACL. É a **atribuição**: gravada na **mesma transação** do `net.http_post` (o `pg_net` devolve o `request_id` síncrono e só envia após o COMMIT — a linha existe antes de qualquer resposta). Índice `(tick_id, edge)`.
3. **`public.deploy_sonda_disparar(p_alvos text[] DEFAULT NULL)`** `RETURNS TABLE (tick_id uuid, edge text, request_id bigint)`, `LANGUAGE plpgsql`, `SECURITY INVOKER`, `SET search_path = ''`, `EXECUTE` revogado de `PUBLIC`/`anon`/`authenticated`/`service_role`:
   - lê o `CRON_SECRET` do vault exigindo **exatamente uma** linha não vazia (0 ou 2 → `RAISE EXCEPTION`, zero disparos — Codex P2);
   - `WITH alvos AS MATERIALIZED (SELECT edge FROM public.deploy_sonda_alvos WHERE ativo AND (p_alvos IS NULL OR edge = ANY(p_alvos)) ORDER BY edge)`;
   - por alvo: `net.http_post(url := <SUPABASE_URL do projeto> || '/functions/v1/sonda-relay', headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', v_secret), body := jsonb_build_object('alvo', edge, 'tick', v_tick), timeout_milliseconds := 20000)` e `INSERT INTO public.deploy_sonda_disparos`. A URL do relé fica hardcoded como nos 94 crons (único ponto fixo). Vínculo de ambiente: este projeto tem **um** ambiente (Lovable Cloud, um Supabase); se um dia nascer um segundo, a migration dele tem de trazer a própria URL (checklist no cabeçalho da migration) — e o pior caso de um banco alheio disparando o relé de prod é uma atestação **no banco alheio**, sem efeito em prod (residual aceito, nomeado no §7);
   - o founder sonda **sob demanda** com `SELECT * FROM public.deploy_sonda_disparar();` ou `…disparar(ARRAY['monthly-report'])` — uma linha, sem segredo no chat.
4. **cron `deploy-sonda-cron`**, `'37 */2 * * *'`, comando `SELECT public.deploy_sonda_disparar()`. Kill switch global: `cron.unschedule`. Cadência é knob.
5. **Semente**: os alvos de F1 com `motivo`.
6. **Postcondição** (aborta o Run): RLS nas 2 tabelas; ACL fechada inclusive para `service_role`; função existe e as 4 roles não executam; job único, `username = 'postgres'`, `database = current_database()`, `command` exato e `schedule` esperado (Codex P2); `net.http_post` com a assinatura `(text, jsonb, jsonb, jsonb, integer)` presente; vault com **exatamente uma** `CRON_SECRET` (`count(*) = 1`, sem ler o valor).

A resposta do relé cai em `net._http_response` e `deploy_atestacoes_janela_viva()` a aceita quando é o corpo verbatim da alvo; `deploy_atestacoes_colher()` (15/15 min) a leva ao ledger com `via = 'sonda'` e **o mesmo `request_id`** do disparo. **Nenhum objeto novo escreve no ledger.** Respostas `{"ok":false,…}` não têm `edge`/`versao` no topo: silêncio no ledger, motivo na janela (e, em F3, na tabela de resultados).

### 4.6 `bun run pendencias:deploy` — atribuição por `request_id` (depende do merge de #2199)

- **Mecânica (exit 2):** `deploy_sonda_alvos`/`deploy_sonda_disparos` inexistentes (nomeia a migration); alvo `ativo` no banco fora de `SONDA_CRON_ALVOS`; cron `deploy-sonda-cron` sem sucesso há > 2 períodos + 15 min; coletor do ledger parado (já existe).
- Para cada edge ativa, os **2 últimos ticks** (`deploy_sonda_disparos` por `tick_id`): a atestação do tick é a linha do ledger **com aquele `request_id`** (join exato — resposta atrasada de tick anterior ou sonda manual **não** contam: são outros ids; Codex P1 #4). `edge` do corpo ≠ `edge` do disparo → `IDENTIDADE_INCOERENTE` (exit 1).
- **`SONDA_CRON_SILENCIOSA`** (pendência, exit 1): 2 ticks seguidos sem atestação **e** a última linha do ledger diz `CONFERE` (fonte servida = main, que contém o ramo). Leitura: rollback, deploy parcial ou bundle recriado. Motivo, enquanto a janela de 6 h dura: `net._http_response` por `request_id` → `classe` do corpo do relé (`cors-sem-sonda`, `timeout`, …) ou `status_code` 401 (relé recusou: segredo). 1 tick só = aviso.
- Se a última linha já é `DIVERGE_*`/`INCOERENTE`, o silêncio é esperado (ramo não deployado); o remédio continua sendo o deploy.
- `NUNCA_ATESTADA` de edge na allowlist troca o remédio pelo one-liner `deploy_sonda_disparar(ARRAY[…])`.
- **F3, tabela de resultados** `public.deploy_sonda_resultados (request_id PK, tick_id, edge, status_code, classe, observado_em)`: um coletor próprio (`deploy_sonda_resultados_colher()`, no mesmo cron de 15 min do ledger ou em job irmão) faz `deploy_sonda_disparos ⋈ net._http_response` por `request_id` e guarda o motivo além das 6 h. Não escreve no ledger.

### 4.7 `bun run sonda:sql` — a sonda humana pelo relé

O bloco gerado passa a disparar o **relé** por edge (`net.http_post(…/sonda-relay, body {alvo})`, com `x-cron-secret`), que é inócuo em **todo** bundle da alvo. Enquanto o relé não estiver no ar (F1 pendente de deploy), o bloco legado (POST `{"probe":true}` na alvo) continua disponível com o aviso de `EFEITO` — a decisão é pelo ledger: relé atestado ⇒ bloco novo.

## 5. O teste decisivo — harness de rollback (execução, não leitura)

Diretório **fora** de `supabase/functions/` (os gates enumeram `supabase/functions/*` como edges e só pulam `_shared`), fora de `scripts/`/`db/` (o `tsc` de `tsconfig.scripts.json` não entende `npm:`/`Deno`) e fora do `project` do knip: `supabase/harness-sonda-rollback/` — `runner.ts` (executor de UM closure: patches, `import()`, as três chamadas, veredito JSON no stdout), `stubs/` (catálogo), `rollback_test.ts` (o teste determinístico sempre-on — **termina em `_test.ts`** para o `deno test` o descobrir; está fora de `supabase/functions/`, logo o `test:edges` não o alcança — Codex P2). Script próprio `bun run test:sonda-rollback` → `deno test --no-remote --import-map=<dir>/import_map.json --allow-read=supabase --allow-run=git <dir>/`; zero testes descobertos = erro (default do Deno, sem `--permit-no-files`); step blocking no `validate`.

- **Fixtures = bundles reais materializados de `git show` no momento do teste** (nada copiado para o repo):
  - `monthly-report@ef08dddd2` — **sem gate** (o contraexemplo do Codex): (a) `OPTIONS` do relé → CORS, 0 efeitos; (c) `POST {}` sem credencial → efeitos > 0 e `fetch` ao Resend (a classe que matou a v1, medida);
  - `monthly-report@81f9a111c` (pré-sensor com gate) e `monthly-report@0ed5a9b31` (intermediário) — (a) CORS, 0 efeitos; (c) efeitos > 0;
  - `calculate-scores@45a80118b` (sem gate) e `@d33c83836` (com gate) — idem, com o fecho de `_shared/` **de cada sha**;
  - o bundle **atual** de `monthly-report` e o **relé**.
- **Stubs via import map**: `npm:@supabase/supabase-js@2` (e as variantes históricas do catálogo) → `createClient` que devolve um Proxy contando **toda** chamada de método (`from/rpc/auth/functions/storage/…`) como efeito (criar o client não conta); `globalThis.fetch` → contador que registra `method`/URL/headers e lança; `Deno.serve` → captura o handler; `Deno.env.get` → `CRON_SECRET`, `SONDA_HMAC_KEY` (chave de teste), `SUPABASE_URL = "http://projeto.local"`, `SUPABASE_SERVICE_ROLE_KEY`, `OMIE_WEBHOOK_SECRET` e valor fixo para qualquer outro nome (é a env que os `controles` referenciam por `$NOME`). Sem `--allow-net`.
- **O request do relé é construído pela MESMA função que o relé usa** (`montarRequestSonda` em `_shared/sonda-cron.ts`); o gate de texto do vitest exige, no relé, `METODO_SONDA`/`HEADER_SONDA` e a ausência de `"POST"`/`x-cron-secret` no `fetch` de saída.
- **Asserts (sempre-on):**
  1. cada fixture velha + `OPTIONS` do relé → status 2xx, corpo sem `probe`, `efeitos === 0`, `fetches === 0` (contadores lidos após drenar `waitUntil`/timers);
  2. **controle positivo** por fixture pela escada de `controles` → `efeitos > 0` ou `fetches > 0` (nas sem gate, sem credencial alguma; nas só-JWT, pelo Bearer);
  3. atual + `OPTIONS` do relé → 200 e o **contrato completo** (`ok`, `probe`, `edge === "monthly-report"`, `versao` do `versao.ts`, `fonte` do mapa), efeitos 0;
  4. atual + preflight do browser (sem o header) → **byte a byte** a resposta de CORS anterior ao `desde` (status, headers, corpo), efeitos 0;
  5. atual + hex inválido / valor errado / credencial de **outra** edge / `SONDA_HMAC_KEY` ausente ou curta → a mesma resposta de (4), efeitos 0 (na dúvida, preflight) — e o mesmo quarteto em **toda** fixture velha (nada muda);
  6. atual + `POST {"probe":true}` + `x-cron-secret` (o caminho humano legado) → continua 200 `probe:true` (o gate de contrato já cobre);
  7. relé: `alvo` fora da allowlist → 400 e **zero** `fetch`; `alvo` válido → exatamente 1 `fetch` cujo `Request` tem `method === "OPTIONS"`, headers `{x-sonda-credencial}`, `body === null`, `redirect === "manual"`, origem = `SUPABASE_URL`, pathname `/functions/v1/<alvo>`; alvo que responde CORS → `{"ok":false,"classe":"cors-sem-sonda"}` sem `edge`/`versao` no topo; `probe:true` com `edge` ≠ alvo → `identidade-divergente`; sem `ok`/`fonte` ou `fonte` inválida → `contrato-invalido`; 301/302/303/307/308 → `redirect` **sem 2º fetch**; timeout → `timeout`; contrato completo → corpo verbatim; `SONDA_HMAC_KEY` ausente → 500 `sem-chave` e zero `fetch`;
  8. paridade HMAC (vetores de §4.1) entre `derivarCredencial` (relé) e `verificarCredencial` (alvo), e o negativo (mensagem de outra edge não verifica);
  9. `runner.ts` sobre os closures **sintéticos do `OPTIONS`** (§4.4: IO top-level, IO antes da comparação de método, helper com IO dentro/antes do ramo, fallthrough, trabalho assíncrono antes do `return`, ramo que aceita qualquer header) → `FALHA` em cada um; e sobre "gate ignorado"/"gate em ramo morto" com `OPTIONS` correto → `PASSA` (não são ameaças deste transporte — Codex).
- **`--falsificar`** (cada sabotagem exige vermelho que NOMEIE o assert): (S1) o relé passa a mandar `POST` → (7) e, nas fixtures sem gate, (1) vermelho por efeito > 0; (S2) o stub deixa de contar `.from(` → (2); (S3) o ramo responde sem verificar a credencial → (5); (S4) trocar a mensagem HMAC de um lado → (8); (S5) o runner aceita 200 com `probe` num closure pré-`desde` → sintético "responde sem ter o ramo" deixa de reprovar; (S6) o relé devolve o corpo sem checar `edge === alvo` → (7); (S7) `redirect: "manual"` removido → (7) o 303 vira 2º fetch `GET` → vermelho; (S8) o runner lê os contadores sem drenar `waitUntil` → sintético "assíncrono antes do return" deixa de reprovar.

Harness PG17 (`db/test-deploy-sonda-cron.sh`, padrão de `db/test-deploy-atestacoes.sh`): stub de `net.http_post` que grava url/headers/body e devolve ids; stub de `vault.decrypted_secrets`. Prova: N posts = alvos ativos; **cada post tem sua linha em `deploy_sonda_disparos` com o mesmo `request_id` e `tick_id`**; url termina em `/functions/v1/sonda-relay`; headers exatamente `{Content-Type, x-cron-secret}` (o relé é um cron como os outros); corpo `{alvo, tick}`; edge inativa não postada; `p_alvos` filtra; vault com 0 ou 2 `CRON_SECRET` → exceção e zero posts/linhas; ACL/RLS por role inclusive `service_role`; re-apply sem duplicar cron; postcondição. `--falsificar`: sem `MATERIALIZED`/filtro → inativa postada; sem o `INSERT` em `disparos` → vermelho; sem `REVOKE … FROM service_role` → vermelho.

### 5.1 Premissas do harness verificadas por spike (2026-09-05, scratchpad, Deno 2.9.2)

- Import map remapeia `npm:@supabase/supabase-js@2` para um stub local **sob `--no-remote`**.
- `Deno.serve`, `Deno.env.get` e `globalThis.fetch` aceitam reatribuição antes do `import()` dinâmico: o handler é capturado, a env é a de teste, o `fetch` conta e lança — sem `--allow-net`.
- Bundle simulado `OPTIONS → gate → createClient → fetch`: o request sem credencial devolveu **401 com 0 efeitos** e o controle positivo registrou **2 efeitos + 1 fetch**.
- Prod: `OPTIONS` chega à function e o **corpo** volta pelo gateway (HTTP 200, `ok`).
- **Os contraexemplos do Codex, executados de verdade** (bundles materializados por `git archive`, import map gerado dos remotos do closure — `https://deno.land/std@0.190.0/http/server.ts`, `https://esm.sh/@supabase/supabase-js@2[.49.1]`, `npm:resend@2.0.0` — e o runner do §5 em forma de spike):

  | bundle | (a) `OPTIONS` do relé | (b) preflight | (c) `POST {}` **sem credencial** | (d) `POST {}` + `x-cron-secret` |
  |---|---|---|---|---|
  | `monthly-report@ef08dddd2` (2026-02-21, sem gate) | 200, sem `probe`, **0 efeitos, 0 fetch** | 200, **0 efeitos** | 200 `{"success":true,…}`, **2 efeitos** (`client.from().select`) | idem, 2 efeitos |
  | `calculate-scores@45a80118b` (2026-03-02, sem gate) | 200, sem `probe`, **0 efeitos, 0 fetch** | 200, **0 efeitos** | 200, **11 efeitos** (`from/select/range/in…`) | idem, 11 efeitos |

- **Backfill-spike das 3 edges-piloto — TODOS os closures históricos executados** (mesmo runner; 216 closures em **71 s**, ~0,33 s cada ⇒ as 54 edges ≈ 18 min):

  | edge | closures | inerte ao `OPTIONS` + preflight (0 efeitos) | controle positivo | observações |
  |---|---|---|---|---|
  | `monthly-report` | 65 | **64/64 executados** | 64/64 | 1 `INVERIFICAVEL`: `https://esm.sh/resend@2.0.0` fora do catálogo de stubs (entra no catálogo); 1 closure sem gate (`ef08dddd2`) |
  | `calculate-scores` | 79 | **79/79** | 73/79 | 6 closures com gate só por JWT: `x-cron-secret` dá 401 → o controle precisa do degrau `Bearer <SERVICE_ROLE>` (escada acima); 4 closures sem gate |
  | `sync-reprocess` | 72 | **72/72** | 72/72 | — |

  Nenhum closure das três produziu efeito ao `OPTIONS` — nem os sem gate. O que falta para "100 % `PASSA`" é catálogo (1 stub) e a escada do controle, não segurança.
  É a tese de v3 medida onde a v1 morria: o `OPTIONS` é inerte no bundle que **não autentica nada**, e o contador enxerga o fluxo real desse mesmo bundle (controle positivo sem credencial alguma — a classe "sem gate" fica registrada, não suposta).

Gates de CI que a entrega acrescenta ou toca: `test:sonda-rollback` (novo, blocking), `sonda:cron-prova` (novo, blocking: G1–G4), `test:edges` (testes de `_shared/sonda-cron.ts` e do relé; gate de contrato aprende o ramo no bloco `OPTIONS`), vitest (gates de texto da migration, do relé e do CLI), `db/test-deploy-sonda-cron.sh` (local, PG17), `sonda:bump` + `sonda:fingerprint -- --write`, `manifesto` (sem arquivo novo em `src/`).

## 6. Fatias de entrega

| fatia | conteúdo | prova | o que exige do founder |
|---|---|---|---|
| **F1 — mecanismo (= C)** | `_shared/sonda-cron.ts` (credencial, `atenderSondaOptions`, `montarRequestSonda`) + testes; edge `sonda-relay` + testes; ramo em **3 edges** (`monthly-report`, `calculate-scores`, `sync-reprocess`) com bump; `sonda-cron-alvos.ts` (3 + o relé); runner + catálogo de stubs + `rollback_test.ts`; `sonda:cron-prova` com backfill cacheado das 3; gate de contrato atualizado; doc em `docs/historico/` + ponteiro em `deploy.md` | harness verde + falsificações; `sonda:cron-prova` 100 % `PASSA` nas 3 (**incluindo `ef08dddd2` e `45a80118b`**) e vermelho com `omie-webhook`; nº de `INVERIFICAVEL` por edge reportado | provisionar `SONDA_HMAC_KEY` (uma vez, `openssl rand -base64 32`, Supabase secrets); deploy do relé (`verify_jwt = false` no `config.toml`) + das 3 (1 prompt) — **sem urgência**: alvo sem o ramo responde CORS ao relé |
| **F2 — banco** | migration (alvos, disparos, `deploy_sonda_disparar`, cron) + harness PG17 + handoff + validação | harness PG17 verde + falsificações; pré-voo prod via psql-ro (assinatura de `net.http_post`, `cron.job` sem colisão) | colar a migration; após o 1º tick: receita (ledger por `request_id`, `classe` nas demais, tabelas de efeito intactas) |
| **F3 — CLI + resultados + sonda humana** | estados de §4.6 (após merge de #2199); `deploy_sonda_resultados` + coletor; `sonda:sql` pelo relé | vitest + PG17 estendido | colar a migration de F3 |
| **F4 — ondas** | as 50 restantes, em ondas; cada onda = ramo + bump + entrada na allowlist (com `controles` por época de auth) + backfill da prova + `INSERT` | `sonda:cron-prova` 100 % `PASSA` por edge; `FALHA`/`INVERIFICAVEL` = fora, sem exceção | deploy por onda + colar o `INSERT` |

Ordem: F1 → F2 (a migration referencia as constantes de F1 no gate de texto); F3 depende de #2199; F4 depende de F2 no ar. F1 tem valor próprio (C).

## 7. Threat model — o que prova, o que não prova, defaults fail-closed

**Prova.** Para toda edge da allowlist: **cada closure histórico distinto** da `main` foi **executado** com o `OPTIONS` do relé e não produziu efeito (contador zero), o preflight sem credencial ficou idêntico, e o controle positivo do mesmo bundle produziu efeito (o contador o enxerga) — cacheado por identidade, re-executado no CI para edge nova e por amostra. O relé só emite `OPTIONS` (constante + `Request` real inspecionado + gate de texto + falsificação). A atribuição de cada atestação a um disparo é por `request_id`, gravado na mesma transação.

**Não prova (limites nomeados).** (i) Bundle que não descende da história da `main`. (ii) Efeito por canal invisível aos stubs (socket cru, `Deno.openKv`): mitigação = especificador fora do catálogo é `INVERIFICAVEL`, e o controle positivo exige que o fluxo real daquele bundle seja visível. (ii-b) **A dependência remota não é reproduzível historicamente** (`esm.sh/@supabase/supabase-js@2` é especificador mutável; não há lockfile): a prova cobre o **código local** do closure com as 5 famílias de SDK substituídas por stubs que contam toda chamada — o que ela NÃO cobre é IO na **inicialização** do módulo real. Para essas 5 famílias (clientes HTTP preguiçosos) isso não existe por desenho, e uma família cuja inicialização faça IO não é admitida no catálogo. Codex pediu artefato reproduzível; não existe para bundles antigos, e rebaixar tudo a `INVERIFICAVEL` mataria a prova inteira — o limite fica nomeado e o compensador é o contador de `fetch` global, que enxerga qualquer IO de rede do módulo real se um dia o harness rodar com a dependência real cacheada. (iii) `pg_net` UNLOGGED: resposta perdida = silêncio, tratado como ausência de dado. (iv) Uma resposta prova UMA requisição: o rollback só aparece no tick seguinte — por isso `SONDA_CRON_SILENCIOSA` exige 2 ticks. (v) O harness PG prova a função SQL, não a extensão `pg_net` real; o comportamento real de fila/commit é verificado em prod pela receita de F2 (`request_id` do disparo = `request_id` da resposta). (vi) Vínculo de ambiente: um ambiente só; residual = atestação falsa **no banco alheio**, sem efeito em prod (§4.5).

**Defaults fail-closed, cada um com assert:** credencial ausente/errada/de outra edge/`SONDA_HMAC_KEY` ausente → CORS de hoje, 0 efeitos (5) · exceção no ramo → CORS (5) · relé com `alvo` fora da allowlist → 400 e zero `fetch` (7) · relé só `OPTIONS`, sem seguir redirect (7/S1/S7) · relé sem chave → 500 e zero `fetch` (7) · contrato incompleto → não repassa (7) · vault com ≠ 1 `CRON_SECRET` → exceção, zero disparos (PG) · alvo inativo → não postado (PG) · edge no banco fora do repo → exit 2 (CLI) · closure `INVERIFICAVEL`/`FALHA` → edge fora, sem recorte de história (G2) · 200 com `probe` antes do `desde` → `FALHA` (S5) · contador subiu no import → `FALHA` (§4.4) · manifesto com chave de harness antiga → caduca e re-executa (G2) · noturno vermelho/parado → CLI exit 2 · história rasa → exit 2 (G2).

**Rotação/vazamento.** `SONDA_HMAC_KEY` vive só nos secrets das edges (um lugar): rotação = trocar o secret e redeployar nada (edges leem env a cada request); credencial vazada → o portador lê `(versao, edge, fonte)` de **uma** edge até a rotação, e nada mais — e não aprende nada sobre `CRON_SECRET`.

## 8. Custo/risco por edge

Tabela gerada dos dados medidos (versão atual de cada `index.ts`; `EFEITO` é a constante declarada em cada `versao.ts`). A coluna "bundle velho" descreve o que a **execução por closure** tem de confirmar — não é veredito: só o `sonda:cron-prova` verde (100 % dos closures, sem recorte) aprova uma edge. As 4 edges com closure **sem gate** nomeadas pelo Codex estão marcadas; a varredura textual sugere que a classe é maior, e a prova executada é quem conta.

| edge | gate no handler (atual) | `OPTIONS` 1º (atual) | bundle VELHO com o `OPTIONS` do relé | custo do fluxo real (`EFEITO`) | onda |
|---|---|---|---|---|---|
| `disparar-pedidos-aprovados` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `enviar-pedido-portal-sayerlack` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `conciliar-pedido-portal` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `gerar-pedidos-diario` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `pedido-programado-enviar` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `generate-tactical-plan` | `authorizeCronOrStaff` + JWT | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `generate-bundle-argument` | `authorizeCronOrStaff` + JWT | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-nfe-recebimento` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `process-nfe` | `authorizeCronOrStaff` + JWT | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `sayerlack-captura-precos` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `reposicao-depara-sayerlack-auto` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-cliente` | `authorizeCronOrStaff` + JWT | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `fin-cashflow-engine` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-sync-estoque` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — **closure sem gate `e04b50518`** (Codex) |  | F4 |
| `omie-sync-nfes-recebidas` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-nfe-webhook` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `recommend` | `authorizeCronOrStaff` + JWT | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-analytics-sync` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `fin-valor-cockpit` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `fin-funding` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `algorithm-a-audit` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `carteira-positivacao-snapshot` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-financeiro` | `authorizeCronOrStaff` + JWT | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `analyze-unified-order` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `calculate-scores` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — **closure sem gate `45a80118b`** (Codex) obrigatoriamente executado |  | **F1** (piloto) |
| `ai-ops-agent` | `authorizeCronOrStaff` + JWT | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-sync-status-produtos` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `sync-reprocess` | `authorizeCron` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | **F1** (piloto) |
| `scoring-recalc-batch` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `visit-score-recalc-batch` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `tactical-plans-batch` | `authorizeCron` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `monthly-report` | `authorizeCronOrStaff` + JWT | ✅ | CORS puro, 0 efeitos — **closure sem gate `ef08dddd2`** (Codex) obrigatoriamente executado |  | **F1** (piloto) |
| `carteira-rebuild` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-vendas-sync` | `authorizeCronOrStaff` + JWT | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-nfe-reconcile` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-sync-pedidos-compra` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-sync-ctes-recebidos` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-sync-sku-items` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-sync-vendas-items` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `analytics-outbox-drain` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-sync` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-malha-sync` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-nfe-recebimento-sync` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `omie-sync-metadados` | `authorizeCron` | ✅ | CORS puro, 0 efeitos — **closure sem gate `1dd5d8565`** (Codex) |  | F4 |
| `omie-webhook` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — webhook: controle com `x-webhook-secret` + evento Omie (época própria de auth) |  | F4 |
| `omie-aplicar-parametros` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `process-recurring-orders` | `authorizeCron` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `pedido-programado-extrair` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `cmc-snapshot-backfill` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `whatsapp-send` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `whatsapp-send-template` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `enviar-push` | `authorizeCron` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `nvoip-calls` | `authorizeCronOrStaff` + JWT | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |
| `dispatch-notifications` | `authorizeCronOrStaff` | ✅ | CORS puro, 0 efeitos — a confirmar em 100 % dos closures |  | F4 |

Leitura: o custo do fluxo real é o que a **sonda humana de hoje** arrisca num bundle pré-sensor (a tabela da 8ª leva generalizada). Com o `OPTIONS` via relé esse custo só é alcançável se um closure histórico executar IO **antes** de tratar `OPTIONS` — o que a prova executada mede, closure a closure. Os 3 batches de fan-out mantêm a nota da 8ª leva: o efeito cai na edge de baixo, e o contador conta `functions.invoke`/`fetch` para enxergá-lo.

## 9. Calibração da rodada 1 do Codex, premissas e perguntas para a rodada 2

**O que o Codex escreveu e o que fiz com cada achado** (parecer cru em `scratchpad/codex-challenge-1.out` da sessão; resumo fiel):

| achado | severidade dele | decisão minha |
|---|---|---|
| bundles históricos sem gate executam o fluxo real com o request de v1 (`ef08dddd2`, `45a80118b`, `e04b50518`, `1dd5d8565`) | P1 | **aceito — muda o transporte**: v3 = `OPTIONS` via relé (a sugestão dele). A prova executa esses shas nominalmente (§5) |
| a fixture escolhida (`81f9a111c`) era um predecessor seguro; fecho transitivo tem de vir do mesmo sha | P1 | aceito: v2/v3 executam **todos** os closures, com fecho por sha; os contraexemplos viram fixtures sempre-on |
| G2 textual inconsistente; gate ignorado/ramo morto/IO em helper/IO top-level escapam | P1 | aceito: G2 é execução; as 4 formas viram closures sintéticos de falsificação (assert 9) |
| atribuição temporal fabrica "cron atestou"; persistir `(tick, edge, request_id)` na mesma transação; resultados operacionais em tabela própria | P1 | aceito integralmente (`deploy_sonda_disparos`, join por `request_id`; `deploy_sonda_resultados` em F3) |
| URL de prod hardcoded → risco entre ambientes | P1 | **aceito em parte**: v3 remove a URL da alvo do SQL (o relé usa `SUPABASE_URL` do próprio projeto); a URL do relé continua fixa como nos 94 crons, e um banco de outro ambiente que o dispare leva 401 (segredo diferente) — pior caso é um 401, não um efeito. Não adotei vault/config extra para isso |
| `deno test <dir>/` não descobre arquivo que não termina em `_test.ts` | P2 | aceito: `rollback_test.ts`, fora de `supabase/functions/` |
| ACL frouxa para `service_role`; vault com 2 `CRON_SECRET`; postcondição só por existência | P2 | aceito: `REVOKE … FROM service_role`; exatamente 1 segredo não vazio; postcondição checa owner/database/command/unicidade do job |
| "zero drift" é falso (o segredo já vive em 2 lugares) | P2 | aceito: redação corrigida (§4.1) |
| P2: HMAC ok se `CRON_SECRET` forte; derivar por edge; `crypto.subtle.verify` | — | aceito nos três pontos (§4.1) |
| P5: "segurança independe do deploy" era falsa para parte da lista | — | em v3 volta a ser verdadeira **por construção** (`OPTIONS`), sujeita à prova executada por closure |

**Rodada 2 — o que o Codex escreveu e o que fiz** (parecer cru em `scratchpad/codex-challenge-2.out`):

| achado (rodada 2) | severidade dele | decisão minha |
|---|---|---|
| `OPTIONS` interrompe os dois contraexemplos antes de qualquer IO (linhas 209–212 e 8–11) | fechado | confirmado também por execução (§5.1) |
| **redirect**: `fetch` segue 303 como `GET` → fluxo real no bundle velho | P1 | **aceito**: `redirect: "manual"`, 3xx = `classe: "redirect"`, testes 301/302/303/307/308, barreira runtime antes do único `fetch` (§4.3), falsificação S7 |
| `historicoDesde` fura o quantificador "qualquer closure" | P1 | **aceito**: removido; `INVERIFICAVEL` = edge fora, sem exceção |
| controle positivo não cobre todas as épocas de auth (`omie-webhook` exige `x-webhook-secret`) | P1 | **aceito**: `controles[]` por edge com método/headers/corpo referenciando a env stub; inconclusivo = `INVERIFICAVEL` |
| enumeração do fecho perde dependência removida | P1 | **aceito**: ponto fixo com `--follow` (§4.4 passo 1) |
| cache não identificado pela prova que o produziu | P1 | **aceito**: chave = identidade do closure **+** identidade do harness (runner, stubs, gerador, request builder, asserts, versão do Deno) |
| 3 falsificações eram do transporte da v1 | P1 | **aceito**: substituídas pelos sintéticos do `OPTIONS` (top-level, antes do método, helper no ramo, fallthrough, assíncrono antes do return, header qualquer); "gate ignorado"/"ramo morto" viram controles de que o runner **não** reprova o que é seguro |
| closure histórico ≠ artefato deployado (esm.sh mutável, sem lockfile) | P1 | **aceito em parte**: não existe artefato reproduzível para bundles antigos; rebaixar tudo a `INVERIFICAVEL` mata a prova. Fica como **limite nomeado** (§7 ii-b) com o compensador (contador de `fetch` global; famílias cuja inicialização faça IO não entram no catálogo) — decisão de escopo minha, não concessão do Codex |
| import com contador > 0 vs `INVERIFICAVEL` | P2 | aceito: contador subiu no import = `FALHA` |
| contrato do relé mais fraco que a atestação | P2 | aceito: contrato completo (`ok`, `probe`, `edge`, `versao`, `fonte`, objeto ≤ 4 KB) antes de repassar |
| credencial errada só testada no helper e na fixture atual | P2 | aceito: quarteto negativo em **toda** closure (§4.4 b, assert 5) |
| relé pode nascer com `verify_jwt` ligado | P2 | aceito: `verify_jwt = false` versionado no `config.toml` + smoke test sem `Authorization` |
| vínculo de ambiente por diferença de segredo é hipótese | P2 | **aceito em parte**: um ambiente só; residual nomeado (§7 vi) — não adotei config/vault extra |
| comprimento ≠ entropia; HMAC observado vira verificador offline do `CRON_SECRET` | P2 | **aceito além do pedido**: chave **dedicada** `SONDA_HMAC_KEY` (≥ 256 bits, `openssl rand -base64 32`, só nas edges); o banco não a tem; `CRON_SECRET` sai da equação |
| P5: amostra de 3 é 1,4 % em 216 | — | aceito: re-execução determinística de toda entrada nova/mudada e das edges tocadas no PR; noturno completo com gate; amostra deixa de ser garantia |

Premissas mantidas: construir sobre #2199 como está; cadência 2 h e regra de 2 ticks como knobs; `omie-webhook` só entra com `controles` próprios e prova verde; nenhuma edge entra por "parece igual"; um ambiente só.

Perguntas para a rodada 3 (money-path, `gpt-5.6-sol`/xhigh) — o escopo é estreito de propósito:
- **P1**: com as mudanças da v4 (sem recorte de história; `redirect: "manual"` + barreira runtime; controles por época; ponto fixo; chave do cache com identidade do harness; sintéticos do `OPTIONS`; `SONDA_HMAC_KEY` dedicada), **resta algum motivo para `NÃO PASSA`** no teste "edge respondeu sonda, sofre rollback para QUALQUER closure histórico, o contador fica em zero"? Nomeie-o concretamente ou dê `PASSA`.
- **P2**: o limite nomeado em §7 (ii-b) — dependência remota não reproduzível historicamente; prova sobre o código local + stubs que contam toda chamada; famílias com IO na inicialização não entram no catálogo — é um limite **aceitável e honesto** para um mecanismo de deploy, ou invalida a prova? Se invalida, diga o que seria suficiente sem exigir artefato que não existe.
- **P3**: o residual de ambiente (§7 vi, um ambiente só, atestação falsa apenas no banco alheio) é aceitável?
- **P4**: alguma ordem de fatia (F1→F4) ou detalhe do relé/ramo que ainda permita efeito real em prod **antes** de a prova completa existir (ex.: F2 no ar com a allowlist das 3 enquanto F4 ainda não rodou)?

## 10. Referências

`docs/historico/deploy-redundante-ledger-e-cron-de-sonda.md` §3/§5 · `docs/historico/verificabilidade-do-conjunto-orquestrado.md` §2 e adendo 3 · `docs/historico/deploy-no-op-por-desenho.md` §8ª/§9ª leva · `docs/agent/deploy.md` §"Edge: o veredito é o ledger" · `docs/agent/money-path.md` §Segunda opinião · `supabase/functions/_shared/sonda-versao.ts` · `supabase/functions/_shared/auth.ts` · migration `20260905183314_deploy_atestacoes_ledger_e_sonda_cron.sql` (#2199) · commits `41adc32eb`/`82eb70765` (OPTIONS de 2026-08-28).
