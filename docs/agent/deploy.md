# Deploy no Lovable — 3 camadas manuais (referência operacional)

> O que NÃO acontece sozinho no merge. Lição durável carregada sob demanda. Runbook passo-a-passo completo: `docs/runbooks/lovable-supabase.md`. Banco/migration: `docs/agent/database.md`. Verificação: skill `lovable-deploy-verify`.

## Merge na `main` ≠ produção — 3 deploys MANUAIS e independentes

1. **Migration** → colar o SQL no **SQL Editor do Lovable** → Run → validar com query de contagem. O Lovable **NÃO** aplica migration de nome custom sozinho (falha SILENCIOSA: a feature compila e quebra em runtime). Detalhe + ritual + skill `lovable-db-operator`: `docs/agent/database.md`.
2. **Frontend** → **Publish** manual no editor do Lovable. `steu.lovable.app` serve o **build velho** até o Publish (lição 2026-05-31: mergear e achar que foi pro ar é o erro recorrente).
3. **Edge functions** → criadas/editadas pelo **chat do Lovable** (ele lê `supabase/functions/<nome>/index.ts` do repo e deploya **verbatim**), **NÃO** pela UI Cloud (que só mostra logs).

## Edge — armadilhas

- **Deploy SÓ depois do merge** — o chat lê a `main`; deployar antes pega o código velho.
- **Proibir "melhorias"** — instrua o chat a deployar **verbatim** o arquivo do repo (o Lovable tende a reescrever a função).
- **Verificar por comportamento/bytes, não pela palavra do Lovable** — `503 LOAD_FUNCTION_ERROR` + zero `running` no log = a edge não BOOTA → fix é **redeploy**, não código (ver `docs/agent/sync.md`).
- **`config.toml` pode vir com `[functions.<x>]` DUPLICADO** (bug do bot do Lovable) → TOML inválido (`redefine an already defined table`) que **quebra o `supabase` CLI** no parse. Fix: apagar a 2ª entrada (se idêntica = no-op de comportamento) — pode reaparecer num "Changes" do bot. (#974)
- **Edge "fantasma" (deployada, mas sem invocador):** *deployada/gerenciada pelo Lovable* = commits `gpt-engineer-app[bot]` tocando `<x>/index.ts` (+ commit "Deployou edge function `<x>`"); *invocada* = `cron.job` + `net._http_response` (+ `pg_proc`/código/CI). Antes de apagar um `supabase/functions/<x>/` órfão do repo: prove os DOIS lados E **delete no Lovable PRIMEIRO** (senão o bot regenera o diretório no próximo deploy de scoring). (#974: `n` era clone byte-idêntico de `calculate-scores` — deployado, zero invocador.)
- **Deploy de edge pode REVERTER um fix mergeado (money-path!)** — o Lovable reconcilia com a cópia VELHA dele e **commita a reversão na `main`** como `Changes`, desfazendo o PR (mordido 2026-06-26: o fallback do `analyze-unified-order` #1077 voltou a `override`, `main` silenciosamente revertida; re-aplicado #1080; noutro deploy o bot apagou o comentário-aviso mas manteve o gate). É **evento que MUDA código**, não deploy puro — não está pronto até `main` E comportamento conferidos. **Pós-deploy, 2 camadas:** (1) **source** — `git fetch origin main` + grep o invariante-alvo (ex.: `&& !priceMap[productId]`); sumiu = deploy FALHO; (2) **comportamento** — grep é necessário mas **NÃO suficiente** (o bot pode deployar da cópia interna SEM refletir na `main`) → canária com fixture (ex.: Omie=999 vs local=123 → espera 123). O aviso anti-reversão **não pode morar no código** (o bot remove comentários) — mora aqui.
- **"Deploy verbatim" manual é frágil p/ edge money-path** (cópia-fonte mutável do Lovable pode vencer — Codex 2026-06-26). Mitigar: prompt "deploy from `main` at SHA `<sha>`; do NOT reconcile from your internal copy; abort+report if it differs"; idealmente CI que falha se o invariante some, ou deploy por SHA/Action.

## Verificação de deploy

- A skill **`lovable-deploy-verify`** confere se o bundle servido bate com o esperado (bytes/comportamento). Use após Publish/deploy — não confiar cegamente no "deployed" do Lovable.
- O acesso **read-only** ao banco (`psql-ro`, ver `docs/agent/database.md`) confirma migration aplicada sem depender do founder.
