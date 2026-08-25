# Deploy no Lovable — 3 camadas manuais (referência operacional)

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

## Merge na `main` ≠ produção — 3 deploys MANUAIS e independentes

1. **Migration** → colar o SQL no **SQL Editor do Lovable** → Run → validar com query de contagem. O Lovable **NÃO** aplica migration de nome custom sozinho (falha SILENCIOSA: a feature compila e quebra em runtime). Detalhe + ritual + skill `lovable-db-operator`: `docs/agent/database.md`.
2. **Frontend** → **Publish** manual no editor do Lovable. `steu.lovable.app` serve o **build velho** até o Publish (lição 2026-05-31: mergear e achar que foi pro ar é o erro recorrente).
3. **Edge functions** → criadas/editadas pelo **chat do Lovable** (ele lê `supabase/functions/<nome>/index.ts` do repo e deploya **verbatim**), **NÃO** pela UI Cloud (que só mostra logs).

**Achar UMA camada pendente é SINTOMA — audite as TRÊS do MESMO PR.** As camadas deployam separado, mas o PR que as tocou é um só: migration não-aplicada é evidência de **PR não-deployado**, não de migration esquecida. E o caminho de detecção enviesa — um `/fecho` que varre migrations acha migrations; frontend e edge nem entram no campo de visão. Ao detectar qualquer pendência, classifique o diff por camada antes de fechar o caso:

```bash
git show --name-only --format="" <sha> | awk '/^supabase\/migrations/{m++} /^supabase\/functions/{e++} /^src\//{f++} END{print "mig="m+0" edge="e+0" front="f+0}'
```

Mordido 2026-08-14 (#1520 `9f7e8962`, FU4-F fase 3): o `/fecho` pegou `…130000_fecha_product_costs.sql` mergeada e não aplicada, aplicou, verificou — caso encerrado. O mesmo PR trazia **5 migrations + frontend (já publicado) + 2 edges nunca confirmadas**, e edge velha ali é money-path concreto, porque o front novo é que mudou o contrato: `generate-bundle-argument` imprime `p.margin.toFixed(2)`/`bundle.lieBundle.toFixed(2)` num payload que o hook publicado **parou de mandar** (→ **TypeError**, argumento de venda não gera); `generate-tactical-plan` ordena as recomendações por `lie_bundle DESC`, hoje NULL em toda linha, e DESC implica NULLS FIRST → **topBundle arbitrário, plano tático sobre ranking fabricado**. ⚠️ O risco é assimétrico: com as duas metades faltando elas se cancelam, então **aplicar só a camada que apareceu pode ser o que ARMA a quebra** — é a armadilha do `carteira-rebuild` (abaixo) vista pelo lado do PR, não da edge.

## Edge — armadilhas

- **Deploy SÓ depois do merge** — o chat lê a `main`; deployar antes pega o código velho.
- **Deployar uma edge sobe o ARQUIVO INTEIRO da `main`, não só o seu diff** → o pré-flight é das dependências de banco de TODO o arquivo, inclusive código de PRs de TERCEIROS mergeados desde o último deploy dela. É a irmã da armadilha da migration silenciosa, vista do outro lado: não foi a migration que faltou aplicar — foi o **deploy do código que a exigia** que chegou depois e revelou a falta. Mordido 2026-07-17 (Fatia 2 do épico-drop): deployei `carteira-rebuild` verbatim (a MINHA mudança tinha as deps checadas: `identity_state` existia no schema) — mas o arquivo da main carregava junto o lease do #1333 (`claim_carteira_rebuild`/`finalizar_carteira_rebuild`), mergeado dias antes, cuja migration NUNCA fora aplicada. As duas metades faltando (edge do #1333 nunca deployada + migration nunca aplicada) se cancelavam; meu deploy correto trouxe só a metade-código → **rebuild 500 em produção por ~40min** (`claim: Could not find the function ... in the schema cache`), carteira congelada no snapshot do dia anterior (modo-falha seguro: o `claim` é o 1º passo, morre ANTES de escrever). **Pré-flight barato (roda em segundos, teria pego):** antes de dar o prompt de deploy de uma edge, cruze as RPCs que ela chama com o que existe em prod —
  ```bash
  grep -rhoE "\.rpc\('[a-z_]+'" supabase/functions/<edge>/ | sed "s/.*rpc('//;s/'//" | sort -u
  # cada uma: ~/.config/afiacao/psql-ro -c "select 1 from pg_proc where proname='<rpc>';"  (vazio = bomba armada)
  ```
  Varredura do repo inteiro em 2026-07-17: das 16 RPCs chamadas por edges, as 16 existem em prod — o `claim_carteira_rebuild` era o único caso. Vale o mesmo raciocínio p/ tabela/coluna/view nova que o arquivo referencie.
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

**As 6 canárias estão versionadas** (a dívida das 3 sem marcador fechou em 2026-08-23). Canária sem `contrato` só tem `canary` + `ok`, o que **não** protege contra deploy integralmente velho (ver ⚠️ abaixo): canária nova nasce COM marcador — e o marcador **nomeia a fatia** que ela verifica, nunca um `v1.0-sensor-inicial` genérico (esse só é honesto quando o sensor nasce na mesma fatia).

| edge | rota | `contrato` esperado | o que a fixture discrimina |
|---|---|---|---|
| `analyze-unified-order` | Governança → Auditoria (card "Canária de preço") | `praticado-vence-omie-v1` | praticado 123 vence Omie 999 (velho: o Omie sobrescrevia → `resolved=999`) |
| `omie-vendas-sync` | `identidade_probe` | `identidade-fail-closed-v1` | identidade derivada por documento: 1-dono resolve, e divergência advisory×derivado / ambiguidade / ausência / bigint fora de range **recusam** (velho: o advisory sobrescrevia o derivado) |
| `omie-analytics-sync` | `doc_ambiguo_probe` ⚠️ resposta embrulhada em `data` | `doc-ambiguo-fail-closed-v1` | doc ambíguo não vira vínculo (velho: helper sempre-∅ → `[]` no caso de 2 códigos) |
| `carteira-rebuild` | `?canary=1` | `trava-saida-v1` | conflito permanece com `eligible=false` (velho: some) **+** trava de saída do bootstrap (velho: grava ~Hunter) |
| `generate-tactical-plan` | `{"canary":true}` | `v1.1-paginacao-eof-e-cursor` | margem ausente degrada em vez de fabricar (velho: NULL→`?? 0`→R$0/h; #1498) |
| `omie-financeiro` | `paginacao_probe` | `paginacao-guards-v1` | guards de paginação do #1598: piso NÃO encolhe (vazia antes do fim = anomalia; velho: `\|\| 1` → "fim"), reversa só completa com sonda vazia (velho: `pagina < 1` → complete), fingerprint sem colisão (velho: `1ºcódigo:count`), resposta sem array LANÇA (velho: `\|\| []` → "página vazia" = fim) |

### Sonda de versão (`{"probe":true}`) — quando a edge não tem canária e o efeito é irreversível

Canária prova **comportamento** com fixture; a **sonda** prova só **qual bundle está no ar** — e serve o caso em que a canária não cabe porque a edge não tem caminho barato nenhum. Mecanismo em `_shared/sonda-versao.ts` (#1747/#1750); cada edge contribui `VERSAO` + `EFEITO` no seu `versao.ts`. Instrumentadas — **disparo de pedido** (#1747/#1750): `disparar-pedidos-aprovados` (`v1.1-marco-causal`), `enviar-pedido-portal-sayerlack`, `conciliar-pedido-portal`, `gerar-pedidos-diario`, `pedido-programado-enviar`; **sem caminho de prova** (#1520): `generate-tactical-plan` (`v1.1-paginacao-eof-e-cursor`), `generate-bundle-argument` (`v1.0-prompt-sem-margem`); **efeito fora do nosso banco** (#1753): `omie-nfe-recebimento` e `process-nfe` — gêmeas, mesma tríade `AlterarRecebimento` → `AlterarEtapaRecebimento` etapa 40 → `ConcluirRecebimento`, que dá entrada de estoque e fiscal no ERP, e a `process-nfe` **não tem modo de teste nenhum**, nem o `diagnostico` read-only que a gêmea tem —, `sayerlack-captura-precos` (monta linha no pedido do portal do FORNECEDOR p/ ler preço; aborto deixa rascunho que passa por pedido humano) e `reposicao-depara-sayerlack-auto`; **escrita money-path no NOSSO banco** (#1767): `omie-cliente` — a mais cara das cinco, porque CRIA `auth.users` `@placeholder.local` + `profiles` e a ausência de `profiles` é o discriminante dos ~1.633 aliases fiscais (§5 do `database.md`): errar aqui apaga uma FRONTEIRA, não um número —, `fin-cashflow-engine` (projeção de 13 semanas que vira `fin_projecao_snapshots`/`fin_alertas` quando `save_snapshot:true`, o caminho do cron), `omie-sync-estoque` (reescreve o saldo do motor de reposição **e** avança o marcador de frescor: o run parcial apaga o sinal de que foi parcial), `omie-sync-nfes-recebidas` (rastreio nota↔pedido + `fin_sync_log`, lido sem filtro de `action` pelo cálculo de frescor) e `omie-nfe-webhook` (materializa o recebimento; cabeçalho e itens não são transacionais e a retentativa cai em "já importada", que esconde em vez de consertar). **escrita money-path no NOSSO banco, 2ª rodada**: `recommend` (#1898 — grava `recommendation_log`, o SENSOR DE DESFECHO do motor: sondar sem guarda inventaria uma recomendação que ninguém fez e enviesaria a própria medição de acerto; marcador hoje em `v1.5-denominador-observados`) e `omie-analytics-sync` (#1905 — reescreve `product_costs`, `order_items`, `sales_orders`, `inventory_position` e o mapa de identidade). ⚠️ Esta última JÁ tinha canária (`doc_ambiguo_probe`, na tabela acima) e mesmo assim precisou de sonda: a canária é NÃO-VERSIONADA e responde igual num bundle de hoje e num de três fatias atrás — **ter canária não dispensa marcador**. Nela a sonda é barata e o veredito é binário, porque a edge roteia por `action` e o bundle PRÉ-sensor cai no `default` com `400 "Ação desconhecida"`, sem tocar Omie nem banco. **oitava leva — as 7 que serviam o `paginate.ts` sem sensor NENHUM** (#1889/#1901): `calculate-scores`, `ai-ops-agent`, `omie-sync-status-produtos`, `sync-reprocess`, `scoring-recalc-batch`, `tactical-plans-batch` e `visit-score-recalc-batch` — o deploy delas era literalmente INVERIFICÁVEL (sem marcador, e sem fixture possível porque o #1889 é no-op por desenho). Junto vieram os bumps de `omie-cliente`, `generate-tactical-plan` e `reposicao-depara-sayerlack-auto`, presas num marcador que já respondia em prod, todas para `v1.1-paginacao-eof-e-cursor`. ⚠️ **O custo do bundle VELHO ignorando `probe` varia, e é ele que decide se sondar às cegas é seguro** — tabela por edge em `docs/historico/deploy-no-op-por-desenho.md` §8ª leva; das 7, só a `sync-reprocess` é barata (cai no `default` 400 antes de escrever) e só a `ai-ops-agent` é inócua (401 do gate de JWT). Nas outras 5, sondar um bundle pré-sensor DISPARA o run. Um gate novo (`nenhuma edge que serve o paginate.ts fica SEM prova de deploy`) fecha a classe: dependente nova nasce com sensor ou o CI reprova nomeando-a. Ficaram DE FORA de propósito as de leitura pura (`fin-funding`, `fin-valor-engine`, `fin-next-best-action`, …): chamá-las já é grátis, então a sonda não resolve problema que elas tenham — o que falta nelas é só o campo `versao` na resposta. Sem marcador declarado = `v1.0-sensor-inicial`. **sétima leva — `analyze-unified-order`** (#1930, marcador hoje em `v1.1-corpo-tipado`): a primeira que entra sem escrever no nosso banco E sem ser leitura barata. Motivo é o SEGUNDO do #1520 — chamada pelo BROWSER, não deixa rastro em `net._http_response` nem em `cron.job_run_details`. ⚠️ **Ela TEM canária versionada e mesmo assim precisou de sonda, e as duas NÃO se substituem:** o `contrato` da canária (`praticado-vence-omie-v1`, tabela acima) nomeia a fatia do MERGE DE PREÇO e vive DEPOIS do gate de staff — só o app logado a alcança; a `versao` da sonda nomeia a fatia do corpo/prompt e responde ANTES desse gate, com gate próprio, então é a única das duas que o founder dispara sem abrir o app. ⚠️ **Foi aqui que a armadilha "marcador congelado" mordeu de verdade:** `v1.0-prompt-invertido-cacheado` atravessou o #1938 sem bump, e a sonda provava "≥ #1930" e nada mais (medido em prod 2026-08-25, request_id 59657). O bump é obrigatório ANTES do deploy, e o gate `bump v1.1-corpo-tipado` de `_shared/sonda-versao-contrato_test.ts` barra o retorno ao valor congelado.

- **Efeito irreversível não é a única indicação — "não existe caminho de prova" também é.** As duas edges do #1520 entraram por este segundo motivo: o efeito é caro-mas-reversível (token do modelo, plano regravável), só que elas são chamadas pelo **BROWSER** e por isso não deixam rastro em `net._http_response` nem linha em `cron.job_run_details` — o par que torna uma edge de cron auditável de fora. Quando a pergunta "qual bundle está no ar?" não tem NENHUMA resposta possível, a sonda é o sensor, independentemente de o efeito ser reversível.

- ⚠️ **Sonda SEM marcador prova "≥ o PR que a criou" e nada mais** — e isso se lê como prova de deploy sem ser. A `generate-tactical-plan` tinha `{"probe":true}` desde o #1618 respondendo a CONSTANTE `motor:"anthropic"`: provava a migração para a Anthropic e ficou congelada aí. Todo deploy posterior respondia byte-idêntico, então no fecho do FU4-F fase 3 (#1520, o último commit a tocar a edge) a verificação caiu em "o founder confirmou" **com a sonda respondendo verde** — é a armadilha 2 (abaixo) na sonda em vez de na canária. Corrigido no #1754: marcador versionado + o `versao` também na resposta da canária de margem. A sonda daqui é **superset** da do #1618 (`motor`/`modelo`/`tool`/`fallback_fabricado` continuam servidos, pinados em `generate-tactical-plan/versao_test.ts`) — quem tem o `curl` antigo anotado não perde nada.

- **A pergunta que ela responde** é "está no ar?", em 1 request, sem custo: responde ANTES do `createClient`, de toda query e de toda chamada externa. Com `x-cron-secret` o gate de auth decide por comparação de env pura ⇒ IO-free de ponta a ponta.
- ⚠️ **Verificar exige o eco `probe:true` E `versao`** — é a armadilha 1 acima vista de outro ângulo: bundle ANTERIOR à sonda **ignora o parâmetro e roda o FLUXO REAL**. Resposta sem esses campos = bundle velho **e ele executou o efeito caro** (PO no Omie, pedido no portal do fornecedor). **Sonde só depois de confirmar o deploy** — ou, quando a edge aceitar, com parâmetro que torne o fluxo real um no-op (no `disparar-pedidos-aprovados`, `"data_ciclo":"1970-01-01"`: nada casa no `.eq`/`.lte`).
- **`probe` com valor não reconhecido é 400 fail-closed**, nunca execução por omissão — e grafias que o SQL Editor produz (`"true"`, `"1"`, caixa/espaço) contam como sonda: um `=== true` cru mandaria `{"probe":"true"}` para o efeito irreversível.
- **Onde a sonda entra quando o gate da edge não aceita `x-cron-secret`:** nas duas de NF-e o gate é JWT de usuário staff, e é pelo SQL Editor (cron-secret) que a sonda é invocada — atrás do gate ela seria inalcançável justamente para quem precisa dela. Nelas a sonda responde ANTES desse gate, com gate PRÓPRIO (`authorizeCronOrStaff`): nenhum caminho fica sem auth, o fluxo real continua exigindo os dois, e o custo só é pago quando `probe` vem no corpo. Ao instrumentar uma edge nova, cheque **qual** gate ela tem antes de copiar o padrão. O #1767 acrescentou dois formatos de gate que o padrão original não previa: a `omie-nfe-webhook` usa `x-webhook-secret` (segredo compartilhado com o Omie, que não emite JWT), e a `omie-cliente` **não tem um gate só** — ele é POR AÇÃO dentro do switch, e `buscar_por_documento` é PÚBLICA (pré-cadastro, só rate-limit por IP). Nessa última, deixar a sonda seguir o gate da ação a tornaria ou inalcançável (nas de staff) ou **pública** (na de pré-cadastro) — as duas erradas; o gate próprio evita os dois. Regra prática: se a edge tem mais de um gate, o gate da sonda é sempre o dela, nunca "o da ação que calhar".
- ⚠️ **O sensor só prova versões A PARTIR DE SI MESMO.** Ausência do campo `versao` = bundle pré-sensor, não "versão errada". Ele nunca responde retroativamente — é a regra "superfície de uso nasce COM o sensor" aplicada a deploy, e o motivo de criar a sonda JUNTO do fix.
- ⚠️ **Comentário que promete caminho seguro inexistente é a armadilha irmã** (2 casos achados): `dry_run` do `disparar-pedidos-aprovados` chama `IncluirPedCompra` incondicionalmente e cria PO real; e o header do `enviar-pedido-portal-sayerlack` anunciava um modo `ECO (validacao)` **que não existe no código**. Antes de usar um "modo de teste" documentado em comentário, **confirme no código que ele é tratado**.

⚠️ **Só é canária se a resposta tiver `"canary":true` E o `contrato` esperado.** Duas falhas distintas:
1. Deploy ANTERIOR à canária ignora o param e roda o **fluxo real** — no `carteira-rebuild` isso é um rebuild completo (lease + upserts; idempotente e guardado, mas é escrita). Resposta sem `canary:true` = canária não rodou **e** o deploy é velho: já é o veredito.
2. Deploy **integralmente velho** (com a canária de uma fatia anterior) carrega o `expected` VELHO junto e compara velho×velho → responde `canary:true, ok:true` e **mente verde** (Codex 2026-07-20). Por isso o **`contrato` (version marker) é obrigatório na verificação**: `ok` sozinho não discrimina reversão de fatia. Faça **bump do marcador** a cada fatia que mude o contrato da canária — senão a próxima reversão volta a passar despercebida.

⚠️ **Canária cujo CONSUMIDOR é o frontend precisa de DOIS deploys para discriminar.** A `analyze-unified-order` é a única das 6 assim: ela não aceita `x-cron-secret` (gate por JWT de staff), então não sai pelo SQL Editor — quem exige o `contrato` é o card de Governança, ou seja **código do frontend**. Com o Publish do frontend pendente, o card servido é o ANTIGO, que classifica pela forma pré-marcador (`ok && resolved===123 && expected===123`) e pinta **verde com edge nova OU velha** — e o texto do verde é idêntico nas duas versões, então a tela não desempata. Medido 2026-08-23 no #1922. **Ao verificar essa canária, confirme o Publish do frontend antes de ler o card**; sem ele, a prova independente é a resposta CRUA da edge (DevTools → Network → `analyze-unified-order` → Response, procurando `"contrato"`). Regra geral: a canária herda as camadas de deploy de TODO mundo que participa do veredito, não só da edge que responde. **A sentinela desse Publish é `praticado-vence-omie-v1`** — o `verify-frontend.sh` da skill `lovable-deploy-verify` a acha no chunk `GovernanceAudit-*` (medido 2026-08-23: exit 0, 334 chunks). Provar o card pelos BYTES vem ANTES de pedir a tela: se o Publish estiver pendente, o verde que o founder relatar não é veredito, e a viagem até a tela foi perdida. O DevTools acima é a via de quem já está com o app aberto.

⚠️ **Canária que não discrimina é teatro verde.** Se a mudança for no-op nos dados de hoje (caso do #1397: 0 conflitos em prod), a resposta do fluxo REAL é byte-idêntica com código velho ou novo — não prova deploy nenhum. A fixture tem de exercitar **o comportamento que mudou**, e o teste tem de provar que sob o comportamento ANTIGO a canária ficaria vermelha (ver `rebuild-helpers.test.ts` → "a fixture DISCRIMINA"; e `_shared/omie-paginacao_test.ts` → bloco "CONTROLE DE CALIBRAÇÃO", que roda a forma pré-#1598 sobre os fixtures homônimos da `paginacao_probe`). Sem esse assert, a canária só prova que a função responde.

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

#### Sondar VÁRIAS edges numa tacada (leva inteira) — e as 3 armadilhas do SQL Editor

Uma leva tem 5–10 edges, e repetir o par disparo/leitura por edge convida ao erro de trocar o `request_id`
entre uma e outra. O padrão é disparar todas com `net.http_post` sobre um `VALUES` de nomes, agregar com
`jsonb_object_agg(edge, request_id)::text` numa **célula única** para copiar, e no passo 2 reidratar com
`jsonb_each_text('<colado>'::jsonb)`. Medido 2026-08-24 sondando a oitava leva (#1937).

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
- ⚠️ **Sentinela NÃO-EXCLUSIVA dá falso POSITIVO — e falso positivo ENCERRA a verificação (2026-08-24).** O corolário acima ("assinatura ausente no código PRÉ-fix") não é opcional nem vale só para assinatura estrutural: vale para TODA string-alvo do `verify-frontend.sh`, que devolve `exit 0` para qualquer byte presente no bundle — **inclusive o que já estava lá antes do seu PR**. Verificando o #1949 (`src/hooks/useLastVisit.ts`, 3º PR no mesmo arquivo em um dia), a sentinela sugerida de início foi `visita_tentativa`: era do **#1945**, publicado horas antes, e daria verde com o #1949 inteiro fora do ar (`git grep -c visita_tentativa <sha-pai> -- src/` → 2 arquivos). ⇒ **a prova de exclusividade é do próprio script**: `verify-frontend.sh --pai <sha-do-commit-anterior> '<sentinela>'` exige, ANTES de tocar a rede, **0** ocorrência em `src/` no pai **e ≥1 no commit do PR** (`--novo`, default HEAD) — sem o lado positivo o zero é ausência de dado, não novidade. Recusa com **exit 3**, que nunca é veredito sobre o deploy; fora de repo git, sha que não resolve ou `--pai` sem valor **também** recusam (fail-closed, e `command -v git` não bastaria). Sem `--pai` a varredura roda igual, avisando `EXCLUSIVIDADE_NAO_PROVADA`. **E rode um controle NEGATIVO junto** — o guard prova que a sentinela é nova, não que o script sabe dizer "não" — (string inexistente TEM de dar exit≠0): dois `exit 0` seguidos não distinguem "está no ar" de "o script dá verde pra tudo". Sinal auxiliar de graça: `entry:`/chunk do `✅ ALVO` carregam hash de conteúdo, que muda a cada build — hash igual ao da verificação anterior = bundle velho. Método e caso: skill `lovable-deploy-verify` §Passo 4. É o **irmão** do id de EXEMPLO (§Sonda de versão): aquele reprova um deploy correto e a verificação continua; este **aprova um deploy ausente** e a verificação para.
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
