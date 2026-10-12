# Publish automático do Lovable pela API (2026-10-11)

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
