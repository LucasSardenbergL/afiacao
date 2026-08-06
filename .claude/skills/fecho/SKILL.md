---
name: fecho
description: >-
  Ritual determinístico de FECHAMENTO DE SESSÃO neste repo (Afiação/Colacor). Use SEMPRE que o
  Lucas perguntar se pode excluir/apagar/fechar a sessão — qualquer fraseado: "posso excluir a
  sessão?", "posso apagar?", "falta algo?", "terminamos por aqui?", "pode fechar?" — ou pedir o
  resumo de fecho. Por quê: é a pergunta mais frequente do corpus (~160 msgs/mês) e o ritual
  ad-hoc falha por partes — PR órfão descoberto dias depois (auto-merge não verificado), Publish
  esquecido, migration entregue mas nunca aplicada, chip sem rastreio. A skill responde com
  EVIDÊNCIA (gh/psql-ro/git), não de memória: PRs da sessão, migrations entregues × aplicadas,
  edges deployadas, Publish, chips abertos, resumo de fecho padrão, wt:status. NÃO use para:
  fechar uma ENTREGA no meio da sessão (use lovable-deploy-verify) ou gerar briefing pra
  continuar em sessão nova (use handoff-sessao).
---

# /fecho — ritual de fechamento de sessão

## Princípio

O veredito "pode excluir" sai de **evidência coletada agora**, nunca de memória da conversa.
Cada item abaixo tem um comando concreto; o resultado decide ✅/❌. Se QUALQUER item crítico
estiver pendente, o veredito é "**ainda não** — falta X" com a lista numerada do que fica na
mão do founder.

**Pendência sem DESTINO não existe (pedido do founder, 2026-07-18).** Toda pendência que o
fecho detectar — crítica, informativa ou "opcional" — recebe UM de três destinos ANTES do
veredito, para nada ficar dependendo da memória dele:

1. **Resolver AGORA na sessão** — quando é pequena, do escopo, e cabe sem alongar o fecho
   (ex.: rodar uma validação que faltou, armar um watcher, disparar um Codex retroativo).
2. **Abrir CHIP (`spawn_task`)** — para tudo que merece sessão própria: prompt AUTO-CONTIDO
   (a sessão nova não vê esta conversa) + anunciar o **título exato** no chat. Vale também
   para os "opcionais": se valem a pena, viram chip; o founder decide clicando, não lembrando.
3. **Descartar COM o porquê** — dito explicitamente no veredito ("não vale porque X").
   Exceção: pendência que depende de decisão/etapa futura (ex.: fase 5 que espera a 3) fica
   registrada em doc/plano com o gatilho de quando virar chip — e isso é dito no veredito.

O veredito final rotula cada pendência com seu destino: ✔ resolvida agora · 🔘 chip
"<título exato>" · 🚫 descartada (porquê) · 📌 registrada em <doc> com gatilho. **"PODE
excluir" só quando TODA pendência tem destino** — "fica na sua mão lembrar" não é destino.

Crie estes todos (TodoWrite) e siga em ordem:

1. **PRs da sessão** — mergeados de verdade?
2. **Migrations** — entregues × APLICADAS no banco (psql-ro)
3. **Edges** — deployadas via chat do Lovable?
4. **Publish** — frontend publicado (ou pendente)?
5. **Chips** — abertos nesta sessão, com título exato
6. **Resumo de fecho** — formato padrão do CLAUDE.md
7. **wt:status** — higiene de RAM + oferta de limpeza

---

### Passo 1 — PRs da sessão

```bash
git branch --show-current
gh pr list --head "$(git branch --show-current)" --state all --json number,title,state,url
# + qualquer PR nº citado na conversa (mesmo de outras branches desta sessão)
```

Pra cada PR encontrado/citado:

```bash
gh pr view <N> --json state,mergeStateStatus,statusCheckRollup,url
```

- `MERGED` → ✅
- `OPEN` + CI rodando → ⏳ **arme o watcher antes de fechar**: `scripts/pr-watch.sh <N>` via
  Bash `run_in_background:true` (no desfecho, PushNotification pro founder — CLAUDE.md §Merge).
  A sessão PODE ser excluída com watcher armado? **Não** — o watcher morre com a sessão.
  Nesse caso o veredito é "espere o merge" OU entregue ao founder o link pra conferir depois.
- `OPEN` + `mergeStateStatus: DIRTY` → ❌ conflito; resolver antes de fechar.
- CI vermelho → ❌ investigar antes de fechar (PR não-draft NÃO mergeia vermelho).
- DRAFT segurado de propósito → listar como pendência consciente (com o porquê).

### Passo 2 — Migrations: entregue ≠ aplicada

```bash
# o que esta sessão criou/mergeou de migration
git log origin/main --oneline -20 -- supabase/migrations/   # mergeadas recentes
git diff --name-only origin/main...HEAD -- supabase/migrations/  # ainda no branch
```

Pra cada migration da sessão, **prove no banco** (leitura direta — não pergunte ao founder):

```bash
~/.config/afiacao/psql-ro -c "<query de validação da migration — objeto existe? função atualizada?>"
```

- Existe → ✅ aplicada.
- Não existe → ❌ **PENDENTE: colar no SQL Editor do Lovable** — reentregue o bloco de handoff
  (skill `lovable-db-operator`) na mensagem de fecho.

### Passo 3 — Edges

```bash
git log origin/main --oneline -10 -- supabase/functions/
git diff --name-only origin/main...HEAD -- supabase/functions/
```

Se a sessão tocou edge: ela foi deployada via chat do Lovable? (Evidência: o founder confirmou
na conversa, ou a canária/probe respondeu com o comportamento novo.) Pendente → inclua o prompt
de deploy verbatim (skill `lovable-deploy-verify`, passo 3) na mensagem de fecho.

### Passo 4 — Publish do frontend

Se a sessão tocou `src/` e a mudança já mergeou: o Publish foi feito e verificado (bytes — skill
`lovable-deploy-verify` passo 4)? Pendente → item na lista do founder: "**Publish** no editor do
Lovable (depois me peça a verificação por bytes em sessão viva, ou rode-a você)".

### Passo 5 — Chips (spawn_task)

Liste TODO chip criado nesta sessão com o **título exato** e 1 linha do que faz — o founder é
quem clica, e chip sem rastreio já gerou confusão ("não consegui identificar qual é este chip").
Se um chip ficou obsoleto pelo próprio trabalho da sessão, diga explicitamente que pode ignorar.

### Passo 6 — Resumo de fecho (formato padrão)

> **Problema** → **Diagnóstico** → **Decisões (e pareceres Codex)** → **Implementado**
> (arquivos · PRs · migrations) → **Verificação** (o que foi provado e como) →
> **Pendências do founder** (lista numerada, com destino rotulado: 🟣 SQL Editor / 💬 chat
> Lovable / 🖱️ Publish / 🔘 chip) → **Onde está persistido** (PRs, docs/historico, docs/agent).

### Passo 7 — Higiene de RAM

```bash
bun run wt:status
```

Reporte o resultado e ofereça `wt:clean` / `wt:reap` (e `wt:prune` se houver worktree de
conversa já excluída). Ao fechar ESTA sessão: lembre que `wt:clean --include-current` libera o
node_modules dela.

---

## Veredito final (formato)

```
### Fecho da sessão — <tema>

✅ PRs: #A, #B mergeados (CI verde)
✅ Migrations: 2026…_x.sql aplicada (validação psql-ro ✅)
✅ Edges/Publish: n/a (sessão só de tooling)
Pendências (TODAS com destino — nenhuma "na memória"):
  ✔ <pendência resolvida agora, com a evidência>
  🔘 chip "<título exato>" (faz X — clique quando quiser)
  🚫 <pendência descartada> — porquê em 1 linha
  📌 <pendência futura> — registrada em <doc/plano>, vira chip quando <gatilho>

Veredito: PODE excluir a sessão. / AINDA NÃO — falta (1)…
```

Nunca diga "pode excluir" com item ❌/⏳ crítico em aberto sem nomeá-lo na lista do founder —
e nunca com pendência SEM um dos 4 destinos acima ("fica na sua mão lembrar" não é destino).
