# Duplicata por OBJETIVO — o eixo que a checagem por ARQUIVO não vê

> **A lição não é "coordene mais".** O eixo já estava escrito desde 2026-07-23
> (`docs/agent/worktrees.md`, "achado COMPARTILHADO colide por DESENHO"). O que falhou em
> 2026-08-15 foi o **DETECTOR** que aquela regra prescreve: varrer **TÍTULO** de PR. Medido contra
> as 3 ocorrências, o título dá **0 hits** e o grep do artefato na `origin/main` dá **1**. Regra
> certa com sensor cego é indistinguível de regra ausente — só que mais cara, porque ninguém
> suspeita dela.

## O modo de falha

A checagem multi-sessão do CLAUDE.md é do eixo **ARQUIVO**: `origin/main` + `gh pr list` +
migrations paralelas, para não colidir no merge. Ela funciona, e nas 3 ocorrências abaixo ela
**passou limpa** — não havia conflito de arquivo nenhum a detectar.

O que aconteceu foi outra coisa: **o objetivo da tarefa já estava entregue na `main`**. Não há
conflito porque não há disputa — a outra sessão terminou primeiro, mergeou, e o trabalho desta
sessão virou duplicata inteira. O custo não aparece como rebase; aparece como implementação
descartada.

## As 3 ocorrências (2026-08-15, uma única sessão, mesmo dia)

| # | o que a sessão ia fazer | quem já tinha entregue | como se descobriu |
|---|---|---|---|
| 1 | registrar `public.reposicao_pos_marcador` em `scripts/authz-manifest.ts` | `c542210c` (#1744), com `requiredGate` **idêntico** | tarde — trabalho refeito e descartado |
| 2 | follow-up 1 do §6 de [sentinela-authz-controle-nao-mencao.md](sentinela-authz-controle-nao-mencao.md) (ampliar `touchesSensitive` p/ o eixo COMPRAS) | `c542210c` (#1744) — **o mesmo commit** | idem |
| 3 | consertar a `main` vermelha (o `edges:typecheck` herdava o grafo npm do FRONTEND) | `a891ba9c` (#1763), mesma causa raiz e **solução melhor** (`DENO_NO_PACKAGE_JSON=1`) | ao investigar, o conserto já estava na main |

Duas notas que mudam a leitura:

- **1 e 2 saíram do MESMO commit.** Um PR alheio pode zerar mais de um item da sua fila de uma vez
  — a fila não é conferida item a item contra a main, então o segundo item continua parecendo
  pendente depois que o primeiro é descoberto duplicado.
- **A ocorrência 3 não foi só empate perdido: a solução alheia era MELHOR.** Mesma forma do
  #1550/#1560 (allowlist alheia > denylist minha, que eu provei vazar PII). Chegar depois não custa
  só a hora — custa a chance de construir **sobre** o desenho melhor em vez de contra ele.

## Por que o detector prescrito não pegou

`docs/agent/worktrees.md` já mandava varrer por tema:
`gh pr list --state all --search "<termo> in:title"`. Falsificado contra as ocorrências:

```
# TÍTULO (subject) menciona o símbolo?
git log origin/main --format='%s' | grep -c 'reposicao_pos_marcador'   → 0
git log origin/main --format='%s' | grep -c 'DENO_NO_PACKAGE_JSON'     → 0

# o ARTEFATO existe no código da origin/main?
git grep -c reposicao_pos_marcador origin/main -- scripts/authz-manifest.ts
  → origin/main:scripts/authz-manifest.ts:1
git grep -c DENO_NO_PACKAGE_JSON origin/main -- scripts/
  → origin/main:scripts/edges-typecheck-gate.ts:4
```

Duas causas independentes, e **cada uma sozinha** já cega a busca por título:

1. **O trabalho estava MERGEADO.** `gh pr list` lista PR **aberto** por padrão; sem `--state all` o
   entregador nem aparece. (No caso 1 o símbolo estava no *corpo* da mensagem — `git log --grep`
   acha, `in:title` não. Buscar o corpo é acidente, não método: depende de o autor ter citado.)
2. **O PR entrega sob o tema DELE, não sob o seu símbolo.** O título do `c542210c` é *"o eixo do
   gate passa a ver COMPRAS — 12 SECDEF invisíveis viram contrato medido"*. Ele registra a sua RPC
   como **consequência** de um trabalho maior. Nenhum termo que você buscaria (`reposicao_pos_marcador`,
   `authz-manifest`) está ali. Quanto mais amplo o PR alheio, mais invisível ele é à busca por título
   — e mais provável que ele tenha comido o seu item.

## A regra que fecha

**Procure o ARTEFATO, não o discurso sobre ele.** O símbolo/entrada/comportamento que a tarefa ia
criar é literal, é grep-ável, e existe na `origin/main` se alguém já entregou — independentemente de
como o PR se chamou, de estar aberto ou mergeado, e de o autor ter citado o símbolo em algum lugar.

```bash
git fetch origin && git grep <símbolo> origin/main -- <caminho>   # o artefato já existe?
git log -S '<símbolo>' origin/main --oneline                       # quem o introduziu
```

**Duas vezes: antes de implementar e antes de entregar.** A primeira evita a hora perdida; a segunda
pega o PR que mergeou durante a sua sessão (o auto-merge fecha PR em minutos — um já viveu 6). É a
mesma cadência que a regra do eixo ARQUIVO já tem; o que muda é **o que** se procura.

⚠️ **Só vale com `git fetch` na frente.** Grep contra uma `origin/main` defasada é o
`Number(null)===0` desta classe: devolve "não existe" com a mesma cara de quem procurou de verdade.
Irmã da regra "sincronize antes de MEDIR" (`worktrees.md`).

## Onde isto ficou

- **CLAUDE.md, §Multi-sessão** — uma cláusula anexada à checagem existente (o eixo ARQUIVO estava lá
  sozinho, e é *ele* que a sessão lê em toda sessão/subagente; sem a cláusula, nada sinaliza que há
  um segundo eixo em `worktrees.md`).
- **`docs/agent/worktrees.md`** — o detector falsificado, anexado ao bullet "achado COMPARTILHADO"
  de 2026-07-23, que é onde o eixo já morava.
- Aqui — as 3 ocorrências e a falsificação.

## Precedente

| quando | caso | forma |
|---|---|---|
| 2026-07-23 | #1550/#1560 (redação de PII do PostgREST) | 2 sessões, mesmo achado de Codex; implementação descartada inteira; desenho alheio melhor |
| 2026-08-06 | #1525/#1526 | duplicata detectada 6 min tarde demais; 26 arquivos jogados fora |
| 2026-08-15 | as 3 acima | primeira vez com o entregador **já na main** — o que expôs a cegueira do detector por título |
