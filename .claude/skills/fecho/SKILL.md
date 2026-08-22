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
  edges deployadas, Publish, main verde (PR verde ≠ main verde), chips abertos, resumo de
  fecho padrão, wt:status. NÃO use para:
  fechar uma ENTREGA no meio da sessão (use lovable-deploy-verify) ou gerar briefing pra
  continuar em sessão nova (use handoff-sessao).
---

# /fecho — ritual de fechamento de sessão

## Princípio

O veredito "pode arquivar" sai de **evidência coletada agora**, nunca de memória da conversa.
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
ARQUIVAR" só quando TODA pendência tem destino** — "fica na sua mão lembrar" não é destino.

Crie estes todos (TodoWrite) e siga em ordem:

1. **PRs da sessão** — mergeados de verdade?
2. **Migrations** — entregues × APLICADAS no banco (psql-ro)
3. **Edges** — deployadas via chat do Lovable?
4. **Publish** — frontend publicado (ou pendente)?
5. **A MAIN está verde?** — PR verde ≠ main verde (só se a sessão mergeou algo)
6. **Chips** — abertos nesta sessão, com título exato
7. **Resumo de fecho** — formato padrão do CLAUDE.md
8. **wt:status** — higiene de RAM + oferta de limpeza

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
# saiu `UNKNOWN`/vazio em mergeStateStatus? a 1ª consulta só ENFILEIROU o cálculo — re-consulte:
sleep 5 && gh pr view <N> --json state,mergeStateStatus,statusCheckRollup,url
```

⚠️ **`mergeStateStatus` é calculado sob demanda e a sonda cega no PR FRIO** — que é exatamente
o PR de sessão parada que a `/fecho` audita. Medido em 2026-08-21: **6 de 7 PRs abertos** vieram
`UNKNOWN` na 1ª chamada; a 2ª devolveu **5 `CONFLICTING`**. O único que respondeu de primeira
tinha 0 dia de idade. → [mergeabilidade-assincrona.md](../../docs/historico/mergeabilidade-assincrona.md)

**Default do passo: sem leitura POSITIVA, não libera.** `UNKNOWN` é ausência de dado, nunca "não
está em conflito" — ler assim é o `Number(null) === 0` da mergeabilidade, e é fail-OPEN num ritual
que termina em EXCLUSÃO. (2ª reincidência da classe nesta skill: o #1677 já a consertou de "dava
'pode excluir' sem nunca olhar se a `main` está verde".)

- `MERGED` → ✅
- `OPEN` + CI rodando → ⏳ **arme o watcher antes de fechar**: `scripts/pr-watch.sh <N>` via
  Bash `run_in_background:true` (no desfecho, PushNotification pro founder — CLAUDE.md §Merge).
  A sessão PODE ser excluída com watcher armado? **Não** — o watcher morre com a sessão.
  Nesse caso o veredito é "espere o merge" OU entregue ao founder o link pra conferir depois.
- `OPEN` + `mergeStateStatus: DIRTY` → ❌ conflito; resolver antes de fechar.
- `OPEN` + `mergeStateStatus` **`UNKNOWN`/vazio nas DUAS leituras** → ❌ **não sei ≠ está limpo**;
  o veredito é *não consegui verificar* (irmão do exit **6** do `pr-watch.sh`). Não libere a
  exclusão nesse estado — entregue o link pro founder conferir depois.
- CI vermelho → ❌ investigar antes de fechar (PR não-draft NÃO mergeia vermelho).
- DRAFT segurado de propósito → listar como pendência consciente (com o porquê) **e com a
  DISTÂNCIA**: `git rev-list --count <branch>..origin/main`. Freio puxado não tem mola de retorno —
  o #1332 estava 415 commits atrás e o rebase revelou 2 defeitos reais de money-path. Acima disso,
  "segurado de propósito" precisa do propósito dito em voz alta, senão é esquecimento.

### Passo 2 — Migrations: entregue ≠ aplicada

```bash
# o que esta sessão criou/mergeou de migration
git log origin/main --oneline -20 -- supabase/migrations/   # mergeadas recentes
git diff --name-only origin/main...HEAD -- supabase/migrations/  # ainda no branch

# ⚠️ E o que OUTRAS sessões mergearam durante a janela desta — com ~30 worktrees paralelas,
# migration custom de terceiro entra na main sem ninguém aqui saber, e ela também NÃO se
# auto-aplica. Custa uma query e a falha é SILENCIOSA (2026-08-06: a ATP fase 1 entrou entre
# dois merges meus; conferida, estava aplicada — mas ninguém a teria conferido).
git log origin/main --since="<hora de início da sessão>" --name-only --format="" -- supabase/migrations/ | sort -u
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

### Passo 5 — A MAIN está verde? (só se a sessão mergeou algo)

**PR verde ≠ main verde.** O verde do PR atesta a base do momento em que o CI *rodou*; entre
ele e o merge cabe outro PR que muda a régua. Dois PRs verdes ISOLADAMENTE podem quebrar a
main JUNTOS — conflito semântico, que o git mescla sem reclamar. Não é hipótese: em
2026-08-06 o #1670 (gate de índice de docs) e o #1212 (que trazia um `.md` de julho, sem
linha no índice) mergearam com **135 segundos** de diferença e derrubaram a main por ~5h.

⚠️ **`gh run list --branch main` NÃO serve para isso.** O `auto-merge.yml` usa
`secrets.GITHUB_TOKEN` e, pela proteção anti-loop do GitHub, o push dele **não aciona
workflow nenhum** — o último run de `push` na main costuma ser de semanas atrás (só a via do
bot do Lovable cai ali). Consultar isso dá "verde por ausência de dado". Dispare de verdade:

```bash
gh workflow run CI --ref main            # o botão "validar a main agora" (~6 min)
sleep 60 && gh run list --branch main --workflow CI --limit 1 --json databaseId,status,conclusion
```

- `success` → ✅ pode fechar.
- `failure` → ❌ **investigue antes de fechar** — mas distinga REPROVAÇÃO de AUSÊNCIA DE
  RUNNER: job `cancelled` sem nenhum step executado, com duração ≈ `timeout-minutes`, é fila
  de runner, não defeito. Confirme pelo passe vizinho (outro run do repo verde na mesma
  janela) antes de re-rodar; sem isso, rerun só apaga sinal.
- Não deu tempo de esperar → entregue o link do run na mensagem de fecho como pendência com
  destino (o `schedule` diário das 09:17 UTC pega de qualquer forma, mas só no dia seguinte).

### Passo 6 — Chips (spawn_task)

Liste TODO chip criado nesta sessão com o **título exato** e 1 linha do que faz — o founder é
quem clica, e chip sem rastreio já gerou confusão ("não consegui identificar qual é este chip").
Se um chip ficou obsoleto pelo próprio trabalho da sessão, diga explicitamente que pode ignorar.

### Passo 7 — Resumo de fecho (formato padrão)

> **Problema** → **Diagnóstico** → **Decisões (e pareceres Codex)** → **Implementado**
> (arquivos · PRs · migrations) → **Verificação** (o que foi provado e como) →
> **Pendências do founder** (lista numerada, com destino rotulado: 🟣 SQL Editor / 💬 chat
> Lovable / 🖱️ Publish / 🔘 chip) → **Onde está persistido** (PRs, docs/historico, docs/agent).

### Passo 8 — Higiene de RAM

```bash
bun run wt:status   # ⚠️ com a máquina em swap passa de 120s → rode com run_in_background:true
```

Reporte o resultado e ofereça `wt:clean` / `wt:reap` (e `wt:prune` se houver worktree de
conversa já excluída) — isso vale para as **outras** worktrees paradas.

**Para ESTA sessão, não ofereça `wt:clean --include-current`:** arquivar já para o processo
**e limpa o worktree** por padrão (e a sessão segue reabrível pela lista de Arquivadas).
Sugerir a limpeza manual em cima disso é redundante e faz o founder trabalhar à toa.

---

## Veredito final (formato)

```
### Fecho da sessão — <tema>

✅ PRs: #A, #B mergeados (CI verde)
✅ Migrations: 2026…_x.sql aplicada (validação psql-ro ✅)
✅ Edges/Publish: n/a (sessão só de tooling)
✅ Main: CI completo verde (run <id>, disparado agora)
Pendências (TODAS com destino — nenhuma "na memória"):
  ✔ <pendência resolvida agora, com a evidência>
  🔘 chip "<título exato>" (faz X — clique quando quiser)
  🚫 <pendência descartada> — porquê em 1 linha
  📌 <pendência futura> — registrada em <doc/plano>, vira chip quando <gatilho>

Veredito: PODE ARQUIVAR a sessão. / AINDA NÃO — falta (1)…
```

**Diga "pode ARQUIVAR", não "pode excluir".** Arquivar para o processo, limpa o worktree
(mesma RAM e mesmo disco que excluir) e ainda deixa a sessão reabrível — não há motivo para
recomendar a via destrutiva. Se o founder arquiva sessão a sessão na mão, mencione UMA vez a
preferência **"Auto-archive on PR close"** nas Settings, que resolve isso estruturalmente.

Nunca diga "pode arquivar" com item ❌/⏳ crítico em aberto sem nomeá-lo na lista do founder —
e nunca com pendência SEM um dos 4 destinos acima ("fica na sua mão lembrar" não é destino).
