# Publish automático do Lovable pela API (2026-10-11)

> ⚠️ **Estado em 2026-11-22: DESLIGADO na prática** (secret `LOVABLE_API_KEY` ausente — run 45023928279 saiu `success` sem publicar).
> **Reverificado em 2026-11-22 nas docs atuais:** criar API key exige **Business ou Enterprise** (docs.lovable.dev/features/api-keys.md — Free/Pro veem "upgrade prompt");
> `POST /v1/projects/{id}/publish` marca "**Plan:** Business or higher" e 402 "Public API access requires Business or higher"
> (docs.lovable.dev/api-reference/deploy-domains/publish-project.md); a tabela de planos marca "Lovable API" e "Workspace publish" como "—" no Pro.
> **Não há auto-publish nativo**: o GitHub só sincroniza para DENTRO do Lovable, e o ar "keeps showing the version you published" até novo Publish
> (features/publish.md, integrations/github.md). No Pro, o caminho é o **vigia local** (`scripts/lovable-vigia.sh`, launchd): tick barato
> `scripts/lovable-publish.sh --julgar` (sem chave, sem API) e, só no veredito `PUBLICAR`, `claude -p` (Haiku) com `mcp__lovable__deploy_project`.
> **Vigia local (2026-11-22):** ver § "Vigia local no Mac" abaixo.

**Incidente que motiva:** "merge ≠ produção" — `steu.lovable.app` serve o build velho até alguém
clicar Publish (lição de 2026-05-31; recorrente no `/fecho`). A API do Lovable passou a expor
`POST /v1/projects/{id}/publish` (versão `2026-09-11`, plano Business, escopo `projects:write`).

## Desenho

`.github/workflows/lovable-publish.yml` (cron de 15 min + push do bot + `workflow_dispatch`) → `scripts/lovable-publish.sh`:

1. lê o SHA que o ar serve (`__BUILD_SHA__` no entry; 1 carimbo, resolvível, ancestral de HEAD);
2. intervalo ar..HEAD com `supabase/migrations/` ou `supabase/functions/` → **RETIDO** (o Publish
   leva a main inteira; ordem DDL → edges → Publish). Liberação só para UM SHA (`liberar_sha`);
3. intervalo só com caminhos inertes (docs/.github/.claude/scripts/db/supabase/`*.md` na raiz) → nada;
4. espera `latest_commit_sha` do projeto == HEAD (main andou → SUPERADO, o run seguinte decide);
5. POST `{"name":"steu"}` + polling do deployment (backoff 2→10 s);
6. **prova pelo ar**: o carimbo servido tem de virar HEAD; descendente → re-julga HEAD..servido.

## O que o challenge Codex (gpt-6-astra/xhigh, 118 s) mudou

- Marcador "último run verde" era bug crítico (um run RETIDO verde apagaria a migration do
  intervalo seguinte) → o marcador é o **ar**, que também reconcilia Publish manual (MCP).
- Consulta do workspace + POST **não é atômico**: o Lovable pode publicar B tendo validado A →
  passo 6 re-julga o intervalo até o que de fato foi servido (`PUBLICOU_NAO_AVALIADO`, exit 22).
- Resultado ambíguo (503 sem id, status sem desfecho) **trava** os runs seguintes via Issue.
- Sem `force` genérico: `liberar_sha` precisa ser o HEAD exato.
- Filtro de "publicável" invertido: padrão é publicar; `package.json`/lock/config contam.

## Mordido no próprio merge: `push:` não vê merge de PR

O #2958 nasceu só com `on: push` e **nunca rodou** — nem no merge dele (14:43Z, zero runs). O
auto-merge.yml mergeia com o `GITHUB_TOKEN` (`mergedBy` = app/github-actions), e a proteção
anti-loop do GitHub não dispara workflow a partir disso: nem `push`, nem `pull_request: closed`. O
`ci.yml` já documentava o MESMO buraco (o `push:` dele só pega commit direto do bot do Lovable) —
o mapa existia e eu não perguntei "quem dispara este gatilho?". A suíte com curl falso não podia
ver isso: ela testa o script, não a fiação. Correção: `schedule` a cada 15 min (o script é
idempotente; ar em dia = `JA_NO_AR` com 2 leituras), Issues deduplicadas por SHA+veredito, e a
trava de ambíguo virou aviso (vermelho a cada 15 min seria spam; o alarme é a Issue).
**Lição:** workflow novo que reage à main — confira no `gh run list` que o evento chega, antes de
afirmar que "roda a cada merge".

## Fora de escopo, conscientemente

- O gate é por **diff**, não por banco: não prova migration APLICADA, e front novo chamando RPC
  sem migration no intervalo passa. Fechar isso exige credencial de banco no CI (`pendencias:deploy`
  / `audit-custom-migrations` via psql) — decisão separada.
- Compatibilidade de PWA com contrato velho (DDL aditiva).

## Prova

`scripts/test-lovable-publish.sh` (no `test:hooks`): 20 cenários com curl falso + controle
sabotado na mesma invocação. Falsificado em cópia, camada por camada (corrida, 503, prova pelo ar
com CDN lento, ancestralidade, nada-a-publicar, liberar_sha): todas vermelhas.

## Vigia local no Mac (2026-11-22) — o caminho no plano Pro

`scripts/lovable-vigia.sh`, instalado por `scripts/lovable-vigia-instalar.sh` como LaunchAgent
`dev.afiacao.lovable-vigia` (60 s; era 180 s até 2026-11-26). Clone PRÓPRIO em `~/.local/share/afiacao/vigia-repo` (checkout
de `origin/main` a cada tick — nunca um worktree de sessão); estado/log em
`~/.local/state/afiacao/lovable-vigia/` (`vigia.log` rotacionado 1 MB×3; `touch pausado` pausa).

- **Tick sem LLM:** `lovable-publish.sh --julgar` (passos 1-3, sem chave/API). Só `PUBLICAR` chama
  `claude -p --model haiku --allowedTools "mcp__lovable__get_project mcp__lovable__deploy_project"`;
  o modelo confere `latest_commit_sha == main` antes do `deploy_project {name: steu}` (~US$ 0,04).
- **Gate de edge com evidência, não com clique:** o julgamento real de 2026-11-22 deu RETIDO por um
  commit de edge "sem Publish" (#4123) — e como o ar só anda com Publish, o gate de diff seguraria
  o front PARA SEMPRE. Regra nova (só no vigia, que tem `psql-ro`): intervalo com SÓ
  `supabase/functions/` → libera se `bun run pendencias:deploy` sair **0** (toda edge da main
  servida, pelo ledger `deploy_atestacoes`); 1 = espera (aviso 1x/SHA); 2 = mecânica, não libera.
  **Migration** no intervalo segue RETIDA: aviso 1x/SHA e liberação manual `echo <sha> > liberar`.
- **Prova pelo ar** (carimbo servido == main, até 8 min); falha → backoff 5/15/60 min no MESMO SHA
  e, na 3ª, notificação macOS + Issue; main nova destrava.
- **Auth:** o app desktop não empresta login a processos do launchd — `claude auth status` dava
  `loggedIn:false`. Token de 1 ano (`claude setup-token`) no Keychain, serviço `claude-vigia-lovable`.
  **Mordida:** no painel do app o token sai MASCARADO e quebrado em 2 linhas; copiar só a visível
  gravou 29/79 de 108 caracteres. Confira tamanho/prefixo `sk-ant-oat` sem exibir o valor.
- **Ensaios** (clone descartável + ar falso em `http.server`, `LV_SECO=1`): edge+ledger=0 → PUBLICAR;
  migration → 1 aviso em 2 ticks, sem publicar; `claude` falso com erro → `1/3` e o tick seguinte
  não re-chama; ar em dia → NADA_A_PUBLICAR.
- **Fora do alcance:** Mac desligado/dormindo = sem Publish (o workflow do GitHub segue sem chave).
- **Sessão espera sem polling (2026-11-25):** `lovable-publish.sh --esperar <sha-merge>` em background (shell, sem LLM) sai `NO_AR`/`NADA_A_PUBLICAR` (0), `RETIDO=<camada>` (10, lendo `liberar`/`pendencias-<sha>` do vigia), `TIMEOUT` (30) — uso em `docs/agent/deploy.md` Camada 2.

## 1ª medição em produção (2026-11-22 → 25)

407 ticks, **8 `PUBLICADO` provados pelo ar** (40–80 s após o disparo; 1º: `ecefeb53`), nenhum SHA
desistido (3x). Retenções por migration avisaram 1x/SHA e foram publicadas à mão depois da DDL —
o comportamento desenhado. Mas **11 de 19 chamadas ao `claude -p` falharam na 1ª**: o MCP `lovable`
ainda não estava conectado quando o modelo começou ("ferramentas_mcp_nao_disponiveis", "session
tools unavailable", timeout 124). O backoff segurou o custo, mas cada uma atrasava o Publish 5 min.
Correção: `MCP_TIMEOUT=60000` + 2ª chamada no MESMO tick (publicar 2x o mesmo commit é idempotente).
Ensaio: `claude` falso que falha na 1ª e dispara na 2ª → 2 chamadas, `DISPARADO`.

## Causa raiz das falhas do `claude -p` (2026-11-25) — não era conexão

A hipótese acima ("MCP ainda não conectado") **caiu com evidência**: em 30 de 33 transcrições do
vigia, e em 24/24 sondas com `stream-json` (`system/init`), o `lovable` estava `connected`. O defeito
era o **contexto**: sem flags, o `-p` herda a sessão interativa inteira (21 plugins com hooks, um deles
injetando "invoque skills antes de responder"; ~10 MCPs de plugin; ~100 ferramentas ADIADAS atrás do
`ToolSearch`). O Haiku carregava o `get_project` pelo `ToolSearch` e, na maioria, NÃO o invocava: ia pro
`Bash` (`echo`, `curl` no Lovable) e numa sonda chegou a `Agent`/`ListAgents`/**`SendMessage`** para
outras sessões. Na 2.1.283 o `MCP_TIMEOUT` nem governa a espera do 1º turno sem `--mcp-config`.

**Medição A/B** (prompt REAL do vigia com main fictícia `000…` — exige `get_project`, nunca publica;
`env -i` + PATH/HOME/USER do launchd; intercalado; sucesso = `tool_result` com `latest_commit_sha`):

| braço | `get_project` na 1ª | init `connected` | desvio Bash/Agent | mediana | custo (12) |
|---|---|---|---|---|---|
| antes (invocação da main) | **7/12** | 12/12 | 9/12 | 57 s | US$ 0,51 |
| depois (invocação mínima) | **12/12** | 12/12 | 0/12 | 16 s | US$ 0,15 |

**Conserto** (`scripts/lovable-vigia.sh`): `--strict-mcp-config` com SÓ o `lovable` (o OAuth do Keychain
é achado igual — a chave é `lovable|<hash da config>`), `ENABLE_TOOL_SEARCH=false`, `--tools ""`,
`--setting-sources ""`. E o **veredito sai do protocolo**, não do texto: `DISPARADO` só com `tool_result`
do `deploy_project` trazendo `deployment_id`; `NAO_SINCRONIZADO` só com `latest_commit_sha` lido ≠ main
(o modelo já tinha cravado `NAO_SINCRONIZADO` sem chamar ferramenta — adiava o SHA sem debitar);
deploy emitido sem aceite lido (`timeout` no meio) = `INDETERMINADO` → o ar decide, nunca redisparo.
Challenge Codex (gpt-6.2-astra/high, 202 s): aprovou o isolamento; exigiu o veredito por `tool_result`
casado por `tool_use_id`, o não-redisparo pós-deploy e o aviso por EPISÓDIO — todos adotados.
Teste: `scripts/test-lovable-vigia.sh` (no `test:hooks`) roda o vigia INTEIRO com falsos; contra o
vigia anterior os 6 casos reprovam, com controle verde na mesma invocação.

**Mordida secundária — `needs-auth` em cascata, compartilhado por TODA sessão Claude.** Uma única
leitura do Keychain que falhe (o token estava gravado e válido: 80/80 amostras em 20 min, e nenhuma
escrita no item no intervalo) faz o CLI gravar `lovable` em `~/.claude/mcp-needs-auth-cache.json`; daí
em diante todo `claude` pula a conexão ("Skipping connection (cached needs-auth)") por ≥6 min —
medido: 1 falha às 20:21 derrubou as 18 chamadas seguintes dos DOIS braços. O vigia agora lê o status
no `init`: `needs-auth` não debita o SHA, re-tenta em 10 min e avisa 1x por episódio. **Não** limpamos
o cache (estado compartilhado de dezenas de sessões). Isolar de vez = `CLAUDE_CONFIG_DIR` próprio do
vigia com login OAuth próprio no Lovable (exige 1 clique do founder) — só se o episódio se repetir.
**Armadilha de sonda:** `env -i` sem `USER` grava a entrada `acct=unknown` no Keychain e envenena o
cache acima — reproduza o launchd com `USER`/`LOGNAME` explícitos (o vigia agora os exporta).

### 1º PUBLICAR real pós-#4189 caiu no `needs-auth` — e desta vez o token SUMIU (2026-11-25 23:05)

`claude (1/2) rc=0 mcp=needs-auth usos=nenhum → NEEDS_AUTH`: o vigia reagiu como desenhado (sem debitar
o SHA, re-tenta em 10 min, 1 aviso). Mas a causa não era leitura transitória: a entrada `lovable` do
item `Claude Code-credentials` ficou só com `discoveryState` (sem access nem refresh token), gravada às
22:33 — o mesmo minuto em que o cache marcou `needs-auth`. O item é UM blob JSON (79 MCPs + login)
reescrito por dezenas de sessões Claude; com refresh token rotativo, quem renova em paralelo ou grava
cópia velha apaga o token de todo mundo. **Conserto: store próprio do vigia** — `CLAUDE_CONFIG_DIR`
(provado: o CLI cria outro item, `Claude Code-credentials-<hash>`, e outro `mcp-needs-auth-cache.json`),
com 1 escritor (o lock do vigia). Ativação única pelo founder: `scripts/lovable-vigia-instalar.sh --login`
(OAuth no navegador); o vigia só passa a usar o store quando existe `.vigia-pronto` — sem ele, segue no
padrão. As sessões interativas também perderam o `lovable` nesse episódio: `/mcp` → lovable para religar.

## Plano de 5 PRs pós-auditoria (2026-11-26) — PR 1: liberação que funciona

**Medido no `vigia.log` (22–26/11, auditoria Fable):** 36 RETIDO por migration contra 2 liberações
manuais, e NENHUMA das duas virou PUBLICADO; mediana ~5 h retido (pior 42,7 h). As duas liberações
morreram pelo mesmo motivo: `liberar` exigia `== main de agora`, e a main andou minutos depois
(25/11 23:04 liberou `3bda3e02`, a main foi a `c39f1f5a`; 26/11 08:36 liberou `39ea6374`, a main foi
a `8ca02e51` às 08:38). O `--esperar` saía RETIDO com o `liberar` gravado.

O que mudou (só `scripts/` e docs):

- **Decisão única** `lovable-publish.sh --decidir <sha>`: o vigia e o `--esperar` chamam a MESMA função,
  com o mesmo estado (`$LP_ESTADO` = o diretório do vigia) e a mesma validade do cache de edge
  (`LP_CACHE_EDGE_MIN`, 15 min). Antes o `--esperar` reimplementava a política e lia o cache sem idade.
  Últimas linhas preservadas: o vigia lê `VEREDITO=`; o `--esperar` segue saindo `RETIDO=migration:<arq>`.
- **`liberar` vale para descendentes:** aceito se for SHA de 40 hex, ancestral de HEAD e
  `git diff LIBERADO HEAD -- supabase/migrations` vazio (tecnicamente: as camadas passam a ser julgadas
  em `LIBERADO..HEAD`). `HEAD`, ramo e abreviado são ignorados com aviso. Comando novo:
  `bash scripts/lovable-publish.sh --liberar <sha40>` — valida contra a origin/main, mostra a main
  medida e as migrations cobertas, grava atômico (tmp + mv). Vale também para `LP_LIBERAR_SHA` do workflow.
- **`liberar` cobre SÓ migration:** edge entre o ar e o liberado segue pelo ledger — o humano atesta "apliquei as migrations", não edge.
- **Piso de migrations atestadas** (`$EST/piso`): decisão limpa que se apoiou em atestação humana
  (liberar ou piso anterior) imprime `PISO=<main>` e o vigia grava — o PR de front seguinte a uma
  migration liberada não re-trava, mesmo que o `liberar` seja sobrescrito.
- **Só migration/inerte no intervalo → `NADA_A_PUBLICAR`** (sem avançar o piso): ninguém espera Publish,
  e a camada continua no intervalo do próximo PR porque o marcador é o ar.
- **Não retêm:** `supabase/functions/**/*_test.ts` e `supabase/functions/**/*.md`.
- **Aviso por episódio:** 1 notificação quando o RETIDO começa, lembrete a cada `LV_RELEMBRA_H` (4 h) com a
  idade, log `RETIDO ar=… main=… <motivo>` quando o par muda e `fim do episódio RETIDO após N min`.
  Antes era 1 aviso por SHA (cada merge re-notificava o mesmo bloqueio). `PUBLICAR` loga `liberado: <fonte>`.
- **`--esperar` em RETIDO** imprime o comando de liberação da main atual e distingue
  `liberado para SHA antigo <sha> — migration(s) depois dele`.

**Challenge Codex (gpt-6.2-astra/high) — 9 achados, 8 novos, todos aceitos:**
o piso NÃO cobre edge (o ledger vale 15 min e a edge pode sofrer rollback depois — edge é sempre
`ar..HEAD` + ledger fresco para HEAD); o ledger mede a main que ele mesmo buscou → o vigia confere
`ls-remote` depois e descarta a prova se a main andou; `JA_NO_AR` e decisão sem atestação humana não
gravam piso (carimbo igual prova o front, não a migration — um rollback do ar deixaria piso falso);
`git diff --no-renames` (mover `index.ts` para `index_test.ts` esconderia a remoção da edge); cada
atestação (ar, liberar, piso) é testada SOZINHA contra HEAD — piso e liberar em ramos irmãos são
incomparáveis e a regra "a mais nova" ignorava o liberar; o `--esperar` usa o ar que a decisão MEDIU
(`AR=` completo) e sai `MECANICA=FRONT_SUPERADO` quando a main reverteu o front pedido sem publicá-lo;
e o `--esperar` roda o decisor da main medida (`git show <main>:scripts/lovable-publish.sh`), para que
um worktree velho não decida com a regra velha.

Prova: `scripts/test-lovable-publish.sh` reproduz os dois casos reais (`dec_caso_2511` pelo `--decidir`,
`esperar_caso_2611` pelo `--esperar`) e ambos saem LIBERADO/NO_AR; falsificação com controle verde na
mesma invocação (ancestral→igualdade, piso ignorado, filtro de teste de edge desligado, sabotagem do
RETIDO do `--esperar`), mais 4 sabotagens externas da suíte inteira (filtro, piso, linha `PISO=`, gravação
do `--liberar`) — todas vermelhas no cenário certo. `scripts/test-lovable-vigia.sh`: ledger renovado pelo
vigia + piso gravado, e o roteiro do episódio RETIDO (falsificado: vigia que re-avisa a cada tick reprova).

## PR 2 (2026-11-26): liberação automática pelo recibo do `db:aplicar`

**Incidente que justifica a máquina (regra de máquina meta):** o mesmo do PR 1 — `vigia.log` 22–26/11,
36 RETIDO por migration × 2 liberações manuais, mediana ~5 h retido (pior 42,7 h). Mesmo com o
`liberar` consertado, toda migration ainda dependia de um humano lembrar de liberar, e quem aplica
pelo `db:aplicar` JÁ deixa a prova: recibo `aplicada` em `public.db_aplicacoes`, pelo SHA-256 dos
bytes commitados.

- `scripts/lovable-recibos.sh <ar> <head>` (psql-ro, só leitura): por migration de `ar..head`
  (`--no-renames`), SHA-256 de `git show <head>:<arq>` contra o ledger → `aplicada` · `adiada` ·
  `desconhecido` (`tentativa`/`desconhecido` sem `aplicada`) · `sem_recibo` (nada, ou só `falhou`) ·
  `removida`. Veredito 0/1/2; ler falhou = 2. **Nunca** `schema_migrations`
  (docs/historico/schema-migrations-fail-open.md).
- `--decidir`: migration sem atestação → cache `recibos-<ar>-<head>` (o vigia grava; válido
  `LP_CACHE_RECIBO_MIN`=5 min; o ar entra na chave porque muda o conjunto). 0 = `LIBERADO=recibos`;
  1 = RETIDO; 2 = RETIDO com "recibo DESCONHECIDO" (não libera o que pode ter rodado pela metade);
  ausente/vencido = `PRECISA_RECIBOS` (exit 12). Recibo **não** grava piso: `adiada` é revogável e o
  recibo se relê a cada decisão.
- **Status `adiada`**: tabela `public.db_migracoes_adiadas` (migration `20261126230001`, aplicada pelo
  `db:aplicar`: ensaio → apply #1507 → validação por psql-ro). RLS, ACL por allowlist (dono, claude_rw
  INSERT/UPDATE/SELECT, claude_ro SELECT — uma linha forjada liberaria o Publish; o default ACL dava
  escrita a service_role/sandbox_exec_*), sem DELETE (desfazer = `revogada_em`). Escrita:
  `bash scripts/db-adiar.sh <arq> "<motivo>"` / `--revogar <arq>`, com releitura. Prova PG17:
  `db/test-db-migracoes-adiadas.sh` (falsificação: sem o bloco de allowlist, a postcondição A3 aborta),
  em `LC_ALL=C` e `pt_BR.UTF-8`.
- **Edge que o ledger não prova** (`supabase/functions/_shared/**`, ou função sem `versao.ts` em HEAD):
  `pendencias:deploy=0` não libera; exige `liberar` sem mudança nela depois. Instrumentar as 11 edges
  sem `versao.ts` ficou fora.
- Vigia: laço de até 3 renovações (`PRECISA_RECIBOS` → recibos, `PRECISA_LEDGER` → ledger) e nova
  decisão; loga `recibos ar=… main=…: <resultado>` só quando muda.

Testes: `scripts/test-lovable-recibos.sh` (psql-ro/psql-rw falsos; falsificação: `tentativa` tratada
como sem recibo, e `db-adiar` sem releitura), `scripts/test-lovable-publish.sh` (+recibos 0/1/2,
ausente, vencido, de outro ar, ilegível; edge sem versão/_shared; sabotagens `rec_desc` e `semv`),
`scripts/test-lovable-vigia.sh` OK (13).

**Challenge Codex do PR 2 (gpt-6.2-astra/high) — 9 achados, todos tratados:** recibo casa CAMINHO + SHA
(os mesmos bytes noutro arquivo não provam este); `tentativa`/`desconhecido` vencem `adiada` (apply em
curso não se esconde atrás do adiamento); a base dos recibos é a atestação humana válida (liberar/piso),
não só o ar — migration do SQL Editor liberada à mão não volta a travar quando chega outra com recibo
(`RECIBOS_DE=` na decisão); edge sem `versao.ts` compara o DIRETÓRIO inteiro da função contra o liberar
(um helper revertido sumia do intervalo); `core.quotePath=false` (nome com acento saía entre aspas e
escapava do gate); `db-adiar.sh` com nome estrito e valores por variável do psql (`:'x'`, SQL pela
entrada — o nome do arquivo entrava como SQL na conexão `claude_rw`) e recusa `--revogar` de migration já
atrás do ar (o gate não a olharia de novo: o caminho é aplicar); e, liberado por recibo, o vigia RELÊ os
recibos imediatamente antes do disparo (uma revogação durante o ledger perdia para o cache de 5 min).
Grant por COLUNA (`attacl`) e membro herdando `claude_rw`: medidos em PROD em 26/11 — zero `attacl` na
tabela, único membro do `claude_rw` é o dono `postgres`; sem migration nova, fica registrado.

**Pronto do PR 2 no `vigia.log` (26/11 22:59):** o vigia já roda a versão de `f81162f6`, lê os recibos
(`recibos ar=39ea6374 main=f81162f6: 1 …`) e RETÉM corretamente: 10 `aplicada` e 3 `sem_recibo`
(`20261126233000_omie_os_espelho`, `20261127000000_fin_mov_chave_ncodbaixa`,
`20261127100000_credito_painel_nome_grupo`). O par `liberado: recibos` → `PUBLICADO` ainda não aconteceu:
fica para quando essas 3 tiverem recibo (ou forem adiadas por `db-adiar.sh`).

## PR 3 (2026-11-27): disparo à prova de erro

**Incidente:** o mesmo do plano (auditoria Fable + Codex, itens 4/6/7/8/9). Os buracos eram de disparo:
store padrão como fallback (o blob onde o token do lovable SUMIU em 25/11), nenhuma memória de um deploy
em voo quando o stream terminava inconclusivo, `DISPARADO` aceito sem conferir projeto/slug/SHA, ar
divergente só em log, lock roubado pela idade, prazos por contagem de `sleep`.

- **Store próprio obrigatório:** sem `$CFG_DIR/.vigia-pronto` o vigia avisa 1x por episódio (`$EST/sem-store`)
  e PARA, sem chamar o claude. `needs-auth` é por episódio: acaba na 1ª leitura do PROJETO em qualquer das
  2 chamadas.
- **Intenção** (`$EST/intencao`: `sha= hora= tentativa= ar=` + `dep=` quando lido), gravada atomicamente
  ANTES de qualquer `claude -p`. Se a gravação falhar, não há disparo. Só some quando: o stream está COMPLETO
  (tem `result`) sem `deploy_project`; o ar mudou (é reclassificado contra o `sha` da intenção, mesmo num
  tick posterior); ou passaram `LV_INTENCAO_S` (1200 s). Enquanto pendente, nenhum disparo e nem releitura
  de recibos. Stream truncado sem deploy visível = `INDETERMINADO`, sem 2ª chamada.
- **Controle determinístico do stream** (`controle()` em jq): ≤1 `deploy_project`; `project_id` = PROJETO;
  `name` = `steu`; `get_project` do mesmo projeto com resultado sem erro e ANTERIOR ao deploy na ordem do
  stream; `latest_commit_sha` NA RAIZ do JSON (o texto real vem com o prefixo `[Image: …]`) = HEAD. Fora
  disso → `VIOLACAO`: desiste do SHA na hora (3/3, aviso + Issue) e mantém a intenção. A escrita no Lovable
  não é interceptável pelo stream: o controle impede que o vigia aceite um deploy fora do roteiro e o escala.
  `SHA_LOV`/`DEP_ID` só valem de chamadas com o `project_id` certo.
- **Reconciliação do ar** (`classifica()`): alvo · `PUBLICADO_ADIANTE` (descendente limpo) · descendente COM
  camada (aviso por SHA, nomeando o arquivo) · **divergente** → `$EST/alerta-divergente` + aviso por
  episódio, que só acaba quando o ar sai daquele SHA. Carimbo que o clone não conhece → `fetch` e o curto cru. Stream vazio (sem `init`) = nada rodou.
- **Lock = PID + posse:** `$EST/lock/pid`; só é tomado se o dono morreu ou se o PID foi reciclado por algo
  que não é `bash …/lovable-vigia.sh` (um `tail -f vigia.log` não segura o lock). A tomada passa por
  `lock.tomada` com re-conferência do PID. Dono vivo há >60 min → aviso, sem roubo.
- **Relógio:** a prova pelo ar mede `date +%s` decorrido (`LV_PASSO_AR`); o backoff conta do FIM da falha
  (`adia`). A Issue de desistência que não abriu (gh fora) fica em `$EST/issue-pendente` e é re-tentada no
  máximo a cada 15 min.

Testes: `scripts/test-lovable-vigia.sh` OK (53). As falsificações rodam com controle verde na MESMA invocação
(`falsifica <nome> <sed> <roteiro>`: o roteiro passa no vigia real, a sabotagem tem de casar e o roteiro
tem de reprovar o sabotado): `controle`, `intencao`, `lock`, `backoff`, `truncado`, `le_e_cai`, `issue`,
`store` e o lembrete do episódio RETIDO.

**Challenge Codex do PR 3 (gpt-6.2-astra/high, 89 s): 10 achados, todos tratados.** Timeout podia gerar
2 deploys num tick (stream truncado = `SEM_DEPLOY` → 2ª chamada). Dois ticks podiam tomar o mesmo lock
morto (B renomeava o lock novo de A). Intenção não gravada ainda disparava. O SHA era casado no texto
inteiro, e um objeto aninhado passava. Publicação tardia divergente apagava a intenção sem alerta. Carimbo
não resolvível virava "ar segue". PID reciclado por `tail -f vigia.log` travava todo tick. `get_project` de
outro projeto adiava para sempre. O episódio `needs-auth` se perdia entre as 2 chamadas. A Issue que não
abriu sumia em silêncio.

## PR 4 (2026-11-27): higiene — instalador verificável, menos rede, docs e workflow

- **Instalador verificável:** `scripts/lovable-vigia-instalar.sh --verificar` roda o mesmo `claude -p` mínimo
  sob `env -i`, com só `HOME`/`USER`/`LOGNAME`, o PATH do plist, o store próprio e o token. Exige um
  `tool_result` do `get_project` com `latest_commit_sha` de 40 hex na raiz. O `--login` e a instalação
  terminam nele: sem prova, exit 1 e "NÃO verificado". Estado (`$EST`) e store com `chmod 700`; o vigia
  re-aplica o `chmod` no estado a cada tick.
- **Menos rede:** cada tick faz 1 `ls-remote`; o `fetch` só roda quando a main aponta para um commit que
  o clone ainda não tem, e o checkout só quando o HEAD local não é a main. O `bun install` já era
  condicionado ao `bun.lock` (`bun-lock.sha`).
- **Docs:** `docs/agent/deploy.md` não diz mais "Publish automático DESLIGADO": quem publica é o vigia.
  O cabeçalho do vigia diz 60 s (antes dizia 3 min).
- **Workflow:** `schedule:` do `lovable-publish.yml` desligado. Sem o secret `LOVABLE_API_KEY` eram ~96
  runs verdes por dia sem publicar. Ficam `push`/`workflow_dispatch`.

Testes: `scripts/test-lovable-vigia.sh` OK (65). Falsificações com controle verde na mesma invocação:
`sem_fetch` (sem o atalho, o clone ganha `FETCH_HEAD`), `checkout_f` (sem `-f`, um decisor adulterado no
clone segue rodando), `env_i` (sem o `env -i`, `LVT_VAZA`/`ANTHROPIC_BASE_URL` da sessão vazam para o claude)
e `token` (sem o token, o dublê não o recebe).

**Challenge Codex do PR 4 (gpt-6.2-astra/high, 53 s): 8 achados; 7 tratados, 1 registrado como resíduo.**
- O checkout ficou SEMPRE e com `-f`. Com o "só se HEAD ≠ main", um `lovable-publish.sh` restaurado à mão
  no clone rodava um decisor velho com o HEAD certo; os testes agora mudam ARQUIVO, não só o SHA.
- O plist leva `LV_CLAUDE_DIR` = o store verificado (um `--login` num store alternativo dava OK e o vigia
  parava em `sem-store`).
- `jq` é resolvido pelo PATH do launchd, e o `--verificar` re-tenta 1x quando a 1ª chamada não usou
  ferramenta, como o vigia faz.
- O teste exige que o token chegue ao claude.
- **Resíduo (anterior ao PR 4):** o Lovable pode sincronizar um commit B entre o `get_project` (= A) e o
  `deploy_project`, que não recebe SHA. O pós-deploy classifica B e avisa "COM camada" se houver migration
  ou edge no meio, mas DEPOIS do Publish. Fechar isso exige um deploy por SHA, que o MCP não oferece.

## PR 5 (2026-11-27): medir a 1ª chamada antes de tirar o modelo do disparo

O disparo ainda passa por um LLM (Haiku), que chama `get_project` + `deploy_project`. Tirar o modelo e chamar o
MCP direto é decisão de arquitetura e espera um **número**, não impressão. O PR 5 versiona o comando que gera
esse número; o modelo **não** sai do disparo agora.

- **Comando:** `scripts/vigia-taxa-1a-chamada.sh [log] [dias]` (default `vigia.log` + `.1`/`.2`, 7 dias).
  - Conta as linhas `claude (1/2) rc=… → <RESULTADO>`.
  - **Acerto** = `DISPARADO` ou `NAO_SINCRONIZADO`, quando o protocolo andou e o veredito saiu do tool_result.
  - Imprime o **denominador**. Sem 1ª chamada na janela → `TAXA=SEM_DADO denominador=0` e exit 3 (ausente ≠ zero).
  - Só conta a era do protocolo, ou seja, as linhas com ` mcp=` (desde o #4189). As linhas legadas `VIGIA=…`
    traziam o texto do modelo, que chegou a fabricar DISPARADO. Por isso saem do denominador e aparecem à
    parte em `legado_excluido=`.
- **Teste:** `scripts/test-vigia-taxa-1a-chamada.sh` (no `test:hooks`) dá OK (18). O log fabricado tem 3
  arquivos e o `.2` contribui. Esperado: `TAXA=37.5% acertos=3 denominador=8 legado_excluido=1` em 7 dias e
  `28.6%` com denominador 7 em 5 dias; a comparação é LITERAL, em `C` e em `pt_BR.UTF-8`. Também cobre:
  - vazio/ausente → exit 3;
  - só ERRO → `0.0%` com exit 0 (zero ≠ ausente);
  - 113/119 aparece `95.0%` com `corte95=NAO_ATINGIDO`;
  - arquivo rotacionado ilegível → exit 2, sem taxa parcial.
  As sabotagens têm controle verde na mesma invocação e o mutante precisa RODAR: `janela`, `teto`,
  `rotacionados`, `legado`, `acerto`, `so_primeira`, `primeira_seta`, `dias` e `locale`.
- **Challenge Codex do PR 5 (gpt-6.2-astra/high, 80 s): 8 achados, todos tratados.**
  - O mais grave: `sub(/.* → /)` pegava a ÚLTIMA seta, e `→ ERRO (modelo: … → DISPARADO)` contava como
    acerto. Agora o resultado é a 1ª palavra depois da 1ª seta, e o cabeçalho é reconhecido por CAMPO
    (`$3=claude $4=(1/2) $5=rc= $6=mcp=`). Antes, um legado que terminava em `mcp=…` entrava no
    denominador, e um `(2/2)` que citava `(1/2)` também.
  - Leitura que falha aborta (antes saía com taxa parcial e exit 0). Rotação durante a leitura é detectada
    por inode e relida.
  - Janela com teto (linha do futuro não entra) e início validado (um GNU `date` que não converte deixava
    a janela vazia, ou seja, todo o histórico).
  - `LC_ALL=C`: em pt_BR o awk do macOS imprimia `33,3`, e o `grep` do teste aceitava, porque o `.` é curinga.
  - O corte sai em inteiro em `corte95=`: o % arredondado pode virar a decisão.
  - Teste: o `.2` contribui, `dias` varia, há o caso zero-acerto, e mutante quebrado não conta como vermelho.
- **1ª medição (2026-11-27):** `TAXA=75.0% acertos=3 denominador=4 legado_excluido=4 corte95=NAO_ATINGIDO`. São 3 DISPARADO e
  1 NEEDS_AUTH (o episódio de 25/11, em que o token sumiu). **Denominador 4 não decide nada.**
- **Decisão, por volta de 03/12/2026:** rodar o comando (janela de 7 dias) e registrar a linha `TAXA=` aqui. Quem decide é `corte95=`, não o %.
  - **≥95%:** fica como está, fechado com o número.
  - **Abaixo de 95%:** o próximo PR tira o LLM do disparo e chama o MCP do Lovable direto.
  - Com denominador pequeno (o vigia só chama o claude quando há o que publicar), registrar o número com o
    denominador e decidir explicitamente. "Ninguém reclamou" não é sinal.

## Fecho do roteiro (2026-11-27): item 12 decidido e base dos recibos corrigida

**Item 12 decidido em 27/11, sem esperar 03/12.** O founder pediu para fechar o roteiro.
- Medição: `TAXA=85.7% acertos=6 denominador=7 legado_excluido=4 corte95=NAO_ATINGIDO` (7 dias).
- A única falha é o `NEEDS_AUTH` de 25/11 23:05, quando o token do MCP sumiu do Keychain compartilhado.
  Com `mcp=connected` foram 6/6 `DISPARADO`. Tirar o LLM **não** cura essa falha: a chamada direta ao MCP
  usa o mesmo OAuth. A causa já foi tratada no #4193 (store próprio do vigia).
- **Decisão: o modelo fica no disparo.** É um desvio explícito do corte pré-registrado (<95% → tirar o LLM):
  o corte media "o modelo erra", e o erro medido é de autenticação. Reabre se aparecer uma falha com
  `mcp=connected` que não seja `DISPARADO`/`NAO_SINCRONIZADO`. Comando para reabrir: `scripts/vigia-taxa-1a-chamada.sh`.

**Por que a liberação por recibo nunca tinha disparado (bug, corrigido neste PR).** O
`lovable-publish.sh` escolhia como base dos recibos o arquivo `liberar` antes do ar, mesmo quando o
`liberar` era MAIS VELHO. O `liberar` de 26/11 08:35 (`39ea6374`) ficou no disco, e o intervalo
`39ea6374..HEAD` passou a incluir 2 migrations aplicadas fora do envelope e já servidas
(`20261126190127_sales_orders_claim_envio_conferido`, `20261127120100_pedido_edicao_omie_posse_duravel`).
Toda leitura de recibo devolvia `1` (`sem_recibo`), e o front ficava RETIDO até um Publish por fora.
- Correção: a base é o MAIS NOVO entre ar, `liberar` e piso, desde que seja ancestral de HEAD.
- Não abre fail-open: o `PEND`, que decide se há migration pendente, já parte do ar. O recibo só exigia a
  mais o que estava antes dele.
- Teste `dec_recibo_lib_velho` (ar à frente do `liberar`): verde com a correção, vermelho (rc=12
  `PRECISA_RECIBOS`) com o código antigo, em `C` e em `pt_BR.UTF-8`.
- Codex não consultado: cota em 99% até 02/12 (Caminho B).
- A prova em produção é a próxima linha `LIBERADO=recibos` no `vigia.log`
  (`grep LIBERADO=recibos ~/.local/state/afiacao/lovable-vigia/vigia.log`).

## Rodada 2 (2026-11-27): 19 melhorias da varredura B1–B5 / M1–M14

**Origem.** No `vigia.log` de 22 a 27/11 houve 17 `PUBLICADO` e **0** `LIBERADO=recibos`. Os 5 episódios RETIDO
terminaram todos com alguém publicando por fora. Uma varredura (Fable), conferida no log, achou 25 linhas
`CARIMBO_INVALIDO`, 132 linhas de recibo repetidas e nenhuma liberação por recibo. A lista B1–B5 / M1–M14 vira
6 PRs sequenciais (A–F), um por lote.

### PR A — higiene (B2, B3, B4, M4, M6, M9, M13)

- **B2, dedup do log de recibos.** `rm -f "$EST"/recibos-*` apagava também o `recibos-ultimo`, que é a memória do
  dedup. Por isso a mesma linha de ~400 caracteres voltava ao log a cada releitura (5 min, 11 vezes por hora).
  O glob agora é `recibos-[0-9a-f]*`, só os caches. Teste `r_dedup`: 3 releituras de mesmo conteúdo dão 1 linha.
- **B3, `liberar` ultrapassado.** A atestação humana só vale enquanto o ar for ancestral dela. Quando o ar a
  passa, o vigia apaga `$EST/liberar` e loga `liberar <sha> apagado: o ar (<sha>) já o ultrapassou`. No
  `lovable-publish.sh`, `retido()` deixa de dizer "liberado para SHA antigo" para esse caso
  (`liberar <sha> ultrapassado`). O ramo de edge sem versão/`_shared` também deixou de aceitar um `L` que o ar
  passou. Ali havia um verde falso real: um helper que muda (L→ar) e volta aos bytes de L em HEAD tem
  `diff L..HEAD` vazio, mas a edge servida é a do ar e precisa de deploy (teste `dec_semv_lib_ultrapassado`).
- **B4, MECANICA vira episódio.** Antes era 1 aviso por dia (`mecanica-<data>`), sem lembrete nem fim: em 27/11
  foram ~5 h de `CARIMBO_INVALIDO` com um aviso às 07:25 e mais nada. Agora segue a mesma lógica do RETIDO
  (`episodio()`): 1 aviso no início, lembrete a cada `LV_RELEMBRA_MEC_MIN` (60) com a idade, e
  `fim do episódio MECANICA após N min` quando a medida volta. Os arquivos são `mecanica-episodio` e `mecanica-chave`.
- **M4, cache de recibos invalidado no apply.** Quando o `db-aplicar.sh` grava `aplicada` (inclusive no caso
  "COMMIT chegou, resposta perdida"), ele apaga os `recibos-[0-9a-f]*` do vigia (`LP_VIGIA_ESTADO`, por padrão
  `~/.local/state/afiacao/lovable-vigia`). Assim o próximo tick relê o banco, sem esperar os 5 min do cache.
- **M6, batimento.** Toda invocação do launchd grava o epoch em `$EST/batimento`, inclusive a que sai porque o
  lock está com um tick vivo. Ao acordar depois de um buraco maior que `LV_BURACO_S` (300 s), o vigia loga
  `acordei após buraco de N min sem tick`. O `--esperar`, no prazo, troca o `TIMEOUT` cru por
  `TIMEOUT=vigia parado há N min` quando o batimento tem mais de `LP_BATIMENTO_VELHO_S` (300 s).
- **M9, publicado por fora.** `$EST/ar-ultimo` guarda o último ar medido (40 hex). Se o ar muda sem `intencao`
  do vigia, sai `JA_NO_AR por fora (ar A→B)`. O PR B reaproveita esse arquivo para o B1.
- **M13, tetos.** `avisados` tem teto de 200 linhas (fica com as 100 mais novas). Os caches `pendencias-*` e
  `recibos-*` de outra main são apagados a cada tick. O último stream do `claude -p` que não disparou fica em
  `claude-falha.jsonl`.

Prova: `test-lovable-vigia.sh` e `test-lovable-publish.sh`. Cada correção tem roteiro próprio e falsificação com
controle verde na mesma invocação (o real passa, a cópia sabotada na linha da correção reprova), em `LC_ALL=C` e
`pt_BR.UTF-8`.

### PR B — B1 (carimbo ausente) e B5 (dívida de camada)

- **B1, causa investigada.** Em 27/11, das 07:25 às 07:51, o entry servido `index-Bueh8PF1.js` não trazia nenhum
  `__BUILD_SHA__="<hex>"`: 25 linhas `CARIMBO_INVALIDO: 0 carimbos`, todas com o mesmo entry. Às 07:25:26 o bot do
  Lovable commitou `04a04a22f` "Work in progress" (`.env` + `types.ts`). Ou seja, houve um Publish **por fora**, do
  workspace sujo, segundos antes do commit. A causa provável é o `vite.config.ts` `resolveCommitSha()`: sem
  variável de commit e sem `.git`, ele cai em `"dev"`, e o regex hex de `sha_no_ar` não casa. Não deu para confirmar
  os bytes, porque o asset já respondia 404 quando fui olhar. Daí a 1ª correção: o motivo agora traz o que o
  bundle mostra no lugar, `CARIMBO_INVALIDO: 0 carimbos em <entry> (visto: __BUILD_SHA__=dev)` ou
  `(visto: nenhum __BUILD_SHA__)`.
  O "5 h de MECANICA" era quase todo um buraco do launchd: de 07:51 a 12:16 não houve tick, e o M6 agora loga isso.
- **B1, correção.** O vigia conta os ticks seguidos com `CARIMBO_INVALIDO` (`$EST/carimbo-invalido`). No 5º
  (`LV_CARIMBO_TICKS`), decide de novo com `LP_AR_FALLBACK=$(cat ar-ultimo)`, o último ar **medido**, gravado a cada
  leitura boa desde o PR A. O `--decidir` então julga as camadas a partir dele, com o gate inteiro (migration sem
  recibo e edge sem ledger seguem RETIDO). Nesse modo ele não aceita `JA_NO_AR` nem `NADA_A_PUBLICAR`, porque o
  servido é desconhecido e republicar a main é o que conserta o carimbo. Só `CARIMBO_INVALIDO` aciona o fallback:
  site fora ou entry que não baixa seguem `MECANICA`. Sem `ar-ultimo` é **fail-closed**: segue MECANICA e loga
  `sem ar-ultimo — fail-closed`. Na prova pelo ar, qualquer carimbo válido depois do deploy conta (`AR_ANTES`
  vazio); republicar sem o carimbo voltar cai no backoff 5/15/60 min e na Issue, como qualquer falha.
- **B5, dívida de camada.** Quando um episódio RETIDO termina em `JA_NO_AR`, o ar foi à main sem o vigia liberar.
  As camadas que seguravam o episódio (`$EST/retido-camadas`) viram um aviso "publicado por fora com camada não
  atestada: X" e uma linha em `$EST/divida-camadas`. Só alerta, nunca bloqueia. Terminar em `NADA_A_PUBLICAR`
  não gera dívida.

### PR C — M1, `_shared/` pelo ledger

**Antes.** Todo arquivo de `supabase/functions/_shared/` no intervalo ar..main exigia `liberar` humano. O mapa
`_shared/sonda-fingerprints.ts` muda em todo PR de edge, então todo PR de edge virava RETIDO manual: em 27/11
foram 74 min, de 18:16 a 19:31, por `sonda-fingerprints.ts` e depois `pii-carteira.ts`.

**Por que o ledger prova.** O `pendencias:deploy` compara `(versao, fonte)` servido com a main, e `fonte` é o hash
do FECHO transitivo da edge, `_shared/` incluído. Para uma edge DO MAPA, o ledger já vê a mudança de `_shared/`.
Ele só não vê uma consumidora fora do mapa (edge sem `versao.ts`, ou que não entrou no mapa).

**Agora.** O `scripts/sonda-fan-out.ts --prova-ledger --base <ar> --head <main>` olha TODA edge com `index.ts`, e
não só as instrumentadas. Imprime `LEDGER`/`FORA_DO_MAPA`/`ILEGIVEL`/`SEM_CONSUMIDORA` por linha e termina em
`PROVA_LEDGER=0|1`; exit 2 é mecânica. O vigia grava o resultado em `$EST/shared-<base>-<head>` no ramo
`PRECISA_LEDGER`, e qualquer falha da prova grava `2`.
- No `--decidir`: `0` tira o `_shared/` do caminho humano e o manda para o ledger.
- `1` ou `2` mantém o `liberar` e lista as consumidoras fora do mapa.
- Sem leitura fresca da prova, sai `PRECISA_LEDGER` (exit 11).

O teste antigo `dec_shared_ledger0`, em que `_shared` com ledger=0 ficava RETIDO, foi invertido em 6 cenários.

**Calibração em produção, os dois RETIDO de 27/11:**
- `--base 166ed871 --head 370e32c8` (só o mapa mudou) → `PROVA_LEDGER=0`.
- `--base 166ed871 --head d7ae7171` → `LEDGER omie-cliente/omie-sync/omie-vendas-sync _shared/pii-carteira.ts`,
  `PROVA_LEDGER=0`.

Os dois teriam ido ao ledger em vez de esperar 74 min por um `liberar`.

### PR E — M7, M10, M11, M5 (mínimo)

- **M10, o comando certo.** Todo RETIDO imprime linhas `ACAO=`:
  - migration: `bun run db:aplicar <arq>`, ou `--atestar` se ela já foi aplicada fora do envelope (PR D);
  - edge: a lista INTEIRA a deployar, que junta o diff, as consumidoras da prova do `_shared/` (PR C) e as edges
    que o ledger nomeia.

  O aviso do Mac usa a 1ª `ACAO=` no lugar do `--liberar`. O `--esperar <sha> --ate-o-ar` não encerra no RETIDO:
  imprime as `ACAO=` uma vez e segue esperando o ar, porque quem aplica a camada é a própria sessão.
- **M11.** O `--esperar` lê o `batimento` do vigia (PR A) a cada volta. Com mais de `LP_ESPERAR_PARADO_S` (600 s)
  ele sai na hora com `TIMEOUT=vigia parado há N min`, em vez de dormir até o prazo de 30 min. Um tick vivo com o
  lock não envelhece o batimento: toda invocação do launchd o renova.
- **M5 mínimo.** O cache `pendencias-<head>` passa a guardar, a partir da 2ª linha, as edges que o
  `pendencias:deploy` nomeia nas seções pendentes (≠ ✅). O RETIDO por edge lista todas, e não só a 1ª do diff.
- **M7, dono da camada.** As linhas `DONO=<pr>|<autor>|<arquivo>` saem do commit mais novo que tocou a camada no
  intervalo. O PR vem do `(#NNNN)` do título do squash, sem rede. O vigia comenta no PR dono (`gh pr comment`)
  uma vez por PR por episódio; falha do `gh` vira log, sem laço. O 1º lembrete do RETIDO vem aos
  `LV_PRIMEIRO_LEMBRETE_MIN` (45), e os seguintes a cada `LV_RELEMBRA_H` (4 h). MECANICA não comenta em PR:
  não há camada nem dono.
