# As 3 provas do canal WhatsApp revividas — e o funil que não roda para o staff em prod

**2026-09-30.** Fatia 2 (a parte do canal) da revivência registrada em
[provas-db-mortas-fora-do-nucleo.md](provas-db-mortas-fora-do-nucleo.md). As três morriam no setup
porque re-aplicavam as migrations de 07-13 sobre um snapshot que já as tinha absorvido (`CREATE POLICY`
não é idempotente); a da proposta nasceu morta.

| prova | como morria | agora |
|---|---|---|
| `test-whatsapp-hsm.sh` | `policy "wt_staff_read" … already exists` (re-dump `9c9aae173`, #1509) | revivida, **núcleo**: 18 asserts, 16 sabotagens |
| `test-whatsapp-proposta.sh` | idem — nasceu morta (`250754cdf`) | revivida, **núcleo**: 16 asserts, 14 sabotagens |
| `test-whatsapp-funil.sh` | idem | revivida e **VERMELHA**: achou o funil quebrado em prod; fora do núcleo até o conserto |

A parte da carteira (`melhorias-rpcs`, `fornecedores-classificacao`) fica para a próxima sessão — o
alvo dela já está medido (abaixo).

## O alvo, medido — e o que o snapshot NÃO carrega

`md5(pg_get_functiondef())` via `psql-ro` × o banco montado: `get_whatsapp_funil` e
`get_whatsapp_proposta_cotacao` são iguais em prod e no snapshot, e nenhuma migration ≥ `20260905090000`
faz DDL sobre elas ou sobre as tabelas do canal — a cadeia viva sai vazia, e isso é legítimo. O diff de
catálogo inteiro (funções, policies, triggers, constraints, índices únicos, RLS, colunas: ~8,5 mil
objetos) mostrou deriva nas tabelas que as provas SEMEIAM, sem tocar a semântica asseverada: em
`sales_orders`/`order_items`, o constraint trigger de coerência (`20260907220000` — só vale para pedido
COM linhas, e as RPCs só leem `order_items`), `unit_price` agora nullable (`20260905225613`) e colunas
novas; em `profiles`, o `trg_auto_commercial_super_admin` que prod removeu (`20260830122702` — só
dispara para employee com o CPF do master).

O que o snapshot não carrega de jeito nenhum é o **ACL**: o dump é `--no-privileges`. As provas de julho
davam `GRANT ALL ON ALL TABLES` a anon/authenticated — um ACL que prod não tem. Medido: 81 tabelas e 297
funções fogem do default do Supabase, e `sales_orders` tem SELECT **por coluna** para authenticated.

**Para a próxima fatia (Melhorias):** as duas RPCs divergem do snapshot. Snapshot + o ACL de prod +
`20260905225613` → `20260929000234` reproduz o md5 de prod das duas (`619fdf35…`, `7be92ff8…`); sem o
ACL antes, a pós-condição da `…000234` reprova (POS12: ela confere o EXECUTE de 7 funções).

## A lib: `db/lib/corpo-vivo.sh` + `db/lib/corpo-vivo-acl.sql`

A `data-health-vivo.sh` é do trio (MV, ACL e cadeia dele, cadeia vazia = defeito). A nova é genérica: a
prova declara `CV_FUNCOES`/`CV_TABELAS`, e entra na cadeia toda migration ≥ `CV_INICIO` com DDL sobre
uma delas — função (`CREATE/ALTER/DROP FUNCTION`) **ou tabela** (`ALTER TABLE`, policy, índice, trigger,
`GRANT/REVOKE`), lida sem comentários de linha e com DDL multi-linha achatado. Testada nos dois lados:
pega a cadeia de Melhorias (`0905225613`, `0929000234`), pega policy multi-linha e `ALTER TABLE ONLY`,
ignora a menção em comentário e o nome vizinho (`whatsapp_templates_backup`); lista vazia falha fechado.

O fixture de ACL é o default do Supabase + as 546 exceções medidas em prod (tabela → coluna → função,
nessa ordem: `REVOKE ALL` de tabela apaga o GRANT por coluna), com a consulta de re-medição no rodapé.
Objeto de prod ausente do snapshot é pulado e CONTADO (48 hoje). E `prova.sqlstate(sql)` devolve a
SQLSTATE com a **camada** que negou o 42501 — `/acl-funcao`, `/acl-tabela`, `/acl-schema` ou `/rls`: o
código é o mesmo para as quatro, e o anon barrado no EXECUTE da RPC ainda bateria no SELECT da tabela.
Sem nomear a camada, abrir o EXECUTE ficaria verde.

## O achado: o funil do canal não roda para o staff em prod

`get_whatsapp_funil` é `SECURITY INVOKER` e filtra por `sales_orders.whatsapp_conversation_id`. A
`20260709163500` trocou o SELECT de tabela de authenticated por SELECT **por coluna** (para fechar
`omie_payload`/`omie_response`); a `20260713030000` e a `20260713050000` criaram as colunas do canal
quatro dias depois, e **coluna nova não herda GRANT por coluna**. Medido em prod:
`has_column_privilege('authenticated', 'public.sales_orders', 'whatsapp_conversation_id', 'SELECT')` = f
(idem `whatsapp_proposta_dedupe`). Com o ACL de prod, a prova reproduz: o staff leva
`42501/acl-tabela` no funil (F0), e a releitura do orçamento por `whatsapp_proposta_dedupe` — o caminho
do 23505 em `src/services/whatsappProposta/enviarProposta.ts:209` — também (F10). O app chama a RPC como
authenticated (`useWhatsappFunil`, na `WhatsappSlaSupervisao`).

**Latente:** prod tem 0 envios, 0 templates ativos, 0 conversas e 0 orçamentos com elo — o canal ainda
não foi ligado. Quando ligar, o funil e o "reusar orçamento" falham para todo staff.

**O conserto proposto** é o idioma do próprio hardening — as duas colunas entram na lista por coluna:
`GRANT SELECT (whatsapp_conversation_id, whatsapp_proposta_dedupe) ON public.sales_orders TO
authenticated;` (`omie_payload`/`omie_response` seguem fechadas, nenhum SELECT de tabela). Validado num
espelho com o GRANT só no fixture: 11/0 e falsificação 15/0 nos dois locales. **Não está no repo:** a
sessão tentou escrever a migration e o classificador de permissão a barrou (mudança de autorização que
chega a prod) — é decisão do founder. A prova do funil fica fora do núcleo até prod ter o GRANT e o
fixture ser re-medido.

A classe tem mais um membro medido, sem leitor authenticated: `omie_reconciliado_em` (nenhum uso em
`src/`).

## Falsificação — medida

Cada sabotagem troca UMA camada do schema vivo no banco da rodada (corpo da RPC por `cv_sabotar`, com
âncora única e md5 que muda; constraint, policy ou GRANT por DDL) e declara o assert que TEM de cair e os
que seguem verdes; o juiz é o do molde. Controle verde na MESMA invocação, antes da 1ª sabotagem.

| prova | modo normal | `--falsificar` em `LC_ALL=C` | em `pt_BR.UTF-8` |
|---|---|---|---|
| HSM | `PASS=18  FAIL=0` | `SABOTAGENS: 16 vermelhas / 0 falhas` | 16/0 |
| proposta | `PASS=16  FAIL=0` | `SABOTAGENS: 14 vermelhas / 0 falhas` | 14/0 |
| funil, ACL de prod | `PASS=2  FAIL=9` (o achado) | — (controle vermelho aborta) | — |
| funil, espelho com o GRANT | `PASS=11  FAIL=0` | `SABOTAGENS: 15 vermelhas / 0 falhas` | 15/0 |

O juiz pegou, ao vivo, duas declarações MINHAS erradas: `seed_incompleto` apagava justo o template que o
H2 usa (a FK derrubou um verde declarado), e a sabotagem do NaN tira as duas guardas, então o Infinity
vaza junto (P8 não era pré-condição). **Meta-falsificação** formal (cópia com 1 declaração certa, uma
que não vira e uma sabotagem inexistente): `SABOTAGENS: 1 vermelhas / 2 falhas`, exit 1.

**Runner** com manifesto parcial (`MANIFESTO=` só com as 2 linhas novas): `SQL_PROOF_OK provas=2/2
falsificacoes=2/2 fora_do_ci=0`, 73 s. Custo no M2 no modo do CI: HSM 4 s + 27 s, proposta 5 s + 36 s.

## O que mudou ao portar

- **HSM:** a negação de escrita no log declara a camada (`/acl-tabela`, não `/rls`), e o UPDATE (H15)
  mostra por que ela importa — aberto o GRANT, a policy CALA (0 linhas, sem erro). Novos: o CHECK de
  `origem`, o teto de parâmetros, o master lendo o log, o anon escrevendo no catálogo. O seed do catálogo
  é DADO da migration (o dump é schema-only): extraído do próprio arquivo, fail-closed.
- **Funil:** a sabotagem de julho trocava a RPC inteira por um stub; agora cada regra é um trecho do
  corpo vivo. Novos: a mensagem que SAI não é resposta, o piso de 1 dia e o teto de 365, a receita só do
  que virou pedido, e o anon barrado no EXECUTE — a `migracao_nova_drop_create` (a armadilha do
  CLAUDE.md: DROP+CREATE devolve o EXECUTE a PUBLIC) só fica vermelha porque o assert nomeia a camada.
- **Proposta:** o assert de julho "o não-staff cai na tabela 99" é FALSO hoje — `omie_products` virou
  só-staff, e o cliente recebe 0 linhas. Novos: Infinity no praticado e na tabela. A guarda `<> 'NaN'` é
  REDUNDANTE com a `< 'Infinity'` (medido: `'NaN'::numeric < 'Infinity'` é falso), então a sabotagem
  do NaN tira as duas. O UNIQUE da proposta é escrito COMO o staff (`cap_pedido_escrever`).
- **Não portado:** o `GRANT ALL ON ALL TABLES` (ficção) e as sabotagens por stub.

## Revisão independente (Caminho B)

O Codex não foi consultado: o `scripts/codex-async.sh` barrou pelo sensor de cota (86% > 85%; a janela
reabre em 03/10 19:11) sem gastar a chamada. No lugar, uma revisão adversarial por subagente só-leitura
com o roteiro da fatia 1.

## Lições

- **ACL é parte do corpo vivo.** Prova que lê ou escreve como authenticated/anon com um ACL inventado
  aprova o que prod nega — e o snapshot, sendo `--no-privileges`, não o traz. O `GRANT ALL` das provas de
  julho não era atalho de setup: era a razão de elas não poderem ver o defeito.
- **Coluna nova em tabela com GRANT por coluna não herda o GRANT.** O hardening por coluna é uma
  allowlist; cada coluna criada depois nasce fechada para quem a lia pelo SELECT de tabela.
- **42501 não diz quem negou.** GRANT de função, de tabela, de schema e policy dão o mesmo código; em
  defesa em profundidade, o assert tem de nomear a camada, senão sabotar a primeira fica verde pela
  segunda.
- **O juiz pega quem o escreve.** Duas das minhas declarações estavam erradas e o juiz as reprovou antes
  de qualquer revisão — a declaração de verdes não é burocracia, é o que separa o dente da coincidência.
