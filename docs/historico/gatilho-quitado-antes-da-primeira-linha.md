# A fatia de GATILHO, quitada antes da primeira linha (2026-09-06)

Fecha o "Dano hoje ZERO ⇒ chip com gatilho" de
[a-forma-que-some-e-a-forma-que-mente.md](a-forma-que-some-e-a-forma-que-mente.md):
8 sítios em 6 páginas cujas fontes medem **0 linha** em prod. Não foram corrigidos por
severidade herdada — foram corrigidos porque **depois da primeira linha o aviso some
calado**, e aí ninguém liga o sumiço à falha de leitura. Mesmo perfil do
`carteira_coverage` (0 linhas em 2026-08-22, quitado na leva seguinte).

**Re-medido antes de agir** (`psql-ro`, 2026-09-06 — o gatilho é justamente a fonte deixar
de ser zero): `fin_ic_matches` 0 · `v_sugestao_negociacao_ativa` 0 · `picking_tasks` 0 ·
`whatsapp_conversations` 0. Denominador de gente inalterado: **2 employee + 1 master**,
`commercial_roles` = 3 — toda tela admin aqui é vista por 3 pessoas.

## O que a entrega acrescentou à classe

### 1. O inventário errou em UM hook, e o erro mudava o conserto

O inventário registrou `WhatsappInbox:110` como "também engole". **Não engole**:
`fetchWhatsappSla` faz `if (res.error) throw new Error(res.error.message)`. Quem convertia
falha em vazio era o **`= []` do binding do consumidor** (`const { data: slaRows = [] } =
useWhatsappSla()`), que enche o `Map` de vazio e apaga o `<SlaBadge>` de **todas** as
linhas — lista completa, zero sinal, sobre um relógio de 15/30 min.

A lição não é "o inventário errou": é que **`= []` no binding é um segundo lugar onde a
mesma conversão acontece**, e ele não está no `queryFn` nem no `&&`. O inventário mediu por
AST se o hook lança (§2) e por forma o que a UI faz (§1) — o default do *destructuring* do
consumidor cai entre os dois. Procurar só nos dois lugares conhecidos deixa este terceiro
passar.

### 2. A camada sem teste aparece na falsificação, não na revisão

`AuditoriaTab` faz **duas** leituras (`picking_tasks`, depois `picking_task_items`). Pôr o
`throw` só na primeira deixaria a segunda inalcançada — e o dano dela é pior que o da aba:
sem itens, `divCount` fica vazio, cada linha recebe `divergencias: 0` e a coluna pinta um
badge **verde de "0"** sobre uma conferência que ninguém leu. O teste original falhava só na
1ª leitura; a camada da 2ª ficaria **verde sob sabotagem**. Foi preciso um caso que faz a 1ª
VIR e só a 2ª falhar — o que exigiu o mock rotear **dados por tabela**, não só a falha.

> **Regra que sai daqui:** um `queryFn` com N leituras precisa de N sabotagens, e o mock tem
> de saber devolver **sucesso numa tabela e erro na outra**. Mock que só sabe "tudo ok" ou
> "tudo erro" não consegue exercitar a 2ª leitura — a camada fica invisível para o laço.

### 3. `{data?.length ?? 0} registros` é o sub-tipo que mente **em número**

Na Fila IC a frase ("Nenhum registro encontrado") e o **contador do título** mentiam juntos:
`Number(null) === 0` fabrica o zero, e "0 registros" é tão afirmativo quanto a frase. Corrigir
só a frase deixaria o número dizendo a mesma coisa em cima. O contador virou `—`.

## O laço de falsificação (9 camadas, controle verde na MESMA invocação)

Controle **31/31 verde** antes do 1º `sed`; 8 das 9 sabotagens vermelhas; **uma verde** —
`if (erroItens) throw erroItens` (a 2ª leitura da auditoria). O diagnóstico do rótulo é
"redundante **ou** inalcançada", e aqui foi a segunda, por um motivo que vale a regra:

> **O `git checkout --` do `restaurar()` apagou o teste que cobria a camada** — ele fora
> escrito DEPOIS do commit da implementação, durante o preparo do laço, e nunca commitado.
> A regra "COMMITE antes de falsificar" vale também para o teste que você acabou de
> escrever para o próprio laço: `restaurar()` não distingue sabotagem de trabalho novo.

Depois de recommitar o caso, a mesma sabotagem virou vermelha
(`AssertionError: expected 'success' to be 'error'`) com controle **32/32**. Sem o laço,
a linha teria ficado no diff parecendo protegida, com o teste ausente e ninguém sabendo.

## Armadilhas de FERRAMENTA medidas nesta entrega

- **`bunx` no PATH é o shim do `heavy`** (`which -a bunx` → `~/.local/bin/heavy`), e `bun` é
  uma função de shell que faz o mesmo. Consequência para laço de falsificação: `heavy bash
  laço.sh` que chame `bunx` por dentro pede um **2º slot** e trava — com `SLOTS=1` trava a
  máquina. O certo é **um** `heavy bash script.sh` e, dentro, `./node_modules/.bin/vitest`.
  Sem isso, 9 sabotagens = 9 entradas na fila (foram ~30 min de espera cada).
- **`heavy` aborta na fila por timeout (`AFIACAO_HEAVY_TIMEOUT`, default 30 min) e sai 1
  sem nunca rodar o comando.** É o "wrapper que aborta sem rodar" de
  [evidencia-positiva-shell.md](evidencia-positiva-shell.md): o `exit=1` **não** é resultado
  de teste, e a ausência de "Test Files" é ausência de dado. Todo laço aqui passou a terminar
  com marcador positivo `VITEST_TERMINOU_DE_VERDADE exit=N`.
- **A fila pode ficar horas parada sem estar travada.** O dono do slot rodava `bun run
  typecheck` há 2h16 com 10min de CPU (~8%) e **1.716.401 pageouts** — swap thrashing na M2
  8GB, não deadlock. Diagnóstico: `ps -o etime,time,%cpu` do dono (tempo de CPU ≪ wall-clock
  = a máquina está paginando, não o processo travado).

## O que ficou de fora, medido

`AdminEstoquePicking.tsx` tem **7 outras** leituras que engolem o erro (`pk-tasks-abertas`,
`pk-pedidos-aguardando`, `pk-skus-criticos`, `pk-fefo-compliance` ×2, `pk-picking-items`,
`pk-inventory`). Elas **não** usam a forma `{data && <X/>}` — o `KpiCards` faz
`value: tasksAbertas ?? 0` e pinta o card. É a classe **irmã** (`ausente → zero`), pior que
sumir: a falha vira "0 Tasks Abertas" / "0% FEFO", que o separador lê como afirmação sobre o
chão de fábrica. O comentário do próprio `pk-skus-criticos` já nomeia o anti-padrão
("count-exact-vira-0-silencioso") **e a query ainda assim não lança**. Chip aberto.
