# PRE anti-deriva sem trava: a corrida, a fila do executor e o template (2026-09-30)

> Regra viva em `docs/agent/database.md` §2 (bullet da trava). Template colável na skill
> `lovable-db-operator`, `references/sql-house-style.md` ("Recriar objeto VIVO"). Prova:
> `db/test-pre-anti-deriva-concorrencia.sh` (núcleo do CI, 48 asserts, 6 sabotagens).

## O achado

O Codex achou o problema numa revisão adversarial de 2026-09-27, em duas entregas (#2629 e #2632). Uma migration que recria função ou view com `CREATE OR REPLACE` confere antes, numa PRE, que o corpo vivo é o predecessor revisado (md5). Só que ela lê num comando e grava em outro. Em READ COMMITTED a sequência é esta:

1. A passa na PRE.
2. B troca o mesmo objeto e commita.
3. A faz o `CREATE OR REPLACE` e apaga B.
4. A PÓS de A aprova.

A #2629 fechou o buraco com uma trava antes da PRE (um ALTER sem efeito). A `20260927172443` (#2632) e a `20260927133606` só documentaram o limite: já estavam commitadas, e migration commitada não se reescreve.

## Medido antes de decidir

- **Repo:** 19 migrations têm PRE anti-deriva.
  - 6 têm trava: 3 num `DO $trava$` separado e 3 embutidas na própria PRE (`SET search_path = <o mesmo>`).
  - 13 não têm. São de 2026-07-02 a 2026-09-27; as duas do achado já estão aplicadas (ledger 174 e 182).
  - As PREs aparecem em pelo menos 5 formas. Mudam o rótulo (`$pre$`/`$guard$`/`$pf$`/`$validade$`), a fonte do hash (`prosrc` cru ou normalizado, `pg_get_functiondef`, `pg_get_viewdef`) e o lugar da trava (separada ou embutida).
- **Prod (psql-ro):** PG 17.6, `read committed`, `track_commit_timestamp = off`.
  - O ledger `db_aplicacoes` tem 151 linhas desde 09/09: 148 aplicadas e 3 falhas, nenhuma de concorrência.
  - Em nenhum par a tentativa de B foi gravada até 10 s depois do BEGIN de A.
  - A menor distância entre BEGINs foi de 13,4 s. Inclusive as duas migrations do achado (ids 182→183) foram aplicadas em sequência, pela mesma sessão.
- ⚠️ **Limite da régua:** `concluido_em` é o `now()` da transação do apply, ou seja, o BEGIN dela, não o commit. O fim do apply não fica registrado em lugar nenhum. Então "nenhuma sobreposição" só vale supondo que cada apply durou menos de ~11 s.
- ⇒ A corrida é **possível** (provada em PG17), mas não foi **observada** em prod.

## O que a prova mostrou (PG17.10 local; nos dois `lc_messages`)

| cenário | resultado |
|---|---|
| função, sem trava (M0) | B commita no meio e some; A sai 0 com a PÓS verde |
| função, com trava (M1–M3) | B espera A e falha alto com `XX000 tuple concurrently updated`; o corpo de A fica |
| view, sem trava (V0) | mesma corrida: `pg_get_viewdef` na PRE **não** trava a própria view |
| view, com trava (V1/V2) | B espera e, **sem PRE, aplica por cima quando A termina**: não falha |
| view, com trava e B no padrão (V3) | B espera na trava dele e a PRE de B recusa |
| executor sem fila, corpo REAL de prod (E1) | dois `db-aplicar.sh` reais: B aplica com A parado e A o apaga; **os dois saem 0** e o recibo de B diz `aplicada` para uma mudança que não existe mais |
| executor com fila (E5/E6) | B é visto esperando a vez; A sai 0; a PRE de B recusa; B sai 4 com recibo `falhou` |
| REPEATABLE READ (E9/E10) | a porta recusa antes do corpo (`25000`, `ISOLAMENTO_ERRADO`) |

Medições laterais:

- `OWNER TO <o mesmo dono>` **não** trava função: é no-op e nem toca a linha. Numa view **trava**, porque o lock vem antes da comparação.
- `LOCK TABLE` numa view trava a tabela-base. `ALTER VIEW … SET (security_invoker = …)` prende só a view.
- A trava de função não impede chamar a função.

O comentário da #2629, "quem chegar depois espera e falha alto", só vale para **função**. Numa view, o atrasado sem protocolo vence, e esse é o regime sequencial ("a última a recriar vence"), não esta corrida: a trava garante que **A** não apaga ninguém.

## A decisão: os dois níveis, sem gate

- **Executor (fila em `aplicar_sql`):** advisory `(20260909, 1)` antes de ler qualquer coisa, e READ COMMITTED **exigido**.
  - Fecha a corrida para todo apply pelo `db:aplicar`, que é o caminho dominante (sessões paralelas), sem depender da disciplina de quem escreve o arquivo.
  - Também cobre check-then-act que não é PRE.
  - **Não alcança** quem não passa pela porta: SQL Editor, `query_database` do MCP e o builder do Lovable.
- **Migration (template na skill):** a trava é imposta pelo banco no próprio objeto e alcança qualquer escritor, mas depende de o autor seguir o molde. A skill não tinha template de PRE nenhum.
- **Sem gate textual.** `docs/agent/maquinas-meta.md` exige incidente: dano nomeado, ou verde-falso provado num PR de produto. Aqui a corrida é possível, não ocorrida (0 sobreposições em 150 applies).
  - Além disso, um gate por regex sobre 19 PREs em pelo menos 5 formas nasceria com falso-positivo e falso-negativo, e sem dono do vermelho.
  - Registro: `Máquina meta: nenhuma`.
- As 13 PREs sem trava ficam como estão: commitadas, aplicadas, e o hook as protege.

## A entrega em prod

O arquivo `db/aplicar-executor-serializa.sql` é aplicado pelo próprio `db:aplicar`, que se substitui: a chamada que o aplica ainda roda o corpo antigo, e a fila vale da próxima chamada em diante. A ordem dentro dele:

1. **TRAVA.**
2. **PRE:** aceita o corpo de prod `ac51b3c…` ou este, `38699b…`.
3. **CREATE.**
4. **PÓS:** além de conferir o md5, ela **executa a porta nova** com tentativa NULL, sem escrever no ledger. Um corpo novo quebrado (PL/pgSQL é late-bound) aborta tudo e a porta antiga fica de pé (E14). Sem isso, um corpo quebrado viraria uma porta que nem o próprio conserto atravessa.

O mesmo corpo vai no bootstrap: E3 exige o mesmo md5 pelos dois caminhos, e o `BOOTSTRAP_OK` passou a conferir a fila.

## Defeitos do próprio harness (lições para quem escreve prova de duas sessões)

- **O `printf` builtin, escrevendo no FIFO de uma sessão que já morreu, vaza o buffer na saída capturada.** O veredito chegava com `ROLLBACK;` na frente. O conserto foi usar `env printf` (o processo externo, cujo buffer morre com ele) e `trap '' PIPE`. Está em `prove-sql-money-path/references/assert-patterns.md` §5.
- **`${PIPESTATUS[0]}` no Bash tool sai vazio**, porque o shell é zsh. Um `shellcheck_exit=` foi impresso sem ter medido nada; o hook pegou. O conserto é captura pelada (`cmd > arq; rc=$?`).
- **O cabeçalho do template citava `$trava$` num comentário**, e a checagem "a versão sem trava não contém `$trava$`" reprovava a fixture certa. A checagem certa olha a linha `DO $trava$` e os `ALTER`, não a palavra.

## Codex

- **Desenho:** o sensor do `codex-async.sh` recusou sem gastar a chamada (exit 79). A cota estava em 86%, acima do teto de 85%, e a janela reabre em 03/10 19:11.
  - Fomos pelo Caminho B: a régua abaixo foi escrita e conferida por mim.
  - **REVISÃO INDEPENDENTE PENDENTE:** desenho e adversarial retroativos quando a janela reabrir.
- **RÉGUA:**
  - **Unidade:** a transação de apply × o objeto que ela recria. A propriedade é "ao commitar, A não sobrescreveu versão fora de {predecessor, a própria}".
  - **Onde aparece:** o md5 de `prosrc`/`pg_get_viewdef`. O ledger mostra só os applies do executor, e só o início de cada um.
  - **Denominador:** 150 applies e 19 PREs, 13 delas sem trava.
  - **Falsificação:** duas sessões com barreira observada; baseline vermelho com o código real de prod; 6 sabotagens, cada uma vermelha no assert certo, com o controle verde na mesma invocação.
  - **Ordem do irreversível:** prova → `--ensaio` em prod → apply → `psql-ro` → bootstrap no mesmo PR.

## Fora do escopo, registrado

`service_role` tem `EXECUTE` em `aplicar_sql` e `INSERT` no ledger, com BYPASSRLS. Ou seja, quem tem a service key consegue executar SQL arbitrário como `postgres`. O problema é anterior a esta entrega: o `CREATE OR REPLACE` preserva a ACL, e o bootstrap revogou PUBLIC, anon e authenticated, mas não `service_role`. A decisão fica com o founder.
