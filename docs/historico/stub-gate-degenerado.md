# Stub de gate DEGENERADO — quando o bloco de authz não prova política nenhuma

**Classe:** um harness PG17 declara o stub de uma função-gate com um corpo **mais simples** que o de
prod. Se a simplificação apaga a única distinção que separava duas políticas, todo o bloco de authz
do harness passa a provar apenas "master vs resto" — e continua **verde** enquanto a autorização
regride em produção.

**Discriminante (a pergunta que decide):** *existe, no SEED, alguma persona que as duas políticas
classificam DIFERENTE?* Se não existe, o bloco de authz não prova política — prova só que o gate é
binário. Assert que sobrevive à troca da política não guarda a política.

## Instância 1 — #1761 (2026-08-15), `db/test-pos-frescor-marcador.sh`

O gate ANTERIOR ao FU4-G era declarado como `SELECT has_role(_uid,'master')`, tornando-o idêntico ao
novo (`private.cap_compras_ler`, master-only). Com as duas políticas colapsadas, os asserts só
exercitavam customer e master — que os dois gates classificam igual. Medido: trocar `cap_compras_ler`
pelo gate velho devolvia a RPC ao `commercial_role='gerencial'` (regressão real de autorização) e o
harness seguia **VERDE com 42 OK**. Correção: asserts D7/D8 + falsificações X6b/X6c.

## Instância 2 — `db/test-cockpit-preco.sh` e `db/test-defasagem.sh`

Varredura dos **83 stubs de capability em `db/test-*.sh`** (49 arquivos), medida em duas etapas:

1. corpo REAL lido da prod (`~/.config/afiacao/psql-ro` + `pg_get_functiondef`) — 11 capabilities;
2. cada stub **EXECUTADO** num PG17 descartável contra 6 personas (master, employee
   gerencial/estratégico/vendedor, customer, anon), e o vetor comparado com o de prod.

Os dois harnesses stubavam `pode_ver_carteira_completa` como `SELECT has_role(_uid,'master')`
(master-only), enquanto prod (migration `20260526040000`) é
`master OR (employee AND commercial_role IN ('gerencial','estrategico','super_admin'))`.
As 3 personas semeadas — master, employee **sem** `commercial_role`, customer — recebem o mesmo
veredito das duas. **Medido:** substituindo o gate por uma política que só diverge no employee
gerencial, ambos seguiam verdes com **exit 0**.

Agravante: `bun run authz:check` **não mede** `get_preco_cockpit` nem `get_defasagem_cliente`
estaticamente (são recriadas por reescrita da definição viva) e diz, na própria saída, que
"o gate delas se prova por asserção EXECUTADA" — isto é, delega a prova exatamente a estes dois
harnesses.

**Correção, passo 1 (molde D7/D8):** gate modelado fielmente (+ tipo `commercial_role`, tabela e
`get_commercial_role`); persona discriminante semeada (`...000d` = employee gerencial); `A11`/`D11`
asserta que ele VÊ o número; `A12`/`D12` é a **contraprova** de que as duas políticas divergem só
nele (sem ela, A11/D11 passam por vacuidade com seed furado); `X-A11`/`X-D11` regridem o gate e
`X-A12`/`X-D12` sabotam o seed, ambos exigindo o vermelho.

### O segundo achado: modelar o gate fielmente não basta se for o gate ERRADO

Corrigido o stub, os harnesses passaram a provar `pode_ver_carteira_completa` **fielmente** — mas
esse é o gate de **junho**. Medido em prod (`pg_get_functiondef`), as duas RPCs usam
`v_pode_num := private.cap_custo_ler(auth.uid())` desde a
`20260718190000_authz_capability_matrix_e2.sql`, que **reescreve a definição viva** (`regexp_replace`
sobre `pg_get_functiondef`, sem `CREATE` no repo — por isso o `authz:check` não a mede
estaticamente). Os harnesses aplicam migrations reais, mas nenhuma delas fazia essa troca: provavam
uma RPC que não é a que atende o cliente.

**Correção, passo 2:** os harnesses reproduzem a MESMA transformação, com o MESMO guard da E2
(aborta se o padrão não casar, em vez de no-op silencioso), e conferem o gate vivo por
`pg_get_functiondef` antes de asserir. A política **inverte** no discriminante — `cap_custo_ler` é
master + estratégico/super_admin e **exclui** o gerencial, que `pode_ver_carteira_completa` inclui:

- `A11`/`D11`: o employee GERENCIAL é **BARRADO** (era "vê"), preservando faixa e status/p_req — o
  corte é no número, não na tela;
- `A13`/`D13` (novo): o employee ESTRATÉGICO **vê** — sem ele, A11/D11 passariam por vacuidade,
  porque um gate que barra todo mundo também barra o gerencial;
- `A12`/`D12`: a contraprova passa a ser entre os **dois gates reais**, divergindo só no gerencial;
- `X-A11`/`X-D11` regridem o gate **da RPC** (a regressão de autorização de verdade).

**A falsificação existente também envelhece com o gate.** `A5`/`D9` sabotavam
`pode_ver_carteira_completa` → `true` e exigiam vazamento; depois da E2 isso virou no-op. O próprio
harness acusou ao rodar (*"mesmo com o gate furado o número NÃO vazou"*) — um teste que troca de
gate precisa reapontar TODA falsificação que mordia o gate antigo, senão elas viram teatro em
silêncio. Regra prática: **falsificação tem de sabotar o gate que a função REALMENTE chama** —
descubra-o por `pg_get_functiondef`, não pelo nome que o comentário do harness usa.

**Nuance que a degeneração escondia:** o corpo de prod **não tem `COALESCE`** → devolve **NULL**
(não `false`) para employee sem `commercial_role` (`false OR (true AND NULL)`). O stub master-only
devolvia `false`. Por isso a contraprova compara o **efeito** (`IS TRUE`) — que é o que policy
`USING` e o gate da RPC consomem —, não o boolean cru.

## Medidos e CORRETOS (nenhuma alteração)

`test-authz-capability-matrix.sh`, `test-fu7b-pode-ver-carteira-wrapper.sh`,
`test-atp-reserva-estoque-fase1.sh`, `test-authz-custo-fu4f-fase3-ranking.sh`,
`test-authz-is-not-true-escritas.sh` — o que um detector textual acusa como "colapso" são
**falsificações deliberadas com restauração** (o harness aperta a capability, exige o vermelho e
devolve o corpo fiel). `test-po-inexistente-antes-de.sh` declara os dois gates degenerados, mas não
os usa em assert algum: fixture de compilação, não teatro.

Simplificação menor, sem colapso (não corrigida): `test-selfservice-pr02a-views.sh` e
`test-selfservice-pr03-isolamento.sh` modelam o gate só com `'gerencial'` (faltam `estrategico` e
`super_admin`); não há segunda política no arquivo nem persona estratégica no seed.

## Como reauditar

Não confie em leitura textual do stub — **execute-o**. E não confie no nome do gate que o
harness declara: confira, por `pg_get_functiondef` na PROD, **qual gate a função sob teste chama
hoje** — reescrita da definição viva não deixa `CREATE` no repo e é invisível a qualquer grep. O padrão que funcionou: subir um PG17
descartável com `user_roles`/`commercial_roles`/`has_role`/`get_commercial_role`, semear as 6
personas, criar cada stub extraído dos harnesses e comparar o vetor de personas liberadas com o de
prod. Um classificador por regex erra nos dois sentidos — errou no `fu7b` (acusou fiel de
degenerado) e teria deixado passar o `IS TRUE`/NULL.
