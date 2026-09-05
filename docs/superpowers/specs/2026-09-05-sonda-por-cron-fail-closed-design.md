# Sonda de deploy por cron, fail-closed no bundle velho — a credencial que o bundle pré-sensor REJEITA antes de qualquer efeito

> 2026-09-05 · spec (brainstorm + challenge Codex) · money-path · depende de #2199 (ledger `deploy_atestacoes`, **já aplicado em prod** em 2026-09-05; o PR segue aberto).
> Pedido: *"desenhar um mecanismo de atestação que o bundle PRÉ-sensor REJEITE antes de qualquer efeito; allowlist positiva e versionada; o cron escreve no ledger existente via `net._http_response` → `deploy_atestacoes_colher`; teste decisivo de rollback; nada implementado antes do challenge do Codex passar."*

## 0. Resumo

A sonda humana continua sendo a única via de atestação porque um cron que mande `{"probe":true}` com `x-cron-secret` para as 54 edges instrumentadas **executa o fluxo real em qualquer bundle que não conheça o classificador** (`monthly-report` = e-mail para 5.276 perfis). A saída é trocar a *credencial* da sonda, não o corpo: o cron passa a se apresentar com um header que **nenhum bundle anterior a esta entrega reconhece** — `x-sonda-credencial`, derivado do `CRON_SECRET` por HMAC — e **sem** `x-cron-secret`/`Authorization`. Para todo bundle velho o request é simplesmente **um request não autenticado**, e ele bate no gate de auth (`authorizeCron`/`authorizeCronOrStaff`) e morre em **401 antes de tocar banco, ERP, modelo ou e-mail** — propriedade que essas edges já precisam ter por segurança, medida em 53/54 na versão atual (a exceção, `omie-webhook`, fica fora) e em todas as 5 versões históricas do gate. O bundle novo responde a sonda (`{ok, probe:true, versao, edge, fonte}`) num ramo colocado entre o `OPTIONS` e o gate, **sem IO**, e só se o corpo for a sonda; com a credencial de sonda o fluxo real é inalcançável por construção. A resposta cai em `net._http_response` e o coletor existente a leva ao ledger — **nenhuma segunda via**. O cron só sonda edges de uma **allowlist positiva versionada no repo** (default-deny), cada uma provada por um gate de CI que percorre **todas as versões históricas** do `index.ts` exigindo gate-antes-de-IO, e o teste decisivo executa o **bundle velho de verdade** (fixture de `git show <sha-pré-sensor>`) contra o request do cron e exige **401 + contador de efeito = 0**, com controle positivo (o mesmo bundle com `x-cron-secret` PRODUZ efeito no contador) e falsificações.

## 1. Fatos medidos que fecham o espaço de desenho (2026-09-05, prod `fzvklzpomgnyikkfkzai`)

| fato | valor | consequência |
|---|---|---|
| `pg_net` em prod | **0.19.5**, só `http_get` / `http_post` / `http_delete` | **não existe `OPTIONS` por cron** — o candidato (a) direto está morto; só viveria com uma edge-relé |
| ledger `public.deploy_atestacoes` + cron `deploy-atestacoes-colher` | **aplicados** (tabela existe, 1 job) | o coletor já é a via única de escrita; este desenho só ALIMENTA `net._http_response` |
| crons em prod | 94; os que chamam edge usam `x-cron-secret` lido de `vault.decrypted_secrets` (`CRON_SECRET`) | o transporte (SQL + vault) já existe; falta só o header e a função |
| `pgcrypto` | 1.3 em `extensions`, com `hmac(text,text,text)` | a credencial pode ser DERIVADA no banco sem provisionar segredo novo |
| edges instrumentadas (`EDGES` do gate de contrato) | 54 | universo da allowlist |
| ordem `OPTIONS → gate de auth → IO` no handler (versão atual) | **53/54** (`omie-webhook` foge: a sonda vem antes do gate, gated pelo `authorizeCronOrStaff` só quando o corpo classifica como sonda; o fluxo de webhook segue outro caminho) | 53 candidatas diretas; `omie-webhook` fica FORA até prova por fixture |
| `_shared/auth.ts` | 5 versões na história; `authorizeCron` **byte a byte idêntico** nas 5 (`expected && provided && provided === expected`, senão 401); `authorizeCronOrStaff` sem `Bearer` devolve 401 **antes** de qualquer `fetch` | um request sem credencial conhecida nunca foi autorizado por nenhuma versão do gate |
| versões históricas de `index.ts` (54 edges) | **1.164** (máx. 168 numa edge) | o gate histórico custa ~1.164 `git show` (≈15 s); o CI faz checkout com `fetch-depth: 0` |
| `monthly-report` pré-sensor | `0ed5a9b31^` = **`81f9a111c`**: `Deno.serve` → `OPTIONS` → `authorizeCronOrStaff` → `createClient` → Resend | fixture do teste decisivo: o pior caso da 9ª leva, executável |
| implementação de `OPTIONS` descartada em 2026-08-28 | commits `41adc32eb` / `82eb70765` alcançáveis | reaproveitável só como referência de forma (classificador + gates); o motivo 3 do descarte (competir com o relógio do orquestrador) não se aplica a um cron, mas o motivo 0 (pg_net não manda `OPTIONS`) é novo e decisivo |

Achado do Codex que este desenho responde (2026-09-05, `gpt-5.6-sol`/xhigh): *"sondar para descobrir se o sensor existe é executar o request que o bundle pré-sensor lê como fluxo real"*. A inversão aqui: **o request do cron não é um request que o bundle velho "lê como fluxo real" — é um request que ele lê como NÃO AUTENTICADO**, e não autenticado ele já rejeitava antes de o sensor existir.

## 2. Objetivo, não-objetivos, critério de sucesso

**Objetivo.** Um cron que atesta o `(versao, fonte)` servido pelas edges da allowlist, com **zero efeito real em qualquer bundle que não conheça o mecanismo** (pré-sensor, intermediário com `{"probe":true}` mas sem a credencial, rollback, restauração, deploy parcial), escrevendo no ledger pela via que já existe.

**Não-objetivos.** (i) Detectar bundle que não veio da história da `main` (fonte escrita à mão) — limite nomeado, não promessa. (ii) Substituir a régua da matriz `(versao, fonte)` de `pendencias:deploy` — ela fica; ganha estados. (iii) Sondar edges fora da allowlist "por conveniência". (iv) Tornar a sonda um health-check de disponibilidade (uma sonda ausente é ausência de dado, não incidente).

**Sucesso (mensurável).**
1. Harness de rollback verde: bundle **velho** (fixture `81f9a111c`) + request do cron → 401, `probe` ausente, contador de efeito **0**; controle positivo (mesmo bundle + `x-cron-secret`) → contador **> 0**; bundle **intermediário** (main de hoje: classificador após o gate, sem a credencial) → 401, efeito 0; bundle **novo** → 200 `probe:true`, `edge` correto, efeito 0. Falsificações vermelhas nomeando o assert.
2. Gate `sonda:cron-alvos` verde para a allowlist e **vermelho** ao inserir `omie-webhook` (ou qualquer edge sem gate-antes-de-IO em alguma versão histórica).
3. Em prod, após o 1º tick: N linhas `via='sonda'` no ledger para as edges deployadas, 401 para as não deployadas, e **as tabelas/serviços de efeito das edges sondadas sem escrita nova** (regra "IO-free prova-se na tabela de destino", `deploy-no-op-por-desenho.md` §8ª leva).
4. `pendencias:deploy` passa a distinguir "cron atestou" de "cron ficou em silêncio para uma edge cujo ledger diz CONFERE" — o rastro de um rollback.

## 3. Abordagens consideradas

### A — credencial de sonda DERIVADA + cron por `net.http_post` (recomendada)

O cron manda `POST {"probe":true}` com `x-sonda-credencial: hex(HMAC-SHA256(chave = CRON_SECRET, msg = "sonda-de-versao:v1"))` e **sem** `x-cron-secret`/`Authorization`. Bundle velho: gate → 401 (request sem credencial conhecida). Bundle novo: ramo `atenderSondaCron` entre o `OPTIONS` e o gate responde a sonda sem IO.

- ✅ Rejeição pelo bundle velho é a **propriedade de segurança que ele já tem** (gate fail-closed em toda a história), não uma convenção de CORS.
- ✅ Transporte = o dos 93 crons (`net.http_post` + vault). Sem edge nova, sem relé, sem segundo caminho para o ledger.
- ✅ Nenhum segredo novo para o founder provisionar em dois lugares; rotação do `CRON_SECRET` rotaciona a credencial nos dois lados.
- ✅ A credencial **não é** o `CRON_SECRET`: mesmo um `authorizeCron` que um dia leia o header errado por refactor descuidado rejeita o valor (≠ segredo). Vazar a credencial dá **só** leitura de versão/fingerprint.
- ⚠️ Toca `index.ts` de cada edge da allowlist (2 linhas + bump de `VERSAO`) ⇒ **um P1 por edge**, em ondas; **a segurança NÃO depende do deploy** (edge sem o ramo responde 401 ao cron), então o ramo pode pegar carona no próximo deploy legítimo de cada edge.
- ⚠️ Edges cujo fluxo não passa pelo gate (webhooks) ficam fora até prova por fixture executada.

### B — atestação por `OPTIONS` autenticado via edge-relé

`pg_net` não manda `OPTIONS` ⇒ uma edge `sonda-relay` receberia `POST {alvo}` do cron e faria `OPTIONS` + `Bearer SERVICE_ROLE` na edge-alvo, devolvendo o corpo da sonda **verbatim** (uma resposta por edge em `net._http_response`, preservando a via única).

- ✅ Cobre também edges **sem gate** (webhooks/públicas): `OPTIONS`-primeiro é universal nos templates Supabase.
- ❌ Uma edge a mais no caminho crítico (o relé também precisa de deploy, atestação e gate); relé que mande `POST` por bug vira exatamente o caso catastrófico — a proteção passa a ser um teste do relé, não estrutura.
- ❌ Reabre o ramo `OPTIONS` das 54 edges ("o mais silencioso que existe — errar ali quebra o CORS do app inteiro", `verificabilidade-do-conjunto-orquestrado.md` §2) e põe a **service role** em 54 requests por tick.
- ❌ Já foi implementada e descartada uma vez (adendo 3 de 2026-08-28); o gatilho para reconsiderar ("atraso de detecção que provoque ciclo incorreto, reparo de dados ou incidente") não ocorreu.
- Fica como **fallback nomeado** para as edges que A não cobre, se um dia valerem o custo.

### C — só a credencial, sem cron (subconjunto de A)

Entrega o ramo + a credencial e troca o `sonda:sql` humano para o header seguro; nada de cron. Torna a sonda humana fail-closed (hoje ela é o risco das tabelas da 8ª/9ª leva), mas o founder continua sendo o sensor.

- ✅ Menor superfície; toda a prova de A vale.
- ❌ Não resolve o pedido ("não sondar toda vez, e não nunca sondar"); não detecta rollback.
- É a **fatia 1 de A**: se o Codex derrubar o cron, C fica de pé sozinha.

**Decisão: A**, entregue em fatias em que **C é a primeira**.

## 4. Desenho de A

### 4.1 A credencial

```
x-sonda-credencial = lowercase-hex( HMAC-SHA256( key = CRON_SECRET, message = "sonda-de-versao:v1" ) )
```

- **Banco** (dispatcher): `encode(extensions.hmac('sonda-de-versao:v1', <CRON_SECRET do vault>, 'sha256'), 'hex')`.
- **Edge**: `crypto.subtle` (`importKey('raw', …, {name:'HMAC', hash:'SHA-256'})` → `sign`) → hex minúsculo. Função pura `derivarCredencialSonda(cronSecret: string | undefined): Promise<string | null>` em `_shared/sonda-cron.ts` — `null` para env ausente/vazia (nunca `""`).
- **Paridade provada nos dois lados** com o mesmo vetor fixo (RFC 4231 caso 2: chave `Jefe`, msg `what do ya want for nothing?` → `5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843`) e com o vetor da mensagem real sob uma chave de teste, literal idêntico nos dois harnesses. Divergência de encoding (bytea vs UTF-8, hex maiúsculo) reprova ANTES de prod.
- Comparação por igualdade simples, como o `authorizeCron` (documentado; não é o eixo de risco deste mecanismo).
- ⚠️ **Limite do pré-voo:** `claude_ro` (psql-ro) **não tem USAGE no schema `extensions`** (medido 2026-09-05: `permission denied for schema extensions`), então a expressão `extensions.hmac(...)` não pode ser pré-voada em prod pelo wrapper. A paridade é provada no **PG17 local com pgcrypto** (harness de F2) e, em prod, pela própria 1ª execução do dispatcher: credencial errada = 401 em toda edge nova = fail-closed e visível no CLI (silêncio total), nunca efeito. Quem executa o cron é `postgres`, que tem USAGE em `extensions` e lê o vault (é o que os 93 crons fazem).
- Vetores fixados para os dois harnesses: RFC 4231 #2 = `5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843`; mensagem real `sonda-de-versao:v1` sob a chave de teste `Jefe` = `6156024433e6673930e512251123c73875aaf81bfe490d60b5e4dd0661033aa5` (Web Crypto/Deno 2.9.2, spike 2026-09-05).
- Por que derivada e não segredo independente: zero provisionamento em 2 lugares (Supabase secrets + vault) e zero drift entre eles — drift = cron sempre 401 = fail-closed mas invisível. Por que HMAC e não o próprio `CRON_SECRET` num header novo: a credencial precisa ser **incapaz** de autorizar o fluxo real em qualquer bundle, presente ou futuro, por VALOR e não só por nome de header.

### 4.2 O ramo na edge — `atenderSondaCron`

```ts
// _shared/sonda-cron.ts
export async function atenderSondaCron(
  req: Request,
  respostaSonda: (versao: string) => RespostaSonda,   // a fábrica que a edge já tem (criarRespostaSonda(edge))
  versao: string,
  cronSecret = Deno.env.get("CRON_SECRET"),
): Promise<Response | null>
```

| `x-sonda-credencial` | corpo | resultado | efeito |
|---|---|---|---|
| **ausente** | qualquer | `null` → o handler segue exatamente como hoje (gate → classificador → fluxo real) | nenhum aqui |
| presente, **≠ esperado** (inclui `CRON_SECRET` ausente/vazia) | qualquer | **401** `{"error":"credencial de sonda invalida"}` e **PARA** — mesmo que um `x-cron-secret` válido acompanhe | nenhum |
| presente, = esperado | sonda (`classificarSonda` → `sonda`) | **200** `respostaSonda(versao)` = `{ok:true, probe:true, versao, edge, fonte}` | nenhum (sem client, sem fetch) |
| presente, = esperado | disparo ou ambíguo | **400** `{"error":"a credencial de sonda so serve a sonda"}` e **PARA** — nunca fluxo real | nenhum |

Posição no `index.ts` (2 linhas, entre o `OPTIONS` e o gate; o corpo só é lido quando o header existe, e nesse caso o ramo SEMPRE devolve `Response`, então o fluxo real nunca lê o corpo duas vezes):

```ts
if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
const sondaCron = await atenderSondaCron(req, respostaSonda, VERSAO);
if (sondaCron) return sondaCron;
const auth = await authorizeCronOrStaff(req);
```

O caminho humano de hoje (`x-cron-secret` + `{"probe":true}` → gate → `classificarSonda`) **continua existindo** — é o que atesta as edges que ainda não têm o ramo — e passa a ser trocado pelo header seguro no `sonda:sql` quando o repo tem o ramo (§4.6).

### 4.3 Allowlist positiva, versionada, default-deny — e a prova por EXECUÇÃO de cada closure histórico

`supabase/functions/_shared/sonda-cron-alvos.ts` exporta `SONDA_CRON_ALVOS: readonly AlvoSondaCron[]` — por edge: `edge`, `desde` (sha do commit que introduziu o ramo), `corpoControle` (corpo que dispara o fluxo real naquela edge, default `{}`) e, só por exceção declarada, `historicoDesde` (sha a partir do qual a história conta, com `motivo`). É a **única** fonte; o banco espelha (§4.4) e o CLI exige `banco ⊆ repo` (§4.5).

**Por que a prova não pode ser textual.** Um spike (2026-09-05) aplicou um critério textual "gate antes de IO" às 1.164 versões dos 54 `index.ts`: reprovou 37 edges, e a maioria era ruído — helper de auth definido antes do handler e chamado por nome próprio, comentário contendo `Deno.serve(`, âncora de IO em função auxiliar. Um gate textual ou reprova o que é seguro ou, pior, **aprova o que não leu** (a classe "verde por cegueira", `gates-textuais-cegos.md`). Para money-path, o que prova é **executar o bundle velho com o request do cron e contar o efeito**.

**A prova (`bun run sonda:cron-prova`, `scripts/sonda-cron-prova.ts`):** para cada edge da allowlist,
1. enumera os **closures históricos distintos**: para cada commit da `main` que toca qualquer arquivo do fecho transitivo da edge (index + imports locais, `_shared/` incluso), a identidade do closure é o hash dos conteúdos daquele commit (o mesmo cálculo do `sonda:fingerprint`, aplicado a `git show <sha>:<path>`). Medido hoje: **~3.2 k closures distintos** nas 54 edges (35–216 por edge) — um backfill de ~20–30 min, **uma vez**; história é imutável, então o resultado é cacheado por identidade de closure em `supabase/functions/_shared/sonda-cron-prova.json` (commitado, revisável);
2. **materializa** cada closure num diretório temporário (`git archive <sha> supabase/functions/<edge> supabase/functions/_shared`), gera o import map: locais resolvem sozinhos; todo especificador remoto (`npm:`, `https://`, `jsr:`) do closure é mapeado para um stub do **catálogo** (`supabase/harness-sonda-rollback/stubs/`: `@supabase/supabase-js` → client que conta toda chamada como efeito; `std/http/server.ts` → `serve` que captura o handler; SDKs de efeito externo — Resend, Anthropic — → conta e lança). Especificador **fora do catálogo = closure `INVERIFICAVEL`** (nunca "passou");
3. executa `deno run --no-remote --import-map=<gerado> runner.ts` com `Deno.serve`/`Deno.env.get`/`fetch` substituídos ANTES do `import()` (§5.1), e faz **duas** chamadas ao handler: (a) o **request do cron** (§4.4) → exige `efeitos = 0`, `fetches = 0`, status **4xx** (um 200 sem `probe` com zero efeito é comportamento desconhecido = `FALHA`, não "inócuo"); (b) o **controle positivo**: `x-cron-secret` válido + `corpoControle` → exige `efeitos > 0` ou `fetches > 0` (o contador VÊ o fluxo real **daquele** bundle). Erro de import ou de execução em (a) = `INVERIFICAVEL`;
4. veredito por edge: `APROVADA` só se **100 % dos closures** (desde `historicoDesde`, default = o 1º commit da edge) são `PASSA` com controle positivo. `INVERIFICAVEL` ou `FALHA` em UM closure = edge fora (o relatório nomeia sha, closure e motivo). Controle inconclusivo (`corpoControle` que não dispara IO naquela versão) só é aceito por declaração na entrada da allowlist, com motivo.

**Gates de CI (blocking):**
- **G1 (posição, textual — aqui texto basta porque é o código ATUAL, revisado):** o `index.ts` de cada edge listada chama `atenderSondaCron(` depois do `OPTIONS` e antes do gate de auth e de qualquer âncora de IO; a edge está em `EDGES` do gate de contrato; `desde` é ancestral do `HEAD`.
- **G2 (cobertura da prova):** o manifesto cobre **todos** os closures históricos enumerados para cada edge da allowlist e todos são `PASSA`; edge **adicionada no PR** tem a prova **re-executada inteira no CI** (≤ 216 × ~0,4 s), não confiada ao manifesto; história rasa / `git` ausente / `deno` ausente = **exit 2**.
- **G3 (o gate em si):** cada versão histórica de `_shared/auth.ts` tem `authorizeCron` na forma fail-closed e `authorizeCronOrStaff` retorna antes de `fetch` sem `Bearer` (regex sobre `git show`; 5 versões idênticas hoje) — redundante com G2 (a execução já cobre) e mantido porque é barato e nomeia a regressão pelo gate, não pela edge.
- **G4 (o espelho):** todo `INSERT INTO public.deploy_sonda_alvos` nas migrations só nomeia slugs da allowlist (gate de texto no vitest).
- Falsificações: inserir `omie-webhook` sem prova → G2 vermelho nomeando a edge; alterar um veredito do manifesto à mão para `PASSA` → a re-execução por amostra (G2 re-executa 3 closures aleatórios por edge a cada run, além dos adicionados) discorda → vermelho; remover o ramo de `monthly-report` → G1 vermelho; sabotar a forma do `authorizeCron` numa cópia → G3 vermelho.

**Ondas:** F1 backfila e aprova as 3 edges-piloto; F4 aprova as demais — e "aprova" é o `sonda:cron-prova` verde, não juízo de leitura. Uma edge que reprove por closure antigo pode entrar com `historicoDesde` **só** com motivo verificável (ex.: "recriada do zero em <sha>; nenhum ambiente serve bundle anterior" — e o ledger/eco de prod corrobora).

### 4.4 Banco — alvos, dispatcher, cron (uma via só)

Migration `supabase/migrations/<ts>_deploy_sonda_cron_fail_closed.sql` (ritual `lovable-db-operator`; ordena DEPOIS de `20260905183314`), idempotente, com postcondição:

1. **`public.deploy_sonda_alvos`** — `edge text PRIMARY KEY CHECK (edge ~ '^[a-z0-9-]{1,80}$')`, `ativo boolean NOT NULL DEFAULT true`, `habilitado_em timestamptz NOT NULL DEFAULT now()`, `motivo text NOT NULL`. RLS ligada; `REVOKE ALL` de `anon`/`authenticated` **por nome**; `GRANT SELECT` a `authenticated` com policy de staff; só `postgres`/`service_role` escrevem. **Kill switch por edge**: `UPDATE … SET ativo = false WHERE edge = …` (1 linha no SQL Editor, sem migration).
2. **`public.deploy_sonda_disparar()`** `RETURNS TABLE (edge text, request_id bigint)`, `LANGUAGE plpgsql`, `SECURITY INVOKER`, `SET search_path = ''`, `EXECUTE` revogado de `PUBLIC`/`anon`/`authenticated` (quem executa é o cron, como `postgres`, ou o founder no SQL Editor). Corpo:
   - lê `CRON_SECRET` do vault; **ausente/vazio → `RAISE EXCEPTION`** (zero disparos, e a falha aparece em `cron.job_run_details`);
   - deriva a credencial (§4.1) numa variável local — **nunca retornada**;
   - `WITH alvos AS MATERIALIZED (SELECT edge FROM public.deploy_sonda_alvos WHERE ativo ORDER BY edge)` e, sobre ele, `net.http_post(url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/' || edge, headers := jsonb_build_object('Content-Type','application/json','x-sonda-credencial', v_cred), body := '{"probe":true}'::jsonb, timeout_milliseconds := 20000)`. O `MATERIALIZED` existe porque trava por `WHERE` é dependente de PLANO (§8ª leva); o harness prova que edge inativa **não** é postada.
   - headers **exatamente** `Content-Type` + `x-sonda-credencial` — sem `x-cron-secret`, sem `Authorization`, sem `apikey` (é o que faz o bundle velho ver um request não autenticado).
3. **cron `deploy-sonda-cron`**, `'37 */2 * * *'` (a cada 2 h, fora dos minutos cheios que os outros 94 jobs usam): `SELECT public.deploy_sonda_disparar()`. Kill switch global: `SELECT cron.unschedule('deploy-sonda-cron')`. Cadência é knob, não invariante: 54 sondas IO-free a cada 2 h ≈ 650/dia, ~240 k linhas/ano no ledger.
4. **Semente**: os alvos da fatia 1 (§6) com `motivo`.
5. **Postcondição** (aborta o Run): tabela com RLS; ACL fechada (anon sem SELECT, authenticated sem escrita); função existe e `anon`/`authenticated` não executam; cron agendado uma vez com o schedule esperado; **`extensions.hmac` existe**; `vault` tem `CRON_SECRET` (só existência — `EXISTS`, sem ler o valor).

A resposta de cada edge cai em `net._http_response`; `deploy_atestacoes_janela_viva()` já aceita a forma (`probe` booleano `true`, `edge` slug, `versao`, `fonte`); `deploy_atestacoes_colher()` (cron de 15/15 min) a leva ao ledger com `via = 'sonda'`. **Nenhum objeto novo escreve no ledger.** 401/400 têm `status_code ≠ 200` e ficam fora da janela viva — silêncio, não linha.

### 4.5 `bun run pendencias:deploy` — o cron vira testemunha (depende do merge de #2199)

- **Mecânica (exit 2):** `deploy_sonda_alvos` inexistente (nomeia a migration); algum alvo `ativo` no banco fora de `SONDA_CRON_ALVOS` do repo ("desative no banco: `UPDATE …`"); cron `deploy-sonda-cron` sem execução bem-sucedida há > 2 períodos + 15 min (`cron.job_run_details`) — o ledger cheio de ontem e o cron morto hoje têm a mesma cara.
- **`SONDA_CRON_SILENCIOSA`** (pendência, exit 1): edge ativa no banco, cron com sucesso em T₁ e T₂ (os 2 últimos ticks), **nenhuma** linha `via='sonda'` com `observado_em ≥ T₂ − 2 min` para a edge, **e** a última linha do ledger dessa edge diz `CONFERE` (fonte servida = fonte da main, que contém o ramo). Leitura: *"o bundle que o ledger diz estar no ar honraria a credencial; prod não honrou em 2 ticks → rollback, deploy parcial ou bundle recriado. Sonde à mão (segura) e investigue."* Silêncio em **1** tick só = aviso (timeout/429 acontecem; precisão > recall).
- Se a última linha já é `DIVERGE_*`/`INCOERENTE`, o silêncio é esperado (o ramo ainda não está no ar) — nada novo; o remédio continua sendo o deploy.
- `NUNCA_ATESTADA` de edge na allowlist troca o remédio: em vez do bloco `sonda:sql`, *"aguarde o tick das HH:MM ou dispare agora: `SELECT * FROM public.deploy_sonda_disparar();`"* — uma linha, sem segredo no chat.
- Informativo: edges na allowlist do repo sem linha ativa no banco → "habilitável" com o `INSERT` pronto.

### 4.6 `bun run sonda:sql` — a sonda humana fica fail-closed também

Por edge, se o `index.ts` do repo contém `atenderSondaCron(` → o bloco gerado usa `x-sonda-credencial` (a mesma expressão SQL do dispatcher, lendo o vault) e **não** manda `x-cron-secret`; senão, o header legado com o aviso de `EFEITO` de hoje. Decisão pelo REPO, não por prod: se prod ainda não tem o ramo, a resposta é **401** — verdadeira ("não está no ar") e inócua. Quando as 54 tiverem o ramo, o caminho legado morre.

## 5. O teste decisivo — harness de rollback (execução, não leitura)

Diretório **fora** de `supabase/functions/` (os gates enumeram `supabase/functions/*` como edges e só pulam `_shared`), fora de `scripts/`/`db/` (o `tsc` de `tsconfig.scripts.json` não entende `npm:`/`Deno`) e fora do `project` do knip: `supabase/harness-sonda-rollback/` — `runner.ts` (o executor de UM closure: patches, `import()`, as duas chamadas, veredito em JSON no stdout), `stubs/` (o catálogo), `rollback.harness.ts` (o teste determinístico, sempre-on). O orquestrador que enumera closures e cacheia (`scripts/sonda-cron-prova.ts`) roda em Bun e chama o runner por processo. O teste sempre-on roda com script próprio (`bun run test:sonda-rollback` → `deno test --no-remote --import-map=<dir>/import_map.json --allow-read=supabase --allow-run=git <dir>/`), step blocking no `validate`; o arquivo não termina em `_test.ts` para o `test:edges` (que varre `supabase/functions/`) nunca o pegar sem o import map.

- **Fixtures = bundles reais materializados de `git show` no momento do teste** (nada copiado para o repo; história é imutável e o sha é a referência):
  - `monthly-report@81f9a111c` (pré-sensor; o caso de 5.276 e-mails), com o fecho de `_shared/` **daquele sha** (`auth.ts`, `relatorio-mensal.ts`, `paginate.ts`, `leitura-critica.ts`, `erro-mensagem.ts`);
  - `monthly-report@0ed5a9b31` (intermediário: tem `classificarSonda` após o gate, não tem a credencial — é o estado de toda edge entre o merge e o deploy);
  - `calculate-scores@d33c83836` (a classe "não lê o corpo → toma o lease");
  - o bundle **atual** (import direto de `supabase/functions/monthly-report/index.ts`).
- **Stubs via import map**: `npm:@supabase/supabase-js@2` → `createClient` que devolve um Proxy contando **toda** chamada de método (`from/rpc/auth/functions/storage/…`) como efeito (criar o client não conta); `globalThis.fetch` → contador que registra a URL e lança (Resend, Omie, Anthropic — tudo cai aqui); `Deno.serve` → captura o handler; `Deno.env.get` → `CRON_SECRET = <chave de teste>` e valor fixo para qualquer outro nome. Sem `--allow-net`.
- **O request do cron é construído pela MESMA especificação que a migration** (constantes `SONDA_CRON_HEADER` e `SONDA_CRON_MENSAGEM` de `_shared/sonda-cron.ts`; o gate de texto do vitest exige as mesmas strings dentro de `deploy_sonda_disparar` e a AUSÊNCIA de `x-cron-secret` ali).
- **Asserts:**
  1. velho + request do cron → `status 401`, corpo sem `probe`, `efeitos === 0`, `fetches === 0`;
  2. **controle positivo**: velho + `x-cron-secret` válido + `corpoControle` → `efeitos > 0` (o contador VÊ o fluxo real; sem isto, o zero de (1) seria cegueira);
  3. intermediário + request do cron → 401, efeitos 0;
  4. atual + request do cron → 200, `probe === true`, `edge === "monthly-report"`, `versao` = a do `versao.ts`, efeitos 0;
  5. atual + credencial errada + `x-cron-secret` válido → 401, efeitos 0 (a credencial errada PARA, não cai no gate);
  6. atual + credencial certa + corpo `{}` → 400, efeitos 0; corpo `{"probe":"talvez"}` → 400, efeitos 0;
  7. atual com `CRON_SECRET` ausente → 401, efeitos 0;
  8. paridade HMAC: vetor RFC 4231 + vetor da mensagem real = literais idênticos aos do harness PG;
  9. `calculate-scores@d33c83836` + request do cron → 4xx, efeitos 0; + controle → efeitos > 0 (o lease e o `apply_score_updates` aparecem no contador).
- **`--falsificar`** (cada sabotagem exige vermelho que NOMEIE o assert): (S1) o request do cron ganha `x-cron-secret` → (1) vermelho por efeito > 0; (S2) o stub deixa de contar `.from(` → (2) vermelho (controle morto); (S3) no bundle atual, mover `atenderSondaCron` para depois do gate → (4) vermelho (401 em vez de 200); (S4) trocar a mensagem HMAC de um lado → (8) vermelho; (S5) o runner aceita `status 200` sem `probe` como inócuo → o closure sintético "200 silencioso" deixa de reprovar → vermelho.

Harness PG17 (`db/test-deploy-sonda-cron.sh`, padrão de `db/test-deploy-atestacoes.sh`, com `CREATE EXTENSION pgcrypto SCHEMA extensions` — disponível no PG17 local): stub de `net.http_post` que grava url/headers/body; stub de `vault.decrypted_secrets` com a chave de teste. Prova: N posts = alvos ativos; headers **exatamente** `{Content-Type, x-sonda-credencial}` (`NOT headers ? 'x-cron-secret'`, `NOT headers ? 'Authorization'`); credencial = o literal do vetor; edge inativa **não** postada; vault sem `CRON_SECRET` → exceção e **zero** posts; ACL/RLS por role; re-apply sem duplicar cron; postcondição. `--falsificar`: header renomeado para `x-cron-secret` → vermelho nomeando o header; sem `MATERIALIZED`/filtro → inativa postada → vermelho; sem `REVOKE` → vermelho.

Gates de CI que a entrega acrescenta ou toca: `test:sonda-rollback` (novo, blocking), `sonda:cron-prova` (novo, blocking: G1–G4), `test:edges` (testes de `_shared/sonda-cron.ts`; gate de contrato aprende a posição do ramo e a leitura condicional do corpo), vitest (gates de texto da migration + do CLI), `db/test-deploy-sonda-cron.sh` (local, PG17, evidência no PR), `sonda:bump` + `sonda:fingerprint -- --write` (bumps e mapa), `manifesto` (arquivos novos em `src/` — nenhum previsto).

### 5.1 Premissas do harness verificadas por spike (2026-09-05, scratchpad, Deno 2.9.2)

- Import map remapeia `npm:@supabase/supabase-js@2` para um stub local **sob `--no-remote`** (o bundle importa o especificador `npm:` literal e recebe o stub).
- `Deno.serve`, `Deno.env.get` e `globalThis.fetch` aceitam reatribuição antes do `import()` dinâmico: o handler é capturado, a env é a de teste, o `fetch` conta e lança — sem `--allow-net` nem `--allow-env`.
- Num bundle simulado com a forma `OPTIONS → gate por x-cron-secret → createClient → fetch`, o request do cron devolveu **401 com 0 efeitos**, e o controle positivo (`x-cron-secret` válido) registrou **2 efeitos + 1 fetch** — o contador enxerga o fluxo real.

## 6. Fatias de entrega

| fatia | conteúdo | prova | o que exige do founder |
|---|---|---|---|
| **F1 — mecanismo (= C)** | `_shared/sonda-cron.ts` + testes; ramo em **3 edges** (`monthly-report`, `calculate-scores`, `sync-reprocess`) com bump; `sonda-cron-alvos.ts`; runner + catálogo de stubs + teste sempre-on; `sonda:cron-prova` (enumeração de closures, backfill cacheado das 3, G1–G4) + step de CI; gate de contrato atualizado; doc em `docs/historico/` + ponteiro em `deploy.md` | harness verde + falsificações; `sonda:cron-prova` verde para as 3 (100 % dos closures `PASSA` com controle positivo) e vermelho com `omie-webhook` (falsificação registrada); número de closures `INVERIFICAVEL` reportado por edge | deploy das 3 edges (1 prompt no Lovable) — **sem urgência**: o ramo não deployado = 401 ao cron |
| **F2 — banco** | migration (alvos com as 3 sementes, `deploy_sonda_disparar`, cron) + harness PG17 + bloco de handoff + query de validação | harness PG17 verde + falsificações; pré-voo prod via psql-ro (`extensions.hmac`, `net.http_post` assinatura, `cron.job` sem colisão de nome) | colar a migration; após o 1º tick: receita de leitura (ledger `via='sonda'` para as deployadas, 401 nas demais, tabelas de efeito intactas) |
| **F3 — CLI + sonda humana** | estados de §4.5 em `pendencias-deploy.ts` (após merge de #2199); `sonda:sql` com header seguro por edge (§4.6); testes | vitest + `db/test-deploy-atestacoes.sh` estendido (query nova executada no PG17) | nada |
| **F4 — ondas** | as 50 restantes (menos `omie-webhook`), em ondas de tamanho a combinar; cada onda = ramo + bump + entrada na allowlist (com `corpoControle`) + backfill da prova + `INSERT` no banco | `sonda:cron-prova` 100 % `PASSA` por edge; edge com closure `FALHA`/`INVERIFICAVEL` fica fora (ou entra com `historicoDesde` + motivo verificável) | deploy por onda + colar o `INSERT` |

Ordem de dependência: F1 → F2 (a migration referencia constantes de F1 no gate de texto); F3 depende de #2199 mergeado; F4 depende de F2 no ar. F1 tem valor próprio (C).

## 7. Threat model — o que prova, o que não prova, defaults fail-closed

**Prova.** Para toda edge da allowlist: **cada closure histórico distinto** da `main` foi **executado** com o request do cron e não produziu efeito (contador zero, resposta 4xx), e o mesmo bundle com o controle positivo produziu efeito (o contador o enxerga) — G2, cacheado por identidade de closure e re-executado no CI para edge nova e por amostra. G3 nomeia a regressão pelo gate compartilhado. O teste sempre-on (§5) fixa os 3 casos de referência (`monthly-report` em 2 épocas, `calculate-scores`).

**Não prova (limites nomeados).** (i) Bundle que não descende da história da `main` (fonte escrita à mão no Lovable): fora do modelo. (ii) A prova executada mede o que os stubs enxergam: efeito por um canal que não passe por `fetch`, pelo client Supabase nem por SDK do catálogo (ex.: `Deno.openKv`, socket cru) ficaria invisível — mitigação: especificador remoto fora do catálogo = `INVERIFICAVEL` (fail-closed), e o controle positivo exige que o fluxo real **daquele** bundle seja visível ao contador; canal novo entra no catálogo antes da edge entrar na allowlist. (iii) O gateway do Supabase (`verify_jwt`) pode rejeitar o request antes da edge — afeta **disponibilidade** da atestação (silêncio), nunca a segurança. (iv) `pg_net` é UNLOGGED: resposta perdida em restart = silêncio, tratado como ausência de dado. (v) Uma resposta prova UMA requisição; o ledger continua não sabendo de um rollback até o próximo tick — por isso `SONDA_CRON_SILENCIOSA` exige 2 ticks.

**Defaults fail-closed, cada um com assert no harness (§5) ou no gate (§4.3):** env `CRON_SECRET` ausente → 401 (assert 7) · credencial errada → 401 mesmo com cron secret válido (5) · credencial certa + corpo não-sonda → 400 (6) · vault sem `CRON_SECRET` → exceção, zero posts (PG) · alvo inativo → não postado (PG) · edge no banco fora do repo → exit 2 (CLI) · história rasa no CI → exit 2 (G2) · closure com import fora do catálogo ou erro de execução → `INVERIFICAVEL` = edge fora (G2) · 200 sem `probe` e sem efeito → `FALHA`, não inócuo (S5) · manifesto adulterado → re-execução por amostra discorda (G2) · `probe` presente com valor não reconhecido → 400 (herdado do classificador).

**Rotação/vazamento.** `CRON_SECRET` rotacionado no vault e nos secrets da edge → credencial muda nos dois lados sem migration. Credencial vazada → o portador lê `(versao, edge, fonte)` das edges da allowlist e nada mais (o ramo não tem IO e o fluxo real é inalcançável com ela).

## 8. Custo/risco por edge

Tabela gerada dos dados medidos (versão atual de cada `index.ts`; `EFEITO` é a constante declarada em cada `versao.ts`). Colunas: gate encontrado no handler · ordem `OPTIONS<gate<IO` na versão atual · o que o bundle **velho** faz com o request do cron · custo do fluxo real se o gate fosse furado · onda proposta. **A coluna "bundle velho" é hipótese até o gate histórico (G2) e, para as classes marcadas, a fixture executada confirmarem** — é exatamente o que F1/F4 provam antes de cada edge entrar.

| edge | gate no handler | `OPT<gate<IO` (atual) | bundle VELHO com o request do cron | custo do fluxo real (`EFEITO`) | onda |
|---|---|---|---|---|---|
| `disparar-pedidos-aprovados` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `enviar-pedido-portal-sayerlack` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `conciliar-pedido-portal` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `gerar-pedidos-diario` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `pedido-programado-enviar` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `generate-tactical-plan` | `authorizeCronOrStaff` + JWT | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `generate-bundle-argument` | `authorizeCronOrStaff` + JWT | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-nfe-recebimento` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `process-nfe` | `authorizeCronOrStaff` + JWT | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `sayerlack-captura-precos` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `reposicao-depara-sayerlack-auto` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-cliente` | `authorizeCronOrStaff` + JWT | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `fin-cashflow-engine` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-sync-estoque` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-sync-nfes-recebidas` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-nfe-webhook` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `recommend` | `authorizeCronOrStaff` + JWT | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-analytics-sync` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `fin-valor-cockpit` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `fin-funding` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `algorithm-a-audit` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `carteira-positivacao-snapshot` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-financeiro` | `authorizeCronOrStaff` + JWT | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `analyze-unified-order` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `calculate-scores` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | **F1** (fixture executada: monthly-report ×2, calculate-scores) |
| `ai-ops-agent` | `authorizeCronOrStaff` + JWT | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-sync-status-produtos` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `sync-reprocess` | `authorizeCron` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | **F1** (fixture executada: monthly-report ×2, calculate-scores) |
| `scoring-recalc-batch` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `visit-score-recalc-batch` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `tactical-plans-batch` | `authorizeCron` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `monthly-report` | `authorizeCronOrStaff` + JWT | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | **F1** (fixture executada: monthly-report ×2, calculate-scores) |
| `carteira-rebuild` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-vendas-sync` | `authorizeCronOrStaff` + JWT | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-nfe-reconcile` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-sync-pedidos-compra` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-sync-ctes-recebidos` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-sync-sku-items` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-sync-vendas-items` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `analytics-outbox-drain` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-sync` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-malha-sync` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-nfe-recebimento-sync` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-sync-metadados` | `authorizeCron` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `omie-webhook` | `authorizeCronOrStaff` | ⚠️ ? | corpo lido e classificado ANTES do gate; o fluxo de webhook tem outra auth → NÃO provado |  | **fora** (fluxo de webhook não passa pelo gate; entra só com fixture) |
| `omie-aplicar-parametros` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `process-recurring-orders` | `authorizeCron` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `pedido-programado-extrair` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `cmc-snapshot-backfill` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `whatsapp-send` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `whatsapp-send-template` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `enviar-push` | `authorizeCron` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `nvoip-calls` | `authorizeCronOrStaff` + JWT | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |
| `dispatch-notifications` | `authorizeCronOrStaff` | ✅ | 401 no gate (sem `x-cron-secret`/`Bearer`), antes de client/fetch |  | F4 |

Leitura da tabela: o custo do fluxo real é o que a **sonda humana de hoje** arrisca num bundle pré-sensor (é a tabela da 8ª leva generalizada); com a credencial derivada, esse custo só é alcançável se o gate histórico (G2/G3) estiver errado — e é isso que a fixture executada mede nas classes piores. Os 3 batches de fan-out (`scoring-recalc-batch`, `visit-score-recalc-batch`, `tactical-plans-batch`) mantêm a nota da 8ª leva: o efeito cai na edge de baixo, e o contador do harness precisa contar `functions.invoke`/`fetch` para enxergá-lo.

## 9. Premissas assumidas sem o founder (sessão autônoma) e perguntas para o challenge

Premissas:
1. Construir SOBRE #2199 como está (ledger já em prod); F3 espera o merge do PR. Se #2199 for reescrito, o único acoplamento é o nome do coletor e a forma da janela viva.
2. Nenhum segredo novo: a credencial deriva do `CRON_SECRET` (§4.1). Alternativa (segredo independente em vault + secrets) fica registrada como rejeitada por drift.
3. Cadência 2 h e regra de 2 ticks para `SONDA_CRON_SILENCIOSA` são knobs — escolhidos por precisão > recall, não por medição (não há medição possível antes do 1º tick).
4. O corpo continua `{"probe":true}` mesmo com a credencial (intenção **e** credencial; com credencial e corpo vazio o ramo recusa 400).
5. `omie-webhook` fica fora da allowlist até ter fixture executada; nenhuma edge entra por "parece igual".

Perguntas que o challenge deve responder (money-path, `gpt-5.6-sol`/xhigh):
- **P1 (o teste decisivo)**: com o request de §4.4 (headers só `Content-Type` + `x-sonda-credencial`, corpo `{"probe":true}`), existe algum bundle histórico de uma edge da allowlist em que o efeito real ocorra? Onde a prova por execução (§4.3: closure materializado + stubs + contador + controle positivo) deixa brecha — efeito invisível ao contador, closure que a enumeração não gera, stub que mascara?
- **P6**: a prova executada de ~3.2 k closures (cache por identidade, re-execução no CI para edge nova + amostra) é proporcional, ou há um recorte de história defensável (ex.: só bundles posteriores ao 1º `authorizeCron`, 2026-05-10) que reduza o custo sem abrir brecha?
- **P2**: a credencial derivada por HMAC do `CRON_SECRET` é aceitável, ou um segredo independente é obrigatório? Há cenário em que a credencial autorize o fluxo real em algum bundle?
- **P3**: a via única (`net._http_response` → `colher`) e a atribuição por diferença de conjunto (silêncio = allowlist − respostas) bastam para o sinal de rollback, ou falta atribuição por `request_id`?
- **P4**: o que a postcondição/harness PG deixam passar (plano do `net.http_post` na projeção, vault, ACL)?
- **P5**: o custo de 54 P1 em ondas é aceitável dado que a segurança não depende do deploy? Há forma de reduzir sem perder a identidade declarada pela edge (a resposta vir de `_shared/` foi rejeitada porque mascararia deploy parcial)?

## 10. Referências

`docs/historico/deploy-redundante-ledger-e-cron-de-sonda.md` §3/§5 · `docs/historico/verificabilidade-do-conjunto-orquestrado.md` §2 e adendo 3 · `docs/historico/deploy-no-op-por-desenho.md` §8ª/§9ª leva · `docs/agent/deploy.md` §"Edge: o veredito é o ledger" · `docs/agent/money-path.md` §Segunda opinião · `supabase/functions/_shared/sonda-versao.ts` · `supabase/functions/_shared/auth.ts` · migration `20260905183314_deploy_atestacoes_ledger_e_sonda_cron.sql` (#2199) · commits `41adc32eb`/`82eb70765` (OPTIONS descartado).
