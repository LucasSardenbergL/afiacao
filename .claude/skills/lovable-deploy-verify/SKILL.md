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

1. **Você nunca diz "está no ar" sem prova.** Mergear na main **não publica nada**. Frontend só está no ar quando os **bytes do bundle** confirmam (hash novo do index + a string-alvo presente nos chunks). Edge só está no ar quando o Lovable reporta `Active` **e** o comportamento bate. Até lá: "mergeado na main; **falta Publish/deploy** pra ir ao ar".
2. **As 3 camadas são independentes — sempre diga QUAIS se aplicam.** Um diff só-frontend não precisa de deploy de edge; um diff de edge precisa de deploy via chat *e* (se mexeu em UI) Publish. Liste só o que o diff realmente toca.
3. **Edge deploy SÓ DEPOIS do merge, e VERBATIM.** Deployar "da main" antes do merge faz o Lovable ler a main **velha** (já mordeu em #383/#252 — a action nova não existia no binário → `400 "Ação desconhecida"`). E o Lovable tende a "melhorar" o código — o prompt deve mandar **não modificar/reinterpretar**, ler de `supabase/functions/<nome>/index.ts` e deployar idêntico.
4. **Verificar frontend varre TODOS os chunks, e enumerá-los é a UNIÃO de duas fontes.** Nenhuma sozinha é completa (validado em prod 2026-06-18 + Codex): (a) o **fechamento transitivo** do grafo lazy do Vite — o entry lista só o 1º nível via `__vite__mapDeps(["assets/x.js"])` (sem barra, aspas), e um lazy-dentro-de-página guarda o mapDeps no chunk DELE (entry=260, closure=274); (b) o **precache do Workbox** (`/sw.js`), que omite chunks grandes (globIgnores/maxFileSize — faltavam 6). Use a UNIÃO. Grep de literais `/assets/...` dá 0 (o bug original). Contagem 0/1 = enumeração quebrada — conserte antes de concluir.

## O ritual — 5 passos

Crie estes todos (TodoWrite) ao fechar uma entrega que pode precisar de deploy:

1. **Classificar o diff** — quais das 3 camadas o PR toca (frontend / edge / migration)?
2. **Pendências do founder** — montar o checklist do que ele precisa fazer manualmente
3. **Prompt de edge** (se houver edge) — montar o handoff "ler do repo, verbatim, não melhorar"
4. **Verificar frontend** (após o founder dar Publish) — provar pelos bytes
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

### Passo 2 — Checklist de pendências do founder

Entregar SÓ as linhas que se aplicam (do passo 1):

> ⚠️ **Pra ir ao ar, falta (manual no Lovable):**
> - [ ] **Publish** do frontend no editor do Lovable *(se o passo 1 deu frontend=SIM)*
> - [ ] **Deploy** das edges X, Y via chat do Lovable, verbatim da main *(se tocou `supabase/functions/`)*
> - [ ] **Migration** Z no SQL Editor *(se tocou `supabase/migrations/` — ver bloco da `lovable-db-operator`)*

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

⚠️ Guard embutido (exit 2): contagem 0/1 = enumeração quebrada (formato do bundler/Workbox mudou) —
NÃO conclua "não está no ar"; conserte o script primeiro. O `/browse` do gstack NÃO renderiza esta
SPA (React não monta) — a verificação visual fica no Chrome real do founder; o maior sinal sem o
founder é este, pelos bytes.

### Passo 5 — Confirmar honestamente

- Frontend: "✅ no ar — `ALVO` presente em `<chunk>`, entry hash `<novo>`" **ou** "❌ ainda o build velho (hash inalterado / alvo ausente) — Publish pendente".
- Edge: "✅ Active no Lovable + comportamento confere (`<probe>`)" **ou** "deploy pendente".
- Nunca um "pronto!" genérico sem uma dessas evidências por camada tocada.

---

## Referências
- CLAUDE.md §"Deploy do FRONTEND (app) — Publish MANUAL no Lovable" (a técnica dos bytes; armadilha do chunk de nome inesperado)
- CLAUDE.md §"Edge functions — caminho oficial Lovable" (deploy via chat, ler do repo, verbatim)
- CLAUDE.md §5 lições #383/#252 (deployar edge só após merge), #608 (verificação por bytes usada com sucesso)
- Skill irmã `lovable-db-operator` (camada de banco)

## Estado / pendências
- [x] Enumeração = **UNIÃO** (fechamento transitivo do Vite ∪ precache do Workbox) — nenhuma fonte sozinha é completa (closure 274 ⊃ precache 268; precache omite 6). Validado em prod + Codex; empacotado em `scripts/verify-frontend.sh`.
- [x] `evals/` com classificação de diff (8 casos + runner + mutation-check; espelha `lovable-db-operator/evals`).
- [x] Domínio canônico `steu.lovable.app` confirmado (HTTP 200).
- [ ] **Smoke ponta-a-ponta:** num próximo Publish real, rodar `verify-frontend.sh` com um ALVO conhecido e ver exit 0 (fecha o último elo — não dá com build local).
- [ ] (menor) Confirmar se há ambiente de **preview** distinto do publicado a checar.
