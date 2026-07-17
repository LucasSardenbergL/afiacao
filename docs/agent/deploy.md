# Deploy no Lovable — 3 camadas manuais (referência operacional)

> O que NÃO acontece sozinho no merge. Lição durável carregada sob demanda. Runbook passo-a-passo completo: `docs/runbooks/lovable-supabase.md`. Banco/migration: `docs/agent/database.md`. Verificação: skill `lovable-deploy-verify`.

## Merge na `main` ≠ produção — 3 deploys MANUAIS e independentes

1. **Migration** → colar o SQL no **SQL Editor do Lovable** → Run → validar com query de contagem. O Lovable **NÃO** aplica migration de nome custom sozinho (falha SILENCIOSA: a feature compila e quebra em runtime). Detalhe + ritual + skill `lovable-db-operator`: `docs/agent/database.md`.
2. **Frontend** → **Publish** manual no editor do Lovable. `steu.lovable.app` serve o **build velho** até o Publish (lição 2026-05-31: mergear e achar que foi pro ar é o erro recorrente).
3. **Edge functions** → criadas/editadas pelo **chat do Lovable** (ele lê `supabase/functions/<nome>/index.ts` do repo e deploya **verbatim**), **NÃO** pela UI Cloud (que só mostra logs).

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

## Quando o Lovable reverte um fix — detectar e restaurar

O bot `gpt-engineer-app[bot]` commita direto na `main` SEM CI ("Changes"/"Deployed"/"Deployou edge") e às vezes reverte um PR (~16% dos commits; ≥4-5 reversões money-path recentes). Prevenção é inviável (o bot precisa de escrita direta) → o jogo é **detectar + restaurar rápido** (MTTR), não governança perfeita. Spec: `docs/superpowers/specs/2026-06-26-lovable-revert-mitigation-design.md`.

- **Sinais automáticos (CI desta frente, `.github/workflows/`):** Issue **`ci-main-red`** = a `main` quebrou build/typecheck/test (antes passava silencioso — ninguém alertado); Issue **`lovable-touched-sensitive`** = o bot tocou path money-path/edge **mesmo com CI verde** (regressão compilável — a classe do #1076/#1077). Ambas assinadas pro founder.
- **Guardrails como rede (testes-invariantes):** `src/lib/reposicao/__tests__/edges-onorder-guardrail.test.ts` (janela on-order #1072/#1076) e `src/__tests__/edge-money-path-invariants.test.ts` (analyze: helper espelhado + paridade edge×src + gate de fallback `!(… in priceMap)` + canária #1077/#1080/#1089; e margem do `algorithm-a-audit`) **quebram o CI** se a regressão volta ao REPO. Em refactor legítimo, **reescrever o teste junto** — não deletar.
- **Restauração rápida** (o que destravou #1076/#1085): `git checkout <sha-da-correção> -- <arquivo>` → abrir **PR** (auto-merge no verde). **Nunca** restaurar direto na `main` (vira guerra de commits com o bot).
- **Ritual pós-Lovable:** após qualquer Publish/chat-edit, além da verificação de deploy de edge (acima), `git fetch origin main` e cheque o commit do bot — tocou money-path sem intenção → restaure na hora. Para o **edge de preço** (`analyze-unified-order`), confirme o COMPORTAMENTO deployado pela **canária**: Governança → Auditoria — o card "Canária de preço" **roda sozinho ao abrir** (botão "Verificar de novo" para re-checar). Verde = praticado 123 vence Omie 999; vermelho/erro = edge revertida → restaure. É a única prova do que está SERVIDO em prod (o invariante do CI só prova o repo). Evite editar pelo Lovable arquivos mantidos via PR.

## Verificação de deploy

- A skill **`lovable-deploy-verify`** confere se o bundle servido bate com o esperado (bytes/comportamento). Use após Publish/deploy — não confiar cegamente no "deployed" do Lovable. A varredura por bytes é **paralela** (`xargs -P`, halt-on-hit) — o bundle passou de 300 chunks e o modo 1-a-1 estourava o timeout.
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
