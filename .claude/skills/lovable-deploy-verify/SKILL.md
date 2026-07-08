---
name: lovable-deploy-verify
description: >-
  Ritual de "está REALMENTE no ar?" para QUALQUER entrega neste repo (Afiação/Colacor),
  que roda em Lovable Cloud. Use SEMPRE que terminar de mergear um PR e precisar saber o que falta pra
  a mudança ir a produção, ou quando o usuário perguntar "já está no ar?", "deu pra ver no app?",
  "publiquei?", "preciso dar Publish?", "tem que deployar a edge?". Vale mesmo quando o usuário não
  diz "deploy" e só assume que mergear basta ("terminei, era só isso?", "pode testar agora?"). Por quê:
  o Lovable NÃO auto-deploya NADA a partir de push no GitHub — mergear na main deixa o código na main,
  mas o app continua servindo o build anterior. TRÊS coisas são manuais e independentes: (1) FRONTEND
  (Publish no editor do Lovable), (2) EDGE FUNCTIONS (chat do Lovable, ler do repo, verbatim), (3)
  MIGRATIONS (SQL Editor — coberto pela skill lovable-db-operator). A skill empacota: detectar quais
  das 3 se aplicam ao diff, montar o checklist de pendências do founder, montar o prompt de deploy de
  edge, e VERIFICAR o deploy do frontend pelos bytes do bundle (hash do index + grep da string-alvo em
  TODOS os chunks). NÃO use para: a mudança de banco em si (use lovable-db-operator), escrever a feature,
  ou debugar erro de runtime no app (use /investigate).
---

# Lovable Deploy & Verify

> **v1.2 — método de enumeração validado em produção + 2ª opinião do Codex (2026-06-18).** A
> verificação por bytes (Passo 4) enumera os chunks pela **UNIÃO** de duas fontes que sozinhas têm
> furos: o fechamento transitivo do grafo lazy do Vite (o entry sozinho perdia o 2º nível — 260 vs
> 274) e o precache do Workbox (`/sw.js`, que omite ~6 chunks grandes via globIgnores/maxFileSize).
> Empacotado em [`scripts/verify-frontend.sh`](scripts/verify-frontend.sh). **Pendência única:** o
> *smoke* ponta-a-ponta num Publish real. Irmã da `lovable-db-operator` (lado do banco).

## Por que esta skill existe (leia antes de qualquer coisa)

Este repo roda em **Lovable Cloud**. Há uma armadilha operacional documentada na §5/§"Deploy do FRONTEND" do CLAUDE.md:

> **O Lovable NÃO auto-deploya o frontend a partir de push no GitHub.** Mergear PR na `main` deixa o
> código na main, mas o app em `steu.lovable.app` **continua servindo o build anterior** até alguém
> clicar **Publish** no editor do Lovable.

Isso já pegou de surpresa: após mergear 6 PRs alguém disse "pronto pra QA" — mas o ar ainda era um build velho (provado nos bytes). O pior tipo de erro: **dizer "está no ar" quando não está.**

As **três** coisas são deploy manual e **independente**, e NENHUMA acontece sozinha no merge:

| Camada | Como sobe | Skill dona |
| --- | --- | --- |
| **Frontend** (app React) | **Publish** no editor do Lovable (pode precisar sincronizar com o GitHub antes — senão publica estado velho dele) | esta skill |
| **Edge functions** (`supabase/functions/`) | **chat do Lovable** (ler do repo, deploy **verbatim**) | esta skill |
| **Migrations** (`supabase/migrations/`) | **SQL Editor** (colar → Run) | `lovable-db-operator` |

## A Lei de Ferro (guardrail inegociável)

1. **Você nunca diz "está no ar" sem prova.** Mergear na main **não publica nada**. Frontend: os **bytes do bundle** confirmam (string-alvo nos chunks — Passo 4). Edge **não serve seu código**, logo não há prova por bytes — a prova é a **escada** existência (`verify-edge.sh`) → versão (Management API/painel) → comportamento (probe); `Active` sozinho prova existência, **não** que a versão nova subiu. Até lá: "mergeado na main; **falta Publish/deploy** pra ir ao ar".
2. **As 3 camadas são independentes — sempre diga QUAIS se aplicam.** Um diff só-frontend não precisa de deploy de edge; um diff de edge precisa de deploy via chat *e* (se mexeu em UI) Publish. Liste só o que o diff realmente toca.
3. **Edge deploy SÓ DEPOIS do merge, e VERBATIM.** Deployar "da main" antes do merge faz o Lovable ler a main **velha** (já mordeu em #383/#252 — a action nova não existia no binário → `400 "Ação desconhecida"`). E o Lovable tende a "melhorar" o código — o prompt deve mandar **não modificar/reinterpretar**, ler de `supabase/functions/<nome>/index.ts` e deployar idêntico.
4. **Verificar frontend varre TODOS os chunks, e enumerá-los é a UNIÃO de duas fontes.** Nenhuma sozinha é completa (validado em prod 2026-06-18 + Codex): (a) o **fechamento transitivo** do grafo lazy do Vite — o entry lista só o 1º nível via `__vite__mapDeps(["assets/x.js"])` (sem barra, aspas), e um lazy-dentro-de-página guarda o mapDeps no chunk DELE (entry=260, closure=274); (b) o **precache do Workbox** (`/sw.js`), que omite chunks grandes (globIgnores/maxFileSize — faltavam 6). Use a UNIÃO. Grep de literais `/assets/...` dá 0 (o bug original). Contagem 0/1 = enumeração quebrada — conserte antes de concluir.
5. **Todo artefato pro founder tem o DESTINO rotulado na 1ª linha** — `🟣 SQL Editor` / `💬 chat do Lovable` / `🖱️ Publish (editor do Lovable)` / `⌨️ seu terminal` — e **zero placeholders** (`<VALOR>` não substituído já foi colado em produção). JS/bash NUNCA vai pro SQL Editor (já foi colado lá 4×); o rótulo responde de antemão o "isso eu colo onde?".

## O ritual — 5 passos

Crie estes todos (TodoWrite) ao fechar uma entrega que pode precisar de deploy:

1. **Classificar o diff** — quais das 3 camadas o PR toca (frontend / edge / migration)?
2. **Pendências do founder** — montar o checklist do que ele precisa fazer manualmente
3. **Prompt de edge** (se houver edge) — montar o handoff "ler do repo, verbatim, não melhorar"
4. **Verificar o deploy** — frontend pelos bytes; edge pela escada existência→versão→comportamento
5. **Confirmar honestamente** — só então dizer "no ar", com a evidência

---

### Passo 1 — Classificar o diff

Quais das 3 camadas o PR toca? A lógica canônica — ampliada para pegar **arquivos de build na raiz**
(`vite.config`, `package.json`, …), não só `src/` — vive em [`evals/classify.sh`](evals/classify.sh) e é
coberta por [`evals/run.sh`](evals/run.sh) (8 casos + mutation-check):

```bash
git diff --name-only origin/main...HEAD \
  | .claude/skills/lovable-deploy-verify/evals/classify.sh
# -> frontend=SIM|não · edge=SIM|não · migration=SIM|não
```

### Passo 2 — Checklist de pendências do founder (ORDEM TRAVADA: merge → SQL → edge → Publish)

**Nada de deploy antes do MERGE** (Lei de Ferro #3 — o Lovable lê da main). Entregar SÓ as linhas que se aplicam (do passo 1), NESTA ordem, cada uma com o destino rotulado:

> ⚠️ **Pra ir ao ar, falta (manual no Lovable) — nesta ordem, APÓS o merge do PR:**
> - [ ] 🟣 **SQL Editor**: migration Z *(se tocou `supabase/migrations/` — bloco da `lovable-db-operator`; banco ANTES do código que o consome)*
> - [ ] 💬 **chat do Lovable**: deploy das edges X, Y — verbatim da main *(se tocou `supabase/functions/`)*
> - [ ] 🖱️ **Publish** do frontend no editor do Lovable *(se o passo 1 deu frontend=SIM; por último — o build novo nasce contra banco/edge já atualizados)*

### Passo 3 — Prompt de deploy de edge (se aplicável)

Montar pro founder colar no chat do Lovable (um por edge tocada):

> Edit the existing edge function `<nome>` and replace its code with the current contents of
> `supabase/functions/<nome>/index.ts` from the `main` branch. Deploy it **verbatim** — do NOT modify,
> reinterpret, "improve", or reformat the code. After deploying, confirm it shows **Active**.

⚠️ Só depois do PR **mergeado** na main (Lei de Ferro #3).

### Passo 4 — Verificar o frontend pelos bytes (após Publish)

> **Validado em produção (2026-06-18) + 2ª opinião do Codex.** Enumerar os chunks tem furos sutis:
> o entry sozinho perde o 2º nível (lazy-dentro-de-lazy, 260 vs 274); o precache do Workbox omite
> chunks grandes (globIgnores/maxFileSize, faltavam 6). Por isso a enumeração é a **UNIÃO** de (A)
> fechamento transitivo do grafo Vite + (B) precache do `/sw.js`. Tudo empacotado no script:

```bash
.claude/skills/lovable-deploy-verify/scripts/verify-frontend.sh \
  'COLE_UMA_STRING_LITERAL_UNICA_DO_COMMIT'   # 2º arg opcional: a URL (default steu.lovable.app)
# saída: "chunks (closure ∪ precache): N" + "✅ ALVO em <chunk>"
# exit 0 = no ar · 1 = ausente (Publish pendente / alvo não-literal) · 2 = enumeração quebrada
```

**Escolher a string-alvo — refactor visual NÃO tem texto novo.** A sentinela ideal é texto de UI
literal e único do commit. Mas refactor puramente visual (spinner→skeleton, cor→token, troca de
layout) não adiciona texto — e a string precisa estar em **JSX renderizado**: comentário (`//`),
teste e edge NÃO entram no bundle (mordido em prod 2026-07-07: `'identidade não provada'` só vivia
num comentário → falso "ausente", não prova nada). Duas saídas:
- **Calibrar** com uma string RENDERIZADA já existente da própria página (um `<h2>`/label antigo) —
  prova que o chunk certo está no ar + o método enumera (não é falso-negativo). Não prova a versão.
- **Provar a versão** por **assinatura estrutural** no chunk da página, baixado direto
  (`curl .../assets/<Página>-<hash>.js`): a **prop/classe NOVA presente E a marca REMOVIDA ausente**,
  as duas no MESMO chunk (uma só pode dar falso-positivo por reuso). Ex. spinner→skeleton (provado
  #1215): `variant:"detail"` presente (o `<PageSkeleton>` novo) **+** `animate-spin` ausente (o
  `<Loader2>` que saiu). Pela atomicidade do Publish (build da `main` inteira), 1 página provada ⇒ o
  lote todo no ar.

⚠️ Guard embutido (exit 2): contagem 0/1 = enumeração quebrada (formato do bundler/Workbox mudou) —
NÃO conclua "não está no ar"; conserte o script primeiro. O `/browse` do gstack NÃO renderiza esta
SPA (React não monta) — a verificação visual fica no Chrome real do founder; o maior sinal sem o
founder é este, pelos bytes.

**Edge — a escada (o código da edge NÃO é servido em produção, logo não há prova por bytes):**

```bash
.claude/skills/lovable-deploy-verify/scripts/verify-edge.sh <nome> [<nome2> ...]
# N1 existência (sem auth): OPTIONS -> servida (200) vs AUSENTE (404); exit 1 se alguma 404.
# N2 versão  (prova real):  SUPABASE_PAT=sbp_xxx ...  -> version/updated_at via Management API.
```

- **N1 existência** — automático e barato, mas só prova que a função está servida, **não** que é a versão nova.
- **N2 versão** (canônico) — `version` sobe e `updated_at` fica recente a cada deploy. Precisa de PAT (handoff) ou o founder confere "Active + updated agora" no Lovable.
- **N3 comportamento** — chamar com a assinatura da mudança (gated → founder logado / cron secret). A única prova de que o COMPORTAMENTO novo está no ar.

### Passo 5 — Confirmar honestamente

- Frontend: "✅ no ar — `ALVO` presente em `<chunk>`, entry hash `<novo>`" **ou** "❌ ainda o build velho (hash inalterado / alvo ausente) — Publish pendente".
- Edge: nunca "Active = no ar" (Active só prova existência). Diga o NÍVEL provado: "✅ N2 — version subiu + updated agora" / "✅ N3 — probe `<assinatura>` confere" **ou** "só N1 (existe); versão não confirmada — falta PAT/founder".
- Nunca um "pronto!" genérico sem uma dessas evidências por camada tocada.

---

## Smoke E2E autônomo (carimbo de SHA + monitor)

O build **carimba o commit no bundle** (`vite.config` → `define __COMMIT_SHA__`; `main.tsx` →
`window.__BUILD_SHA__`). Com isso o monitor responde "**o ar == `origin/main`?**" sem adivinhar um ALVO:

```bash
.claude/skills/lovable-deploy-verify/scripts/monitor-deploy.sh [url] [sentinela]
# exit 0 = sincronizado · 3 = ATRASADO (Publish pendente) · 4 = deploy novo, versão indeterminada
```

- **Determinístico** quando o ar tem `__BUILD_SHA__="<sha>"` — compara com `origin/main`.
- **Fallback**: se vier `"dev"` (Lovable sem `.git` no build) ou ausente (build pré-carimbo), passe uma
  `sentinela` (string de UI única do HEAD) → o monitor cai pro `verify-frontend.sh`.
- **Agendar** (cron de sistema, sem gastar Claude): `*/30 * * * * cd <repo> && bash .../monitor-deploy.sh
  >> ~/.config/afiacao/deploy-monitor.log 2>&1` (exit 3/4 = avisar; combine com `osascript`/email).

⚠️ **Confirmado em prod (2026-06-26):** o ar serve `__BUILD_SHA__="dev"` — o build do Lovable roda **sem
`.git`**, então o carimbo nunca materializa um SHA real e o caminho determinístico é **inviável neste host**.
Consequência operacional: o monitor **depende SEMPRE da sentinela** (2º arg) — sem ela, exit 4 ("indeterminado")
a cada run. E **passe a URL com `https://`**: sem esquema, o `curl` (sem `-L`) volta vazio e o monitor reporta
falso `"fora do ar"` (exit 2) — não é o site caído, é a URL malformada.

## Referências
- CLAUDE.md §"Deploy do FRONTEND (app) — Publish MANUAL no Lovable" (a técnica dos bytes; armadilha do chunk de nome inesperado)
- CLAUDE.md §"Edge functions — caminho oficial Lovable" (deploy via chat, ler do repo, verbatim)
- CLAUDE.md §5 lições #383/#252 (deployar edge só após merge), #608 (verificação por bytes usada com sucesso)
- Skill irmã `lovable-db-operator` (camada de banco)

## Estado / pendências
- [x] Enumeração = **UNIÃO** (fechamento transitivo do Vite ∪ precache do Workbox) — nenhuma fonte sozinha é completa (closure 274 ⊃ precache 268; precache omite 6). Validado em prod + Codex; empacotado em `scripts/verify-frontend.sh`.
- [x] `evals/` com classificação de diff (8 casos + runner + mutation-check; espelha `lovable-db-operator/evals`).
- [x] Domínio canônico `steu.lovable.app` confirmado (HTTP 200).
- [x] **Edge:** verificação por escada — N1 existência (`verify-edge.sh`, OPTIONS, automático) · N2 versão (Management API, handoff de PAT) · N3 comportamento (probe gated). Fecha a assimetria com o frontend.
- [x] **Smoke E2E autônomo:** carimbo de SHA no build (`__BUILD_SHA__`) + `monitor-deploy.sh` (cron) compara o ar vs `origin/main`. **Exercido em prod 2026-06-26** (pós-Publish do #1065): o carimbo está no ar mas vem `"dev"` (Lovable builda sem `.git`) ⇒ SHA determinístico inviável neste host; **fallback de sentinela validado ponta-a-ponta** (`get_ultimos_precos_cliente` PRESENTE → exit 0). Regra firmada: no cron, **sentinela obrigatória + URL com `https://`** (ver ⚠️ acima).
- [ ] (menor) Confirmar se há ambiente de **preview** distinto do publicado a checar.
