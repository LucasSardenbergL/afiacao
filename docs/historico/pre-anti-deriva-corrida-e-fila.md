# PRE anti-deriva sem trava: a corrida, a fila do executor e o template (2026-09-30)

> Regra viva em `docs/agent/database.md` §2 (bullet da trava). Template colável na skill
> `lovable-db-operator`, `references/sql-house-style.md` ("Recriar objeto VIVO"). Prova:
> `db/test-pre-anti-deriva-concorrencia.sh` (núcleo do CI, 56 asserts; as 8 sabotagens rodam fora do CI —
> ver "Custo no CI").

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
  - A migration de hoje, `20260930230623` (outra sessão), já veio com `DO $trava$`: o padrão está pegando por convenção.
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
| função, com trava e B também no molde (M5) | B fica preso no **próprio** ALTER da trava e falha alto antes da PRE dele |
| view, sem trava (V0) | mesma corrida: `pg_get_viewdef` na PRE **não** trava a própria view |
| view, com trava (V1/V2) | B espera e, **sem PRE, aplica por cima quando A termina**: não falha |
| view, com trava e B no padrão (V3) | B espera na trava dele e a PRE de B recusa |
| REPEATABLE READ, sem porta (R0) | a leitura feita **depois** de B commitar ainda vê o predecessor, e o `CREATE OR REPLACE` apaga B **sem erro**. O catálogo chega a mostrar as **duas** versões do mesmo OID na transação |
| executor sem fila, corpo REAL de prod (E1) | dois `db-aplicar.sh` reais: B aplica com A parado e A o apaga; **os dois saem 0** e o recibo de B diz `aplicada` para uma mudança que não existe mais |
| executor com fila (E5/E6) | B é visto esperando a vez; A sai 0; a PRE de B recusa; B sai 4 com recibo `falhou` |
| a fila é da transação (E7) | na mesma sessão, depois do COMMIT, a chave já está solta (um lock de sessão passaria em qualquer teste que só olhasse depois de a conexão fechar) |
| porta em REPEATABLE READ (E9/E10) | recusa antes do corpo (`25000`, `ISOLAMENTO_ERRADO`). **Sem a guarda**, B em RR esperou a fila, passou a PRE sobre o snapshot velho e recriou a função; quem o barrou foi só a PÓS dele, por acaso do plano |
| delta (E2–E4, E12–E15) | aplica pelo próprio executor; deixa o mesmo corpo do bootstrap; mantém a porta fechada; re-ensaia sobre si mesmo; recusa corpo estranho; aborta com a porta nova quebrada no começo **ou no fim** (a sonda percorre a porta inteira); e a trava do próprio delta prende quem tenta recriar a porta |

Medições laterais:

- `OWNER TO <o mesmo dono>` **não** trava função: é no-op e nem toca a linha. Numa view **trava**, porque o lock vem antes da comparação.
- `ALTER PROCEDURE … VOLATILE` dá `42P13`; `SET search_path = <o mesmo>` trava.
- `ALTER AGGREGATE … OWNER TO <mesmo dono>` não trava. Aggregate não tem trava por ALTER.
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
4. **PÓS:** além de conferir md5, SECDEF, `search_path` e ACL, ela **executa a porta nova do começo ao recibo** com uma tentativa de ensaio. Um SQLSTATE próprio (`P0S01`) desfaz a tentativa e o recibo. O único trecho que a sonda não percorre é o ramo de **espera** da fila, que exige outro apply em curso (esse é o E8). Um corpo quebrado aborta tudo e a porta antiga fica de pé (E14/E14b).

O mesmo corpo vai no bootstrap: E3 exige o mesmo md5 pelos dois caminhos, e o `BOOTSTRAP_OK` passou a conferir a fila. O `--ensaio` em prod deu exit 0 duas vezes, a 2ª já com a sonda completa; por fora (psql-ro), md5 continuou `ac51b3c…`, com 0 linhas no ledger e 0 locks.

## Revisão adversarial interina (subagente; o Codex estava sem cota)

Não houve P0. A revisão **concedeu**:

- a fila não vaza nem trava em ciclo no caminho real;
- a auto-substituição é segura;
- não há deriva de md5 entre o delta e o bootstrap;
- a guarda de isolamento não recusa caso legítimo em prod (sem override de papel ou banco; pooler em session mode);
- "sem gate" está correto.

| achado | o que virou |
|---|---|
| P1 · o job `provas-sql` já leva ~13m41s, com teto de 20 min | **confirmado no PR** — ver "Custo no CI" abaixo |
| P1 · a porta é `postgres` também para `service_role` **e** `sandbox_exec_<ref>` | registrado abaixo; decisão do founder (é anterior a esta entrega, e o `CREATE OR REPLACE` preserva a ACL) |
| P2 · a trava do próprio delta não tinha sabotagem | E15 + sabotagem `delta_sem_trava` |
| P2 · a sonda da PÓS só cobria o começo da porta | sonda nova (tentativa de ensaio → recibo, desfeita por `P0S01`) + E14b, a porta quebrada **no fim**, que a sonda antiga deixaria passar |
| P2 · o E7 passaria com lock de sessão | E7 pergunta na mesma sessão, depois do COMMIT + sabotagem `fila_de_sessao` |
| P2 · o template afirmava além da prova (função×função, procedure, aggregate) | M5 + medições de procedure e aggregate; o template diz o que cada um aceita |
| P2 · número velho no diário | corrigido |

**Limites declarados** (não consertados, por serem estreitos ou fora do escopo):

- **Deadlock só no `--ensaio`:** a tentativa do ensaio é inserida DENTRO da transação, antes da fila. Se um apply com a fila fizer DDL na própria `db_aplicacoes`, os dois se esperam, e o Postgres derruba um com `40P01` (exit 4, limpo).
- **Dois applies dos MESMOS bytes:** a checagem "já aplicado" do script fica fora da fila. O segundo espera, roda o corpo e bate no índice único do recibo (`23505`, exit 4). Não aplica duas vezes, mas a mensagem é "duplicate key" em vez de "já aplicado".
- **`VEZ_OCUPADA` deixa o recibo como `falhou`:** a espera além dos 15 s grava `falhou` para algo que não chegou a rodar. Isso é por desenho: o corpo não rodou, e o operador roda de novo.
- **O bootstrap continua sendo escritor sem PRE:** colar um bootstrap VELHO por cima reverteria a fila em silêncio. Bootstrap ≡ porta é disciplina, não gate (o E3 cobre só o delta atual).

## Custo no CI

- **Mediana da `main`** (3 runs de 2026-10-01): o passo do núcleo leva **13m41s–13m54s**, contra um teto de 20 min.
- **Com esta prova completa no PR #2702** (modo normal + `--falsificar` de 8 sabotagens × 2 idiomas), o passo foi **CANCELADO no teto** às 19m48s (run 36806101676).
  - Localmente a prova custa 25 s mais 189 s de falsificação.
  - O runner é ~1,7–2× mais lento que o M2.
- **O `ci.yml` já decidiu o que fazer quando isso acontecesse:** "a próxima prova que estourar pede **paralelizar o runner**, não subir o teto de novo". Paralelizar é infra compartilhada (portas por slot, o `roda-nucleo-ci.sh` e a autofalsificação dele) e fica fora deste PR.
- **Enquanto isso:**
  - O modo normal (56 asserts, 22 s pelo runner real) segue no núcleo.
  - O `--falsificar` foi declarado **`fora-do-ci`**, com o motivo na própria linha. O runner o imprime a cada execução como "ausência de dado, não aprovação".
  - Quem mexer na prova roda a falsificação no laptop (recibo de hoje: 8 vermelhas / 0 falhas, 189 s).
  - É a 1ª exceção `fora-do-ci` do manifesto, e o sinal de que o runner precisa paralelizar.

## Defeitos do próprio harness (lições para quem escreve prova de duas sessões)

- **O `printf` builtin, escrevendo no FIFO de uma sessão que já morreu, vaza o buffer na saída capturada.** O veredito chegava com `ROLLBACK;` na frente. O conserto foi usar `env printf` (o processo externo, cujo buffer morre com ele) e `trap '' PIPE`. Está em `prove-sql-money-path/references/assert-patterns.md` §5.
- **O `motivo` era extraído por `grep` no log inteiro**, e o `CONTEXT` de qualquer erro dentro do `EXECUTE` ecoa o corpo da fixture, que contém o literal `PRE_RECUSOU`. Um erro de outra natureza saía rotulado como recusa da PRE. O conserto lê só a 1ª linha de severidade do servidor e, sem marcador, devolve o começo da mensagem. Foi assim que apareceu que, sem a guarda, quem barrava o RR era a PÓS, não a PRE.
- **`${PIPESTATUS[0]}` no Bash tool sai vazio**, porque o shell é zsh. Um `shellcheck_exit=` foi impresso sem ter medido nada; o hook pegou. O conserto é captura pelada (`cmd > arq; rc=$?`).
- **O cabeçalho do template citava `$trava$` num comentário**, e a checagem "a versão sem trava não contém `$trava$`" reprovava a fixture certa. A checagem certa olha a linha `DO $trava$` e os `ALTER`, não a palavra.

## Codex

- **Desenho:** o sensor do `codex-async.sh` recusou sem gastar a chamada (exit 79). A cota estava em 86%, acima do teto de 85%, e a janela reabre em 03/10 19:11.
  - Fomos pelo Caminho B: a régua abaixo foi escrita e conferida por mim, e o adversarial de código foi feito por um subagente independente (seção acima).
  - **REVISÃO INDEPENDENTE PENDENTE:** desenho e adversarial do Codex, retroativos, quando a janela reabrir.
- **RÉGUA:**
  - **Unidade:** a transação de apply × o objeto que ela recria. A propriedade é "ao commitar, A não sobrescreveu versão fora de {predecessor, a própria}".
  - **Onde aparece:** o md5 de `prosrc`/`pg_get_viewdef`. O ledger mostra só os applies do executor, e só o início de cada um.
  - **Denominador:** 150 applies e 19 PREs, 13 delas sem trava.
  - **Falsificação:** duas sessões com barreira observada; baseline vermelho com o código real de prod (E1, R0, M0, V0); 8 sabotagens, cada uma vermelha no assert certo, com o controle verde na mesma invocação.
  - **Ordem do irreversível:** prova → `--ensaio` em prod → apply → `psql-ro` → bootstrap no mesmo PR.

## Fora do escopo, registrado

`service_role` **e** `sandbox_exec_fzvklzpomgnyikkfkzai` têm `EXECUTE` em `aplicar_sql`. O `sandbox_exec` é o papel do builder do Lovable, que recebeu um GRANT em massa em 14/08 e tem LOGIN, BYPASSRLS e `INSERT` no ledger; o `service_role` também insere no ledger, com BYPASSRLS. Os dois podem gravar uma tentativa e chamar a porta, ou seja, executar SQL arbitrário como `postgres`. O problema é anterior a esta entrega: o bootstrap revogou PUBLIC, anon e authenticated, e o `CREATE OR REPLACE` preserva a ACL. Fechar é uma decisão de autorização do founder, e precisa ser fechado nas DUAS pontas: a porta e o `INSERT` no ledger.
