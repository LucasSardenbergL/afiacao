# RLS `has_role` por linha → InitPlan na classe inteira (plano v4, lote 9 — "RLS por linha")

Plano: `docs/superpowers/plans/2026-11-01-plano-melhoria-v4/README.md`. Evidência de origem:
`docs/historico/consultas-pesadas-lote9.md`, seção "RLS por linha".
Migration: `supabase/migrations/20261102204836_rls_has_role_initplan_classe.sql`.
Prova: `db/test-rls-has-role-initplan-classe.sh` (núcleo do CI, 39 asserts), fixture
`db/fixtures/rls-has-role-classe-prod-2026-11-02.sql`, gerado por `db/consultas/rls-has-role-classe-fixture.sql`.

## O problema

`has_role` é SQL `STABLE SECURITY DEFINER`. O planejador não inlina SECURITY DEFINER, então
`has_role(auth.uid(), 'x')` direto no `USING`/`WITH CHECK` roda **uma vez por linha**. Na prod
(2026-11-02): **308 policies em 185 tabelas, 872 chamadas cruas**. As provas anteriores trataram 1
tabela (`tint_formulas`) e 15 (reposição); a classe seguia viva no resto.

## O desenho

- Cada chamada crua vira `(SELECT has_role(auth.uid(), '<papel>'::app_role))`. Os dois argumentos são
  constantes no statement, então o sublink vira InitPlan e o valor é o mesmo em toda linha. Nada mais na
  expressão muda (colunas, EXISTS, `auth.uid()` fora do `has_role`, `is_super_admin`).
- **Dinâmica**: a migration lê `pg_policy` da PROD no instante do apply e reescreve. A fonte é a prod
  porque o apply manual diverge do repo. Ler e reparsear na mesma sessão usa o mesmo `search_path`.
- **Pós-condição por policy, dentro da transação:** cmd/permissive/roles iguais, presença de cláusula
  igual, `desembrulhar(novo) = desembrulhar(antigo)`, zero cru. Mais a global: zero cru no `public`.
- **Travar ANTES de ler** (achado Codex): o pré-scan só escolhe as tabelas. Para cada uma, a migration faz
  `LOCK TABLE … ACCESS EXCLUSIVE` e só então relê as policies dela (READ COMMITTED: statement novo, snapshot
  novo; P0 exige o isolamento).
- **Locks:** `lock_timeout` de 500 ms, abaixo do `deadlock_timeout` da prod (1 s), para que num ciclo com um
  cron quem desista seja a migration. E um orçamento GLOBAL de 5 s (P6), abaixo do `statement_timeout` de 8 s
  do `authenticated`.
- **Premissa:** a identidade é constante durante o statement. Conferido na prod: nenhuma função do
  `public` escreve `request.jwt*` nem troca `ROLE`. A prova L1 mostra que o limite é real.

## A prova (PG17, C e pt_BR.UTF-8, 39/39)

Tabelas mínimas (só as colunas que as policies citam, com o tipo da prod) e as 313 policies **verbatim**
(308 alvo + as 5 não-alvo de `commercial_roles`/`orders`, que as subqueries leem). A aplicação passa pelo
caminho do executor: EXECUTE dentro de função SECURITY DEFINER com `search_path` próprio.

| Camada | O que prova |
|---|---|
| C0 | a sonda distingue papéis (não é sempre-igual) e o fixture tem as 308 |
| A1 | 10 chamadores × 185 tabelas × SELECT/INSERT/UPDATE/DELETE + UPDATE que **muda** coluna de autorização: o CONJUNTO de linhas é o mesmo (7.530 sondas) |
| A2 | cada cláusula alterada, ponto a ponto: `(antiga) IS DISTINCT FROM (nova)` = 0 (4.200 pares) |
| A3/A4 | catálogo intacto; 308 policies, 872 chamadas, zero cru |
| A5 | contador: `has_role` 1.006× → 2× por consulta (`profiles`, `tint_importacoes`) |
| A6/A7 | idempotente; plano genérico alternando usuário dá 503,0,503,0 |
| A8 | corrida: policy apertada por outra sessão antes do lock é a que vale |
| A9 | leitor segurando a tabela → `55P03` e nada aplicado |
| L1 | identidade trocada no meio do statement: a direta nega e a embrulhada deixa passar |
| F1–F6 | papel trocado → P3; `TO public` → P1; tabela pulada → P5; orçamento → P6; isolamento → P0; policy sabotada → A1 e A2 |

O A8 foi falsificado à mão: com a versão que lia antes de travar (commit `3043970fe`), o A8 fica
**vermelho** (o employee volta a ver `profiles`). É a corrida que o Codex descreveu.

## Medição na prod, sob `authenticated` (EXPLAIN ANALYZE, transação READ ONLY)

| Consulta da tela | Papel | Antes | Depois |
|---|---|---|---|
| `profiles` pendentes (`AdminApprovals`) | employee | 406 ms · 81.048 buffers | _a medir_ |
| `profiles` pendentes | master | 227 ms · 48.911 buffers | _a medir_ |
| `tint_importacoes` limit 1 (`useTintometricoZone`) | employee | 1,5 ms · 321 buffers | _a medir_ |
| `tint_importacoes` limit 1 | customer | **4.487 ms · 506.106 buffers** | _a medir_ |

O `limit 1` é barato para quem vê a 1ª linha. O caro é quem **não vê nada**: o scan percorre as 116 k
linhas chamando `has_role` em cada uma. Daí a média de 323 ms do `pg_stat_statements`.

## Codex

- Desenho (xhigh, 254 s, 112 k tokens): APLICAR com ajustes. Bloqueava pela corrida ler→reescrever e
  pelos locks sem teto global. Os dois foram corrigidos, e a prova ganhou transição, seed de dono,
  plano genérico, caminho do executor e L1.
- Código: _a preencher_.

## Lições

- **Reescrita dinâmica de policy: TRAVE antes de LER.** Ler o texto e depois pegar o lock deixa outra
  sessão apertar a policy no meio, e a migration reinstala a versão velha com todas as pós-condições
  verdes (elas comparam com o texto lido). A pós-condição de "desembrulhado = antigo" não pega isso.
- **`lock_timeout` é por tentativa.** Em migration que trava muitas tabelas, ponha um orçamento global e
  deixe o `lock_timeout` abaixo do `deadlock_timeout`, para que a vítima de um ciclo seja a migration.
- **O custo da RLS por linha aparece em quem NÃO vê.** Medir só com o papel que tem acesso (que
  curto-circuita no 1º `has_role` ou para no `limit`) esconde o pior caso.
