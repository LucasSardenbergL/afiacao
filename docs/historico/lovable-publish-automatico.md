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
