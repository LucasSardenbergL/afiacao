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
- **`.claude/hooks/pr-duplicata-guard.sh`** (2026-08-18) — o fecho ESTRUTURAL. A cláusula acima é
  contramedida textual, e a meta-regra do catálogo de retrabalho diz que contramedida textual
  reincide: a regra do eixo OBJETIVO já existia desde 2026-07-23 e não segurou as 3 ocorrências.
  O hook testa as três vias por (arquivo, símbolo) e AVISA — **no `git commit` e no `gh pr create`**
  (o gatilho do commit desceu no mesmo dia; §abaixo).
- Aqui — as 3 ocorrências e a falsificação.

## O gatilho desceu para o `git commit` — e o que a medição autorizou (2026-08-18)

O hook nasceu só no `gh pr create`, e isso repetia o furo de TEMPO que o guard irmão
(`pr-collision-guard.sh`) já havia corrigido no #1770: **no `create` o trabalho JÁ está pronto**, então
a rede evita o merge duplicado e não o DESPERDÍCIO — #1757 (6 arq, +270) e #1764 (1 arq, +29) foram
escritos e descartados no mesmo dia, o #1764 morto 36s depois de criado. Decisões reusadas verbatim do
irmão: conjunto = STAGED ∪ commits da branch (∪ árvore só em `-a`); 1 aviso por (branch, conjunto de
achados), com achado novo furando o silêncio e o `create` nunca silenciado; e **nenhum cache de rede**.

O que **não** era transplante — e por isso foi medido antes de implementar — é o risco próprio deste
eixo: extrair "o símbolo que eu ia criar" é mais ruidoso que interseção de nomes de arquivo, e um
detector impreciso disparando a cada commit cega o leitor e degrada o portão do `create` junto.

**Duas evidências decidiram, em direções opostas:**

1. **Contra descer — a precisão é modesta.** Replay do teste de 3 vias sobre **797 pares de PRs
   mergeados concorrentemente** (janela de 8h, 60 PRs): num teto **pessimista** (merge-base velha) o par
   (arquivo,símbolo) dispara em **51 de 134** pares que compartilham arquivo. Os dois PRs de cada par
   mergearam ⇒ ali todo disparo é falso positivo. Causa: "símbolo novo NO arquivo" inclui nome
   **referenciado**, não só criado (`AUTHZ_MANIFEST`, `service_role`), e o ruído concentra em arquivo
   append-only compartilhado — `docs/historico/*.md` + `scripts/audit-custom-migrations.sql` sozinhos
   são 27 dos 51.
2. **A favor — descer não cria ocasião de alarme nova, e é teorema, não estimativa.** Disparar exige o
   símbolo ausente em `<mb>:<arquivo>` **e** presente em `origin/main:<arquivo>` ⇒ a main mexeu naquele
   arquivo desde a merge-base ⇒ o arquivo já está no conjunto (a) do `pr-collision-guard`, que avisa no
   commit desde o #1770. **O conjunto de disparos deste guard é subconjunto do daquele:** ele nunca
   fala onde o irmão cala. O custo marginal de descer não é "um alarme novo por commit" — é uma linha a
   mais dentro de um alarme que já sairia, e essa linha nomeia o símbolo, que é justamente o que torna a
   conferência barata.

**O buraco honesto na medição:** o FP que só o commit pode criar — símbolo escrito no commit K e
removido até a ponta — ficou SEM número. O replay por-commit das 60 branches reais (via
`refs/pull/N/head`, que dá o merge-base verdadeiro) foi montado e morreu antes de terminar (~50min).
O que sobrou é o limite: **38 das 60 branches têm 1 commit só**, e nelas o gatilho é a avaliação do
`create` mais cedo, sem janela para transitório; nas outras 22 a classe existe mas o aviso era
verdadeiro quando saiu. Classe pequena e limitada — não zero, e não medida. Registrado assim de
propósito: inventar o número seria pior que admitir o buraco.

⇒ **desce o gatilho, e a imprecisão vira redação:** a mensagem diz "**possível** duplicata" e manda
conferir com `git log -S`, nunca "você duplicou". **Filtrar `docs/` foi REJEITADO** (para não voltar
como ideia nova): a ocorrência 2 das 3 acima era exatamente um follow-up de doc — o filtro compraria
silêncio ao preço de um falso negativo já medido.

**Achado de tabela:** o `scripts/test-pr-duplicata-guard.sh` do #1769 **não rodava no CI** — o arquivo
foi criado, mas o laço do `test:hooks` lista os guards por nome e ele ficou de fora. Teste órfão é a
forma mais cara de "ausência de sinal com cara de verde" (irmã do `grep` sem ocorrência, do linter sem
a regra). Corrigido nesta entrega, junto com os 5 casos novos e as 2 falsificações novas.

## Auditoria de PODER da suíte (mutation-check, 2026-08-18)

O guard nasceu com bloco de **falsificação embutido** (5 sabotagens: as 3 vias, o escopo por-arquivo,
o alvo do commit, o dedupe) — e mesmo assim tinha 1 furo. Contrato executável agora em
[`scripts/mutcheck.d/pr-duplicata-guard.mut`](../../scripts/mutcheck.d/pr-duplicata-guard.mut)
(6 mutações, todas PEGA; primeiro alvo **shell** do `mutcheck.d` — `@test_cmd: bash`,
`@compile_cmd: bash -n`).

O que a auditoria mostrou, e vale além deste hook:

1. **A falsificação escrita junto com a feature cobre o NÚCLEO — a periferia é o que o autor não
   estava pensando.** As 5 sabotagens embutidas miravam o miolo do algoritmo; o furo estava na
   sanitização de heredoc/aspas (a decisão "menção ≠ execução"), afirmada no cabeçalho e **sem
   nenhuma sabotagem**. Desligar a sanitização inteira **sobrevivia à suíte**.
2. **Por que sobrevivia — e a lição geral: asserção negativa só tem poder se TODO caminho
   alternativo estiver ARMADO para falar.** O caso 4 testava a menção (`echo "git commit -m x"`)
   com `_deve_calar`, mas rodava só com `GIT_STUB_MINE_FILE`. Ao escapar da sanitização o hook
   entrava em modo `commit` e lia `GIT_STUB_STAGED_FILE` — **não setado**, default `/dev/null` →
   calava por **acidente do fixture**, não pela invariante. Correção: o caso 4 arma os três alvos
   do stub (`ARMADO`) e ganhou caso de **heredoc**; a mutação passou a reprovar.
3. **Fechado também o limiar de 12 chars** (caso 7b): irmão do filtro de forma, mas eixo
   independente — sem ele, baixar o limiar de precisão não reprovava nada.

Suíte: 31 → 33 asserções. `bun run test:hooks` verde; contrato roda no job `mutation-check`.

## Precedente

| quando | caso | forma |
|---|---|---|
| 2026-07-23 | #1550/#1560 (redação de PII do PostgREST) | 2 sessões, mesmo achado de Codex; implementação descartada inteira; desenho alheio melhor |
| 2026-08-06 | #1525/#1526 | duplicata detectada 6 min tarde demais; 26 arquivos jogados fora |
| 2026-08-15 | as 3 acima | primeira vez com o entregador **já na main** — o que expôs a cegueira do detector por título |
