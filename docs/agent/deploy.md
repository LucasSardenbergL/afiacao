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

Nas canárias ainda **não-versionadas** (`contrato` = `—`) só há `canary` + `ok`, o que **não** protege contra deploy integralmente velho (ver ⚠️ abaixo) — versioná-las é dívida aberta.

| edge | rota | `contrato` esperado | o que a fixture discrimina |
|---|---|---|---|
| `analyze-unified-order` | Governança → Auditoria (card "Canária de preço") | — | praticado 123 vence Omie 999 |
| `omie-vendas-sync` | `identidade_probe` | — | identidade derivada por documento |
| `omie-analytics-sync` | `doc_ambiguo_probe` | — | doc ambíguo não vira vínculo |
| `carteira-rebuild` | `?canary=1` | `trava-saida-v1` | conflito permanece com `eligible=false` (velho: some) **+** trava de saída do bootstrap (velho: grava ~Hunter) |
| `generate-tactical-plan` | `{"canary":true}` | `v1.0-custo-fora-do-browser` | margem ausente degrada em vez de fabricar (velho: NULL→`?? 0`→R$0/h; #1498) |
| `omie-financeiro` | `paginacao_probe` | `paginacao-guards-v1` | guards de paginação do #1598: piso NÃO encolhe (vazia antes do fim = anomalia; velho: `\|\| 1` → "fim"), reversa só completa com sonda vazia (velho: `pagina < 1` → complete), fingerprint sem colisão (velho: `1ºcódigo:count`), resposta sem array LANÇA (velho: `\|\| []` → "página vazia" = fim) |

### Sonda de versão (`{"probe":true}`) — quando a edge não tem canária e o efeito é irreversível

Canária prova **comportamento** com fixture; a **sonda** prova só **qual bundle está no ar** — e serve o caso em que a canária não cabe porque a edge não tem caminho barato nenhum. Mecanismo em `_shared/sonda-versao.ts` (#1747/#1750); cada edge contribui `VERSAO` + `EFEITO` no seu `versao.ts`. Instrumentadas — **disparo de pedido** (#1747/#1750): `disparar-pedidos-aprovados` (`v1.1-marco-causal`), `enviar-pedido-portal-sayerlack`, `conciliar-pedido-portal`, `gerar-pedidos-diario`, `pedido-programado-enviar`; **sem caminho de prova** (#1520): `generate-tactical-plan` (`v1.0-custo-fora-do-browser`), `generate-bundle-argument` (`v1.0-prompt-sem-margem`); **efeito fora do nosso banco** (#1753): `omie-nfe-recebimento` e `process-nfe` — gêmeas, mesma tríade `AlterarRecebimento` → `AlterarEtapaRecebimento` etapa 40 → `ConcluirRecebimento`, que dá entrada de estoque e fiscal no ERP, e a `process-nfe` **não tem modo de teste nenhum**, nem o `diagnostico` read-only que a gêmea tem —, `sayerlack-captura-precos` (monta linha no pedido do portal do FORNECEDOR p/ ler preço; aborto deixa rascunho que passa por pedido humano) e `reposicao-depara-sayerlack-auto`; **escrita money-path no NOSSO banco** (#1767): `omie-cliente` — a mais cara das cinco, porque CRIA `auth.users` `@placeholder.local` + `profiles` e a ausência de `profiles` é o discriminante dos ~1.633 aliases fiscais (§5 do `database.md`): errar aqui apaga uma FRONTEIRA, não um número —, `fin-cashflow-engine` (projeção de 13 semanas que vira `fin_projecao_snapshots`/`fin_alertas` quando `save_snapshot:true`, o caminho do cron), `omie-sync-estoque` (reescreve o saldo do motor de reposição **e** avança o marcador de frescor: o run parcial apaga o sinal de que foi parcial), `omie-sync-nfes-recebidas` (rastreio nota↔pedido + `fin_sync_log`, lido sem filtro de `action` pelo cálculo de frescor) e `omie-nfe-webhook` (materializa o recebimento; cabeçalho e itens não são transacionais e a retentativa cai em "já importada", que esconde em vez de consertar). Ficaram DE FORA de propósito as de leitura pura (`fin-funding`, `fin-valor-engine`, `fin-next-best-action`, …): chamá-las já é grátis, então a sonda não resolve problema que elas tenham — o que falta nelas é só o campo `versao` na resposta. Sem marcador declarado = `v1.0-sensor-inicial`.

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

⚠️ **Canária que não discrimina é teatro verde.** Se a mudança for no-op nos dados de hoje (caso do #1397: 0 conflitos em prod), a resposta do fluxo REAL é byte-idêntica com código velho ou novo — não prova deploy nenhum. A fixture tem de exercitar **o comportamento que mudou**, e o teste tem de provar que sob o comportamento ANTIGO a canária ficaria vermelha (ver `rebuild-helpers.test.ts` → "a fixture DISCRIMINA"; e `_shared/omie-paginacao_test.ts` → bloco "CONTROLE DE CALIBRAÇÃO", que roda a forma pré-#1598 sobre os fixtures homônimos da `paginacao_probe`). Sem esse assert, a canária só prova que a função responde.

**Como o founder invoca uma probe sem terminal** (ele não tem acesso de shell ao backend): cole no **SQL Editor do Lovable** — o segredo sai do vault, nunca do chat — e leia a resposta em `net._http_response`. Mesmo mecanismo do cron, com `timeout_milliseconds` EXPLÍCITO (default 5s mata silencioso). Trocando `action`/`url`, serve para as outras probes:

```sql
SELECT net.http_post(
  url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
  headers := jsonb_build_object('Content-Type','application/json',
    'x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
  body := jsonb_build_object('action','paginacao_probe'),
  timeout_milliseconds := 20000) AS request_id;
-- ~5s depois, na MESMA aba:
SELECT status_code, content::jsonb->'canary' AS canary, content::jsonb->'contrato' AS contrato,
       content::jsonb->'ok' AS ok,
       (SELECT jsonb_agg(c->'caso') FROM jsonb_array_elements(content::jsonb->'casos') c
        WHERE (c->>'ok')::bool IS NOT TRUE) AS casos_vermelhos
FROM net._http_response ORDER BY id DESC LIMIT 1;
```

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

## Quando o Lovable reverte um fix — detectar e restaurar

O bot `gpt-engineer-app[bot]` commita direto na `main` SEM CI ("Changes"/"Deployed"/"Deployou edge") e às vezes reverte um PR (~16% dos commits; ≥4-5 reversões money-path recentes). Prevenção é inviável (o bot precisa de escrita direta) → o jogo é **detectar + restaurar rápido** (MTTR), não governança perfeita. Spec: `docs/superpowers/specs/2026-06-26-lovable-revert-mitigation-design.md`.

- **Sinais automáticos (CI desta frente, `.github/workflows/`):** Issue **`ci-main-red`** = a `main` quebrou build/typecheck/test (antes passava silencioso — ninguém alertado); Issue **`lovable-touched-sensitive`** = o bot tocou path money-path/edge **mesmo com CI verde** (regressão compilável — a classe do #1076/#1077); Issue **`lovable-reverted-merge`** = **reversão PROVADA por linha** — o commit direto removeu linhas que um merge das últimas 48h tinha adicionado; acusa QUAL PR foi desfeito + comando de restauração (`scripts/lovable-revert-scan.sh`, testável local: `test-lovable-revert-scan.sh`; filtra comentário puro e linha trivial — o bot apaga aviso sem reverter gate). Todas assinadas pro founder.
- **Guardrails como rede (testes-invariantes):** `src/lib/reposicao/__tests__/edges-onorder-guardrail.test.ts` (janela on-order #1072/#1076) e `src/__tests__/edge-money-path-invariants.test.ts` (analyze: helper espelhado + paridade edge×src + gate de fallback `!(… in priceMap)` + canária #1077/#1080/#1089; e margem do `algorithm-a-audit`) **quebram o CI** se a regressão volta ao REPO. Em refactor legítimo, **reescrever o teste junto** — não deletar.
- **Restauração rápida** (o que destravou #1076/#1085): `git checkout <sha-da-correção> -- <arquivo>` → abrir **PR** (auto-merge no verde). **Nunca** restaurar direto na `main` (vira guerra de commits com o bot).
- ⚠️ **O `lovable-watch` só enxerga o ÚLTIMO commit do push — reversão no PENÚLTIMO passa em silêncio (2026-07-23).** O workflow roda `git diff HEAD^ HEAD`, e o bot empurra em LOTE (`Changes` + `Deployed …` no mesmo push): o GitHub dispara UM run, no HEAD, e o commit intermediário nem tem run próprio. Medido: `018e8abc` ("Changes") removeu de novo as 3 linhas da RPC `farmer_association_rules_substituir` do `types.ts`; o run rodou em `54691cc5` (HEAD), cujo diff contra o pai **já não continha a remoção** → nenhuma issue aberta, `conclusion: success`. Na rodada anterior o gate acusou (issue #1583) só porque a reversão calhou de estar no HEAD do push. ⇒ **o gate cobre ~metade dos casos**; até ser corrigido (varrer `github.event.before..HEAD`, não `HEAD^..HEAD`), o **ritual manual abaixo continua obrigatório** — `git fetch` + conferir o diff de TODOS os commits do bot desde o último merge, não só o último. Corolário da causa-raiz: o bot regenera `types.ts` **a partir do BANCO**, então toda migration entregue e NÃO aplicada vira uma bomba-relógio — o próximo deploy de edge remove a RPC do types e quebra o build do Publish (loop observado 2×; some sozinho quando a migration é aplicada).
- **Ritual pós-Lovable:** após qualquer Publish/chat-edit, além da verificação de deploy de edge (acima), `git fetch origin main` e cheque o commit do bot — tocou money-path sem intenção → restaure na hora. Para o **edge de preço** (`analyze-unified-order`), confirme o COMPORTAMENTO deployado pela **canária**: Governança → Auditoria — o card "Canária de preço" **roda sozinho ao abrir** (botão "Verificar de novo" para re-checar). Verde = praticado 123 vence Omie 999; vermelho/erro = edge revertida → restaure. É a única prova do que está SERVIDO em prod (o invariante do CI só prova o repo). Evite editar pelo Lovable arquivos mantidos via PR.

## Verificação de deploy

- A skill **`lovable-deploy-verify`** confere se o bundle servido bate com o esperado (bytes/comportamento). Use após Publish/deploy — não confiar cegamente no "deployed" do Lovable. **N2 de edge (prova de versão) é automático quando `~/.config/afiacao/supabase-pat` existe** (Access Token do Supabase, `chmod 600`, padrão psql-ro): `verify-edge.sh` resolve env `SUPABASE_PAT` > arquivo e consulta a Management API; sem o arquivo, cada verificação de versão vira handoff manual na UI (custou 3 retomadas de sessão p/ confirmar 1 deploy). Teste: `scripts/test-verify-edge-pat.sh`. A varredura por bytes é **paralela** (`xargs -P`, halt-on-hit) — o bundle passou de 300 chunks e o modo 1-a-1 estourava o timeout.
  - ⚠️ **NÃO PEÇA O PAT AO FOUNDER: o projeto roda em Lovable Cloud e o Supabase é da org do LOVABLE** (confirmado pelo founder 2026-07-23, depois de eu pedir o token 2× na mesma sessão). Ele não tem conta no `supabase.com` com acesso ao ref `fzvklzpomgnyikkfkzai`, logo **não existe Access Token para ele gerar** e o N2 é estruturalmente indisponível — o arquivo `supabase-pat` continua válido como mecanismo, só que ninguém pode preenchê-lo neste setup. A escada real de prova de edge aqui é: **N1** (`verify-edge.sh`, OPTIONS → servida) **+ rastro do commit do bot** na `main` (`Deployed …`/`Redeployed …` — evidência de que o deploy rodou, não de qual versão) **+ canária comportamental** quando a edge tiver uma (a ÚNICA prova de versão disponível). Edge sem canária: declare "N1 + rastro; versão não provada" — nunca "no ar". Se a entrega for money-path e a prova importar, **crie a canária junto do fix** (padrão `identidade_probe`/`credito_gate_probe`), porque depois não haverá como provar.
- ⚠️ **Grep de verificação anda PAREADO com um controle positivo, no MESMO comando — senão o vazio se lê como resposta (2026-07-20).** Verificação por bytes conclui por **ausência** ("a string não está lá"), e ausência é o resultado que qualquer erro de alvo produz: arquivo errado, download que não aconteceu, path inválido. Some ao grep da assinatura o grep de uma string que **comprovadamente existe** no alvo (ex.: `order_date_kpi` para o chunk do farmer); controle vazio = você mediu o lugar errado, e o resultado da assinatura **não vale nada** — não é "não encontrei", é "não procurei". Mordido 3× seguidas verificando o Publish de #1466/#1468/#1471: (a) grep no entry `index-*.js`, que **não contém** o código lazy-loaded — as ~119 páginas e vários hooks têm chunk próprio (`useFarmerScoring-*.js`, `useCrossSellEngine-*.js`), então o entry tem ~232KB de 5,6MB; (b) grep nos chunks `Farmer*.js` das páginas, quando o hook mora em chunk separado; (c) `xargs` abortando com `command line cannot be assembled, too long` → **0 arquivos baixados** e os dois greps seguintes lendo um diretório vazio, com cara de "não achei". Nas três o controle denunciou na hora. **Corolário:** valide a assinatura contra o código PRÉ-fix (`git show <sha>~1:<arquivo> | grep -c '<assinatura>'` tem de dar **0**, e `<sha>` dar ≥1) — sem isso você prova que uma string existe, não que a MUDANÇA entrou. **E prefira a skill à varredura ad-hoc:** ela já resolve paralelismo e lista de chunks; refazer com `curl` na mão é como se cai nos três buracos acima.
- **Fix que é uma AUSÊNCIA não se prova por bytes.** Remover um `|| 0`, um fallback ou um default não deixa assinatura: no bundle minificado o nome da variável sumiu, e `x.get(a)||0` legítimo (contador, onde 0 é a resposta certa) é indistinguível do que você tirou. Ou você grepa o **par positivo** que entrou junto (no #1471, o `.order("product_id"` da paginação, que só existe pós-fix), ou aceita que a prova é **comportamental** — e vai para a tela.
- **QA visual pós-Publish** (renderização/comportamento na tela, refactor visual sem texto novo): os bytes não bastam e o `/browse` headless **não monta** a SPA. O padrão é **Claude-in-Chrome na sessão logada do founder** (ele abre o app 1×; o agente confere as telas) — detalhado no Passo 4b da skill `lovable-deploy-verify`.
- O acesso **read-only** ao banco (`psql-ro`, ver `docs/agent/database.md`) confirma migration aplicada sem depender do founder.

## Atualização do PWA — modelo `prompt` (offline-first; #1169)

O SW usa `registerType: 'prompt'` (não `autoUpdate`): a versão nova **instala mas espera** e o operador clica "Atualizar" (toast em `src/lib/pwa-update.ts` → `updateSW(true)` posta `SKIP_WAITING` + reload). Fim do reload-surpresa no meio do turno. **Invariantes ao mexer no `vite.config.ts` (bloco `VitePWA`) — não repetir os P1 que o Codex pegou:**

- **`skipWaiting` FICA removido** (era `true`): é ele que forçava a ativação/reload automáticos. Reintroduzir volta o reload-surpresa.
- **`clientsClaim: true` NÃO se remove junto** — parecem par, mas não são. Sem ele, na **1ª instalação** o SW não controla a aba atual até o próximo reload → se a rede cair na mesma sessão, **offline-first não funciona no primeiro acesso**. Ele não causa reload-surpresa (só o `skipWaiting` causava); só faz claim quando o SW ativa (que na atualização só ocorre após o clique).
- **Registro do SW tem fallback** — `main.tsx` faz `import('./lib/pwa-update')` guardado por `__PWA_ENABLED__` (build const = `production && !preview`; DCE remove em dev/preview, onde `virtual:pwa-register` nem existe). No `.catch`, cai pra `navigator.serviceWorker.register('/sw.js')`: offline-first não pode depender de um import lazy resolver.
- **A verificação de deploy NÃO é cegada pelo prompt mode** — `verify-frontend.sh` usa `curl` direto no host (sem service worker), então mede os **bytes do servidor**, não um cliente com SW velho. O cron não é um browser.
- **Prova de build** (não confiar na config): `dist/sw.js` deve ter `skipWaiting` **só dentro do listener de `message`** (não no `install`) + `clientsClaim` presente. `dist/index.html` **sem** auto-register (por `injectRegister: false`).
- **Transição única no 1º Publish com prompt mode:** clientes com o SW antigo (autoUpdate) auto-recarregam **uma última vez** ao pegar este build; daí em diante toda atualização vira o toast. Inerente, não dá pra evitar.
