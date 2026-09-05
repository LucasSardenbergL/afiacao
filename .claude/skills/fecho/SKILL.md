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
   ⚠️ Chip é destino **perecível** — vale só até a sessão ser arquivada. Ver passo 6: se não for
   clicado no fecho, o prompt também vai para um lugar durável.
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
tinha 0 dia de idade. → [mergeabilidade-assincrona.md](../../../docs/historico/mergeabilidade-assincrona.md)

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

### Passo 2b — A sentinela do `claude_ro` (rápido, e é o único vigia que ele tem)

```bash
bun run authz:claude-ro:prod; echo "exit=$?"
```

O endurecimento do papel de leitura (2026-08-25) é **estado colado à mão**: não existe migration
que o defenda, e não pode existir. Ninguém mais olha para ele — nem o CI (não tem `psql-ro`), nem o
Sentinela de cron. Este passo é a vigília inteira.

- `exit=0` → ✅ segue de pé, siga.
- `exit=1` → ❌ **regrediu ou drifou.** O relatório nomeia a asserção. Se a divergência for só no
  ACL do schema `net` **e** a linha `versão do pg_net` também divergir, a causa é um upgrade da
  extensão feito pelo Supabase — reavalie o novo ACL e atualize o baseline em
  `db/audit-claude-ro-hardening.ts`; **não** afrouxe a comparação.
- `exit=2` → ⚠️ **não consegui medir** (psql-ro fora, sem rede, credencial revogada). Isso é
  ausência de dado, não aprovação — **não feche a sessão anotando "ok"**. Diga que não mediu.

Contexto: `docs/agent/database.md` §1 · `docs/historico/revoke-que-nao-revoga.md`.

### Passo 3 — Edges

```bash
# o que ESTA sessão tocou
git diff --name-only origin/main...HEAD -- supabase/functions/

# ⚠️ E o que OUTRAS sessões mergearam na janela desta — MESMO argumento do passo 2, e ele vale
# aqui palavra por palavra: edge de terceiro entra na main sem ninguém aqui saber, também NÃO
# se auto-deploya (chat do Lovable, manual) e a falha é igualmente SILENCIOSA.
#
# Este script enumera a janela INTEIRA (a desta sessão e a das outras) e já classifica quem
# precisa de chip. Use-o em vez do `git log` cru — o cru é o gatilho velho, ver abaixo.
bash .claude/skills/fecho/scripts/edges-pendentes.sh --desde "<hora de início da sessão>"
# aceita DATA ou REVISÃO — se você anotou o SHA de origin/main ao abrir a sessão, prefira o SHA
# exit 0 = nada pendente · 1 = abra chip para a lista · 2 = MECÂNICA não confiável (o script já
# imprime tudo como pendente; trate assim) · 3 = uso inválido
#
# Se VOCÊ acabou de disparar sondas nesta sessão, cole os request_id: é o único vínculo que
# alcança o bundle que responde sem dizer de quem é (ver `SONDA_ANONIMA` na tabela abaixo).
# ... --request-ids "conciliar-pedido-portal=69377,process-nfe=69381"
```

**O gatilho deste passo é "sem prova de estar no ar", não "tem commit na janela".** O `git log`
cru era o gatilho antigo, e num repo com dezenas de worktrees ele é quase sempre verdadeiro: a
MESMA edge virava chip em toda sessão que fechasse na mesma janela, e fila de chips iguais
enterra o chip que importava. O script troca isso pela evidência que já existe de graça — o campo
`fonte` que a sonda serve (SHA-256 do fecho transitivo dos imports) comparado com
`sonda-fingerprints.ts` da main:

| veredito | o que significa | chip? |
|---|---|---|
| `NO_AR` | `fonte` servido == main — o bundle no ar é este | **não** |
| `DESATUALIZADA` | `fonte` servido ≠ main — bundle VELHO servindo | sim, e prioritário |
| `PRE_SONDA_FONTE` | respondeu a sonda (200 + eco de `probe`/`versao`) **sem** o campo `fonte` — bundle anterior ao #1998 | sim, e prioritário |
| `SEM_PROVA` + `SONDA_ANONIMA` | há resposta de sonda na janela **sem eco de slug** — existe e não é atribuível | sim (fail-closed), e o `--request-ids` determina |
| `SEM_PROVA` | fora do mapa de sondas, sem sonda na janela, ou mecânica quebrada | sim (fail-closed) |
| `INERTE` | edge **aposentada**: o `index.ts` na REF (`origin/main`) carrega `// EDGE-APOSENTADA:` — o handler responde 410 antes de qualquer lógica, bundle novo e velho se comportam igual | **não** — deploy não muda comportamento; não pedir ao founder |

🪦 **`INERTE` é a única prova que vem do git, não do banco (2026-09-05, `tint-import`).** A edge
foi aposentada em #1401 (410 `TINT_IMPORT_RETIRED` logo após a auth), mas continua TOCADA por PR
porque carrega o espelho VERBATIM de `parse-decimal-br.ts` que o `edge-parse-parity.test.ts` exige —
cada PR do parser (#2184) a punha na janela como `SEM_PROVA`, chip para o founder, por um deploy
sem efeito. Prova passiva é impossível (fora do mapa) e prova ativa seria teatro. O que existe é o
marcador DECLARADO, lido da REF e nunca do working tree; o gate `_shared/edge-aposentada-marcador_test.ts`
exige `status: 410` no mesmo arquivo (marcador em edge viva = vermelho). Contrato de quem marca: a
aposentadoria JÁ está no ar — o único deploy que importaria é o que a instala.
Detalhe: `docs/historico/edge-aposentada-inerte-no-fecho.md`.

⚠️ **`PRE_SONDA_FONTE` é pendência PROVADA, não indeterminada — e nasceu de um falso
INDETERMINADO.** `criarRespostaSonda` só passou a servir `fonte` no #1998 (~2026-08-25): um bundle
ANTERIOR responde `{ok, probe, versao, edge}` — 200, com eco —, e a 1ª versão do script filtrava
essas linhas por `? 'fonte'` ANTES de classificar, então elas sumiam e a edge caía em "nenhuma
sonda na janela: INDETERMINADO". Medido em prod (2026-09-05): das 40 edges do mapa, **7** eram
isso, e o script alegava não ter observado nada sobre as 7 — sendo que o 200 sem `fonte` PROVA que
o ar é anterior ao #1998. Ausência FABRICADA não é fail-closed: é ruído com o mesmo desfecho do
sinal, e enterra o chip que importa. Continuam INDETERMINADOS (`SEM_PROVA`): 401, resposta sem eco
de `probe` (pré-sensor) e ausência real de linha.

⚠️ **E há um degrau ANTES desse: o bundle que nem ecoa o slug.** O casamento resposta↔edge usa
`content->>'edge'`, que só nasceu no #1789 — bundle anterior responde `{ok,probe,versao}` e mais
nada. Medido 2026-09-05 (request_ids 69377-69381): das 5 edges sondadas, as 2 que ecoam `edge`
saíram `PRE_SONDA_FONTE` e as 3 restantes saíram "nenhuma sonda em 6 hours" — o **mesmo** erro do
`PRE_SONDA_FONTE` uma geração de campo atrás, e desta vez com a resposta gravada no banco. Não dá
para presumir de qual edge é a linha (`net.http_request_queue`, a única tabela do pg_net com a URL,
é apagada quando a resposta chega — conferido no mesmo dia), então **a identidade ausente continua
ausente**: o veredito é INDETERMINADO e o chip continua. O que mudou é a saída dizer `SONDA_ANONIMA`
e contar quantas há, em vez de alegar que ninguém sondou — e apontar o `--request-ids`, que é o
único vínculo determinístico. Com os 5 ids colados, as 5 edges daquele dia saíram `PRE_SONDA_FONTE`:
pendência PROVADA que o diagnóstico anterior escondia.

🔴 **A direção é uma só: presença PROVA, ausência NÃO reprova** (#2086/#2095). O script só sabe
SUPRIMIR chip com evidência POSITIVA; ele é o lado que APAGA pendência, então na dúvida é chip.
O mapa cobre ~40 das ~95 edges — as outras seguem virando chip como sempre, nada regride.
Medido em 2026-08-28 numa janela real de 24h: 7 edges na janela, 3 provadas no ar, **4 chips em
vez de 7**. E não é só corte: o `DESATUALIZADA` é sinal que o gatilho velho nunca teve — ele
mostra bundle velho SERVINDO, que é a falha silenciosa que este passo existe para pegar.

⚠️ **`_shared/` na janela: a ponta que FALTA decide se é cegueira ou só lista mais larga.** O guard
das duas pontas do mapa nasceu com um `||` — faltando QUALQUER uma, exit 2 por atacado —, e isso
travava o passo justamente na janela de MAIOR risco: quando `_shared/` muda é quando mais edge é
afetada por transitividade. Medido 2026-09-05 (`--desde "2026-08-21 20:00"`): 26 arquivos de
`_shared/` tocados, 41 das 95 edges afetadas, e **veredito nenhum** — porque o commit-base era
anterior ao #1998, que CRIOU o mapa. As duas pontas não têm o mesmo papel: `mapa_agora` (main) é a
fonte do `esperado` de toda edge, e sem ele a cegueira é real (exit 2 segue certo); `mapa_base` só
ESTREITA o diff, e sem ele nenhum par casa e a via (a) emite o mapa INTEIRO como alvo — o
**superconjunto seguro**, a lista larga e não a vazia. Corrigida a assimetria, a MESMA janela
devolve **16 `NO_AR` provadas + 25 `SEM_PROVA`** no lugar de 41 pendências cegas. Degradar aqui é
AMPLIAR a enumeração, nunca absolver: cada alvo segue classificado um a um por prova positiva.

🕳️ **`SEM_PROVA` por "nenhuma sonda na janela" NÃO se resolve esperando — DISPARE.** Não existe
cron de sondagem: `cron.job` tem 93 jobs e **zero** com `probe`. Quem dá prova passiva é só a edge
cujo fluxo NORMAL já ecoa o envelope (`edge`+`fonte`) **e** tem cron frequente —
`analytics-outbox-drain` (5 em 5 min) é o caso típico. Medido 2026-09-05: **24 das 54 edges do
mapa não têm cron NENHUM** (webhook como `omie-nfe-webhook`, ou invocada sob demanda pelo app como
`analyze-unified-order`), e para essas a prova passiva é *impossível*; ainda por cima
`net._http_response` expira no TTL do pg_net, então a janela só encolhe. O remédio é
`bun run sonda:sql <edge>…` — PASSO 1 (escrita + vault) o founder cola no SQL Editor do Lovable;
PASSO 2 julga em SELECT puro (`--so-leitura`, roda no `psql-ro`); com o id em mãos, `--request-ids
<slug>=<id>` fecha o vínculo. ⚠️ Aprendido caro: o autor do próprio script leu este ramo como
"espere o próximo tick do cron" **horas depois de escrevê-lo**, ao verificar dois deploys reais — a
espera nunca terminaria, e o `SEM_PROVA` persistente passaria por pendência real (chip eterno numa
edge que já está no ar). O script hoje imprime o remédio no rodapé, preso pelo caso 3b e pela
sabotagem (a6).

Se a sessão tocou edge: ela foi deployada via chat do Lovable? (Evidência: o founder confirmou
na conversa, ou a canária/probe respondeu com o comportamento novo.) Pendente → inclua o prompt
de deploy verbatim (skill `lovable-deploy-verify`, passo 3) na mensagem de fecho.

⚠️ **"Se a sessão tocou edge" NÃO é o gatilho deste passo — é só o gatilho da metade dele.**
Edge de TERCEIRO na janela é pendência desta `/fecho` do mesmo jeito que migration de terceiro é,
e pela mesma razão. Medido em 2026-08-26, na sessão do #2023/#2027: o `7e076f1f7`
(`fix(omie)`, coleira de relógio no reconcile) mergeou dentro da janela tocando
`omie-nfe-reconcile/index.ts` e um `_shared/omie-deadline.ts` NOVO. Só apareceu porque o agente
alargou a consulta por conta própria — pela letra deste passo, ele teria olhado a saída do
`git log`, visto commit que não era dele, e seguido em frente.

Destino de edge de terceiro **não é** "deployar por ela" nem "assumir que a outra sessão já
pediu": é **chip** (a sessão dona pode ter fechado sem pedir o deploy) — para as que o script
marcar como pendentes, e só para elas —, com o prompt mandando CONFIRMAR antes de pedir deploy
redundante. E o prompt tem de nomear **todos** os arquivos,
`_shared` novo incluído — prompt que nomeia um só deixa a edge sem bootar (#2020).

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

### Passo 6 — Chips (spawn_task): criado ≠ CLICADO

Liste TODO chip criado nesta sessão com o **título exato** e 1 linha do que faz — o founder é
quem clica, e chip sem rastreio já gerou confusão ("não consegui identificar qual é este chip").
Se um chip ficou obsoleto pelo próprio trabalho da sessão, diga explicitamente que pode ignorar.

⚠️ **E aqui o passo GATEIA o veredito.** Criar o chip não entrega a pendência: o chip é um convite
que só vira trabalho quando o founder CLICA. Havendo chip não clicado, o veredito **não** é "pode
arquivar" — é "**clique os chips e então arquive**", com a lista na frente dele.

**O clique não é verificável por sonda, e não tente.** O único caminho seria o `dismiss_task`, que
até responde se o founder já agiu — mas RETIRA o chip quando ele ainda não agiu. Sonda que destrói
o que mede não é sonda. Pergunte ao founder, ou liste e deixe o gate explícito.

⚠️ **Chip não clicado é destino PERECÍVEL — e isso colide com o princípio desta skill.** O chip
mora dentro da sessão que o criou, o `/tasks` é por-sessão e não há fila global. Arquivada a sessão
antes do clique — pelo founder ou pelo auto-archive —, não há caminho conhecido de volta até aquele
chip. Levantado em 2026-08-26: **não está documentado** se o chip sobrevive ao arquivamento (o
`spawn_task` é MCP local, sem doc pública; em disco, `~/.claude/tasks/` guarda TodoWrite, não chip).
Ausência de dado não é "sobrevive" — num ritual que termina em arquivamento, isso é **fail-CLOSED**.

**A regra:** chip que não for clicado durante o fecho tem o prompt copiado para um lugar DURÁVEL
antes do veredito — corpo do PR da sessão, `docs/historico/`, ou issue. O chip vira o atalho; o
texto durável vira o destino. "Pendência sem destino não existe" vale **também** quando o destino
é perecível.

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
  🔘 chip "<título exato>" (faz X — CLIQUE ANTES de arquivar; prompt salvo em <lugar durável>)
  🚫 <pendência descartada> — porquê em 1 linha
  📌 <pendência futura> — registrada em <doc/plano>, vira chip quando <gatilho>

Veredito: PODE ARQUIVAR a sessão. / CLIQUE OS CHIPS e então arquive. /
         AINDA NÃO — falta (1)…
```

**Diga "pode ARQUIVAR", não "pode excluir".** Arquivar para o processo, limpa o worktree
(mesma RAM e mesmo disco que excluir) e ainda deixa a sessão reabrível — não há motivo para
recomendar a via destrutiva.

⚠️ **A menção ao auto-archive é CONDICIONAL — e os passos 1 e 6 já mediram as condições.**
O nome exato é **"Auto-archive after PR merge or close"** e ele mora **só na UI do app desktop**
(Settings → Claude Code): procurá-lo em `settings.json` não acha nada, e a ausência ali **não**
significa desligado.

**O gatilho é uma CONJUNÇÃO** (verificado em 2026-08-26, doc do desktop): PR mergeado *ou* fechado
**E** a sessão *"finished running"*. Logo ele **não** arquiva sessão ocupada — a versão anterior
deste rodapé temia isso e exagerava; corrigido. O que a doc **não** define é o que conta como
"finished running" (subagente vivo? task enfileirada? chip pendente?) — então não afirme nada sobre
isso.

**O que sobra é o que importa aqui:** "finished running" quer dizer *o agente parou*, não *a
entrega acabou*. Neste repo **merge ≠ produção** — a sessão que mergeou um PR com migration dentro
e está parada esperando o founder colar o SQL no Lovable satisfaz as duas condições e arquiva com a
pendência viva. O evento de PR não enxerga SQL Editor, deploy de edge nem Publish, e não enxerga
**chip não clicado** (passo 6). Só mencione o toggle quando a sessão fechou com **exatamente UM PR,
zero camada manual pendente e zero chip por clicar** — fora disso ele arquiva cedo demais.

**E não dá para torná-lo condicional:** não há setting, flag ou hook documentado que suprima ou
adie o arquivamento (levantado em 2026-08-26). O ritual não controla o gatilho; controla a **ORDEM**
— o veredito segura o arquivamento até os chips serem clicados e as camadas manuais nomeadas.

A classe: **recomendação embutida em ritual sai com a AUTORIDADE do ritual.** O founder lê "o
fecho mandou", não "o agente sugeriu" — então recomendação daqui carrega a própria pré-condição
junto, ou vira conselho errado dito com voz de veredito. É o defeito dos #1677 e #1863 deslocado
do veredito para o rodapé: fail-open não deixa de ser fail-open por estar no fim da página.

Nunca diga "pode arquivar" com item ❌/⏳ crítico em aberto sem nomeá-lo na lista do founder —
e nunca com pendência SEM um dos 4 destinos acima ("fica na sua mão lembrar" não é destino).
