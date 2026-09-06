# Captura de corpo vivo: quando a migration é no-op, a validação fica cega — e o `FOR SHARE` cobra privilégio

> **A classe (2026-09-06):** uma migration de **captura** (recria a função com o corpo que já roda)
> é, por construção, um no-op semântico. Isso é a virtude dela — e o problema: **nenhuma query
> sobre o corpo distingue "aplicada" de "esqueci de colar"**, porque ela é verde nos dois casos. A
> validação por `md5(pg_get_functiondef)` prova *fidelidade*, não *apply*. Num banco operado por
> paste manual, onde a falha silenciosa é o modo de falha padrão, entregar só essa query é
> entregar um sensor que não sensoria.
>
> A regra: **toda captura carrega um efeito observável que só existe depois do Run.**
> `COMMENT ON FUNCTION` serve: não entra no `pg_get_functiondef` (o md5 do corpo segue idêntico),
> não muda comportamento, é idempotente. A validação passa a ter duas colunas que respondem
> perguntas diferentes — `corpo`/`acl` = "não mudei produção"; `carimbo` = "o SQL rodou".

Entrega: `20260906164001_captura_authz_gate_custo_rpcs_preco.sql` +
`20260906164002_captura_authz_escopo_carteira_farmer.sql` +
`db/test-captura-authz-gate-custo.sh` (novo, 32 asserts) + `db/test-farmer-escopo-carteira.sh`
(repontado, 17 asserts). Fecha a pendência 1 de
[deriva-de-corpo-prod-a-frente-do-repo.md](deriva-de-corpo-prod-a-frente-do-repo.md).

## Diferença em relação à pendência 2

Em [captura-de-corpo-vivo-como-aposentar-migration.md](captura-de-corpo-vivo-como-aposentar-migration.md)
o repo **já continha** o corpo certo: a captura era desempate de *precedência*. Aqui não — o
hardening é genuinamente **ausente** do repo, e a captura é resgate de *conteúdo*. O que separou
os dois casos foi a mesma medição: diff por **token** contra a última migration que define cada
função, com o stripper compartilhado `removerComentariosSql`. Nas 3 de preço a única divergência
era o predicado do gate; nas 2 de farmer o vivo **só acrescenta** — as remoções eram todas do
renderizador (`NULL`→`NULL::text`, `SECURITY INVOKER` que é default e o `pg_get_functiondef`
omite). Sem esse diff, "captura" seria palavra, não fato.

## O segundo achado: `FOR SHARE` cobra privilégio, e SECURITY INVOKER cobra do usuário

`farmer_recomendacoes_substituir` trava o lote com `SELECT … FOR SHARE` sobre
`farmer_client_scores`. O Postgres exige **UPDATE ou DELETE** — não basta SELECT — para travar
linha. E a RPC é **SECURITY INVOKER**: quem trava é o `authenticated` do farmer, não o owner.

Logo existe uma dependência invisível entre uma cláusula de *concorrência* e a **ACL de uma
tabela**. Um endurecimento futuro perfeitamente razoável — *"authenticated não escreve em
`farmer_client_scores`, revoga UPDATE"* — derruba a RPC em **runtime**, no **caminho feliz**, com
42501. Nada no corpo da função diz isso; nenhum teste que só exercite o gate pega.

Apareceu porque o harness local concedia só SELECT (fiel ao que parecia bastar) e o assert de
fail-closed sob RLS veio `permission denied` em vez de `FG009`. A prod tem
`authenticated=arwdDxtm`, medido — então **funciona hoje**. Virou:

- `PRIV1` no harness: revoga UPDATE, exige que o caminho feliz quebre, devolve o grant;
- `RAISE WARNING` (não EXCEPTION) no guard da migration — o estado é o mesmo antes e depois, então
  bloquear o apply da captura não consertaria nada, só atrasaria o alinhamento do repo.

⚠️ **O assert PRIV1 só vale com `SET ROLE authenticated` de verdade.** O helper `chamar()` do
harness seta apenas o GUC que `auth.uid()`/`auth.role()` leem e segue como superuser — para quem
nenhum REVOKE morde. Sem o `SET ROLE`, PRIV1 passaria por cegueira: exatamente o teatro que a
falsificação existe para matar.

## Falsificar aqui é reescrever o gate na versão do repo

A falsificação do harness de custo não inventa uma sabotagem: ela **restaura o predicado que o
repo tinha** (`employee OR master`, e `pode_ver_carteira_completa` no cockpit). Os asserts do eixo
ficam vermelhos — o employee comum volta a ver `custoBase=200`, o `gerencial` volta a ver
`cmc=100`. É a prova mais direta possível de que a migration captura hardening real: a sabotagem
**é** a regressão que ela previne.

## Coexistência deliberada de dois harnesses que se contradizem

`db/test-tint-gate-custo-staff.sh` assere `employee comum vê custoBase=200` e **segue verde**,
porque aplica explicitamente a migration de 2026-07-08. Ele descreve o que *aquela* migration fez;
o gate de hoje é provado pelo harness novo, que aplica a captura. Os dois são verdes ao mesmo
tempo sobre arquivos diferentes — e isso está dito no cabeçalho dos dois. Num repo onde a
migration é história e não estado, um teste ancorado a uma migration específica é um registro
datado, não uma afirmação sobre o presente. Se a coexistência confundir mais do que documenta, o
barato é aposentar o antigo.

## Armadilhas de shell que cobraram nesta entrega

- **Backtick em heredoc não-quotado e em `-m` de commit é substituição de comando.** Um comentário
  SQL com `` `FOR SHARE` `` dentro de `<<SQL` executou `FOR SHARE` como comando; uma mensagem de
  commit com backticks perdeu os trechos citados, silenciosamente. Use `<<'SQL'` quando o corpo
  não precisa expandir, e `git commit -F arquivo` para mensagem com crase.
- **`set -e` + `pipefail` matam o harness no assert cujo comando DEVE falhar.** O `psql` que aborta
  é o resultado esperado; sem `|| true` o script morre antes de ler a mensagem.
- **`/private/tmp` morre.** Os corpos extraídos da prod sumiram no meio da sessão e uma verificação
  "passou" sem rodar, porque o recorte engoliu o erro. Evidência positiva é ver o **OK**, não a
  ausência de vermelho.

## Adendo (2026-09-06): o que a revisão do Codex derrubou

A 2ª opinião veio no fecho, depois de a cota voltar. Três achados sobreviveram à verificação, e o
primeiro é um defeito no teste — a classe que este repo mais persegue.

**1. A falsificação do harness farmer aceitava ERRO como sucesso.** O ramo era
`if [ "$V1" = "FG009" ] ...; then bad; else ok`, e o `else` engolia qualquer coisa: uma sabotagem
que QUEBRASSE a RPC (coluna inexistente, erro de sintaxe) devolvia `ERRO: …`, caía no verde e
declarava "os asserts têm dente" **sem ter provado nada**. Erro não é passagem. Corrigido para
exigir `SEM_ERRO` nos dois, com um terceiro ramo explícito para `FALSIFICAÇÃO INCONCLUSIVA`.
Falsificado: com uma sabotagem deliberadamente quebrada, o harness agora **reprova** (exit 1) em
vez de aprovar. Herdei o defeito ao repontar o harness, então era meu.

**2. `FOR SHARE` exige UPDATE — `DELETE` sozinho NÃO basta.** Medido em PG17 (2026-09-06):
só-SELECT nega; `SELECT+DELETE` **também nega**; `SELECT+UPDATE(uma coluna)` permite. O texto que
eu tinha escrito ("UPDATE/DELETE") estava errado nos dois sentidos.

**3. `has_table_privilege(…, 'UPDATE')` dá falso alarme sob grant por coluna.** No mesmo teste,
com `GRANT UPDATE(b)` o `FOR SHARE` funciona, mas `has_table_privilege` devolve `f` e só
`has_any_column_privilege` devolve `t`. A sonda da migration `20260906164002` usa a primeira: ela
avisaria de um problema inexistente num banco que concedesse UPDATE por coluna. Fica registrado
aqui em vez de editado lá — **migration aplicada é história, não se reescreve** —; a forma certa
(`has_any_column_privilege`) vale para a próxima que tocar o assunto. O harness já usa o eixo real
(revoga e exige que a RPC quebre), então a defesa viva não depende dessa função.

**Não se materializou:** o `COMMENT ON FUNCTION` substitui integralmente o comentário anterior, e
se alguma das 5 carregasse diretiva de extensão (`@graphql`) eu a teria destruído silenciosamente.
Conferido: as 5 não tinham comentário nenhum antes (zero ocorrências no repo, e o texto vivo hoje é
o meu). O risco era real e o dano foi zero — mas inspecionar antes de comentar é a regra que fica.

O Codex também observou que o harness novo, como o antigo, fixa uma migration específica: os dois
seguem verdes se uma TERCEIRA migration futura reabrir o gate. É verdade, e é o limite de qualquer
teste ancorado a arquivo. Quem fecha esse vetor é o sentinela de EXECUTE — e 4 das 5 funções estão
fora da allowlist dele (`scripts/authz-funcoes-fechadas.ts`; só `get_preco_cockpit` está lá).
