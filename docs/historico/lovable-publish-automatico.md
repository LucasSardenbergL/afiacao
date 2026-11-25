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
`dev.afiacao.lovable-vigia` (180 s). Clone PRÓPRIO em `~/.local/share/afiacao/vigia-repo` (checkout
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

## 1ª medição em produção (2026-11-22 → 25)

407 ticks, **8 `PUBLICADO` provados pelo ar** (40–80 s após o disparo; 1º: `ecefeb53`), nenhum SHA
desistido (3x). Retenções por migration avisaram 1x/SHA e foram publicadas à mão depois da DDL —
o comportamento desenhado. Mas **11 de 19 chamadas ao `claude -p` falharam na 1ª**: o MCP `lovable`
ainda não estava conectado quando o modelo começou ("ferramentas_mcp_nao_disponiveis", "session
tools unavailable", timeout 124). O backoff segurou o custo, mas cada uma atrasava o Publish 5 min.
Correção: `MCP_TIMEOUT=60000` + 2ª chamada no MESMO tick (publicar 2x o mesmo commit é idempotente).
Ensaio: `claude` falso que falha na 1ª e dispara na 2ª → 2 chamadas, `DISPARADO`.
