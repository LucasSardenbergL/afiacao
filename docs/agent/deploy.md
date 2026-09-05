# Deploy no Lovable — 3 camadas manuais + o secret (referência operacional)

> O que NÃO acontece sozinho no merge. Lição durável carregada sob demanda. Runbook passo-a-passo completo: `docs/runbooks/lovable-supabase.md`. Banco/migration: `docs/agent/database.md`. Verificação: skill `lovable-deploy-verify`.

## Domínio canônico — `https://steu.lovable.app`

É **a** URL de produção: o que verificar depois de um Publish, o host do QA visual, e o destino de todo link que uma edge mande para o cliente. **`afiacao.lovable.app` está MORTO** — HTTP 404 `Project not found` (conferido 2026-07-18), assim como `preview--afiacao.lovable.app` e as variações por project-id. O nome do projeto no Lovable não é o nome do repo; não dá para adivinhar a URL a partir de "afiacao".

**Edge que linka o app não hardcoda host** — lê a env, com o canônico só como fallback:

```ts
const APP_URL = Deno.env.get("APP_URL") ?? "https://steu.lovable.app";
```

Padrão em `gerar-pedidos-diario`/`disparar-pedidos-aprovados`. O guard `src/__tests__/edge-app-url.test.ts` quebra o CI se alguma edge voltar a citar host nu ou o domínio morto (#1413: o CTA "Agendar Afiação" do `monthly-report` apontava para o 404 — e só era renderizado para o cliente COM ferramenta atrasada, o de maior intenção).

Como provar o que está **SERVIDO** nesse host (hash do index + grep nos chunks): skill `lovable-deploy-verify` — o método vive lá, não é duplicado aqui.

## O que BLOQUEIA o PR — leia o `ci.yml` INTEIRO, não os primeiros steps

O job `validate` do `.github/workflows/ci.yml` tem **muito mais que os 5 gates óbvios**. Em 2026-08-23 eram 15 steps: `tsc` (app) · `scripts:typecheck` · `test` · `test:edges` (Deno) · `edges:typecheck` · `build` · `lint` · `claude:size` · `test:hooks` · `authz:check` · `bunpin:check` · `docs:indice` · `docs:citacoes` · `docs:links` · **`bunx knip`** (dead code). Mais o job `mutation-check` (`mutcheck:selftest` + `mutcheck`).

⚠️ **`bunx knip` É bloqueante** — export sem consumidor derruba PR. O `/health` roda o mesmo knip localmente, mas "também roda no /health" **não** significa "só roda no /health".

**A armadilha real (mordido 2026-08-23):** ler `sed -n '1,80p' ci.yml` de um arquivo de **424 linhas**, não achar o knip, e afirmar que ele não é gate. O arquivo tem ~30 linhas de comentário por step, então os 5 primeiros gates ocupam as primeiras 230 linhas e **os 10 restantes ficam fora de qualquer leitura truncada**. Custo: um PR vermelho e uma errata errada escrita em 3 documentos. Use `grep -n "^      - name:" .github/workflows/ci.yml` — cabe numa tela e não mente.

**Dois gates costumam pegar código novo, e são independentes:**

1. **`manifesto.gate.test.ts`** (dentro do `bun run test`) — todo arquivo de `src/` precisa de **1 dono declarado** em `src/lib/modulos/manifesto.ts` (`codigo`/`testes` do módulo). Arquivo novo sem entrada sai como `[orfao]`. Sobreposição de globs entre módulos e glob que não casa nada também são erro. `NAO_CLASSIFICADOS` é dívida datada e está VAZIO — não seja o primeiro a sujá-lo.
2. **`bunx knip`** — export sem consumidor. Núcleo de domínio novo, ainda sem UI, tende a bater aqui: os testes tornam as *funções* alcançáveis (o `vitest.config.ts` é entry no `knip.json`), mas **tipo/interface exportado que só o próprio arquivo usa fica órfão**. Correção certa é tirar o `export` do que é interno — reexportar quando a fase seguinte lhe der consumidor —, não engordar o `ignore` do `knip.json`.

## Merge na `main` ≠ produção — 3 deploys MANUAIS e independentes (+ a 4ª dependência)

1. **Migration** → colar o SQL no **SQL Editor do Lovable** → Run → validar com query de contagem. O Lovable **NÃO** aplica migration de nome custom sozinho (falha SILENCIOSA: a feature compila e quebra em runtime). Detalhe + ritual + skill `lovable-db-operator`: `docs/agent/database.md`.
2. **Frontend** → **Publish** manual no editor do Lovable. `steu.lovable.app` serve o **build velho** até o Publish (lição 2026-05-31: mergear e achar que foi pro ar é o erro recorrente).
3. **Edge functions** → criadas/editadas pelo **chat do Lovable** (ele lê `supabase/functions/<nome>/index.ts` do repo e deploya **verbatim**), **NÃO** pela UI Cloud (que só mostra logs).
4. **SECRET novo de edge** → **Edge Functions → Secrets**, e **antes** do deploy da edge. Não é camada de código — nenhuma das 3 acima o acusa — e falha do jeito mais caro: a edge fica **Active**, o cron fica **verde**, `cron.job_run_details` diz `succeeded`, e a função morre no 1º `Deno.env.get` devolvendo 500 sem fazer nada. Deployar antes do secret **arma** exatamente esse estado, e a verificação por sonda pode carimbar "no ar" uma edge que não faz nada. #2035 (`analytics-outbox-drain` ↔ `POSTHOG_INGEST_KEY`, lido por essa edge e por nenhuma outra) só não quebrou porque o secret já estava lá — **sorte, não processo**.

**Achar UMA camada pendente é SINTOMA — audite as TRÊS do MESMO PR.** As camadas deployam separado, mas o PR que as tocou é um só: migration não-aplicada é evidência de **PR não-deployado**, não de migration esquecida. E o caminho de detecção enviesa — um `/fecho` que varre migrations acha migrations; frontend e edge nem entram no campo de visão. Ao detectar qualquer pendência, classifique o diff por camada antes de fechar o caso:

```bash
git show --name-only --format="" <sha> | awk '/^supabase\/migrations/{m++} /^supabase\/functions/{e++} /^src\//{f++} END{print "mig="m+0" edge="e+0" front="f+0}'
# as 4 de uma vez (secret inclusive), da RAIZ do repo — fonte única do Passo 1 da lovable-deploy-verify:
git show --name-only --format="" <sha> | .claude/skills/lovable-deploy-verify/evals/classify.sh
```

Mordido 2026-08-14 (#1520 `9f7e8962`, FU4-F fase 3): o `/fecho` pegou `…130000_fecha_product_costs.sql` mergeada e não aplicada, aplicou, verificou — caso encerrado. O mesmo PR trazia **5 migrations + frontend (já publicado) + 2 edges nunca confirmadas**, e edge velha ali é money-path concreto, porque o front novo é que mudou o contrato: `generate-bundle-argument` imprime `p.margin.toFixed(2)`/`bundle.lieBundle.toFixed(2)` num payload que o hook publicado **parou de mandar** (→ **TypeError**, argumento de venda não gera); `generate-tactical-plan` ordena as recomendações por `lie_bundle DESC`, hoje NULL em toda linha, e DESC implica NULLS FIRST → **topBundle arbitrário, plano tático sobre ranking fabricado**. ⚠️ O risco é assimétrico: com as duas metades faltando elas se cancelam, então **aplicar só a camada que apareceu pode ser o que ARMA a quebra** — é a armadilha do `carteira-rebuild` (abaixo) vista pelo lado do PR, não da edge.

## Edge — armadilhas

- **Deploy SÓ depois do merge** — o chat lê a `main`; deployar antes pega o código velho.
- **Deployar uma edge sobe o ARQUIVO INTEIRO da `main`, não só o seu diff** → o pré-flight é das dependências de banco de TODO o arquivo, inclusive código de PRs de TERCEIROS mergeados desde o último deploy dela. É a irmã da armadilha da migration silenciosa, vista do outro lado: não foi a migration que faltou aplicar — foi o **deploy do código que a exigia** que chegou depois e revelou a falta. Mordido 2026-07-17 (Fatia 2 do épico-drop): deployei `carteira-rebuild` verbatim (a MINHA mudança tinha as deps checadas: `identity_state` existia no schema) — mas o arquivo da main carregava junto o lease do #1333 (`claim_carteira_rebuild`/`finalizar_carteira_rebuild`), mergeado dias antes, cuja migration NUNCA fora aplicada. As duas metades faltando (edge do #1333 nunca deployada + migration nunca aplicada) se cancelavam; meu deploy correto trouxe só a metade-código → **rebuild 500 em produção por ~40min** (`claim: Could not find the function ... in the schema cache`), carteira congelada no snapshot do dia anterior (modo-falha seguro: o `claim` é o 1º passo, morre ANTES de escrever). **Pré-flight barato (roda em segundos, teria pego):** antes de dar o prompt de deploy de uma edge, cruze as RPCs que ela chama com o que existe em prod —
  ```bash
  bun run preflight:rpcs <edge> [<edge>...]
  ```
  Ele segue o **fecho transitivo dos imports locais** (o mesmo grafo que dá o `fonte` da sonda de versão — pré-flight e sonda falam do MESMO conjunto de arquivos), lista cada RPC com `arquivo:linha`, e emite o SQL pronto para o `psql-ro`. **Exit `3` = a lista está INCOMPLETA** (há chamada cujo nome não é literal); `0` = completa. O `3` existe porque um `0` sobre uma lista que o extrator sabe estar furada é o falso verde que o pré-flight existe para matar.

  ⚠️ **O comando anterior deste runbook era um `grep` e ele MENTIA.** Era `grep -rhoE "\.rpc\('[a-z_]+'"` sobre o diretório da edge, com três cegueiras que produzem a mesma falha — uma lista curta que parece completa: (1) só casava **aspas simples**; (2) só varria o **diretório** da edge, e helpers de `_shared/` chamam RPC; (3) só via o nome **literal** colado no `.rpc(`. Medido em 2026-08-30: das **53** RPCs literais chamadas em `supabase/functions/`, ele enxergava **16**. A frase que este parágrafo substituiu dizia *"das 16 RPCs chamadas por edges, as 16 existem em prod"* — o denominador era 53, e o 16/16 tranquilizava sobre um terço do universo. Varredura das 95 edges com a ferramenta nova: **4** têm chamada por indireção (`calculate-scores`, `melhoria-triagem`, `fin-valor-cockpit`, `omie-analytics-sync`) — as 4 RPCs que estavam escondidas ali existem em prod (conferido), então a cegueira não tinha bomba armada hoje; o que ela tinha era um detector incapaz de dizer isso.

  Vale o mesmo raciocínio p/ tabela/coluna/view nova que o arquivo referencie — para essas o cruzamento segue manual.
- **Proibir "melhorias"** — instrua o chat a deployar **verbatim** o arquivo do repo (o Lovable tende a reescrever a função).
- **Verificar por comportamento/bytes, não pela palavra do Lovable** — `503 LOAD_FUNCTION_ERROR` + zero `running` no log = a edge não BOOTA → fix é **redeploy**, não código (ver `docs/agent/sync.md`).
- **`config.toml` pode vir com `[functions.<x>]` DUPLICADO** (bug do bot do Lovable) → TOML inválido (`redefine an already defined table`) que **quebra o `supabase` CLI** no parse. Fix: apagar a 2ª entrada (se idêntica = no-op de comportamento) — pode reaparecer num "Changes" do bot. (#974)
- **Edge "fantasma" (deployada, mas sem invocador):** *deployada/gerenciada pelo Lovable* = commits `gpt-engineer-app[bot]` tocando `<x>/index.ts` (+ commit "Deployou edge function `<x>`"); *invocada* = `cron.job` + `net._http_response` (+ `pg_proc`/código/CI). Antes de apagar um `supabase/functions/<x>/` órfão do repo: prove os DOIS lados E **delete no Lovable PRIMEIRO** (senão o bot regenera o diretório no próximo deploy de scoring). (#974: `n` era clone byte-idêntico de `calculate-scores` — deployado, zero invocador.)
- **Deploy de edge pode REVERTER um fix mergeado (money-path!)** — o Lovable reconcilia com a cópia VELHA dele e **commita a reversão na `main`** como `Changes`, desfazendo o PR (mordido 2026-06-26: o fallback do `analyze-unified-order` #1077 voltou a `override`, `main` silenciosamente revertida; re-aplicado #1080; noutro deploy o bot apagou o comentário-aviso mas manteve o gate). É **evento que MUDA código**, não deploy puro — não está pronto até `main` E comportamento conferidos. **Pós-deploy, 2 camadas:** (1) **source** — `git fetch origin main` + grep o invariante-alvo (ex.: `&& !priceMap[productId]`); sumiu = deploy FALHO; (2) **comportamento** — grep é necessário mas **NÃO suficiente** (o bot pode deployar da cópia interna SEM refletir na `main`) → canária com fixture (ex.: Omie=999 vs local=123 → espera 123). O aviso anti-reversão **não pode morar no código** (o bot remove comentários) — mora aqui.
- **"Deploy verbatim" manual é frágil p/ edge money-path** (cópia-fonte mutável do Lovable pode vencer — Codex 2026-06-26). Mitigar: prompt "deploy from `main` at SHA `<sha>`; do NOT reconcile from your internal copy; abort+report if it differs"; idealmente CI que falha se o invariante some, ou deploy por SHA/Action.
- **Validar edge com `deno lint` é FALSO VERDE: quem barra o CI é o ESLint, e a SUPRESSÃO não é intercambiável.** Os dois lintam as edges, com regras diferentes: `bun lint` (= `eslint .`) cobre `supabase/functions/**` — de tudo que está sob `supabase/functions/`, o `ignores` do `eslint.config.js` exclui **só** `functions/mcp/**` (bundle auto-gerado) — e aplica `tseslint.configs.recommended`, onde **`no-explicit-any` é ERROR**. O `deno lint` tem a mesma regra, mas **cada linter só enxerga o SEU comentário**: `// deno-lint-ignore no-explicit-any` não diz nada ao ESLint, e `// eslint-disable-next-line @typescript-eslint/no-explicit-any` não diz nada ao deno lint. O repo exibe os dois lados da armadilha ao mesmo tempo (medido 2026-07-18): os **6 `any` pré-existentes** das edges têm supressão de ESLint e por isso figuram nos 198 problemas do `deno lint` **com o CI verde**; no #1432 eu fiz o inverso — suprimi só p/ deno, `deno lint` limpo, **CI vermelho com 4 erros**. Ou seja: nenhum dos dois linters, sozinho, prova o outro. **Regra: mexeu em edge, rode `bun lint` (o do CI) antes do push** — `deno lint`/`deno check`/`test:edges` são complemento, não substituto. (E o `bun lint` também não basta sozinho: o **vitest** é o terceiro caminho pelo qual uma edge reprova — bullet abaixo.) (Por que `deno lint` não entrou no CI: `docs/historico/ci-testes-edge-deno.md`.)
- **O `vitest` também reprova edge — por TESTE DE FORMA, que lê `supabase/functions/` como TEXTO.** É a terceira perna, e **nenhum dos três comandos "de edge" a enxerga**: `test:edges` roda a suíte Deno, `edges:typecheck` type-checa, `bun lint` linta — o guardrail mora em `src/`, dentro do `include` do vitest (`src/**/*.{test,spec}.{ts,tsx}`), e casa **regex contra o código-fonte da edge** via `readFileSync`. Não é caso de canto: medido 2026-08-18, **20 arquivos de teste** leem edge como texto, cobrindo **70 dos 95** diretórios de `supabase/functions/` (reproduza com `for f in $(grep -rl supabase/functions src --include='*.test.ts'); do grep -q readFileSync "$f" && echo "$f"; done`). ⇒ **mudança PURAMENTE sintática numa edge — extrair helper de resposta, reordenar, renomear — pode ficar vermelha sem nenhuma mudança de semântica.** Mordido no #1772 (sonda de versão nas 5 edges de escrita money-path): centralizar as respostas da `omie-cliente` num helper `jsonRes(body, status)` — necessário para o marcador `versao` ir em TODA resposta — transformou o `status: 409` que o `edge-money-path-invariants` exigia a ≤700 chars de `if (mappingError)` em `jsonRes(..., 409)`. Os três comandos de edge **exit 0** (`test:edges`; `edges:typecheck` baseline 136/0; `bun lint` zero ocorrências em `supabase/functions`) e o `validate` **vermelho** mesmo assim. Corrigido em `f765a71b`: o padrão passou a aceitar as duas grafias **sem afrouxar o poder discriminante** — o que reprova continua sendo um ramo do `mappingError` que não responde 409 (engolir o erro faz a UI anexar a ferramenta ao cliente ERRADO), e o `toBe(2)` segue exigindo os DOIS ramos. **O guardrail estava CERTO em reagir**: em refactor legítimo, **reescrever o teste junto — não deletar** (mesma regra da §Lovable abaixo). **Rede estrutural (2026-08-18):** não precisa lembrar da lista — ao editar arquivo sob `supabase/functions/`, o hook `.claude/hooks/edge-guardrail-nudge.sh` (PreToolUse Write/Edit/MultiEdit) responde **quem lê AQUELE arquivo**, com o `bunx vitest run` já montado só com os testes afetados. Motor: `scripts/edges-guardrails-afetados.ts` (também rodável à mão: `bun scripts/edges-guardrails-afetados.ts supabase/functions/<edge>/index.ts`). Ele só **avisa** — quem reprova segue sendo o CI. Histórico das três pernas: `docs/historico/ci-testes-edge-deno.md`.

## Gateway de IA do Lovable — teto MENSAL de créditos derruba 7 edges de uma vez

O `ai.gateway.lovable.dev` (e o `ai.lovable.dev/chat/v1` do `copilot-analyze`) tem orçamento PRÓPRIO — *"AI features usage limit"*, **teto de 4 créditos/mês**, reset no dia 1º. Ao estourar, ele para de servir **todas** as edges de uma vez, e o sintoma NÃO aponta para créditos: o gateway devolve um status fora do `429`/`402` que as edges tratam, então cada uma cai no `else` genérico e reporta **HTTP 500**. Estourou em 2026-07-27 (4,20 de 4) e a geração de planos táticos ficou **3 dias em zero** — cron disparando certo, batch reportando honestamente `{"ok":false,"erros":59}`.

- **Diagnóstico rápido:** quebra ABRUPTA e TOTAL numa feature de IA, com o cron saudável, é teto de créditos até prova em contrário — **não** modelo descontinuado. O discriminante é o conjunto: o gateway serve modelos diferentes (`gemini-3-flash-preview` e `gemini-2.5-flash`), então "modelo removido" derrubaria só um subconjunto; teto derruba todos. `git log -S "<modelo>" --all` acha o diagnóstico anterior em segundos.
- **A conta que decide a prioridade:** o consumo é MUITO desigual. O batch noturno de planos táticos sozinho fazia 59 chamadas/dia (~1.770/mês) — tirá-lo do gateway protege as demais no mês seguinte. Antes de migrar por ordem alfabética, conte as chamadas/mês de cada uma.
- **Migração (padrão dos #1592/#1608/#1618):** `claude-sonnet-4-6` via `npm:@anthropic-ai/sdk` (nunca `esm.sh` — falha no boot sem stack), forced tool-use com `disable_parallel_tool_use: true`, prompt caching no `system`, gate de auth preservado, contrato de request/response inalterado, e **mapear o 402 explicitamente** (a Anthropic devolve `billing_error`; sem mapear, crédito esgotado volta a virar `http_500` genérico e o próximo diagnóstico recomeça do zero).
- **Ao migrar, procure o FALLBACK FABRICADO junto.** Todas essas edges nasceram parseando JSON de texto livre com `try/catch`, e o `catch` costuma inventar uma saída "padrão" que é gravada como real. Forced tool-use elimina a causa; o fallback tem de ser removido no mesmo PR, senão vira falha silenciosa com outro provedor.

## Canárias de deploy (a única prova do que está SERVIDO)

Grep na `main` prova a **fonte**; a canária prova o **deploy**. Chame com `?canary=1` (staff-gated). Nas canárias **VERSIONADAS** (as que têm `contrato` na tabela abaixo) exija os **TRÊS** campos — nunca só o `ok`:

```text
canary === true   E   contrato === '<marcador da fatia>'   E   ok === true
```

**As 7 canárias estão versionadas** (a dívida das 3 sem marcador fechou em 2026-08-23; a 7ª nasceu versionada no #1991 e só entrou nesta tabela em 2026-08-25 — ver ⚠️ "canária fora da tabela" abaixo). Canária sem `contrato` só tem `canary` + `ok`, o que **não** protege contra deploy integralmente velho (ver ⚠️ abaixo): canária nova nasce COM marcador — e o marcador **nomeia a fatia** que ela verifica, nunca um `v1.0-sensor-inicial` genérico (esse só é honesto quando o sensor nasce na mesma fatia).

| edge | rota | `contrato` esperado | o que a fixture discrimina |
|---|---|---|---|
| `analyze-unified-order` | Governança → Auditoria (card "Canária de preço") | `praticado-vence-omie-v1` | praticado 123 vence Omie 999 (velho: o Omie sobrescrevia → `resolved=999`) |
| `omie-vendas-sync` | `identidade_probe` ⚠️ a resposta ecoa **também** `versao` (sonda `{"probe":true}` desde o #2026), mas **não** o `fonte` — fatia que toca `_shared/` exige as DUAS chamadas (⚠️ abaixo) | `identidade-a2-client-to-user-v3` | identidade derivada por documento: 1-dono resolve, e divergência advisory×derivado / ambiguidade / ausência / bigint fora de range **recusam** (velho: o advisory sobrescrevia o derivado). **+ assinatura A2 (#1888)** em `assinatura_a2`: o `client_to_user` do snapshot é exigido (ausente = fail-closed), a prova positiva VENCE o cache divergente, o revogado SAI do cache e a revogação em massa aborta. ⚠️ `ok` já agrega os dois — mas leia `assinatura_a2.ok` e `casos` para saber QUAL lado falhou |
| `omie-analytics-sync` | `doc_ambiguo_probe` ⚠️ resposta embrulhada em `data` | `doc-ambiguo-fail-closed-v1` | doc ambíguo não vira vínculo (velho: helper sempre-∅ → `[]` no caso de 2 códigos) |
| `omie-analytics-sync` (2ª) | `transferencia_probe` ⚠️ resposta embrulhada em `data` | `transferencia-codigo-fail-closed-v1` | P1-c: código que muda de dono vira CONFLITO, não transferência (velho: 23505 derrubava o chunk de 500 e o run inteiro). 6 fixtures que se falsificam mutuamente — `codigo_livre`/`refresh_mesmo_user`/`duplicata_paginacao` → `aplicar`, `transferencia_de_dono` → `transferencia`, `manual_protegido` (override humano não é rebaixado), `disputa_intra_lote` |
| `carteira-rebuild` | `?canary=1` | `trava-saida-v1` | conflito permanece com `eligible=false` (velho: some) **+** trava de saída do bootstrap (velho: grava ~Hunter) | ⚠️ **também tem sonda `{"probe":true\}` desde o #2009** — a canária prova COMPORTAMENTO (a trava de saída) e o `VERSAO` prova o DEPLOY; antes ela acumulava os dois papéis e o `contrato` ficou parado de 2026-07-20 a 2026-08-08 enquanto duas fatias reais entravam.
| `generate-tactical-plan` | `{"canary":true}` | `v1.1-paginacao-eof-e-cursor` ⚠️ servido no campo **`versao`**, não `contrato` | margem ausente degrada em vez de fabricar (velho: NULL→`?? 0`→R$0/h; #1498) |
| `omie-financeiro` | `paginacao_probe` | `paginacao-guards-v1` | guards de paginação do #1598: piso NÃO encolhe (vazia antes do fim = anomalia; velho: `\|\| 1` → "fim"), reversa só completa com sonda vazia (velho: `pagina < 1` → complete), fingerprint sem colisão (velho: `1ºcódigo:count`), resposta sem array LANÇA (velho: `\|\| []` → "página vazia" = fim) |

### Sonda de versão (`{"probe":true}`) — quando a edge não tem canária e o efeito é irreversível

Canária prova **comportamento** com fixture; a **sonda** prova só **qual bundle está no ar** — e serve o caso em que a canária não cabe porque a edge não tem caminho barato nenhum. Mecanismo em `_shared/sonda-versao.ts` (#1747/#1750); cada edge contribui `VERSAO` + `EFEITO` no seu `versao.ts`. Instrumentadas — **disparo de pedido** (#1747/#1750): `disparar-pedidos-aprovados` (`v1.1-marco-causal`), `enviar-pedido-portal-sayerlack`, `conciliar-pedido-portal`, `gerar-pedidos-diario`, `pedido-programado-enviar`; **sem caminho de prova** (#1520): `generate-tactical-plan` (`v1.1-paginacao-eof-e-cursor`), `generate-bundle-argument` (`v1.1-cota-ia`); **efeito fora do nosso banco** (#1753): `omie-nfe-recebimento` e `process-nfe` — gêmeas, mesma tríade `AlterarRecebimento` → `AlterarEtapaRecebimento` etapa 40 → `ConcluirRecebimento`, que dá entrada de estoque e fiscal no ERP, e a `process-nfe` **não tem modo de teste nenhum**, nem o `diagnostico` read-only que a gêmea tem —, `sayerlack-captura-precos` (monta linha no pedido do portal do FORNECEDOR p/ ler preço; aborto deixa rascunho que passa por pedido humano) e `reposicao-depara-sayerlack-auto`; **escrita money-path no NOSSO banco** (#1767): `omie-cliente` — a mais cara das cinco, porque CRIA `auth.users` `@placeholder.local` + `profiles` e a ausência de `profiles` é o discriminante dos ~1.633 aliases fiscais (§5 do `database.md`): errar aqui apaga uma FRONTEIRA, não um número —, `fin-cashflow-engine` (projeção de 13 semanas que vira `fin_projecao_snapshots`/`fin_alertas` quando `save_snapshot:true`, o caminho do cron), `omie-sync-estoque` (reescreve o saldo do motor de reposição **e** avança o marcador de frescor: o run parcial apaga o sinal de que foi parcial), `omie-sync-nfes-recebidas` (rastreio nota↔pedido + `fin_sync_log`, lido sem filtro de `action` pelo cálculo de frescor) e `omie-nfe-webhook` (materializa o recebimento; cabeçalho e itens não são transacionais e a retentativa cai em "já importada", que esconde em vez de consertar). **escrita money-path no NOSSO banco, 2ª rodada**: `recommend` (#1898 — grava `recommendation_log`, o SENSOR DE DESFECHO do motor: sondar sem guarda inventaria uma recomendação que ninguém fez e enviesaria a própria medição de acerto; marcador hoje em `v1.5-denominador-observados`) e `omie-analytics-sync` (#1905 — reescreve `product_costs`, `order_items`, `sales_orders`, `inventory_position` e o mapa de identidade). ⚠️ Esta última JÁ tinha canária (`doc_ambiguo_probe`, na tabela acima) e mesmo assim precisou de sonda: a canária é NÃO-VERSIONADA e responde igual num bundle de hoje e num de três fatias atrás — **ter canária não dispensa marcador**. Nela a sonda é barata e o veredito é binário, porque a edge roteia por `action` e o bundle PRÉ-sensor cai no `default` com `400 "Ação desconhecida"`, sem tocar Omie nem banco. **oitava leva — as 7 que serviam o `paginate.ts` sem sensor NENHUM** (#1889/#1901): `calculate-scores`, `ai-ops-agent`, `omie-sync-status-produtos`, `sync-reprocess`, `scoring-recalc-batch`, `tactical-plans-batch` e `visit-score-recalc-batch` — o deploy delas era literalmente INVERIFICÁVEL (sem marcador, e sem fixture possível porque o #1889 é no-op por desenho). Junto vieram os bumps de `omie-cliente`, `generate-tactical-plan` e `reposicao-depara-sayerlack-auto`, presas num marcador que já respondia em prod, todas para `v1.1-paginacao-eof-e-cursor`. ⚠️ **O custo do bundle VELHO ignorando `probe` varia, e é ele que decide se sondar às cegas é seguro** — tabela por edge em `docs/historico/deploy-no-op-por-desenho.md` §8ª leva; das 7, só a `sync-reprocess` é barata (cai no `default` 400 antes de escrever) e só a `ai-ops-agent` é inócua (401 do gate de JWT). Nas outras 5, sondar um bundle pré-sensor DISPARA o run. Um gate novo (`nenhuma edge que serve o paginate.ts fica SEM prova de deploy`) fecha a classe: dependente nova nasce com sensor ou o CI reprova nomeando-a. Ficaram DE FORA de propósito as de leitura pura (`fin-funding`, `fin-valor-engine`, `fin-next-best-action`, …): chamá-las já é grátis, então a sonda não resolve problema que elas tenham — o que falta nelas é só o campo `versao` na resposta. Sem marcador declarado = `v1.0-sensor-inicial`. **sétima leva — `analyze-unified-order`** (#1930, marcador hoje em `v1.1-corpo-tipado`): a primeira que entra sem escrever no nosso banco E sem ser leitura barata. Motivo é o SEGUNDO do #1520 — chamada pelo BROWSER, não deixa rastro em `net._http_response` nem em `cron.job_run_details`. ⚠️ **Ela TEM canária versionada e mesmo assim precisou de sonda, e as duas NÃO se substituem:** o `contrato` da canária (`praticado-vence-omie-v1`, tabela acima) nomeia a fatia do MERGE DE PREÇO e vive DEPOIS do gate de staff — só o app logado a alcança; a `versao` da sonda nomeia a fatia do corpo/prompt e responde ANTES desse gate, com gate próprio, então é a única das duas que o founder dispara sem abrir o app. ⚠️ **Foi aqui que a armadilha "marcador congelado" mordeu de verdade:** `v1.0-prompt-invertido-cacheado` atravessou o #1938 sem bump, e a sonda provava "≥ #1930" e nada mais (medido em prod 2026-08-25, request_id 59657). O bump é obrigatório ANTES do deploy, e desde então há **dois** gates, que cobrem metades diferentes e nenhum substitui o outro: `bump v1.1-corpo-tipado` de `_shared/sonda-versao-contrato_test.ts` barra a **REGRESSÃO** (voltar ao valor literal que já respondia em prod), e `scripts/sonda-versao-bump-gate.ts` (`bun run sonda:bump`, no `validate`, só em `pull_request`) barra a **OMISSÃO** — que foi o que de fato aconteceu no #1938. Este último lê o DIFF contra o merge-base (por isso o checkout do job carrega `fetch-depth: 0`) e reprova nomeando a edge quando o **corpo servido** muda sem o `VERSAO` mudar junto. Corpo servido exclui `*_test.ts` (o bundle é byte-idêntico), o próprio `versao.ts` (é o marcador, e é quase todo prosa) e o que não sobrevive ao `removerComentarios` — comentário e reindentação não pedem marcador. Régua medida contra as 414 fatias anteriores a 2026-08-25, com o próprio gate decidindo: **26** tocam uma das 32 edges instrumentadas, **6 reprovariam** e o #1938 está entre elas, nenhuma sem mudança real de `index.ts` (o denominador ~68 do histórico conta os **94** diretórios de edge, não só os instrumentados). `supabase/functions/_shared/` fica **fora de propósito**: cobri-lo daria 290 pares (edge, fatia) em 25 PRs — ~12 marcadores a bumpar por PR —, e gate que grita 12× por PR é gate que alguém afrouxa. É fail-CLOSED: sem base determinável ou sem `VERSAO` legível ele reprova, porque não medir não é o mesmo que estar em ordem. ⚠️ **Ele NÃO era fail-CLOSED de verdade até 2026-08-25, e o furo era na fronteira de I/O — não no núcleo, que tinha 23 testes verdes:** o status do `git diff` era descartado, então comando que falha devolvia saída vazia, virava "nenhuma edge tocada" e imprimia o `✓` (a MESMA fatia que reprova dava `rc=0` trocando o `--head` por rev inexistente, porque o `--head` entrava CRU sem ser resolvido); e `versao.ts` ausente no HEAD era `continue` silencioso, ou seja **apagar o marcador junto com a mudança de corpo passava**. Corrigidos, com um assert por furo (eles se cobriam) e contrato de mutação em `scripts/mutcheck.d/sonda-versao-bump-gate.mut`. **Auditoria do débito ANTIGO** (o que o gate de transição não vê), feita com o próprio gate por `--base <c>^ --head <c>`: 12 fatias pós-bump e **2 congeladas**; re-medido após rebase, **1** (`disparar-pedidos-aprovados`/`dc67b4261`) — a `omie-analytics-sync` foi bumpada por worktree paralela em `5d8f1f779`. Nas duas o deploy JÁ tinha acontecido, então o bump tardio não devolve discriminação e deixa **deploy de edge pendente** só para realinhar marcador (prod respondia `v1.1-mapa-codigo-sem-alias`). Auditoria de débito **tem prazo de validade** com ~30 worktrees: re-meça antes de afirmar. Para auditar assim, use `git log -G` (o `-S` conta ocorrências e é cego a mudança só de VALOR) e exija o `✓` POSITIVO: "reprovou" e "recusou medir" dão o mesmo `exit 1`. A variante do `FONTE_SHA256` por **ledger guardado** foi desenhada, levada ao Codex e **perde para o fingerprint SERVIDO** que o `sonda:fingerprint` entregou: ledger fecha o furo no CI, servir fecha na PRODUÇÃO — regravar o hash deixa de ser exploit porque a resposta da sonda muda junto. Registro em `docs/historico/sonda-marcador-congelado.md`. **décima leva — os 4 steps restantes do `omie-cron-diario`** (2026-08-27): `omie-sync-pedidos-compra`, `omie-sync-ctes-recebidos`, `omie-sync-sku-items` e `omie-sync-vendas-items`, todas em `v1.0-eco-versao-passivo`. O critério aqui não é o efeito (os cinco steps escrevem money-path) — é que o deploy delas era **inverificável**: sem `versao.ts`, sem sonda e com o corpo de resposta byte-idêntico antes e depois de uma fatia. Medido no #2031 (coleira de RELÓGIO no `omieCall` dos 5 steps): só o 5º (`omie-sync-nfes-recebidas`, o único com sensor) se provou em prod; os outros quatro ficaram como INFERÊNCIA — e o sintoma que a coleira corrige (request pendurado) é indistinguível de "o Omie estava lento" quando não se sabe qual bundle está no ar. ⚠️ Sondar bundle PRÉ-sensor nas quatro é **caro**: nenhuma roteia por `action`, então o corpo desconhecido cai nos defaults e a varredura roda inteira. É exatamente por isso que elas vieram com o eco PASSIVO do bullet abaixo.

- **11ª leva — as 5 de efeito FORA do nosso banco que estavam na CLASSE CEGA do Passo 3** (2026-09-05): `whatsapp-send`, `whatsapp-send-template` (template é TARIFADO), `enviar-push`, `nvoip-calls` (origina LIGAÇÃO) e `dispatch-notifications` (e-mail pelo Gmail + evento no Calendar). Todas em `v1.0-sensor-inicial`; o mapa vai de 40 para 45. O critério da escolha é o de sempre (#1753, efeito que rollback nenhum recolhe), mas o motivo de ELAS terem aparecido é novo e vale a régua: **a união das duas vias de enumeração do `edges-pendentes.sh` deixava uma CLASSE fora — edge FORA do mapa que importa `_shared/`**. Medido sobre `origin/main`: 95 pastas com `index.ts`, 81 importam `_shared/`, 40 no mapa ⇒ **41 cegas**, e na janela 21/08→05/09 duas foram afetadas de fato (`visit-score-recalc-client` por `_shared/leitura-critica.ts`, e `elevenlabs-transcribe`). ⚠️ **Instrumentar as 41 seria o conserto ERRADO** — fecha os casos e não a classe, e como entrar no mapa só vira evidência positiva DEPOIS do deploy manual, uma leva de 41 produziria 41 deploys e 41 chips, exatamente a enxurrada que aquele script existe para cortar. O conserto da classe é a **via (c)** (`scripts/edges-afetadas.ts`): afetada = algum arquivo do fecho transitivo aparece no `git diff`, com universo = toda pasta com `index.ts`, no mapa ou fora. Não toca produção e erra para cima. → `docs/historico/uniao-de-vias-cegas-nao-e-cobertura.md`
- **12ª leva — as 6 do SYNC OMIE que escrevem no money-path do NOSSO banco e também estavam na CLASSE CEGA** (2026-09-05): `omie-sync` (roteia por `action` e escreve dos DOIS lados — `IncluirOS`/`AlterarOS`/`ExcluirOS`/`IncluirCliente` no ERP mais `orders`/`omie_ordens_servico`/`loyalty_points`/carteira aqui), `omie-malha-sync` (reescreve `pcp_malha_staging`, de onde sai a necessidade de compra), `omie-nfe-recebimento-sync` (insere `nfe_recebimentos` e, em escrita SEPARADA, `nfe_recebimento_itens` — e o guard de duplicata faz a retentativa PULAR a NF que ficou só com cabeçalho, em vez de consertá-la), `omie-sync-metadados` (reescreve `omie_products` das duas contas e CARIMBA o frescor em `sync_state` — run parcial apaga o sinal de que foi parcial, igual à `omie-sync-estoque`), `omie-webhook` (grava `omie_webhook_events` e despacha o processamento em `waitUntil`) e `omie-aplicar-parametros` (`AlterarProduto` — escrita no ERP, não aqui). Todas em `v1.0-sensor-inicial`; o mapa vai de 45 para 51. ⚠️ Duas entram com forma própria: a `omie-webhook` é a gêmea estrutural da `omie-nfe-webhook` e precisa de **gate PRÓPRIO** (o gate dela é `x-webhook-secret`, que o SQL Editor não emite) **e** de linha em `ANCORA_CLIENT` — o client dela nasce no TOPO do módulo, então `createClient(` não aparece no trecho do handler e o gate de posição cairia no ramo "controle positivo vazio"; a âncora honesta é o primeiro USO (`registrarEvento`). E na `omie-malha-sync` há **colisão de nomes que não é a mesma coisa**: o `action:"probe"` DELA inspeciona a forma do payload do Omie (read-only); a sonda de versão decide pelo campo `probe` do corpo. Um não substitui o outro.

- **Efeito irreversível não é a única indicação — "não existe caminho de prova" também é.** As duas edges do #1520 entraram por este segundo motivo: o efeito é caro-mas-reversível (token do modelo, plano regravável), só que elas são chamadas pelo **BROWSER** e por isso não deixam rastro em `net._http_response` nem linha em `cron.job_run_details` — o par que torna uma edge de cron auditável de fora. Quando a pergunta "qual bundle está no ar?" não tem NENHUMA resposta possível, a sonda é o sensor, independentemente de o efeito ser reversível.

- ⚠️ **Campo `versao` na resposta do FLUXO REAL não é sensor de deploy — é o disfarce mais perigoso que existe.** A `omie-nfe-reconcile` respondia `versao:"v3.3-paginacao-janelas"` em dois `return`, e verificar o #2025 (coleira de relógio no `omieCall`) travou no N1 com todo o resto fechado: N2 indisponível, o rastro do bot `gpt-engineer-app[bot]` só prova que UM deploy rodou, e o marcador é **idêntico byte a byte nos dois bundles** — o #2025 não o tocou nem acrescentou campo algum à resposta. Quem sondasse leria `versao: v3.3` e concluiria "verificado". É o `canaria-papel-duplo.md` com uma volta a mais: lá o marcador de papel duplo mora na CANÁRIA (caminho barato, aceso à mão); aqui mora na resposta do fluxo real, que custa a varredura inteira contra o Omie — o preço de descobrir o disfarce é pagar o efeito. **Régua:** marcador só é sensor de BUNDLE se um gate obrigar a movê-lo (`sonda:bump`) ou se ele for DERIVADO da fonte (`fonte`/`sonda:fingerprint`); aceso à mão e sem gate, ele nomeia a FATIA e nada mais. O `v3.3` **não** foi substituído quando a edge ganhou sonda (2026-08-26) — ele identifica o emissor em `net._http_response` (jobid 162, `docs/historico/cron-teto-volume-vs-latencia.md`); a sonda **acrescenta**, como no #2009/#2026.
- ✅ **O eco de `versao` no fluxo real É sensor de deploy quando o marcador vem do `versao.ts` — e é o caminho N3 PASSIVO mais barato do repo.** É o inverso do disfarce acima, e a régua que separa os dois é a do próprio bullet anterior: marcador aceso à mão e sem gate nomeia a FATIA; marcador que um gate obriga a mover (`sonda:bump`) e que o `sonda:fingerprint` deriva da fonte identifica o BUNDLE. O `v3.3` hardcoded da `omie-nfe-reconcile` é o primeiro caso; `versao: VERSAO` importado do `versao.ts` é o segundo. Nos **5 steps do `omie-cron-diario`** (2026-08-27) o helper `jsonRes` de cada edge anexa `versao: VERSAO` a **TODA** resposta, não só à da sonda — e o orquestrador faz `JSON.parse` do corpo de cada step e o devolve inteiro em `resultados.<key>.body`, então o tick de 2h do **jobid 52** (`afiacao_omie_oben_sync_incremental_2h`) já grava em `net._http_response` o marcador de cada step **que respondeu a tempo** (3 dos 5, medido). É **evidência OPORTUNISTA, não cobertura 5/5**: com `modo:"respondido"` e o marcador esperado em `body.versao`, prova que AQUELE POST foi atendido por código que servia esse `VERSAO` — e **não** prova que o trabalho terminou com sucesso (o eco viaja igual na resposta de erro, de propósito). `modo:"background"`, `coletado:false`, erro de transporte, `abortado_total_timeout` ou corpo sem marcador são amostras **INCONCLUSIVAS**, jamais evidência de bundle velho. Prova de deploy **sem invocar nada**, sem cron secret, sem o founder logado e sem pagar efeito — que é o que importa em edge cujo bundle pré-sensor DISPARA o fluxo real quando sondado. ⚠️ **MEDIDO EM PROD 2026-08-28 — o eco cobre os steps que RESPONDEM dentro dos 25s, e são os 2 mais pesados que ficam de fora.** No tick pós-deploy (id 61756) vieram com marcador `ctes`, `sku_items` e `vendas`; `pedidos` e `nfes` vieram `modo:"background"`, logo SEM corpo e sem `versao`. Nos 4 ticks da janela de retenção: `nfes` background **4/4**, `pedidos` **3/4**, os outros três `respondido` 4/4 (amostra pequena — 4 ticks é o que o `pg_net.ttl` permite). ⇒ a régua honesta **não** é "os 5 steps provam por eco": é **o eco prova o step que cabe no `STEP_TIMEOUT_MS`; o que estoura precisa de sonda ativa** — e é justamente nos pesados que a sonda é mais cara. Prometer os cinco seria a própria classe que esta fatia combate: régua mais forte que o mecanismo. Foi assim que o #2031 se provou na `omie-sync-nfes-recebidas` (ids 61498/61560, 2026-08-27, `v1.1-deadline-relogio`). Gates: `os 5 steps do cron diário ECOAM versao em toda resposta` + a CALIBRAÇÃO gêmea, em `_shared/sonda-versao-contrato_test.ts`.
  - ⚠️ **Leia o `modo` ANTES do `versao`.** Em `modo:"background"` — o orquestrador aborta o cliente em 25s pelo `STEP_TIMEOUT_MS` e a edge segue server-side — o corpo **não foi coletado** e `versao` sai vazio. Vazio ali é **linha inutilizável, não "marcador velho"**: julgar por ele reprova um deploy correto e manda redeployar edge money-path à toa. Mesma família da linha de timeout do `net._http_response`, que vem com `content` e `status_code` NULL e devolve linha vazia com exit 0.
  - ⚠️ **O eco passivo carrega `versao`, NÃO `fonte`** — a mesma ressalva do #2054 sobre a canária da `omie-vendas-sync`. Fatia que chegue inteira por `_shared/` não move o `VERSAO` (o `sonda:bump` exclui `_shared/` por medição) e o eco responde idêntico nos dois bundles. ⇒ quando a fatia tocar `_shared/`, o veredito exige a chamada à sonda `{"probe":true}`, que é quem serve o `fonte`.
- ⚠️ **Sonda SEM marcador prova "≥ o PR que a criou" e nada mais** — e isso se lê como prova de deploy sem ser. A `generate-tactical-plan` tinha `{"probe":true}` desde o #1618 respondendo a CONSTANTE `motor:"anthropic"`: provava a migração para a Anthropic e ficou congelada aí. Todo deploy posterior respondia byte-idêntico, então no fecho do FU4-F fase 3 (#1520, o último commit a tocar a edge) a verificação caiu em "o founder confirmou" **com a sonda respondendo verde** — é a armadilha 2 (abaixo) na sonda em vez de na canária. Corrigido no #1754: marcador versionado + o `versao` também na resposta da canária de margem. A sonda daqui é **superset** da do #1618 (`motor`/`modelo`/`tool`/`fallback_fabricado` continuam servidos, pinados em `generate-tactical-plan/versao_test.ts`) — quem tem o `curl` antigo anotado não perde nada.

- **A pergunta que ela responde** é "está no ar?", em 1 request, sem custo: responde ANTES do `createClient`, de toda query e de toda chamada externa. Com `x-cron-secret` o gate de auth decide por comparação de env pura ⇒ IO-free de ponta a ponta.
- **A sonda também responde `fonte` — fingerprint da FONTE da edge (#1998).** SHA-256 sobre o fecho transitivo dos imports LOCAIS a partir do `index.ts`, **`_shared/` incluso**, gerado por `bun run sonda:fingerprint -- --write` e servido por `criarRespostaSonda`. Ele cobre o que o `versao` não alcança: mudança que chega inteira por `_shared/` não move o marcador humano, e o gate `sonda:bump` deixa `_shared/` de fora por medição (~12 bumps à mão por PR). Ler os dois: `versao` diz **o que** mudou (slug humano), `fonte` diz **que** mudou (derivado, sem depender de disciplina). `fonte` diferente do mapa da `main` ⇒ o bundle no ar foi buildado de outra fonte. ⚠️ É fingerprint da **FONTE**, não hash do bundle — não há `deno.lock` versionado e há range aberto (`npm:@supabase/supabase-js@2`), então a mesma fonte pode resolver dependência externa diferente; e ele **não prova atomicidade** do deploy manual.
- ✅ **E ele rodou PONTA-A-PONTA em prod pela primeira vez em 2026-08-25**, na `carteira-rebuild` (instrumentada no #2009), logo após o deploy manual dela: `status_code=200`, `eco_probe=true`, `versao=v1.0-sensor-inicial` e `fonte=8d2589d0…986eb78a` — **idêntico** ao que `_shared/sonda-fingerprints.ts` guarda para ela na `main`. `versao` + `eco_probe` sozinhos só provariam que ALGUM bundle com sonda subiu; é o **`fonte` bater** que prova que o código servido hasheia o **grafo transitivo inteiro** igual à `main` — ou seja, **que o Lovable deployou VERBATIM**, a dúvida que a Lei de Ferro #3 da skill `lovable-deploy-verify` existe para cobrir e que até aqui ninguém conseguia responder. ⚠️ Prova a **FONTE, não o artefato final** (o range aberto do bullet acima continua valendo) — por isso o campo se chama `fonte` e não `bundle`.
- ⚠️ **Resposta de sonda COM eco (`probe`+`versao`) e SEM `fonte` é prova POSITIVA de bundle anterior ao #1998 — nunca "não observei nada".** A leitura que filtra as respostas por `content ? 'fonte'` **antes** de classificar descarta exatamente essa classe e a edge cai no ramo de ausência de dado. Medido em 2026-09-05 (request_ids 69305–69314): **7 das 40** edges do mapa responderam 200 assim, e o Passo 3 do `/fecho` imprimiu "nenhuma sonda em 6 hours" para as 7 — mandando investigar o SENSOR quando o defeito era **deploy pendente**. Se a edge está no mapa, a main serve `fonte`; o ar não servir ⇒ o ar não é a main. Corrigido em `.claude/skills/fecho/scripts/edges-pendentes.sh` (ramo `PRE_SONDA_FONTE`); o gêmeo do #2148 (filtro `"probe"` perdendo o eco passivo) é o mesmo defeito no sinal oposto → `docs/historico/ausencia-fabricada-por-filtro-de-forma.md`.
- ⚠️ **Um degrau ANTES: resposta de sonda SEM eco de `edge` EXISTE e não é atribuível — e isso também não é "não observei nada".** O eco do slug só nasceu no **#1789**; bundle anterior responde `{ok,probe,versao}` e mais nada, então toda leitura que casa por `content->>'edge'` (o `/fecho` e o `sonda:sql` sem colagem) fica cega para ele. Medido 2026-09-05 (request_ids 69377–69381): das 5 edges sondadas, só as 2 que ecoam `edge` saíram `PRE_SONDA_FONTE`; as 3 restantes saíram "nenhuma sonda em 6 hours" — pendência PROVADA virando ausência de dado, o **mesmo** erro da linha acima uma geração de campo atrás. **A identidade não se presume:** `net.http_request_queue` é a única tabela do pg_net que guarda a URL e é APAGADA quando a resposta chega (conferido no mesmo dia — a fila só tinha os ids em voo), então o `request_id` do disparo é o **único vínculo determinístico** que sobrevive. Daí o `--request-ids` do `edges-pendentes.sh` e o `ids` do `sonda:sql` — com os 5 ids colados, as 5 edges saíram `PRE_SONDA_FONTE`. Sem eles a saída diz `SONDA_ANONIMA` e **conta** quantas anônimas há, em vez de alegar que ninguém sondou; o veredito segue INDETERMINADO (chip), o que muda é o diagnóstico não mentir.
- ⚠️ **`fonte` AUSENTE ≠ `fonte` valendo `nao-mapeada` — e um `COALESCE` fundindo os dois nomeia a causa ERRADA.** O `sonda:sql` respondia `DEPLOY PARCIAL — subiu index.ts+versao.ts, mas _shared/sonda-fingerprints.ts NAO` para as 5 respostas acima, em que não houve deploy parcial nenhum: é bundle inteiro anterior ao #1998. O desfecho prático coincide (redeployar), mas quem lê vai investigar um prompt de deploy que nomeou poucos arquivos — e ele não existiu. **Campo ausente ⇒ `PRE_SONDA_FONTE`** (o mesmo nome que o `edges-pendentes.sh` já usava: dois nomes para um estado é como o operador conclui que são dois problemas). **Campo presente valendo `nao-mapeada` ⇒ `DEPLOY PARCIAL` de verdade** — o bundle conhece o campo (logo é ≥ #1998) e o mapa que subiu não tem esta edge. A separação é semântica de ordem de `WHEN` e de `?` sobre jsonb: só aparece EXECUTANDO, e é o que o eval `edges-pendentes-sql-eval.sh` (+ os 2 cenários novos do `sonda-veredito-401-eval.sh`) guarda no CI.
- ⚠️ **Verificar exige o eco `probe:true` E `versao`** — é a armadilha 1 acima vista de outro ângulo: bundle ANTERIOR à sonda **ignora o parâmetro e roda o FLUXO REAL**. Resposta sem esses campos = bundle velho **e ele executou o efeito caro** (PO no Omie, pedido no portal do fornecedor). **Sonde só depois de confirmar o deploy** — ou, quando a edge aceitar, com parâmetro que torne o fluxo real um no-op (no `disparar-pedidos-aprovados`, `"data_ciclo":"1970-01-01"`: nada casa no `.eq`/`.lte`).
- **`probe` com valor não reconhecido é 400 fail-closed**, nunca execução por omissão — e grafias que o SQL Editor produz (`"true"`, `"1"`, caixa/espaço) contam como sonda: um `=== true` cru mandaria `{"probe":"true"}` para o efeito irreversível.
- **Onde a sonda entra quando o gate da edge não aceita `x-cron-secret`:** nas duas de NF-e o gate é JWT de usuário staff, e é pelo SQL Editor (cron-secret) que a sonda é invocada — atrás do gate ela seria inalcançável justamente para quem precisa dela. Nelas a sonda responde ANTES desse gate, com gate PRÓPRIO (`authorizeCronOrStaff`): nenhum caminho fica sem auth, o fluxo real continua exigindo os dois, e o custo só é pago quando `probe` vem no corpo. Ao instrumentar uma edge nova, cheque **qual** gate ela tem antes de copiar o padrão. O #1767 acrescentou dois formatos de gate que o padrão original não previa: a `omie-nfe-webhook` usa `x-webhook-secret` (segredo compartilhado com o Omie, que não emite JWT), e a `omie-cliente` **não tem um gate só** — ele é POR AÇÃO dentro do switch, e `buscar_por_documento` é PÚBLICA (pré-cadastro, só rate-limit por IP). Nessa última, deixar a sonda seguir o gate da ação a tornaria ou inalcançável (nas de staff) ou **pública** (na de pré-cadastro) — as duas erradas; o gate próprio evita os dois. Regra prática: se a edge tem mais de um gate, o gate da sonda é sempre o dela, nunca "o da ação que calhar".
- ⚠️ **O sensor só prova versões A PARTIR DE SI MESMO.** Ausência do campo `versao` = bundle pré-sensor, não "versão errada". Ele nunca responde retroativamente — é a regra "superfície de uso nasce COM o sensor" aplicada a deploy, e o motivo de criar a sonda JUNTO do fix.
- ⚠️ **Comentário que promete caminho seguro inexistente é a armadilha irmã** (2 casos achados): `dry_run` do `disparar-pedidos-aprovados` chama `IncluirPedCompra` incondicionalmente e cria PO real; e o header do `enviar-pedido-portal-sayerlack` anunciava um modo `ECO (validacao)` **que não existe no código**. Antes de usar um "modo de teste" documentado em comentário, **confirme no código que ele é tratado**.

⚠️ **Só é canária se a resposta tiver `"canary":true` E o `contrato` esperado.** Duas falhas distintas:
1. Deploy ANTERIOR à canária ignora o param e roda o **fluxo real** — no `carteira-rebuild` isso é um rebuild completo (lease + upserts; idempotente e guardado, mas é escrita). Resposta sem `canary:true` = canária não rodou **e** o deploy é velho: já é o veredito.
2. Deploy **integralmente velho** (com a canária de uma fatia anterior) carrega o `expected` VELHO junto e compara velho×velho → responde `canary:true, ok:true` e **mente verde** (Codex 2026-07-20). Por isso o **`contrato` (version marker) é obrigatório na verificação**: `ok` sozinho não discrimina reversão de fatia. Faça **bump do marcador** a cada fatia que mude o contrato da canária — senão a próxima reversão volta a passar despercebida. **Há gate desde 2026-08-25:** `scripts/canaria-contrato-bump-gate.ts` (`bun run canaria:bump`, no `validate`, só em `pull_request`) reprova o PR nomeando a canária quando o que ela atesta muda e o `contrato` fica parado — é o que a auditoria dos 7 `contrato` apontou como o furo real ("não é um contrato parado, é a falta de gate"). **A régua não é a do `sonda:bump`, e a diferença foi medida:** cobrar bump do `contrato` a cada mudança do corpo reprovaria 8 de 10 fatias em 400, e 7 dessas 8 mexem em parte da edge que a canária não atesta. Ela sai de o `contrato` ter dois trabalhos — identificar o bundle e nomear o contrato verificado — e de quem responde pelo primeiro: **edge sem `versao.ts`** (desde o #2026, **nenhuma** — a `omie-vendas-sync` era a última) teria o `contrato` como ÚNICO marcador de bundle ⇒ régua = corpo servido inteiro; **edge com `versao.ts`** já tem `sonda:bump` + `fonte` servido respondendo por isso ⇒ régua = a **superfície da canária** (o bloco dela mais o fecho dos símbolos que ela exercita, `_shared/` incluído **por símbolo**, que custou zero reprovação a mais e é o que põe `desfechoVarreduraReversa` e `fingerprintPagina` dentro do gate). Assim medido: **2 reprovações em 400 fatias**, mais o `f6561b0b2` — o caso concreto da auditoria — logo antes da janela. **A régua sai do HEAD em RUNTIME** (`temSonda ? 'superficie-da-canaria' : 'corpo-servido'`), não de lista no código: instalar `versao.ts` migra a edge de categoria sozinha, sem tocar no gate — foi o que o #2009 fez com a `carteira-rebuild`. Medido em 2026-08-25: o encanamento do `5f5523df9` a reprovava pela régua de corpo e hoje **passa**, enquanto sabotar `computeCarteira` a reprova pela de superfície. Logo é a **lista de nomes deste parágrafo** que envelhece calada, não o gate. É fail-CLOSED: sem base, ou com emissão de `contrato` cujo bloco não dá para delimitar, reprova. → `docs/historico/sonda-marcador-congelado.md`

⚠️ **Canária cujo CONSUMIDOR é o frontend precisa de DOIS deploys para discriminar.** A `analyze-unified-order` é a única das 6 assim: ela não aceita `x-cron-secret` (gate por JWT de staff), então não sai pelo SQL Editor — quem exige o `contrato` é o card de Governança, ou seja **código do frontend**. Com o Publish do frontend pendente, o card servido é o ANTIGO, que classifica pela forma pré-marcador (`ok && resolved===123 && expected===123`) e pinta **verde com edge nova OU velha** — e o texto do verde é idêntico nas duas versões, então a tela não desempata. Medido 2026-08-23 no #1922. **Ao verificar essa canária, confirme o Publish do frontend antes de ler o card**; sem ele, a prova independente é a resposta CRUA da edge (DevTools → Network → `analyze-unified-order` → Response, procurando `"contrato"`). Regra geral: a canária herda as camadas de deploy de TODO mundo que participa do veredito, não só da edge que responde. **A sentinela desse Publish é `praticado-vence-omie-v1`** — o `verify-frontend.sh` da skill `lovable-deploy-verify` a acha no chunk `GovernanceAudit-*` (medido 2026-08-23: exit 0, 334 chunks). Provar o card pelos BYTES vem ANTES de pedir a tela: se o Publish estiver pendente, o verde que o founder relatar não é veredito, e a viagem até a tela foi perdida. O DevTools acima é a via de quem já está com o app aberto.

⚠️ **Canária que não discrimina é teatro verde.** Se a mudança for no-op nos dados de hoje (caso do #1397: 0 conflitos em prod), a resposta do fluxo REAL é byte-idêntica com código velho ou novo — não prova deploy nenhum. A fixture tem de exercitar **o comportamento que mudou**, e o teste tem de provar que sob o comportamento ANTIGO a canária ficaria vermelha (ver `rebuild-helpers.test.ts` → "a fixture DISCRIMINA"; e `_shared/omie-paginacao_test.ts` → bloco "CONTROLE DE CALIBRAÇÃO", que roda a forma pré-#1598 sobre os fixtures homônimos da `paginacao_probe`). Sem esse assert, a canária só prova que a função responde.

⚠️ **O `contrato` da canária e o `VERSAO` da sonda são marcadores INDEPENDENTES — nenhum cobre o outro, e cada um tem o SEU gate (o do `contrato` desde o #2005).** Auditoria dos 7 `contrato` pelo critério do marcador congelado (2026-08-25, tabela em `docs/historico/sonda-marcador-congelado.md`): **nenhum congelado** — em todas, os símbolos que a fixture exercita (`mergeCustomerPrices`, `docsComCodigoAmbiguoNoOmie`, `classificarLoteProof`, `computeCarteira`/`verificarCobertura`/`avaliarGuardResultado`, `desfechoVarreduraReversa`/`fingerprintPagina`/`listaOmie`) estão intocados desde a fatia que definiu o contrato. Mas o resultado limpo esconde uma assimetria de MECANISMO: `scripts/sonda-versao-bump-gate.ts` só olha edges com `versao.ts` (`if (fonteHead === null) continue`), então a omissão de bump de `contrato` ficou **sem gate nenhum até o #2005** criar o `canaria-contrato-bump-gate.ts` acima — antes dele, o teste de contrato pegava só a REGRESSÃO. O fingerprint SERVIDO do #1998 **não fecha isto e aprofunda o desnível**: desde o #2026 as **6** edges com canária têm sonda e entram no mapa de `_shared/sonda-fingerprints.ts`, ganhando um discriminador imune a disciplina — o desnível que este ⚠️ descrevia está fechado, e o que resta dele é a regra: **canária nova nasce com sonda**, senão o `contrato` volta a acumular os dois papéis. Como as duas últimas foram fechadas, na ordem: a `carteira-rebuild` ficava fora do gate `nenhuma edge que serve o paginate.ts…` por não importar o helper, e o caso concreto era o `f6561b0b2` — 4 guards money-path (`data == null` → `failLease` em vez de encerrar o laço com carteira TRUNCADA) contra um `trava-saida-v1` de 8 dias antes; o #2009 lhe deu `versao.ts` e o `fonte` foi VALIDADO em prod (#2018). A `omie-vendas-sync` era o inverso — IMPORTA o `paginate.ts` (`import type`, que o gate conta) e era a única entrada de `VERIFICAVEL_POR_CANARIA`, a dispensa que aquele gate concede a quem tem canária: registrava a canária como prova, mas não dava discriminador de BUNDLE. O #2026 lhe deu `versao.ts` + rota `{"probe":true}` e fez o `identidade_probe` **ecoar o `versao` ao lado do `contrato`** (desenho da `generate-tactical-plan`), então o mapa `VERIFICAVEL_POR_CANARIA` ficou vazio — e fica, como válvula para a próxima edge que sirva o `paginate.ts` provando deploy só por canária.

⚠️ **Nem `contrato` + `VERSAO` JUNTOS cobrem `_shared/` — só o `fonte`, e ele NÃO viaja na canária** (achado do `/codex challenge` sobre o #2026, gpt-5.6-sol/xhigh). A canária da `omie-vendas-sync` ecoa `versao` ao lado do `contrato` justamente para poupar uma segunda chamada — e isso vale enquanto a fatia for edge-local. Um PR que mexa **só** em `_shared/` não bumpa o `VERSAO` (o `sonda:bump` exclui `_shared/` de propósito: cobri-lo daria ~12 bumps à mão por PR) **nem** o `contrato` (o `canaria:bump` traz de `_shared/` apenas os símbolos que a FIXTURE exercita, e o `authorizeCronOrStaff` roda ANTES dela). Sem o deploy, a canária do bundle velho responde os três campos IDÊNTICOS e **mente verde** — inclusive para um hardening do próprio gate de auth desta edge money-path. Só o `fonte` da rota `{"probe":true}` discrimina, porque o fingerprint é do fecho transitivo COM `_shared/`. ⇒ **Quando a fatia tocar `_shared/`, verifique com as DUAS chamadas:** sonda (`fonte` idêntico ao de `_shared/sonda-fingerprints.ts`) **e** canária (`contrato` + `ok`). O eco de `versao` economiza a 2ª chamada só no caso edge-local.

⚠️ **Canária pode existir FORA desta tabela — e canária que a tabela não lista é canária que ninguém exige.** A `transferencia_probe` (#1991, 81f9a111c) nasceu versionada e correta, e mesmo assim ficou 1 dia invisível: quem verifica deploy lê esta tabela, e o que não está aqui não entra no veredito. Ela é a **segunda** canária da mesma edge — o par (edge, canária) é 1:N, então "a canária da `omie-analytics-sync`" é ambíguo e a `action` é quem desempata. Ao criar canária, editar esta tabela é parte da entrega, não follow-up. Inventário autoritativo: `git grep -n "contrato: *[\"']" supabase/functions/` — 7 hoje, e o `x` que aparece é fixture de `assinatura-a2_test.ts`, não canária.

⚠️ **O campo nem sempre se chama `contrato` — e o verificador que assume o nome lê `undefined`.** A `generate-tactical-plan` serve o marcador em **`versao`** (`{ canary: true, versao: VERSAO, ok, resultados }`), não em `contrato`: ela ACOPLA o contrato da canária ao `VERSAO` da sonda de propósito, e um verificador que faça `contrato === 'v1.1-paginacao-eof-e-cursor'` recebe `undefined` e reprova uma canária sadia. O acoplamento é o desenho mais forte das 7, e vale copiar: sendo o mesmo símbolo, a canária **herda o gate da sonda** — o `sonda:bump` já barra a omissão, que é justamente o que falta às canárias com `contrato` literal.

⚠️ **No-op por DESENHO: quando NENHUMA fixture existe, e o marcador vira a única prova.**
A armadilha acima é no-op por **acaso dos dados** (#1397: 0 conflitos em prod) e conserta-se com
fixture melhor. Há um caso em que isso é impossível: o PR cujo ganho é **proteção contra mudança
futura**, que por desenho não altera comportamento nenhum hoje — bundle novo e velho produzem
bytes IDÊNTICOS (o #1889 da paginação: o `max-rows` de prod é 1000, igual ao `PAGE` do helper).
Procurar fixture aí é procurar o que o PR garante não haver. Sobra a **sonda de versão** — e ela
só prova se o marcador for **bumpado ANTES do deploy**: marcador igual na `main` e em prod
responde a mesma string tendo o deploy acontecido ou não. **Compare `main`×prod no PRÉ-FLIGHT**;
iguais, a viagem é inverificável e o bump vira pré-requisito, não consequência. Nas 3 edges do
#1889 as três falhavam nisso, uma delas por canária NÃO-VERSIONADA (a ⚠️ #2 acima).
→ `docs/historico/deploy-no-op-por-desenho.md`

**Como o founder invoca uma probe sem terminal** (ele não tem acesso de shell ao backend): cole no **SQL Editor do Lovable** — o segredo sai do vault, nunca do chat — e leia a resposta em `net._http_response`. Mesmo mecanismo do cron, com `timeout_milliseconds` EXPLÍCITO (default 5s mata silencioso). Trocando `action`/`url`, serve para as outras probes:

```sql
SELECT net.http_post(
  url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
  headers := jsonb_build_object('Content-Type','application/json',
    'x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
  body := jsonb_build_object('action','paginacao_probe'),
  timeout_milliseconds := 20000) AS request_id;
-- ANOTE o request_id devolvido acima e TROQUE o marcador abaixo por ele. ~5s depois, na MESMA aba:
-- ⚠️ COALESCE: a `omie-analytics-sync` responde `{success,data:{...}}` (envelope de action), as
-- demais respondem no TOPO. Sem descer no `data`, a leitura devolve NULL nela — e NULL lido como
-- "não tem canária" é ausência de dado virando veredito. O `corpo` abaixo serve as duas formas.
WITH r AS (
  SELECT status_code,
         COALESCE(content::jsonb->'data', content::jsonb) AS corpo
  FROM net._http_response WHERE id = COLE_AQUI_O_REQUEST_ID  -- NÃO `ORDER BY id DESC LIMIT 1`, NÃO um nº de exemplo
)
SELECT status_code, corpo->'canary' AS canary, corpo->>'contrato' AS contrato, corpo->'ok' AS ok,
       (SELECT jsonb_agg(c->'caso') FROM jsonb_array_elements(corpo->'casos') c
        WHERE (c->>'ok')::bool IS NOT TRUE) AS casos_vermelhos
FROM r;
```

⚠️ **`ORDER BY id DESC LIMIT 1` fabrica veredito NEGATIVO — leia pelo `request_id`.** Este banco recebe resposta de cron o tempo todo (só o watchdog responde a cada ~5 min, e há timestamps com DUAS respostas no mesmo microssegundo), então "a última linha" quase nunca é a sua: entre disparar e ler, um tick alheio entra na frente. Mordido ao vivo em 2026-08-23, com a receita desta seção: a sonda da `recommend` respondeu `{"ok":true,"probe":true,"versao":"v1.5-…","edge":"recommend"}` no id 58859, o `SELECT` pegou o 58858 (`{"modo":"watchdog",…}`, 41s antes) e devolveu `edge NULL, versao NULL, status_code 200` — que é **exatamente a assinatura de "bundle pré-sensor ignorou o probe e rodou o fluxo real"** (armadilha 1 abaixo). Um deploy correto lido como deploy ausente, e o desfecho seguinte é redeployar uma edge money-path à toa. O `id` de `net._http_response` **é** o `request_id` devolvido pelo `net.http_post` — filtrar por ele é determinístico e não custa nada. Sem o número em mãos, o desempate possível é `WHERE content::jsonb->>'edge' = '<nome-da-edge>'` (o campo nasceu para isso), mas ele **degrada para zero linhas** justamente no caso que mais importa — bundle velho não emite `edge` —, e zero linhas é indistinguível de "a resposta ainda não chegou": aí confirme com `SELECT max(id) FROM net._http_response` antes de concluir.

⚠️ **Número de EXEMPLO no `WHERE id =` erra CALADO — é PIOR que o placeholder.** Variante da anterior, mordida 2026-08-23/24 na MESMA verificação, e é a Lei de Ferro #5 (`zero placeholders`) pelo avesso: o `<VALOR>` não substituído falha **ruidoso** — `<nome-da-edge>` deixado na URL rendeu dois `404 {"code":"NOT_FOUND"}` do **gateway** (ids 58965/58966): 2 chamadas perdidas e **zero veredito falso**. Já a "correção" que trocou o marcador por um id PLAUSÍVEL (`WHERE id = 58967`) não falhou — devolveu uma linha REAL de outro emissor. O probe era o **58977** (`{"ok":true,"probe":true,"versao":"v1.0-prompt-invertido-cacheado","edge":"analyze-unified-order"}`, verde); o 58967 era o tick do watchdog de 01:20:00Z, e `{"modo":"watchdog","conciliacao":0,"duracao_ms":193}` projeta `edge NULL, status_code 200, versao NULL` — **byte a byte** a assinatura de bundle pré-sensor. Deploy CORRETO lido como ausente, mesmo desfecho da ⚠️ acima (redeployar edge money-path à toa), e **nada na saída denuncia** que se leu o alvo errado. Não é azar: medido nesta tabela em 2026-08-24, **198 respostas em 355 min — uma nova a cada ~1,8 min, e ZERO delas emitindo `edge`** ⇒ id vizinho é tick alheio por padrão. **Regra: em receita de verificação, o campo que o founder substitui NUNCA carrega valor de EXEMPLO** — deixe-o sintaticamente inválido de propósito (`COLE_AQUI_O_REQUEST_ID` devolve `ERROR: column "cole_aqui_o_request_id" does not exist`, que ecoa a própria instrução), ou leia pelo `edge` do corpo com o guard de zero-linhas acima. Vale para TODA receita, não só esta: `id`, timestamp, ref de projeto, nº de PR. ⚠️ **"Inválido" é a regra do bloco que só LÊ** — no bloco que DISPARA (lote, abaixo) o placeholder é VÁLIDO e a trava real vai no `CASE`: lá o inválido aborta o batch inteiro por rollback, o que protege por ACIDENTE e mata a leitura junto. O eixo não é a sintaxe, é o que o campo errado CUSTA: numa leitura, ler a linha de outro emissor; num disparo, executar o efeito.

⚠️ **Edge NOVA nasce fora do radar, e nenhum gate de sonda reclama.** O universo de `sonda:bump` e
`sonda:fingerprint` são as edges **instrumentadas**, e o denominador de `pendencias:deploy` sai do
**mapa commitado** — quem nunca entrou na lista não reprova, some. A `analytics-outbox-drain` (#2035)
passou assim e o deploy dela só se provou por arqueologia (N1 + uma string de erro que estava no corpo
por acaso). Ao criar edge com cron próprio, a régua barata é conferir se ela **aparece** em
`bun run pendencias:deploy`; e se ela é chamada por `net.http_post`, ecoe `versao`/`edge`/`fonte` em
TODA resposta — o corpo já cai em `net._http_response`, e o N3 passivo sai de graça. →
`docs/historico/verificar-sonda-versao.md` §14

#### Sondar VÁRIAS edges numa tacada (leva inteira) — e as 3 armadilhas do SQL Editor

Uma leva tem 5–10 edges, e repetir o par disparo/leitura por edge convida ao erro de trocar o `request_id`
entre uma e outra. O padrão é disparar todas com `net.http_post` sobre um `VALUES` de nomes e agregar com
`jsonb_object_agg(edge, request_id)::text` numa **célula única**. Medido 2026-08-24 sondando a oitava leva (#1937).

⚠️ **A leitura NÃO pede mais o `request_id` colado — ela acha a linha pelo ECO do slug.** A resposta da
sonda carrega o próprio nome no corpo (`criarRespostaSonda` devolve `{ok, probe, versao, edge, fonte}`),
então o passo de leitura procura, dentro de uma janela curta, a resposta que diz ser daquela edge. A
colagem à mão era um passo que simplesmente **não acontece**: em 2026-08-30, verificando
`generate-bundle-argument`, o disparo tinha funcionado (4 respostas HTTP 200 em `net._http_response`) e o
veredito saiu `SEM ID — esta edge não saiu no JSON colado (bloco errado, ou trava fechada)`. Honesto, e
ainda assim um round-trip inteiro com o founder por um deploy que já estava no ar. O `jsonb_each_text('{}')`
sobrevive **opcional**, e só para o que o eco não alcança (ver os dois guards abaixo).

⚠️ **O casamento exige `probe = 'true'`, não só o slug — senão ele lê a linha do CRON.** Medido em prod
2026-08-30: a `analytics-outbox-drain` gravou **72** respostas em 6h com `{"edge":…,"versao":…}` e **sem**
`probe` (é o cron dela, de 5 em 5 minutos), contra 5 respostas de sonda. Casando só pelo slug, o `LIMIT 1`
escolhe a linha do cron, cujo `probe` é nulo, e o veredito cai no `ELSE`: **"BUNDLE VELHO" citando a versão
CERTA** — falso NEGATIVO fabricado a partir da linha de outra execução, e o desfecho é redeployar à toa.
Provado com as duas consultas lado a lado: `só-slug` devolveu a resposta 64047 (`probe` ausente),
`slug+probe` devolveu zero. E o `ORDER BY` precisa do desempate por `id`: em prod as respostas 64031 e
64032 têm `created` **idêntico ao microssegundo**, então `ORDER BY created DESC` sozinho deixa a escolha
para o plano, não para o dado.

⚠️ **Janela curta é obrigatória, e ausência de linha é `INDETERMINADO` — nunca "bundle velho".** Sem a
janela, uma sondagem ANTIGA da mesma edge (o `pg_net.ttl` guarda 6h) seria lida como veredito de AGORA —
o guard do #2079. Padrão 20 min, teto 120 (`--janela=<min>`); querer a janela inteira do TTL é querer a
irmã PASSIVA, `bun run pendencias:deploy`, que já trata "não observada" como ausência de dado. E o que o
eco **não** alcança: bundle PRÉ-SENSOR (HTTP 200 rodando o fluxo real) e recusa HTTP (>=400) respondem
**sem** eco do slug, então caem em `INDETERMINADO` junto com "não disparou" e "ainda não chegou". O ramo
nomeia as três causas em vez de escolher uma — contar as respostas sem eco na janela **não** as separa,
porque a janela é cheia de cron alheio. Quem separa é o `request_id` do disparo, e é só para isso que a
colagem continua existindo.

**A divisão de trabalho que sai daí — o founder dispara, o agente lê.** Só o disparo precisa dele: lê
`vault.decrypted_secrets` e faz INSERT via `net.http_post`, e o wrapper read-only recusa os dois
(`permission denied for schema vault`, `cannot execute INSERT in a read-only transaction` — provado
2026-08-30). A leitura é `SELECT` em `net._http_response`, que o `psql-ro` serve. Os recortes são flags,
e a numeração dos passos é **absoluta** nos dois lados, para founder e agente nomearem a mesma coisa:

```bash
bun run sonda:sql --so-disparo <edge>…                        # cole ISTO no SQL Editor do Lovable
bun run sonda:sql --so-leitura <edge>… | ~/.config/afiacao/psql-ro   # e leia o veredito você mesmo
```

**Não digite esse SQL: gere-o.** `bun run sonda:sql <edge>… [--caro=<edge>,…]` lê o `VERSAO` de cada
`supabase/functions/<edge>/versao.ts` **e o fingerprint de `_shared/sonda-fingerprints.ts`**, e emite
os quatro blocos prontos (disparo + leitura das baratas; disparo travado + leitura das caras). A
lista `esperado(edge, versao_esperada, fonte_esperada)` transcrita na unha é o buraco que ele fecha:
**marcador digitado errado produz veredito FALSO** — "BUNDLE VELHO" numa edge que está no ar (e o
desfecho é redeployar edge de money-path à toa), ou o inverso. Edge sem `versao.ts` **ou fora do
mapa de fingerprints** derruba a geração inteira (nada de SQL parcial em silêncio), e `--caro` que
não casa um nome da leva também — o typo deixaria a edge cara no bloco SEM trava.

**QUEM entra no `--caro` é MEDIDO, não presumido — o critério é o EFEITO, não a FORMA do handler.**
Regra curta: edge que **não escreve nem chama serviço externo** no fluxo real é BARATA, e o pior
caso de sondá-la com bundle pré-sensor é computar e devolver. O proxy "a edge despacha por
`body.action`?" está **REPROVADO** — marcou `fin-valor-cockpit`, que não escreve nada, como cara
(`ausente ≠ zero` aplicado à forma do handler: o `default:` que recusa prova que AQUELE caminho é
inócuo, a ausência de dispatch não prova o contrário). O `grep` de triagem, as duas armadilhas que
invertem a leitura (`fetch(` de GET de auth não é efeito; `.delete(` casa com `Set.delete` do JS) e
o eixo reversibilidade/alcance ficam na **escada de edge** da skill `lovable-deploy-verify` —
**cópia única de propósito**, porque só lá o critério é EXECUTADO pelo gate, que extrai o grep da
própria skill e o roda contra as edges-exemplo
(`.claude/skills/lovable-deploy-verify/evals/criterio-caro-eval.sh`).

⚠️ **O veredito julga o `fonte`, não só o `versao` — e o ramo `DEPLOY PARCIAL` vem ANTES do de
confirmação.** O `versao` sai do `versao.ts` da PRÓPRIA edge: um deploy que suba `index.ts` +
`versao.ts` e deixe `_shared/sonda-fingerprints.ts` para trás (o risco do Passo 3 da skill
`lovable-deploy-verify` — prompt que nomeia poucos arquivos) responde `versao` **certo** e
`fonte: "nao-mapeada"`. Julgando só pelo `versao`, isso saía como **'DEPLOY CONFIRMADO'**: falso
POSITIVO num money-path, a classe estritamente pior, porque **encerra** a verificação. Confirmação
exige os dois campos batendo; `fonte` ausente é ramo próprio, e a dúvida cai sempre no lado que
manda olhar de novo. Testes: `scripts/sonda-versao-sql.test.ts` (as falsificações GÊMEAS sabotam o
`versao.ts` e a entrada do mapa, e exigem que o valor velho suma do SQL) +
`scripts/mutcheck.d/sonda-versao-sql.mut`, que no CI prova que a suíte **pega** a trava trocada por
`WHERE`, o `LEFT JOIN` virado `JOIN`, o marcador/fingerprint hardcoded, o ramo `DEPLOY PARCIAL`
neutralizado, o `AND fonte = fonte_esperada` dispensado do `DEPLOY CONFIRMADO` — e, desde a leitura sem
colagem, o casamento sem `probe:true`, a janela alargada, o teto da janela removido, o `LIMIT 1` sem
desempate e o `INDETERMINADO` trocado por veredito negativo.

⚠️ **HTTP 401 é o ÚNICO 4xx ambíguo — tem ramo próprio, e o veredito determinado exige um controle
de CREDENCIAL cruzado na mesma consulta.** Um 404 diz "não há edge servida nessa URL"; um 401 tem
DUAS causas que o dado **não separa**: (a) bundle **pré-sonda** que ignorou o `{"probe":true}`, caiu
no gate JWT e recusou, ou (b) **`CRON_SECRET` ausente/errado no vault**, com `authorizeCronOrStaff`
recusando o header. Nos dois casos `versao` vem NULL e o status é 401. O ramo antigo (`versao IS NULL
AND status_code >= 400 → 'BUNDLE VELHO … NADA executou'`) lia os dois como (a): **falso negativo
confiante**, cujo desfecho é redeployar edge que já está no ar — `ausente ≠ zero` na dimensão
CREDENCIAL, irmão exato do guard temporal do #2079 (`verify-edge-eco.sh`), onde tick pré-merge lido
como pendência produzia o mesmo erro. Agora o bloco carrega o CTE `controle_credencial`: conta, em
`net._http_response` e **excluindo a própria leva** (`NOT EXISTS`, porque `NOT IN` seria NULL-blind
com a trava fechada), as respostas recentes de 6h — **≥10 2xx e ZERO 401** provam que o secret do
vault está sendo aceito AGORA, e só então o 401 vira `'BUNDLE VELHO (pre-sonda)'`. Sem essa prova o
veredito é **`INDETERMINADO`**, nunca "bundle velho": fail-CLOSED, como o
`CONTROLE_CRUZADO_NAO_OBSERVADO` do `verify-edge-escrita.sh`. O piso não é `> 0` por **denominador**:
com 1–2 respostas, "nenhum 401" não distingue secret bom de ninguém-bateu-na-porta. Nasceu de o
desempate ter sido feito **à mão, fora da ferramenta**, ao verificar `generate-bundle-argument`
(#2101) — ferramenta que depende de o operador lembrar é a armadilha da sentinela não-exclusiva.
Provado **EXECUTANDO** em `.claude/skills/lovable-deploy-verify/evals/sonda-veredito-401-eval.sh`
(Postgres efêmero, 8 cenários + 6 sabotagens): casar string ficaria verde justamente quando a ordem
dos `WHEN` está errada, e `NULL > 0` não é falso — é NULL.

⚠️ **O que esse controle NÃO fecha — e está escrito no próprio SQL:** ele é **populacional**, conclui
"o secret está sendo aceito" a partir de tráfego que passou. Se o `CRON_SECRET` foi trocado **há
poucos minutos** e **nenhum cron rodou desde a troca**, os 2xx da janela foram feitos com o secret
ANTIGO e o controle avaliza indevidamente. O ramo **estreita** muito o erro (antes ele era
incondicional), não o elimina; na próxima execução dos crons a recusa vira 401 e o controle se
desqualifica sozinho. Regra prática: **se você acabou de mexer no vault, leia o veredito determinado
como INDETERMINADO.**

- ⚠️ **A trava do bloco perigoso tem de ser `CASE`, NÃO `WHERE`.** Quando parte da leva só pode ser sondada
  DEPOIS do deploy confirmado (bundle pré-sensor ignora o `probe` e dispara o run), a tentação é
  `... FROM alvos, guard WHERE guard.confirmei = 'sim'`. **Isso não protege**: o Postgres avalia a projeção
  independentemente do filtro, e o `http_post` sai do mesmo jeito. Falsificado nos dois sentidos com
  `1/(length(edge)-1)` no lugar do post: sob `WHERE` explode com a trava FECHADA (avaliou), sob
  `CASE WHEN guard.confirmei = 'sim' THEN net.http_post(…) END` só explode com ela ABERTA. Guard por `WHERE`
  aqui é teatro — a classe "sonda de script destrutivo é fail-CLOSED" aplicada ao SQL. ⚠️ E o `WHERE`
  é dependente de PLANO: na forma SIMPLES (projeção sem agregação) ele filtra antes e parece proteger —
  quem testar a trava assim lê "seguro" e leva para produção o bloco agregado, que é onde ela falha
  (4 formas medidas em `docs/historico/deploy-no-op-por-desenho.md`).
- ⚠️ **A leitura tem de partir da lista canônica de edges, não dos ids.** Com `FROM ids JOIN esperado`, colar
  o JSON do bloco errado devolve **zero linhas** — e zero linhas lê-se como "nada a reportar", não como erro.
  Inverta (`FROM esperado LEFT JOIN ids`) e dê um ramo próprio ao id ausente: toda edge esperada aparece
  SEMPRE, e a sem id se acusa. Mesmo motivo do `LEFT JOIN` contra `net._http_response`: sem ele, "a resposta
  ainda não chegou" e "veredito negativo" ficam indistinguíveis.
- ⚠️ **Placeholder que quebra o batch não é proteção — é sorte.** Um `'<COLE_AQUI>'::jsonb` literal aborta com
  `22P02 invalid input syntax for type json`, e o SQL Editor faz **rollback do batch inteiro**; como o `pg_net`
  só envia após o COMMIT, nada é disparado (confirmado ao vivo em 2026-08-24: `http_request_queue` vazia e
  zero respostas de sonda, com a tabela viva e recebendo cron). Foi o erro que salvou a viagem — mas depender
  disso é depender de o founder colar o arquivo INTEIRO e de o Editor abortar no ponto certo. Use um
  placeholder VÁLIDO (`'{}'::jsonb`, que cai no ramo "sem id") e ponha a trava real no `CASE` acima.
- **Distinga rejeição de execução no veredito.** `status_code >= 400` sem `versao` é bundle velho que
  **recusou** o request (401 do gate de JWT na `ai-ops-agent`, 400 do `default` na `sync-reprocess`) —
  nada executou. Só `200` sem `versao` é "ignorou o `probe` e RODOU o fluxo real". Um veredito que junta os
  dois manda investigar efeito colateral que não houve.
- **`net._http_response` retém ~6h** (medido 2026-08-24: 195 linhas, 04:10→10:05 UTC). Sonde e leia na mesma
  sessão; expirada a linha, o `LEFT JOIN` devolve "aguarde" para sempre e a ambiguidade volta.

Verde = `status_code 200` **E** `canary true` **E** `contrato` batendo com a tabela acima **E** `ok true` **E** `casos_vermelhos NULL` (os cinco, não só o `ok`). `400` com `"Ação desconhecida"` = **bundle velho**, a probe não subiu — e a lista `acoes_disponiveis` da resposta é a confirmação (não cita a action nova). ⚠️ Probe é **dry-run**: se um dia uma delas abrir linha em `fin_sync_log`, ela fabrica frescor — `_data_health_compute` e `fin_calcular_confiabilidade` leem essa tabela **sem filtrar `action`** (só o `fin_sync_heartbeat` filtra). No `omie-financeiro` isso é o `PROBE_ACTIONS` → `logId=""`, pinado no `edge-money-path-invariants`.

#### O CUSTO da sonda, edge a edge — a triagem que decide `--caro` (2026-09-04)

O `sonda:sql` aceita `--caro=<edge>,…` e o doc só registrava **uma** decisão ("das 7 daquela leva, só
a `sync-reprocess` é barata"). Quem chega depois refaz a leitura de cabo a rabo, ou — pior — chuta
pelo nome. Triadas as **25 edges mapeadas que não responderam** numa janela de `pg_net.ttl`, lendo o
`index.ts` de cada uma: **5 baratas, 20 caras**.

A pergunta da triagem é sempre a mesma: *se o bloco de sonda não existisse, o que este handler faria
com um body `{"probe": true}`* — ou seja, sem `action` e sem os demais campos?

**Baratas — o bundle velho recusa antes de qualquer efeito:**

| edge | o que barra |
|---|---|
| `conciliar-pedido-portal` | 400 `pedido_id inválido` (`Number(undefined)` não é inteiro) |
| `analyze-unified-order` | 401 do gate `Bearer` antigo; passando, 400 por falta de `text`/imagem antes da Anthropic |
| `omie-nfe-recebimento` | 401 do gate staff (JWT) |
| `omie-nfe-webhook` | 401 do gate `x-webhook-secret` |
| `process-nfe` | 401 (`Bearer` + `getUser`); `nf_number` obrigatório barraria em seguida |

⚠️ **Quatro das cinco recusam com 401 — que é o único 4xx ambíguo** (bundle pré-sonda *ou*
`CRON_SECRET` errado). O bloco gerado já cruza o `controle_credencial` e responde `INDETERMINADO`;
só a `conciliar-pedido-portal` devolve um 400 inequívoco. "Barata" aqui quer dizer **segura de
disparar**, não **conclusiva**.

✅ E as cinco **são sondáveis**: o gate que protege a sonda é `authorizeCronOrStaff`, que aceita
`x-cron-secret`. Em `omie-nfe-recebimento` e `omie-nfe-webhook` isso é DELIBERADO — a sonda tem gate
**próprio**, porque atrás do gate da edge (JWT staff / webhook-secret, que o Omie e o SQL Editor não
emitem) ela seria inalcançável por quem precisa dela.

**Caras (20) — não sonde:** `algorithm-a-audit`, `calculate-scores`, `carteira-positivacao-snapshot`,
`carteira-rebuild`, `disparar-pedidos-aprovados`, `gerar-pedidos-diario`, `monthly-report`,
`omie-nfe-reconcile`, `omie-sync-ctes-recebidos`, `omie-sync-nfes-recebidas`,
`omie-sync-pedidos-compra`, `omie-sync-sku-items`, `omie-sync-status-produtos`,
`omie-sync-vendas-items`, `pedido-programado-enviar`, `reposicao-depara-sayerlack-auto`,
`sayerlack-captura-precos`, `scoring-recalc-batch`, `tactical-plans-batch`, `visit-score-recalc-batch`.

🔴 **O padrão que faz uma edge ser cara quase nunca é `switch(action)` sem `default` — é o DEFAULT
que transforma "sem parâmetro" em ação real.** `body.empresa ?? "OBEN"`, `?? "ALL"`, `dias = 30`,
`resolverEmpresas(null) → ["OBEN"]`: o corpo `{"probe":true}` não tem nenhum campo, e é exatamente
por isso que o caminho padrão dispara inteiro. Os dois piores: `monthly-report`, onde
`send_email !== false` é **true** por omissão e `user_id` ausente significa **todos** (a sonda
manda e-mail de verdade para a base); e `pedido-programado-enviar`, onde a falta de `envio_id` cai
no ramo cron e processa **todos os envios agendados do dia**. Ao triar, procure `??`, `||` e default
de destructuring ANTES de procurar o `default:` do switch.

**12ª leva, triada na mesma régua (2026-09-05).** A triagem de cada uma fica no cabeçalho do
`versao.ts` dela, junto do `EFEITO` — este é o resumo para escolher o `--caro`:

| edge | bundle PRÉ-sensor com `{"probe":true}` | veredito |
|---|---|---|
| `omie-sync` | sem `action`, o `switch` cai no `default:` 400 `Ação não reconhecida` | barata, **inequívoca** |
| `omie-malha-sync` | `action` ausente vira o `"probe"` DELA: `ListarEstruturas` p.1, 2 registros, read-only | barata, inequívoca |
| `omie-aplicar-parametros` | `ids` vazio → 400 `ids vazio`, antes dos secrets e de toda escrita | barata, inequívoca |
| `omie-webhook` | gate `x-webhook-secret` → 401 | barata, **ambígua** (cruze `controle_credencial`) |
| `omie-nfe-recebimento-sync` | **não lê o corpo** — cai direto no laço de sync de todas as credenciais | **CARA** |
| `omie-sync-metadados` | sem `accounts`, o default é as DUAS contas → sync inteiro + carimbo em `sync_state` | **CARA** |

Confirma o padrão do bloco vermelho acima: as duas caras não têm `switch` sem `default` — uma **não
lê o corpo NENHUM** e a outra tem `?? ["vendas","colacor_vendas"]`. Procure o default ANTES do switch.

⚠️ **A triagem lê o `index.ts` ATUAL descontando o bloco de sonda — é uma APROXIMAÇÃO do bundle
velho, não o bundle velho.** Para rigor, confirme o guard no pai
(`git show <sha-da-sonda>^:supabase/functions/<edge>/index.ts`); foi feito só na `process-nfe`. O
erro possível é conservador nas que dependem de gate (um 401 a mais), mas não é nulo: guard que
NASCEU com a fatia da sonda faria uma "barata" ser cara no bundle que está no ar.

### Assinatura no PRÓPRIO log da edge — N3 retroativo, sem canária e sem sonda

Terceiro caminho, e o mais barato quando existe: **a edge que ESCREVE numa tabela já carrega a
prova do que ela é**. Se o defeito corrigido deixava rastro nos dados que a edge grava, a versão
se prova por SQL — sem canária, sem sonda, sem `?canary=1`, sem o founder chamar nada, e
**retroativamente** (serve para deploy que já aconteceu, inclusive um que ninguém verificou na
hora). Diferença para as duas outras: canária e sonda exigem CÓDIGO na edge, escrito ANTES do
deploy; esta não exige nada — só que o defeito tenha uma testemunha na tabela de saída.

**Como achar a assinatura.** Pergunte: *que valor o código VELHO gravava e o NOVO não pode
gravar?* Não serve um valor que os dois possam produzir. Tem de ser um estado que a correção
torna IMPOSSÍVEL.

**Caso que a fundou (`recommend`, 2026-08-21, PR #1836).** As seis leituras não paginavam, então
o custo de ~73% dos candidatos ficava fora da página do PostgREST e a edge gravava
`recommendation_log.cost_source = 'UNKNOWN'`. Depois da paginação, produto **que tem custo
cadastrado** não pode mais sair UNKNOWN. Duas queries fecharam:

```sql
-- (1) O defeito, medido no PRODUTO: o custo existia e a edge não via.
SELECT count(*) FILTER (WHERE rl.cost_source='UNKNOWN')                            AS unknown,
       count(*) FILTER (WHERE rl.cost_source='UNKNOWN' AND pc.product_id IS NOT NULL) AS unknown_mas_tem_custo
FROM recommendation_log rl LEFT JOIN product_costs pc ON pc.product_id = rl.product_id
WHERE rl.event_type='impression';        -- 283 UNKNOWN, dos quais 279 (98,6%) TINHAM custo

-- (2) A linha de base POR CHAMADA, que é o que dá poder estatístico ao veredito.
SELECT date_trunc('minute',created_at) chamada, count(*) n,
       count(*) FILTER (WHERE cost_source='UNKNOWN') unk
FROM recommendation_log WHERE event_type='impression' GROUP BY 1 ORDER BY 1 DESC LIMIT 10;
-- 9 chamadas históricas: 60–100% UNKNOWN · 1ª chamada pós-deploy: 0 de 5
```

⚠️ **A linha de base é obrigatória, e é POR CHAMADA.** "0 de 5 UNKNOWN" não significa nada sozinho
— é a regra do denominador de novo. Contra uma base de 60–100%, um 0/5 seria sorte de ~1% no
melhor caso e ~0,001% no típico; contra uma base de 10%, não provaria coisa alguma. Agrupe por
chamada (as impressões de uma mesma chamada **não são independentes** — mesmo catálogo, mesmo
cliente, mesma página truncada), e diga o tamanho da amostra no veredito.

⚠️ **Descarte o confundidor antes de concluir.** "Caiu o UNKNOWN" também aconteceria se alguém
tivesse feito backfill de `product_costs`. Foi a query (1) que eliminou isso: os UNKNOWN antigos
**já tinham** custo no banco — o dado existia, a edge é que não alcançava.

### Assinatura de GATE — quando a sonda EXISTE mas está FECHADA para você

Quarto caminho, e o que resolve o impasse que a própria sonda criou: desde o #1877 ela exige
credencial (`authorizeCronOrStaff`), então quem não tem JWT de staff **não consegue mais ler a
versão** — o agente inclusive, que só tem `claude_ro` no banco e nenhuma credencial de edge. Mas
**um gate que RECUSA também informa**: cada gate erra com a sua própria string, então a mensagem de
recusa é uma assinatura de versão. Não precisa de credencial, nem de canária, e serve retroativo.

**Como achar a assinatura.** Uma string de erro que a versão NOVA emite e a VELHA **não podia**
emitir. Status HTTP não serve (401 é 401 nas duas) — tem de ser o CORPO.

**Caso que a fundou (`recommend`, 2026-08-22, #1876 + #1877).** Quatro chamadas, zero credencial:

| chamada | HTTP | corpo | quem respondeu |
|---|---|---|---|
| edge **inexistente** | 404 | `{"code":"NOT_FOUND"}` | **gateway** — prova que ele não valida JWT |
| `recommend`, **sem** `Authorization` | 401 | `{"error":"Não autorizado"}` | gate do handler (pt-BR) |
| `recommend`, `{}` + `Bearer x` | 401 | `{"error":"Token inválido"}` | gate do handler (pt-BR) |
| `recommend`, `{"probe":true}` + `Bearer x` | 401 | `{"error":"Unauthorized"}` | `authorizeCronOrStaff` (en) |

A quarta decide — mas **só depois de três descartes**:

1. **o gateway não é a origem**: a chamada à edge inexistente voltou 404, logo ele roteia sem
   validar JWT (se voltasse 401, nada abaixo valeria — a edge nem teria rodado);
2. **a edge está executando**: as outras duas respostas são em português, dos gates internos dela;
3. **a versão velha não podia emitir aquilo**: no bundle anterior `{"probe":true}` retornava
   **200 + versão incondicionalmente**, e a string `"Unauthorized"` não existe em `index.ts` nenhum
   (velho nem novo) — só pode vir de `_shared/auth.ts`, chamado no caminho da sonda **apenas a
   partir do #1877**.

⚠️ **Sem os três descartes isto é adivinhação.** Um 401 sozinho é compatível com "gateway barrou",
"edge não existe" e "gate velho barrou". A conclusão vem do CONJUNTO de respostas DISTINTAS, não de
uma. E confira a string velha com `git show <commit-velho>:<arquivo>`, nunca de memória — o ponto
inteiro é provar que a versão anterior era incapaz daquela saída.

⚠️ **Isto prova o BUNDLE, não o seu arquivo.** "Meu PR está no ar" é conclusão TRANSITIVA: o commit
cuja assinatura você viu precisa ter o seu como ancestral **e** carregar o seu símbolo. Confirme os
dois (`git merge-base --is-ancestor` e `git show <commit>:<arquivo>`), e confirme que ninguém tocou
o arquivo entre eles — a reversão do Lovable (seção abaixo) é exatamente esse risco.

⚠️ **A assinatura é POR VERSÃO — e é isso que a torna útil.** Horas depois da medição acima, o
#1882 moveu a sonda para ANTES do gate de `Bearer ` do handler, e a MESMA chamada (`{"probe":true}`
**sem** `Authorization`) passou de `{"error":"Não autorizado"}` (v1.3) para `{"error":"Unauthorized"}`
(v1.4). Foi exatamente assim que o deploy do #1882 se provou: **a técnica flagrou a troca de versão
ao vivo**, sem credencial e sem ninguém avisar. A consequência prática, porém, é que a tabela acima
descreve o `v1.3` e não uma constante do sistema — levante a SUA assinatura com
`git show <commit>:<arquivo>` a cada uso, nunca copie a tabela.

**A PROMOÇÃO: com marcador EXPLÍCITO no corpo do erro, os três descartes caem (2026-08-28, #2063).**
A tabela acima infere a versão de uma string **acidental** — daí exigir os três descartes e
envelhecer a cada fatia. O #2063 fez o oposto por desenho: o helper `jsonRes` anexa `versao: VERSAO`
a **TODA** resposta das suas 4 edges, o 401 do gate inclusive. A leitura vira direta, sem credencial:

```console
$ curl -s -X POST -d '{"probe":true}' .../functions/v1/omie-sync-pedidos-compra
{"error":"Unauthorized","versao":"v1.0-eco-versao-passivo"}          # HTTP 401
```

O descarte (3) — "a versão velha não podia emitir isto" — se responde sozinho: o campo **nomeia** a
versão em vez de deixá-la inferir, e não existia no bundle anterior (`versao.ts` é arquivo NOVO na
fatia). O (1), do gateway, continua valendo e é barato: confira `verify_jwt = false` no
`config.toml` ANTES, senão o 401 é do gateway e o corpo não é seu.

**Custo ZERO de efeito — é o que a torna preferível à sonda `{"probe":true}` aqui.** O gate recusa
antes de qualquer I/O (`if (!authHeader?.startsWith("Bearer ")) return false;`), então não há
varredura no Omie nem escrita. Sondar um bundle PRÉ-sensor faria o oposto: sem roteamento por
`action`, o corpo cai nos defaults e roda o sync inteiro (o aviso que cada `versao.ts` dos 4 traz).

**Controle negativo de graça:** edge irmã SEM `versao.ts` (`omie-cron-diario`,
`omie-sonda-recebimento`) responde `{"error":"Unauthorized"}` **sem** o campo — mesma linha de gate,
mesma forma de corpo, mesmo 401. É o que prova que o marcador vem do nosso código, não da
plataforma; sem esse par, "achei o campo" não discrimina.

⚠️ **É o SOCORRO do eco passivo quando a linha do cron é INUTILIZÁVEL** (o `modo:"background"` da
§anterior): em 2026-08-28 02:15Z, no MESMO tick, três steps trouxeram o marcador e `pedidos` veio
com `versao` vazio. O 401 resolveu na hora — e mede AGORA, não no último tick.

⚠️ **PRÉ-CONDIÇÃO que a via exige: o gate tem de ser INLINE na edge.** Medido no fecho de
2026-08-29, e o modo de falha é o falso negativo caro. Nas 4 edges do #2063 o
`authorizeCronOrStaff` é inline e a recusa passa pelo `jsonRes`, então o 401 carrega o marcador.
Quando o gate vem de `_shared/auth.ts`, **não passa**: a edge faz `if (!auth.ok) return
auth.response;` e a `Response` já vem pronta de lá (`function unauthorized(message =
"Unauthorized")`), **por fora** do helper. O 401 dessa edge nunca carrega marcador — nem no bundle
NOVO. Ler a ausência como "bundle velho" ⇒ pedir deploy de edge money-path **já no ar**.

O caso: `analytics-outbox-drain` (#2094) respondeu `{"error":"Unauthorized"}` **sem** o campo, e o
`jsonRes` dela na main anexa `versao`/`edge`/`fonte` — leitura que gritaria "não deployou". O eco
PASSIVO desmentiu na mesma janela: o cron de 5 min (jobid 181) grava `versao:"v1.0-sensor-inicial"`
+ `edge:"analytics-outbox-drain"` em `net._http_response`, 4 ticks seguidos, status 200. **No ar.**

⇒ **Antes de usar a via, confirme onde nasce o 401** (`grep -n 'Unauthorized' index.ts` — achou nada
e o import é `_shared/auth.ts`? a via não discrimina AQUI). E o inverso do socorro vale: onde o 401
é cego, quem enxerga é o eco passivo. As duas vias se cobrem em direções opostas — nenhuma sozinha
cobre o parque.

## Quando o Lovable reverte um fix — detectar e restaurar

O bot `gpt-engineer-app[bot]` commita direto na `main` SEM CI ("Changes"/"Deployed"/"Deployou edge") e às vezes reverte um PR (~16% dos commits; ≥4-5 reversões money-path recentes). Prevenção é inviável (o bot precisa de escrita direta) → o jogo é **detectar + restaurar rápido** (MTTR), não governança perfeita. Spec: `docs/superpowers/specs/2026-06-26-lovable-revert-mitigation-design.md`.

- **Sinais automáticos (CI desta frente, `.github/workflows/`):** Issue **`ci-main-red`** = a `main` quebrou build/typecheck/test (antes passava silencioso — ninguém alertado); Issue **`lovable-touched-sensitive`** = o bot tocou path money-path/edge **mesmo com CI verde** (regressão compilável — a classe do #1076/#1077); Issue **`lovable-reverted-merge`** = **reversão PROVADA por linha** — o commit direto removeu linhas que um merge das últimas 48h tinha adicionado; acusa QUAL PR foi desfeito + comando de restauração (`scripts/lovable-revert-scan.sh`, testável local: `test-lovable-revert-scan.sh`; filtra comentário puro e linha trivial — o bot apaga aviso sem reverter gate). Todas assinadas pro founder.
- **Guardrails como rede (testes-invariantes):** `src/lib/reposicao/__tests__/edges-onorder-guardrail.test.ts` (janela on-order #1072/#1076) e `src/__tests__/edge-money-path-invariants.test.ts` (analyze: helper espelhado + paridade edge×src + gate de fallback `!(… in priceMap)` + canária #1077/#1080/#1089; e margem do `algorithm-a-audit`) **quebram o CI** se a regressão volta ao REPO. Em refactor legítimo, **reescrever o teste junto** — não deletar.
- **Restauração rápida** (o que destravou #1076/#1085): `git checkout <sha-da-correção> -- <arquivo>` → abrir **PR** (auto-merge no verde). **Nunca** restaurar direto na `main` (vira guerra de commits com o bot).
- ⚠️ **O `lovable-watch` só enxerga o ÚLTIMO commit do push — reversão no PENÚLTIMO passa em silêncio (2026-07-23).** O workflow roda `git diff HEAD^ HEAD`, e o bot empurra em LOTE (`Changes` + `Deployed …` no mesmo push): o GitHub dispara UM run, no HEAD, e o commit intermediário nem tem run próprio. Medido: `018e8abc` ("Changes") removeu de novo as 3 linhas da RPC `farmer_association_rules_substituir` do `types.ts`; o run rodou em `54691cc5` (HEAD), cujo diff contra o pai **já não continha a remoção** → nenhuma issue aberta, `conclusion: success`. Na rodada anterior o gate acusou (issue #1583) só porque a reversão calhou de estar no HEAD do push. ⇒ **o gate cobre ~metade dos casos**; até ser corrigido (varrer `github.event.before..HEAD`, não `HEAD^..HEAD`), o **ritual manual abaixo continua obrigatório** — `git fetch` + conferir o diff de TODOS os commits do bot desde o último merge, não só o último. Corolário da causa-raiz: o bot regenera `types.ts` **a partir do BANCO**, então toda migration entregue e NÃO aplicada vira uma bomba-relógio — o próximo deploy de edge remove a RPC do types e quebra o build do Publish (loop observado 2×; some sozinho quando a migration é aplicada).
- **Ritual pós-Lovable:** após qualquer Publish/chat-edit, além da verificação de deploy de edge (acima), `git fetch origin main` e cheque o commit do bot — tocou money-path sem intenção → restaure na hora. Para o **edge de preço** (`analyze-unified-order`), confirme o COMPORTAMENTO deployado pela **canária**: Governança → Auditoria — o card "Canária de preço" **roda sozinho ao abrir** (botão "Verificar de novo" para re-checar). Verde = praticado 123 vence Omie 999 **E** o contrato bate (`praticado-vence-omie-v1`); vermelho/erro = edge revertida → restaure. ⚠️ Esta é a única das 6 canárias que **não** sai pelo SQL Editor: ela é gated por **JWT de staff** (não aceita `x-cron-secret`), então a leitura é a TELA — o card imprime o `detalhe`, que nomeia o contrato recebido vs o esperado quando a fatia diverge. É a única prova do que está SERVIDO em prod (o invariante do CI só prova o repo). Evite editar pelo Lovable arquivos mantidos via PR.

## Verificação de deploy

- A skill **`lovable-deploy-verify`** confere se o bundle servido bate com o esperado (bytes/comportamento). Use após Publish/deploy — não confiar cegamente no "deployed" do Lovable. **N2 de edge (prova de versão) é automático quando `~/.config/afiacao/supabase-pat` existe** (Access Token do Supabase, `chmod 600`, padrão psql-ro): `verify-edge.sh` resolve env `SUPABASE_PAT` > arquivo e consulta a Management API; sem o arquivo, cada verificação de versão vira handoff manual na UI (custou 3 retomadas de sessão p/ confirmar 1 deploy). Teste: `scripts/test-verify-edge-pat.sh`. A varredura por bytes é **paralela** (`xargs -P`, halt-on-hit) — o bundle passou de 300 chunks e o modo 1-a-1 estourava o timeout.
  - ⚠️ **NÃO PEÇA O PAT AO FOUNDER: o projeto roda em Lovable Cloud e o Supabase é da org do LOVABLE** (confirmado pelo founder 2026-07-23, depois de eu pedir o token 2× na mesma sessão). Ele não tem conta no `supabase.com` com acesso ao ref `fzvklzpomgnyikkfkzai`, logo **não existe Access Token para ele gerar** e o N2 é estruturalmente indisponível — o arquivo `supabase-pat` continua válido como mecanismo, só que ninguém pode preenchê-lo neste setup. A escada real de prova de edge aqui é: **N1** (`verify-edge.sh`, OPTIONS → servida) **+ rastro do commit do bot** na `main` (`Deployed …`/`Redeployed …` — evidência de que o deploy rodou, não de qual versão) **+ canária comportamental** quando a edge tiver uma (a ÚNICA prova de versão disponível). Edge sem canária: declare "N1 + rastro; versão não provada" — nunca "no ar". Se a entrega for money-path e a prova importar, **crie a canária junto do fix** (padrão `identidade_probe`/`credito_gate_probe`), porque depois não haverá como provar.
- ⚠️ **Grep de verificação anda PAREADO com um controle positivo, no MESMO comando — senão o vazio se lê como resposta (2026-07-20).** Verificação por bytes conclui por **ausência** ("a string não está lá"), e ausência é o resultado que qualquer erro de alvo produz: arquivo errado, download que não aconteceu, path inválido. Some ao grep da assinatura o grep de uma string que **comprovadamente existe** no alvo (ex.: `order_date_kpi` para o chunk do farmer); controle vazio = você mediu o lugar errado, e o resultado da assinatura **não vale nada** — não é "não encontrei", é "não procurei". Mordido 3× seguidas verificando o Publish de #1466/#1468/#1471: (a) grep no entry `index-*.js`, que **não contém** o código lazy-loaded — as ~119 páginas e vários hooks têm chunk próprio (`useFarmerScoring-*.js`, `useCrossSellEngine-*.js`), então o entry tem ~232KB de 5,6MB; (b) grep nos chunks `Farmer*.js` das páginas, quando o hook mora em chunk separado; (c) `xargs` abortando com `command line cannot be assembled, too long` → **0 arquivos baixados** e os dois greps seguintes lendo um diretório vazio, com cara de "não achei". Nas três o controle denunciou na hora. **Corolário:** valide a assinatura contra o código PRÉ-fix (`git show <sha>~1:<arquivo> | grep -c '<assinatura>'` tem de dar **0**, e `<sha>` dar ≥1) — sem isso você prova que uma string existe, não que a MUDANÇA entrou. **E prefira a skill à varredura ad-hoc:** ela já resolve paralelismo e lista de chunks; refazer com `curl` na mão é como se cai nos três buracos acima.
- ⚠️ **Sentinela NÃO-EXCLUSIVA dá falso POSITIVO — e falso positivo ENCERRA a verificação (2026-08-24).** O corolário acima ("assinatura ausente no código PRÉ-fix") não é opcional nem vale só para assinatura estrutural: vale para TODA string-alvo do `verify-frontend.sh`, que devolve `exit 0` para qualquer byte presente no bundle — **inclusive o que já estava lá antes do seu PR**. Verificando o #1949 (`src/hooks/useLastVisit.ts`, 3º PR no mesmo arquivo em um dia), a sentinela sugerida de início foi `visita_tentativa`: era do **#1945**, publicado horas antes, e daria verde com o #1949 inteiro fora do ar (`git grep -c visita_tentativa <sha-pai> -- src/` → 2 arquivos). ⇒ **a prova de exclusividade é do próprio script**: `verify-frontend.sh --pai <sha-do-commit-anterior> '<sentinela>'` exige, ANTES de tocar a rede, **0** ocorrência em `src/` no pai **e ≥1 no commit do PR** (`--novo`, default HEAD) — sem o lado positivo o zero é ausência de dado, não novidade. Recusa com **exit 3**, que nunca é veredito sobre o deploy; fora de repo git, sha que não resolve ou `--pai` sem valor **também** recusam (fail-closed, e `command -v git` não bastaria). Sem `--pai` a varredura roda igual, avisando `EXCLUSIVIDADE_NAO_PROVADA`. **O controle NEGATIVO da sonda deixou de ser recado e virou embutido** — o guard prova que a sentinela é nova, não que o script sabe dizer "não", e dois `exit 0` seguidos não distinguem "está no ar" de "o script dá verde pra tudo". Era um 2º comando manual (string inexistente exigindo exit≠0), e recado depende de alguém lembrar — que é exatamente como a armadilha da sentinela não-exclusiva passou. Agora, **quando o alvo casa**, o script reexecuta o MESMO pipeline (`curl`+`grep -q`+captura) no MESMO chunk que acabou de casar, com uma string hex aleatória nascida no processo; se ela "casar" → `SONDA_NAO_DISCRIMINA` e **exit 2** (que passou a significar "a mecânica da sonda não é confiável", não só "enumeração quebrada"). Sem entropia pra gerar a string, recusa (exit 3) antes da rede. **A escolha de UM chunk em vez de 2ª varredura completa saiu de número, não de opinião** (medido em prod 2026-08-24, 334 chunks: enumeração 337 req/73 s · varredura completa 334 req/18 s · 2ª invocação inteira 671 req/91 s · **controle de 1 chunk: 1 req/0,14 s**): discriminar é propriedade do par (padrão, `grep`), não do chunk, então repetir em 334 chunks é redundância — e os dois furos que sobram (fallback que devolve conteúdo constante, alvo degenerado tipo `.*`) escapam igualmente das duas versões. **Dois limites ficam nomeados:** (i) controle embutido não denuncia "o script inteiro mente" (a asserção é dele mesmo) — isso é do gate `evals/run.sh --falsify`, que sabota e exige vermelho em commit-time; (ii) o ramo `exit 1` (alvo ausente) audita o risco OPOSTO e por isso tem o **controle POSITIVO**, irmão deste — bullet abaixo. Sinal auxiliar de graça: `entry:`/chunk do `✅ ALVO` carregam hash de conteúdo, que muda a cada build — hash igual ao da verificação anterior = bundle velho. Método e caso: skill `lovable-deploy-verify` §Passo 4. É o **irmão** do id de EXEMPLO (§Sonda de versão): aquele reprova um deploy correto e a verificação continua; este **aprova um deploy ausente** e a verificação para.
- ⚠️ **"Ausente" é uma AFIRMAÇÃO sobre o mundo — e uma sonda CEGA a produz igualzinho (2026-08-25).** O `exit 1` do `verify-frontend.sh` diz "Publish pendente, OU o ALVO não é literal/único". Se os chunks passam a falhar (CDN 403/404 em `/assets/*`, rate limit, rede caída, DNS) **enquanto o `index.html` ainda responde** — e responde: o entry sai do HTML, o precache sai do `/sw.js`, ambos fora de `/assets/` —, o script varre os 334 chunks vazios e conclui **exatamente a mesma frase**, com o operador pedindo um Publish que não era necessário. O guard de enumeração (`N < 2`) **não pega**: o precache sozinho enche a lista. É a regra de EVIDÊNCIA POSITIVA — ausência de sinal não é sinal, e aqui a ausência estava sendo lida como afirmação. ⇒ **controle POSITIVO embutido**, irmão do negativo: antes de ENUNCIAR a ausência, uma **agulha** derivada do corpo do entry é procurada NO entry pelo MESMO `varre()` (curl+grep+captura que produz o veredito); não achou → **`SONDA_CEGA` + exit 2, nunca exit 1**. **Não é circular:** o corpo (baixado lá no closure) só **escolhe** a agulha; o veredito sai de um curl+grep **novo**, no momento da conclusão — se a rede caiu no meio dos 18 s de varredura, é esse request que denuncia. A agulha é **derivada, nunca fixa** (string fixa do bundle quebraria no build seguinte e viraria exit 2 espúrio) e **alfanumérica** — o maior token `[A-Za-z0-9_]` do corpo — porque o `grep` dos chunks é BRE. Três modos, marcas ASCII: **`ENTRY_NAO_E_JS`** — o chunk respondeu **HTML com 200** (fallback catch-all do SPA, página de erro): o `-f` do curl **não pega**, o corpo VEM, e sem esse check a agulha nasceria do próprio fallback e **casaria em si mesma**, verde por CEGUEIRA; **`AGULHA_INDISPONIVEL`** (corpo vazio ou curto — é o caso do curl que falhou); **`AGULHA_NAO_CASOU`**. **Custo medido:** o download do entry **já acontecia** no closure e passou só a ser salvo (0 request a mais ali); o controle em si é **1 req / 0,14 s** sobre os 91 s do pior caso do script — **+0,15%**. **Corolário que vale para todo guard escrito ANTES da feature:** o `falsify_case` do harness recebia o `exit_normal` **declarado**, e declarar o exit do script que você ainda vai escrever faz "divergiu do que eu disse" ficar verde **sem sabotagem nenhuma** — duas das três sabotagens novas passaram assim até o normal virar **MEDIDO** no script real, na mesma url, antes de comparar. Método, saídas e fixtures (`site-cego`, `site-fallback`): skill `lovable-deploy-verify` §Passo 4.
- **Fix que é uma AUSÊNCIA não se prova por bytes.** Remover um `|| 0`, um fallback ou um default não deixa assinatura: no bundle minificado o nome da variável sumiu, e `x.get(a)||0` legítimo (contador, onde 0 é a resposta certa) é indistinguível do que você tirou. Ou você grepa o **par positivo** que entrou junto (no #1471, o `.order("product_id"` da paginação, que só existe pós-fix), ou aceita que a prova é **comportamental** — e vai para a tela.
- **QA visual pós-Publish** (renderização/comportamento na tela, refactor visual sem texto novo): os bytes não bastam e o `/browse` headless **não monta** a SPA. O padrão é **Claude-in-Chrome na sessão logada do founder** (ele abre o app 1×; o agente confere as telas) — detalhado no Passo 4b da skill `lovable-deploy-verify`.
- O acesso **read-only** ao banco (`psql-ro`, ver `docs/agent/database.md`) confirma migration aplicada sem depender do founder.

## Atualização do PWA — modelo `prompt` (offline-first; #1169)

O SW usa `registerType: 'prompt'` (não `autoUpdate`): a versão nova **instala mas espera** e o operador clica "Atualizar" (toast em `src/lib/pwa-update.ts` → `updateSW(true)` posta `SKIP_WAITING` + reload). Fim do reload-surpresa no meio do turno. **Invariantes ao mexer no `vite.config.ts` (bloco `VitePWA`) — não repetir os P1 que o Codex pegou:**

- **`skipWaiting` FICA removido** (era `true`): é ele que forçava a ativação/reload automáticos. Reintroduzir volta o reload-surpresa.
- **`clientsClaim: true` NÃO se remove junto** — parecem par, mas não são. Sem ele, na **1ª instalação** o SW não controla a aba atual até o próximo reload → se a rede cair na mesma sessão, **offline-first não funciona no primeiro acesso**. Ele não causa reload-surpresa (só o `skipWaiting` causava); só faz claim quando o SW ativa (que na atualização só ocorre após o clique).
- **Registro do SW tem fallback** — `main.tsx` faz `import('./lib/pwa-update')` guardado por `__PWA_ENABLED__` (build const = `production && !preview`; DCE remove em dev/preview, onde `virtual:pwa-register` nem existe). No `.catch`, cai pra `navigator.serviceWorker.register('/sw.js')`: offline-first não pode depender de um import lazy resolver.
- **A verificação de deploy NÃO é cegada pelo prompt mode** — `verify-frontend.sh` usa `curl` direto no host (sem service worker), então mede os **bytes do servidor**, não um cliente com SW velho. O cron não é um browser.
  ⚠️ **Mas ela mede DISPONIBILIDADE, nunca ADOÇÃO — e no modelo `prompt` os dois divergem por tempo
  indefinido.** A frase acima é verdadeira para o que o script mede e foi lida como garantia do que
  ele NÃO mede: em 2026-08-24 os PRs #1934/#1945/#1949 estavam todos servidos (`verify-bundle-multi`
  exit 0, 334/334 chunks, com controle positivo e negativo) enquanto o browser do founder executava
  um entry anterior, servido do precache pelo SW — o app inclusive exibia "Nova versão disponível".
  Resultado: uma visita ao dashboard gerada de propósito para testar o fix **testou o código de antes
  do fix**, e a tabela vazia quase virou "o fix não pegou". Não é caso de borda: com `skipWaiting`
  removido de propósito, **esperar é o comportamento correto**, e o cliente fica no build velho até
  clicar. Assets antigos continuam servidos com **200** (imutáveis por hash), então o SW consegue
  sustentar o build velho indefinidamente.
  **A regra:** *"está no ar"* e *"está rodando"* são estados diferentes, e o segundo é **por
  cliente**. Bytes no servidor não fecham nenhuma verificação cujo sujeito seja o usuário — para
  essa, o oráculo tem de ser um efeito que só o código novo produz (uma linha que só ele grava, um
  evento que só ele emite), e o cliente precisa aceitar o update antes do teste.
- **A 4ª camada tem SENSOR desde 2026-08-24: `build_id` em todo evento de analytics.** As 3 camadas
  manuais do Lovable (Publish · edge · migration) terminam em "servido"; a 4ª é o **ACEITE do
  cliente**, e ela não tinha medição — a divergência de 2026-08-24 só apareceu porque um toast
  "Nova versão disponível" caiu num screenshot. Agora todo evento carrega o hash do chunk do entry
  que o browser executou (`src/lib/build-id.ts` → super property no `initAnalytics`), no **mesmo
  eixo** que o `verify-frontend.sh` (linha do `ENTRY=`, na skill `lovable-deploy-verify`) extrai do servidor (`/assets/index-*.js`) — os dois lados
  comparam sem tabela de tradução, e um teste de paridade (`build-id-paridade.test.ts`) impede que
  um dos regexes ande sozinho. Como ler e a conta de adoção: `docs/agent/analytics.md` §6.
  ⚠️ **O sensor só responde a partir do Publish que o contém** — antes disso a propriedade é
  ausente em 100% dos eventos, e ausente significa "build anterior à instrumentação", não "erro".
- **Prova de build** (não confiar na config): `dist/sw.js` deve ter `skipWaiting` **só dentro do listener de `message`** (não no `install`) + `clientsClaim` presente. `dist/index.html` **sem** auto-register (por `injectRegister: false`).
- **Transição única no 1º Publish com prompt mode:** clientes com o SW antigo (autoUpdate) auto-recarregam **uma última vez** ao pegar este build; daí em diante toda atualização vira o toast. Inerente, não dá pra evitar.
