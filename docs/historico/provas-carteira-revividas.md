# As 2 provas da carteira revividas — Melhorias e "fornecedor fora da carteira"

**2026-10-01.** Fatia 2b da revivência registrada em
[provas-db-mortas-fora-do-nucleo.md](provas-db-mortas-fora-do-nucleo.md). As duas morriam fora do núcleo
porque re-aplicavam a migration de junho sobre um snapshot que já a tinha absorvido. Agora montam o schema
de prod pela lib da fatia 2a, `db/lib/corpo-vivo.sh` (snapshot + ACL medido em prod + cadeia dinâmica;
[provas-canal-revividas.md](provas-canal-revividas.md)), e entram no núcleo.

| prova | como morria | agora |
|---|---|---|
| `test-melhorias-rpcs.sh` | em 07-21, no 1º assert (o corpo de junho chamava `carteira_visivel_para`, que o fu7 moveu para `private`); desde `39ec9e31e` (08-28), já no seed: o CHECK `farmer_association_rules_cluster_segment_check` | **núcleo**: 37 asserts, 45 sabotagens |
| `test-fornecedores-classificacao.sh` | em 06-25 (`1c05aa8e3`), no seed: `23505 farmer_client_scores_customer_unique` | **núcleo**: 25 asserts, 33 sabotagens |

## O alvo, medido

`md5(pg_get_functiondef())` via `psql-ro` × o banco montado pela lib: **13 de 13 iguais**. São as 2 RPCs de
Melhorias (`619fdf35…`, `7be92ff8…`), o `private.padrao_like_contem` (`b34a1cfb…`), as 4 de fornecedores
(`1ea6738d…`, `6f726d09…`, `88b072d3…`, `8b8a6403…`) e os helpers que elas e as policies chamam
(`carteira_visivel_para`, `pode_ver_carteira_completa` nos dois schemas, `has_role`, `get_commercial_role`,
`reconcile_score_owner_from_carteira`). O ACL delas também é igual; a diferença são só os papéis de sandbox
do Lovable e o `claude_ro`, que existem apenas em prod.

A cadeia viva de Melhorias pega 5 migrations: a `20260929000234` (as 2 RPCs com o escape de curinga) e as
4 de `order_items`/`sales_orders`. A de fornecedores pega 1, o trigger de coerência de `sales_orders`.
As 4 funções de fornecedores são as do snapshot, e a cadeia vazia para elas é legítima.

Comparei também o catálogo das 16 tabelas que as provas leem ou escrevem: colunas, constraints, índices,
gatilhos, o corpo de cada função de gatilho e o ACL. São 368 linhas de prod contra 369 do banco montado.
As diferenças, todas fora do que as provas acionam:

1. a ordem dos itens do ACL (mesmo privilégio, ordem diferente);
2. o `'omie\_%'` do CHECK `sales_orders_hash_omie_canonico` e do índice `uniq_sales_orders_omie_hash`, que
   o snapshot perdeu (a perda de barras dos literais já registrada no eixo 7 do núcleo). O seed não usa
   `hash_payload`;
3. `sincronizar_ativo_omie_para_reposicao`, o gatilho de `omie_products`, diverge, mas só dispara em
   `UPDATE OF ativo` e nenhuma das duas provas o aciona;
4. o gatilho `trg_auto_commercial_super_admin` de `profiles`, que a retardatária `20260830122702` tirou de
   prod (já registrado na fatia 2a). Ele só dispara para employee com o CPF do master.

A pendência do funil (#2715) também foi conferida: em prod,
`has_column_privilege('authenticated', 'public.sales_orders', 'whatsapp_conversation_id', 'SELECT')` = t,
então o GRANT está valendo, embora a versão `20261001100000` não esteja em `schema_migrations`.

## As mortes, medidas executando

- **fornecedores.** O INSERT em `carteira_assignments` dispara `trg_carteira_reconcile_score_owner`, que
  CRIA a linha de `farmer_client_scores` (medido: 0 → 1, com o dono). O seed a inseria de novo e morria com
  `ERROR: duplicate key value violates unique constraint "farmer_client_scores_customer_unique"`, a
  assinatura exata da varredura. A revivida não semeia score de farmer: ele vem do gatilho, como em prod.
- **O guard que descarta calado.** `fcs_block_flagged_insert` é o nome real (o briefing o chamava
  `fcs_guard_flagged_insert`). É BEFORE INSERT e faz `RETURN NULL` para cliente excluído: o score some sem
  erro. Por isso o seed planta os scores antes de alguém ser marcado, e o A1 mede que eles existem antes da
  limpeza. Sem isso, "os scores do excluído foram apagados" passaria por ausência.
- **A hipótese "re-aplicar junho revertia as posteriores (0618, 0621, 0718)" não se confirmou para os
  corpos.** Os de junho diferem dos de prod só em formatação (o DECLARE numa linha, quebras de linha),
  com 0 linha de lógica diferente. As 3 migrations citam as funções só em comentário. O dano medido da
  versão velha foi outro: ela media um texto que prod não executa (md5 diferente), e morreu.
- **A migration de junho só revogava de `anon, authenticated`, sem `PUBLIC`.** Prod mesmo assim está
  fechado: classificar, aplicar e o trigger são só do service_role. O G3 mede o ACL de prod, não o de junho.

## O que mudou ao portar

**Melhorias.**
- **Teatro removido.** O A4 aceitava qualquer erro cuja mensagem tivesse "curto", inclusive a do próprio
  teste ("A4 FALHOU: termo curto…"), e o A8b imprimia OK sem conferir nada. Agora é
  `prova.sqlstate` com a SQLSTATE exata, e a camada e o objeto no 42501.
- **Os 2 guards das RPCs dão a MESMA SQLSTATE (P0001).** O isolamento é pela entrada: o não-staff vai com
  termo longo, o master com termo curto, e cada guard tem a sua sabotagem.
- **Novos:** pedido apagado (`deleted_at`), rascunho e pendente; produto inativo nas duas RPCs (D4, R3);
  mesma família na outra conta; regra de outro antecedente; o máximo por consequente; o termo curto depois
  do trim; os campos do founder e o status no INSERT do item; mensagem em item resolvido; o papel `ia`; o
  master postando como funcionário no item alheio (M9); o anon escrevendo; o master lendo todas as
  mensagens.
- **Fora daqui, por já ter dono:** o gate de staff da `clientes_por_produto` e o escape do termo
  (`test-padrao-like-contem.sh`, F18–F22) e o ranking com receita NULL (`test-preco-ausente-nao-e-zero.sh`).
  A visibilidade por carteira (`escopo`) nenhuma irmã assevera (conferido por grep), e por isso ficou aqui.
- **Não portado:** os GRANTs à mão (prod já tem o default do Supabase nas 2 tabelas, conferido), o
  `pode_ver_carteira_completa` recriado à mão (agora vem do snapshot e da cadeia) e o `auth.uid()` por GUC
  `test.uid` (agora é o JWT na mesma sessão do `SET ROLE`, como no PostgREST).
- **Camada redundante, medida.** Na policy de INSERT de mensagens, a conjunção `i.autor_user_id =
  auth.uid()` não tem dente sobre o NÃO-master: a subconsulta lê `melhoria_itens` sob a RLS de quem insere,
  e a vendedora já não vê o item do master (o M2 segue verde na sabotagem dela). O dente dela é o master,
  que vê todo item; sem ela, ele posta como 'funcionario' no item alheio (M9).

**Fornecedores.**
- **Teatro removido.** O A7g fazia `WHEN others THEN barrou := true`. Agora o G1 exige o P0001 exato e o c4
  intacto (sem exceção, ainda excluído).
- **Uma tag encobria a outra.** O c4 de junho tinha `['FORNECEDOR', ' Transportadora ']`: sem o `trim`, o
  `lower('FORNECEDOR')` ainda casa, então o `trim` não tinha dente. Agora caixa (c4) e espaço (c5) estão em
  clientes separados, cada um com a sua sabotagem, na coluna e na decisão.
- **Novos:** a aplicar re-classifica antes de limpar (A0 deixa a classificação velha, e é a aplicar que o
  cron chama); rascunho e pendente não são venda; o retorno da classificar (K0); as filas vazias antes do
  reverter (V0) e com o motivo e o dono depois (V3); o alias fiscal ativo, que sai da exclusão mas segue
  fora da carteira (V4); o ACL de prod (G2, G3); a porta dos fundos, ou seja, o employee escrevendo a
  exceção direto na tabela (G4); o trigger que não decide a exclusão (T1).
- **Preparo vira assert.** Todo passo de preparo dentro do cenário (corromper as flags, envelhecer a
  classificação, rodar a aplicar) é uma pré-condição com `chk`. Dentro de `rodada … || rc=$?` o `set -e`
  não vale, e um preparo que falhasse calado deixaria os asserts seguintes vermelhos "por valor", que o
  juiz contaria como dente.
- **Medição em lote:** um psql lê a régua dos 7 clientes (`c<n>=is|venda|exclui`), e `campo` a reparte. Se
  a leitura erra, o ERRO passa inteiro a cada assert, e o juiz o reconhece como erro de execução.
- **O stub de `customer_canonical_alias` saiu:** o snapshot já tem a tabela.

## Falsificação — medida

Cada sabotagem troca UMA camada do schema vivo no banco da rodada. Os corpos das funções vão por
`cv_sabotar`, com âncora única e md5 que tem de mudar; nas duas funções em que o filtro se repete
(`produtos_relacionados`, a régua da `classificar`), a âncora leva contexto de linha. As policies vão por
`sabotar_policy`, um `cv_sabotar` das policies que tira UMA conjunção do texto vivo de `pg_policies`, também
com âncora única e expressão que tem de mudar. Constraints, GRANTs e gatilhos vão por DDL. O juiz é o do
molde, com o controle verde na MESMA invocação.

| prova | modo normal | `--falsificar` em `LC_ALL=C` | em `pt_BR.UTF-8` |
|---|---|---|---|
| melhorias | `PASS=37  FAIL=0` | `SABOTAGENS: 45 vermelhas / 0 falhas` | 45/0 |
| fornecedores | `PASS=25  FAIL=0` | `SABOTAGENS: 33 vermelhas / 0 falhas` | 33/0 |

O juiz pegou, ao vivo, uma declaração MINHA errada. A `janela_aberta` declarava o D3 verde, mas o D3
media também o valor do cliente da carteira, e o pedido fora da janela vaza nele. Agora o D3 mede QUEM a
vendedora vê (os valores são o D2), e todas as sabotagens de valor declaram o D3 verde.

A rodada em `pt_BR.UTF-8` não é 2ª evidência: o script fixa `LC_ALL=C` antes de tudo. Foi rodada por
exigência e fica registrada como tal (a mesma lição da fatia 2a).

**Meta-falsificação**, sobre a cópia COMMITADA de cada prova num espelho fora da árvore, com 4
declarações: 1 certa, 1 vermelho que não vira, 1 verde que cai e 1 sabotagem inexistente. Resultado nas
duas: `SABOTAGENS: 1 vermelhas / 3 falhas`, exit 1. Cada falha saiu pelo motivo plantado ("não virou",
"ficou VERMELHO (pré-condição…)", "não aplicou (exit 3)").

**Custo:** PENDENTE.

## Revisão independente (Caminho B)

PENDENTE.

## Lições

- **O gatilho que fabrica a pré-condição também mata o seed que a fabrica de novo.** O score de farmer
  nasce do gatilho da carteira. A prova que o semeia à mão morre no UNIQUE, e a que confia no gatilho
  precisa medir que ele nasceu.
- **Guard que descarta calado transforma "apagado" em "nunca existiu".** Com `RETURN NULL` no BEFORE
  INSERT, o assert de limpeza só tem dente se outro assert medir a linha antes.
- **Dois guards com a mesma SQLSTATE se separam pela ENTRADA, não pela mensagem.** Comparar a mensagem é o
  caminho de volta ao ILIKE que casava a própria sentinela.
- **Uma tag pode encobrir a outra.** Duas bordas no mesmo cliente fazem uma sabotagem ficar verde pela
  outra borda: cada borda precisa do seu caso.
- **md5 diferente não é lógica diferente, mas a prova mede o texto que prod executa.** A cadeia viva
  resolve isso sem julgamento manual, e a hipótese "revertia" só se confirma lendo o diff.
