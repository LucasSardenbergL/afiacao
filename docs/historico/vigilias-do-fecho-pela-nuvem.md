# As vigílias 2b/2c do `/fecho` pela nuvem — e o 42501 que valia por dois (2026-10-01)

## O gatilho

Duas vigílias do `/fecho` só rodavam com o `psql-ro`, que só existe no Mac do founder: a 2b
(`authz:claude-ro:prod`, a única sentinela do endurecimento do papel `claude_ro`) e a 2c
(`deriva:corpo:prod`, a deriva de corpo das funções `public` contra as migrations). Numa sessão de
nuvem as duas saíam com exit 2 (`ENOENT … /root/.config/afiacao/psql-ro`, medido em 27/09 às 19:20Z).
Como o founder passou a trabalhar quase só pela nuvem, as duas ficavam sem medir em todo fecho. O
transporte `--sql-nuvem`/`--dados-nuvem` do #2601 já servia o `pendencias:deploy` e o `pacote`, e o
pedido foi ligar as duas vigílias nele "com os MESMOS vereditos e exits da leitura local".

## O que foi medido antes de desenhar

1. **A 2c cabe direto.** É catálogo + corpo de função: 487 funções em `public`, ~1 MB de `prosrc`,
   ~2 MB em hex. A dúvida era o volume, e a medição respondeu: uma resposta sintética de 2,5 MB
   atravessou o conector do claude.ai íntegra (md5 do banco = md5 local). O harness grava resposta
   grande em arquivo, e esse arquivo vai direto para o `--dados-nuvem`.
2. **A 2b não cabia.** Além do catálogo (papel-parametrizado, `has_*_privilege('claude_ro', …)`),
   ela tem 4 **sondas executivas**, consultas que só provam alcance RODANDO COMO `claude_ro`, e que
   esperam um ERRO (42501, 42703). O conector entra como `postgres`. Medido em `pg_auth_members`:
   `postgres` é membro de `claude_ro` com `admin=t, inherit=f, set=f`, e `pg_has_role(…, 'SET')` dá
   `false`. Pelo canal da nuvem, não havia como virar o papel.
3. **Rodar as sondas como `postgres` não era só medir o papel errado.** A sonda da vault
   (`SELECT decrypted_secret …`) como `postgres` poderia trazer um segredo decifrado para a
   transcrição, que fica em disco.

## A decisão (do founder) e o desenho

Opções na mesa: medir só o catálogo na nuvem e nunca sair 0 (parcial honesto); emular as sondas
por catálogo (rejeitada: "catálogo não prova alcance" é a razão de elas existirem); separar o escopo
(nuvem = catálogo, sondas só no Mac, cobertas por um carimbo que envelhece sem o Mac); ou
**paridade total**. O founder escolheu a paridade, com duas peças:

- **Uma escrita dele:** `GRANT claude_ro TO postgres WITH INHERIT FALSE, SET TRUE`. Com isso o
  `postgres` vira o papel, sem herdar nada dele. Não é privilégio novo, porque o `postgres` já lê tudo
  o que o papel lê.
- **Sondas executivas no transporte:** um preâmbulo `DO` fixo, gerado pela lib, entre a trava e o
  `WITH`. Cada sonda roda num sub-bloco com `SET LOCAL ROLE`, por `EXECUTE` (statement de topo, sem
  embrulho, então o planner não poda coluna e a sonda da vault continua decifrando), e o desfecho
  volta por GUC de transação para consultas reservadas `sonda__<nome>`. O sub-bloco termina SEMPRE em
  exceção, porque o rollback é o que desfaz o `SET LOCAL ROLE`. Sonda que RODA devolve só `RODOU`,
  nunca o dado, salvo `devolverValor`, usado só pela contagem da ponte.

O Codex não foi consultado: a cota estava em 86% (teto de 85%) até 03/10 às 19:11. Foi Caminho B, com
a régua escrita e conferida por mim. Dela saiu o achado principal:

## O 42501 que valia por dois

**O `SET ROLE` negado sai com SQLSTATE 42501, a MESMA que as sondas 1 e 2 esperam.** Uma captura
ingênua (`EXCEPTION WHEN OTHERS THEN guarda SQLSTATE`) gravaria "42501" para uma sonda que nem
chegou a rodar como o papel, e a sentinela diria "negado com 42501" com o papel aberto. É o falso
verde perfeito, e nasceria justamente no estado de prod antes do GRANT. O preâmbulo guarda a ETAPA
numa variável (`papel` → `sonda` → `rodou`), que o rollback do sub-bloco não desfaz. O desfecho
`PAPEL|…` nunca vira resultado: o leitor lança `TRANSPORTE_SONDA_PAPEL`, a sentinela sai 2, e a
mensagem traz o `GRANT` que falta.

A regra que fica, além deste caso: **ao capturar ERRO como veredito, separe "não cheguei a tentar"
de "tentei e fui negado".** As duas falhas podem ter o mesmo código.

## A asserção que nasceu junto: quem pode VIRAR o papel

A sentinela contava as `memberships` (o que o `claude_ro` HERDA). O sentido contrário, os MEMBROS
dele, não tinha asserção nenhuma. Um `GRANT claude_ro TO authenticated` daria a qualquer usuário
logado a leitura do papel, com BYPASSRLS, e todas as outras asserções sairiam verdes. A aresta
nova do `postgres` tornou esse eixo inadiável, e ele virou o conjunto exato `membros`, com as opções
e quem concedeu.

## As provas

- `db/test-transporte-nuvem.sh` (núcleo do CI), T13–T17, num PG17 com um papel-canal membro do alvo,
  como em prod: o canal sem SET é recusado (T13); a sonda roda como o alvo, a negada volta 42501 e a
  permitida traz o valor (T14); o papel não vaza para o resto do lote (T15); o dado não sai do banco
  (T16); a trava barra escrita dentro da sonda (T17). Falsificação: controle verde e 14/14
  sabotagens vermelhas pela marca certa, 4 delas novas, uma por guarda do preâmbulo.
- Dente da sentinela (PG17): (U) membro novo, (V) o SQL da nuvem rodado pelo canal dá o MESMO
  stdout, stderr e exit do `psql-ro` em 5 estados (comparados por `cmp`), e (W) o canal sem SET sai 2,
  nunca "negado". São 46 cenários. Falsificação de (V) e (W): controle verde e 2/2 vermelhas.
- vitest: `claude-ro-nuvem.test.ts` e `deriva-corpo-nuvem.test.ts` cobrem o pacote (todo SQL que o
  caminho local manda ao psql está no pacote) e o veredito byte a byte entre o psql falso e o payload
  montado como o banco montaria (`transporte-nuvem-fixture.ts`).
