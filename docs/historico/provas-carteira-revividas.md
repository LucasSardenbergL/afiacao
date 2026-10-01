# As 2 provas da carteira revividas — Melhorias e "fornecedor fora da carteira"

**2026-10-01.** Fatia 2b da revivência registrada em
[provas-db-mortas-fora-do-nucleo.md](provas-db-mortas-fora-do-nucleo.md). As duas morriam fora do núcleo
porque re-aplicavam a migration de junho sobre um snapshot que já a tinha absorvido. Agora montam o schema
de prod pela lib da fatia 2a, `db/lib/corpo-vivo.sh` (snapshot + ACL medido em prod + cadeia dinâmica;
[provas-canal-revividas.md](provas-canal-revividas.md)), e entram no núcleo.

| prova | como morria | agora |
|---|---|---|
| `test-melhorias-rpcs.sh` | em 07-21, no 1º assert (o corpo de junho chamava `carteira_visivel_para`, que o fu7 moveu para `private`); desde `39ec9e31e` (08-28), já no seed: o CHECK `farmer_association_rules_cluster_segment_check` | **núcleo**: 39 asserts, 55 sabotagens |
| `test-fornecedores-classificacao.sh` | em 06-25 (`1c05aa8e3`), no seed: `23505 farmer_client_scores_customer_unique` | **núcleo**: 26 asserts, 53 sabotagens |

## O alvo, medido

`md5(pg_get_functiondef())` via `psql-ro` × o banco montado pela lib: **13 de 13 iguais**. São as 2 RPCs de
Melhorias (`619fdf35…`, `7be92ff8…`), o `private.padrao_like_contem` (`b34a1cfb…`), as 4 de fornecedores
(`1ea6738d…`, `6f726d09…`, `88b072d3…`, `8b8a6403…`) e os helpers que elas e as policies chamam
(`carteira_visivel_para`, `pode_ver_carteira_completa` nos dois schemas, `has_role`, `get_commercial_role`,
`reconcile_score_owner_from_carteira`). O ACL delas também é igual; a diferença são só os papéis de sandbox
do Lovable e o `claude_ro`, que existem apenas em prod.

A cadeia viva de Melhorias pega 6 migrations: a `20260929000234` (as 2 RPCs com o escape de curinga), as
4 de `order_items`/`sales_orders` e a `20261001100000`, o GRANT por coluna do funil do canal (#2715), que
mergeou com este PR aberto e entrou sozinha nas duas cadeias porque elas guardam `sales_orders`. É a
cadeia dinâmica fazendo o que promete. A de fornecedores pega 2: o trigger de coerência de `sales_orders`
e o mesmo GRANT. As 4 funções de fornecedores são as do snapshot, e a cadeia vazia para elas é legítima.

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
   prod (já registrado na fatia 2a). O seed de Melhorias o dispara (INSERT de profiles de clientes), mas ele
   só age para employee com o CPF do master: sem efeito aqui.

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
| melhorias | `PASS=39  FAIL=0` | `SABOTAGENS: 55 vermelhas / 0 falhas` | 55/0 |
| fornecedores | `PASS=26  FAIL=0` | `SABOTAGENS: 53 vermelhas / 0 falhas` | 53/0 |

O juiz pegou, ao vivo, uma declaração MINHA errada. A `janela_aberta` declarava o D3 verde, mas o D3
media também o valor do cliente da carteira, e o pedido fora da janela vaza nele. Agora o D3 mede QUEM a
vendedora vê (os valores são o D2), e todas as sabotagens de valor declaram o D3 verde.

A rodada em `pt_BR.UTF-8` não é 2ª evidência: o script fixa `LC_ALL=C` antes de tudo. Foi rodada por
exigência e fica registrada como tal (a mesma lição da fatia 2a).

**Meta-falsificação**, sobre a cópia COMMITADA de cada prova num espelho fora da árvore, com 4
declarações: 1 certa, 1 vermelho que não vira, 1 verde que cai e 1 sabotagem inexistente. Resultado nas
duas: `SABOTAGENS: 1 vermelhas / 3 falhas`, exit 1. Cada falha saiu pelo motivo plantado ("não virou",
"ficou VERMELHO (pré-condição…)", "não aplicou (exit 3)"). E o juiz novo (ERRO em qualquer parte do `got`,
da revisão abaixo) foi falsificado num cenário SINTÉTICO com um assert composto. Com `valor`, ele dá
vermelho por valor e é dente. Com `erro_no_meio` (`got[ok|ERRO: …]`), ele dá `1 vermelhas / 1 falhas`,
exit 1, nas duas provas. A MESMA cópia com o regex do juiz do molde (`got\[ERRO: `) dá `2 vermelhas / 0
falhas`, exit 0: aceita o erro como dente. É o ponto cego, reproduzido.

**Custo**, medido no M2 pelo runner do núcleo, na mesma invocação do CI (`MANIFESTO=` com as 2 linhas, com a
máquina já fora do pico de carga): Melhorias 4 s + 68 s (`--falsificar`), fornecedores 4 s + 53 s. **No CI é
projeção, não medida:** os moldes da fatia 2a fazem 26 s → 11 s (HSM) e 38 s → 14 s (proposta) do M2 para o
runner, uma razão de ~0,4. Aplicada aqui, dá ~25–30 s + ~20–22 s de `--falsificar` e ~2–3 s de modo normal
por prova, ~50 s no total. As 2 linhas são consecutivas no manifesto, e a partição é round-robin
(#2713): caem em partes diferentes das 3 paralelas, que medem 4m36s–6m52s contra o teto de 20 min (#2721).
O número real fica no log do job `provas-sql` do PR.

## Revisão independente (Caminho B)

O Codex não foi consultado. O `scripts/codex-async.sh` barrou pelo sensor de cota sem gastar a chamada
(exit 79, `SALDO_ALTO`: 86% contra um teto de 85%; a janela reabre em 03/10 19:11), a mesma janela da
fatia 2a. No lugar dele rodou uma revisão adversarial por subagente só-leitura, com o roteiro das 12 da
fatia 2a. Ela rodou sabotagens PRÓPRIAS em cópias fora da árvore e conferiu prod por `psql-ro`.

Achou **6 defeitos medidos**, e todos entraram:

1. **O D3 passava por AUSÊNCIA.** O seed só tinha o cliente da carteira da vendedora e um cliente sem
   dono. As duas conjunções do helper de carteira que fazem a "carteira DELA" (o dono e o `eligible`) podiam
   sumir com o D3 verde. Entraram um cliente da carteira de OUTRA vendedora e um da carteira dela
   inelegível, com uma sabotagem para cada conjunção.
2. **"Reescreve as 3 flags nas DUAS direções" era falso.** A corrupção era uniforme por coluna, então uma
   classificação "pegajosa" (que nunca tira o `is_fornecedor`) passava 25/25. Agora o K00 corrompe cada
   linha para o valor ERRADO e lê o estado corrompido, e cada flag tem uma sabotagem por direção
   ("pegajosa" e "nunca liga").
3. **O U2 tinha deixado de provar a TRIAGEM.** O A6h de junho, em que o master atualiza o item da
   vendedora, virou um update do item do próprio master, e uma policy restrita ao autor passava. Agora o U2
   é sobre o item alheio (muda a urgência; o status segue aberto para as mensagens) e tem sabotagem própria.
4. **O status `'active'` do alias passava por ausência.** O seed só tinha alias ativo. Entrou um alias
   INATIVO (V5: ele volta para a carteira) com a sua sabotagem. Em prod são 1.633 ativos e 0 de outro
   status, então o risco é latente.
5. **O trim do trigger não tinha dente.** As tags do T1 e do T2 eram limpas. Agora o T2 re-deriva
   `' Transportadora '`, com sabotagem.
6. **O trim da `produtos_relacionados` não tinha dente** (só a `clientes` era testada com espaço). O G2
   passou a usar `'  ab  '`.

E mais, sem defeito no veredito:

- **Dentes que existiam sem sabotagem:** o item da mensagem (`i.id = item_id`, o dente do M2), a caixa na
  decisão da classificar, o `max(lift)`, o escopo `todos`, o "só dos excluídos" das 3 escritas da aplicar,
  os 3 status na coluna `tem_venda_real`, o autor da exceção e o motivo e o dono das filas. Todos ganharam
  sabotagem.
- **Conjunções sem dente por construção:** o `'em_andamento'` da policy de mensagens (entrou um item em
  andamento, o M10) e o anon lendo e escrevendo MENSAGEM (S4 e W2, com sabotagem).
- **Objetos executados fora das listas CV:** em Melhorias, `get_commercial_role`, `commercial_roles` e
  `carteira_coverage` (a vendedora "sem papel gerencial" é premissa do D3); em fornecedores, o
  `farmer_expirar_pendentes_do_dono_anterior`, o gatilho que o DELETE da aplicar dispara. Todos entraram
  (0 migration a mais hoje). A `farmer_recommendations` custaria +1 migration e ficou de fora, registrado
  aqui.
- **O juiz só reconhecia ERRO no INÍCIO do `got`.** Nos asserts compostos (G1, V4, V5, T1, T2, K00, I6),
  um ERRO na 2ª medição contaria como dente "por valor". Agora ele procura `ERRO:` em qualquer parte. O
  juiz dos moldes do canal tem o mesmo ponto cego. Fica registrado aqui, porque consertá-lo é outra
  entrega.
- **Textos desatualizados:** o cabeçalho da `corpo-vivo.sh` (as usuárias), a fatia 2a (o gatilho de
  `profiles` que "nenhuma prova aciona" — a de Melhorias o dispara, sem efeito) e o cabeçalho de
  fornecedores, que delegava o guard a uma prova sem dizer que ela está FORA do núcleo.

**A 2ª passada**, só leitura, sobre os consertos, achou mais um dente que faltava, e ele é o de maior
impacto: **o reverter religava o `eligible` com `WHERE customer_user_id = p_user_id`, e nada provava esse
WHERE.** Sem ele, cada reversão reescreve a carteira INTEIRA com o valor que serve ao alvo. Em prod, um
clique do master viraria as 7.301 atribuições, inclusive as 2.127 inelegíveis. Tudo ficava verde, porque
cada assert só olhava o alvo. Agora o V2 lê também o c4 (intacto) e o V3 lê o total das filas, que só
pode ter o alvo; o V0 mede as filas inteiras vazias antes. Entraram 3 sabotagens: o eligible da carteira
inteira, a flag da carteira inteira e a fila da carteira inteira. Também entraram na cadeia os 2 gatilhos
de coerência que o seed dispara (`pedido_venda_coerencia_cab`/`_lin`, 0 migration a mais). O helper deles,
`pedido_venda_exigir_coerencia`, NÃO entrou, ao contrário do que a revisão estimou: a única DDL posterior
nele é um `GRANT` dentro da `20260914180104`, e guardá-lo puxaria a migration inteira (medido por
`cv_cadeia`).

Conferido por ele e certo: o md5 e o ACL de 21 funções (as 13 do doc mais os gatilhos e helpers que o seed
e a limpeza disparam), as policies, colunas e índices das 16 tabelas, as 2 cadeias, o ACL de prod com a
camada nomeada, o cron (`classificar-fornecedores-nightly` chama só a aplicar), as irmãs no núcleo, o
relógio (datas do dia de SP, longe de borda), o `ON_ERROR_STOP` do `q_como`, o preparo como assert e as
âncoras multi-linha via `psql -v`.

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
- **"Nas duas direções" exige que cada linha comece no valor ERRADO.** Corromper uma coluna para um valor
  uniforme testa uma direção só. A outra fica verde por ausência, e uma reescrita "pegajosa" passa.
- **Assert de visibilidade precisa do caso que NÃO pode ser visto, um por motivo.** "Vê só a carteira
  dela" sem cliente de outra carteira nem cliente inelegível não tem dente sobre o filtro que diz provar.
- **A revisão adversarial achou 6 vácuos que o juiz não podia achar.** O juiz mede a declaração. Ele não vê
  o dente que ninguém declarou, e foi isso que a revisão encontrou.
- **Assert que só olha o alvo não vê a escrita que vaza para os vizinhos.** O WHERE de uma escrita
  pontual (o reverter, as filas) só tem dente se outro registro for lido depois e estiver intacto.
