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

> ⚠️ **ESTE É UM ESBOÇO v0 (2026-06-14).** A lógica está fundamentada na §"Deploy do FRONTEND" e
> §"Edge functions — caminho oficial Lovable" do CLAUDE.md, mas os comandos de verificação por bytes
> ainda **não foram exercidos por esta skill ponta-a-ponta** (foram exercidos manualmente em #608 e
> documentados na §5). Os pontos marcados `TODO(validar na 1ª execução)` precisam de uma rodada real
> antes de promover pra v1. Irmã da `lovable-db-operator` (que cobre o lado do banco).

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
4. **Verificação de frontend varre TODOS os chunks.** O Vite agrupa por content-hash e pode jogar um hook/módulo num chunk de nome **inesperado** (visto: um hook do unified-order caiu no `TintColorSelectDialog-*.js`). Grepar só os chunks de nome "óbvio" dá **falso-negativo** — varra todos os referenciados.

## O ritual — 5 passos

Crie estes todos (TodoWrite) ao fechar uma entrega que pode precisar de deploy:

1. **Classificar o diff** — quais das 3 camadas o PR toca (frontend / edge / migration)?
2. **Pendências do founder** — montar o checklist do que ele precisa fazer manualmente
3. **Prompt de edge** (se houver edge) — montar o handoff "ler do repo, verbatim, não melhorar"
4. **Verificar frontend** (após o founder dar Publish) — provar pelos bytes
5. **Confirmar honestamente** — só então dizer "no ar", com a evidência

---

### Passo 1 — Classificar o diff

```bash
# o que o PR/branch tocou, por camada
git diff --name-only origin/main...HEAD | sort | awk '
  /^src\// {fe=1}
  /^supabase\/functions\// {ef=1}
  /^supabase\/migrations\// {mg=1}
  END {
    print "frontend (Publish): " (fe?"SIM":"não")
    print "edge (chat Lovable): " (ef?"SIM":"não")
    print "migration (SQL Editor → lovable-db-operator): " (mg?"SIM":"não")
  }'
```

### Passo 2 — Checklist de pendências do founder

Entregar SÓ as linhas que se aplicam (do passo 1):

> ⚠️ **Pra ir ao ar, falta (manual no Lovable):**
> - [ ] **Publish** do frontend no editor do Lovable *(se tocou `src/`)*
> - [ ] **Deploy** das edges X, Y via chat do Lovable, verbatim da main *(se tocou `supabase/functions/`)*
> - [ ] **Migration** Z no SQL Editor *(se tocou `supabase/migrations/` — ver bloco da `lovable-db-operator`)*

### Passo 3 — Prompt de deploy de edge (se aplicável)

Montar pro founder colar no chat do Lovable (um por edge tocada):

> Edit the existing edge function `<nome>` and replace its code with the current contents of
> `supabase/functions/<nome>/index.ts` from the `main` branch. Deploy it **verbatim** — do NOT modify,
> reinterpret, "improve", or reformat the code. After deploying, confirm it shows **Active**.

⚠️ Só depois do PR **mergeado** na main (Lei de Ferro #3).

### Passo 4 — Verificar o frontend pelos bytes (após Publish)

```bash
APP=https://steu.lovable.app
ALVO='COLE_AQUI_UMA_STRING_LITERAL_UNICA_DO_COMMIT'   # ex.: um .select() novo, texto de UI, rota nova

# 1) hash do entry — muda quando sobe build novo (mesmo hash = não publicou/propagou)
ENTRY=$(curl -s "$APP/" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
echo "entry: $ENTRY"

# 2) enumerar TODOS os chunks referenciados pelo entry (Lei de Ferro #4 — varrer tudo, não só o óbvio)
curl -s "$APP$ENTRY" \
  | grep -oE '/assets/[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.js' | sort -u > /tmp/chunks.txt
echo "chunks referenciados: $(wc -l < /tmp/chunks.txt)"

# 3) grep da string-alvo em TODOS os chunks
while read -r c; do
  curl -s "$APP$c" | grep -q -- "$ALVO" && echo "✅ ALVO encontrado em $c"
done < /tmp/chunks.txt
echo "(se nada acima, o commit NÃO está no build publicado)"
```

`TODO(validar na 1ª execução)`: confirmar que o regex de enumeração de chunks pega o conjunto completo
(o entry pode usar `__vite__mapDeps` com os caminhos numa array — se o grep acima vier curto, extrair a
array de deps do entry em vez dos literais `/assets/...`). A §5 cita "~233 chunks" — comparar a contagem.

⚠️ O `/browse` do gstack (headless E headed) **NÃO renderiza esta SPA** (React não monta) — a verificação
de Uq fica no Chrome real do founder; a verificação de **maior sinal sem o founder é esta, pelos bytes**.

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

## TODO antes de promover a v1
- [ ] Exercer o passo 4 ponta-a-ponta numa entrega real e confirmar a enumeração de chunks (regex vs `__vite__mapDeps`).
- [ ] Adicionar `evals/` (espelhar o formato do `lovable-db-operator/evals`) com casos: diff só-frontend, diff só-edge, diff misto, diff só-doc (não precisa deploy).
- [ ] Confirmar o domínio publicado canônico (`steu.lovable.app`) e se há ambiente de preview distinto a checar.
