# As 3 provas do canal WhatsApp revividas — e o funil que não roda para o staff em prod

**2026-09-30.** Fatia 2 (a parte do canal) da revivência registrada em
[provas-db-mortas-fora-do-nucleo.md](provas-db-mortas-fora-do-nucleo.md). As três morriam no setup
porque re-aplicavam as migrations de 07-13 sobre um snapshot que já as tinha absorvido (`CREATE POLICY`
não é idempotente); a da proposta nasceu morta.

| prova | como morria | agora |
|---|---|---|
| `test-whatsapp-hsm.sh` | `policy "wt_staff_read" … already exists` (re-dump `9c9aae173`, #1509) | revivida, **núcleo**: 18 asserts, 17 sabotagens |
| `test-whatsapp-proposta.sh` | idem — nasceu morta (`250754cdf`) | revivida, **núcleo**: 17 asserts, 20 sabotagens |
| `test-whatsapp-funil.sh` | idem | revivida e **VERMELHA**: achou o funil quebrado em prod; fora do núcleo até o conserto |

A parte da carteira (`melhorias-rpcs`, `fornecedores-classificacao`) fica para a próxima sessão — o
alvo dela já está medido (abaixo).

## O alvo, medido — e o que o snapshot NÃO carrega

`md5(pg_get_functiondef())` via `psql-ro` × o banco montado: `get_whatsapp_funil` e
`get_whatsapp_proposta_cotacao` são iguais em prod e no snapshot. As TABELAS que elas leem, não: o diff de
catálogo inteiro (funções, policies, triggers, constraints, índices únicos, RLS, colunas: ~8,5 mil
objetos) mostrou em `sales_orders`/`order_items` o constraint trigger de coerência cabeçalho × linhas
(`20260907220000`), `unit_price` agora nullable (`20260905225613`) e colunas novas. Por isso as provas
guardam também as tabelas que a RPC lê, e a cadeia viva pega as 4 migrations da proposta (1 no funil);
a do HSM sai vazia, e isso é legítimo. Fora de qualquer cadeia ficou a `20260830122702`, que tira de
`profiles` um trigger que o snapshot ainda tem — versão anterior ao corte, mergeada depois do dump (só
dispara para employee com o CPF do master; nenhuma prova do canal o aciona — a de Melhorias, da fatia 2b,
o dispara no INSERT de profiles de clientes, sem efeito).

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

O fixture de ACL é o default do Supabase + as 556 exceções medidas em prod (tabela → coluna → função,
nessa ordem: `REVOKE ALL` de tabela apaga o GRANT por coluna) + o DEFAULT PRIVILEGES de prod (o objeto
que a cadeia recria nasce como nasceria em prod), com as consultas de re-medição no rodapé. Objeto de
prod ausente do snapshot é pulado e CONTADO (50 hoje). E `prova.sqlstate(sql)` devolve a SQLSTATE com a
**camada e o objeto** que negaram o 42501 — `/acl-funcao:<f>`, `/acl-tabela:<t>`, `/acl-schema:<s>` ou
`/rls:<t>`: o código é o mesmo para as quatro, e o anon barrado no EXECUTE da RPC ainda bateria no SELECT
da tabela. Sem nomear a camada, abrir o EXECUTE ficaria verde; sem o objeto, a negação vinda da
subconsulta de uma policy em OUTRA tabela passaria pelo assert.

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
espelho com o GRANT só no fixture: 12/0 e falsificação 18/0 nos dois locales. **Não está no repo:** a
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
| HSM | `PASS=18  FAIL=0` | `SABOTAGENS: 17 vermelhas / 0 falhas` | 17/0 |
| proposta | `PASS=17  FAIL=0` | `SABOTAGENS: 20 vermelhas / 0 falhas` | 20/0 |
| funil, ACL de prod | `PASS=2  FAIL=10` (o achado) | — (controle vermelho aborta) | — |
| funil, espelho com o GRANT | `PASS=12  FAIL=0` | `SABOTAGENS: 18 vermelhas / 0 falhas` | 18/0 |

O juiz pegou, ao vivo, duas declarações MINHAS erradas: `seed_incompleto` apagava justo o template que o
H2 usa (a FK derrubou um verde declarado), e a sabotagem do NaN tira as duas guardas, então o Infinity
vaza junto (P8 não era pré-condição). **Meta-falsificação** formal (cópia com 1 declaração certa, uma
que não vira e uma sabotagem inexistente): `SABOTAGENS: 1 vermelhas / 2 falhas`, exit 1.

**Runner** com manifesto parcial (`MANIFESTO=` só com as 2 linhas novas): `SQL_PROOF_OK provas=2/2
falsificacoes=2/2 fora_do_ci=0`, 77 s, depois da revisão e do merge da `main`. Custo no M2 no modo do CI:
HSM 4 s + 26 s, proposta 6 s + 38 s.

## O que mudou ao portar

- **HSM:** a negação de escrita no log declara a camada (`/acl-tabela`, não `/rls`), e o UPDATE (H15)
  mostra por que ela importa — aberto o GRANT, a policy CALA (0 linhas, sem erro). Novos: o CHECK de
  `origem`, o teto de parâmetros, o master lendo o log, o anon escrevendo no catálogo. O seed do catálogo
  é DADO da migration (o dump é schema-only): extraído do próprio arquivo, fail-closed.
- **Funil:** a sabotagem de julho trocava a RPC inteira por um stub; agora cada regra é um trecho do
  corpo vivo. Novos: a mensagem que SAI e a do envio que FALHOU não são resposta, o piso de 1 dia e o
  teto de 365, a receita só do que virou pedido, o cliente com pedidos do canal lendo só os dele, e o
  anon barrado no EXECUTE — as `migracao_nova_drop_create*` (a armadilha do CLAUDE.md) só ficam
  vermelhas porque o assert nomeia a camada e o objeto.
- **Proposta:** o assert de julho "o não-staff cai na tabela 99" é FALSO hoje — `omie_products` virou
  só-staff, e o cliente recebe 0 linhas. Novos: Infinity no praticado e na tabela; o praticado NULL
  (possível em prod desde a `0905225613`) que não esconde o válido mais antigo; a partição por conta
  provada dos DOIS lados; e o seed coerente que o trigger de coerência de prod aceita. A guarda
  `<> 'NaN'` é REDUNDANTE com a `< 'Infinity'` (medido: `'NaN'::numeric < 'Infinity'` é falso), então a
  sabotagem do NaN tira as duas. O UNIQUE da proposta é escrito COMO o staff (`cap_pedido_escrever`).
- **Não portado:** o `GRANT ALL ON ALL TABLES` (ficção) e as sabotagens por stub.

## Revisão independente (Caminho B)

O Codex não foi consultado: o `scripts/codex-async.sh` barrou pelo sensor de cota (86% > 85%; a janela
reabre em 03/10 19:11) sem gastar a chamada. No lugar, uma revisão adversarial por subagente só-leitura
com o roteiro da fatia 1, que rodou sabotagens PRÓPRIAS numa cópia. Achou 12; os defeitos entraram:

1. **O fixture não tinha o DEFAULT PRIVILEGES de prod.** Uma migration com DROP+CREATE seguida de
   `REVOKE … FROM PUBLIC` que esquece o anon deixava o anon NEGADO aqui e EXECUTANDO em prod (o default
   de prod lhe dá EXECUTE explícito) — o P13 ficava verde. Medido (`pg_default_acl`), reproduzido, e a
   `migracao_nova_drop_create_sem_anon` entrou nas duas RPCs.
2. **A sabotagem por migration nova re-aplicava a cadeia inteira** na rodada (que já a tem): inofensivo
   com a cadeia vazia, morreria no 1º `CREATE POLICY` real. Agora aplica só a nova.
3. **Proposta e funil não guardavam as tabelas que a RPC lê**: 4 migrations pós-snapshot mudam
   `order_items`/`sales_orders` em prod (`unit_price` nullable, o trigger de coerência). Guardadas — a
   cadeia da proposta tem 4, a do funil 1 —; o seed virou COERENTE (uma transação, o cabeçalho derivado
   das linhas, o trigger deferido confere no COMMIT), e o praticado NULL ganhou assert (P17). A migration
   do conserto do funil, quando existir, entra pela cadeia sozinha.
4. **A seleção não via `GRANT/REVOKE ON FUNCTION`** (nem `CREATE OR REPLACE TRIGGER`, `DROP FUNCTION f;`,
   schema entre aspas) — estendida e testada em 8 casos sintéticos; e uma fronteira frouxa minha no ramo
   GRANT de tabela (`mv_sales_orders` casava `sales_orders` por sufixo) fechou junto.
5. **O F7 passava por ausência** (cliente sem pedido). Com o GRANT, o cliente COM pedidos do canal lê os
   dele (F7b) — entrou como assert e como parte da decisão do conserto.
6. **O filtro de status do "respondeu" não tinha prova**: envio que falhou com inbound em 1h +
   `respondidos_sem_status`.
7. **O P2 não provava a partição do lado colacor** (o praticado colacor era o mais recente de todos):
   SKU nas duas contas com o da oben mais recente.
8. **10 funções só-do-dono saíam da medição** do ACL — re-medido (556 exceções).
9. **Asserts sem sabotagem** (P9, P10, P11, P16, F4, a metade "envios" do H13) ganharam a sua; os positivos
   ficam como pré-condição declarada, e os cabeçalhos dizem isso.
10. **`q_como` sem `ON_ERROR_STOP`** (um `SET ROLE` que falhasse leria como superusuário e sairia 0) e
    `rodada()` que seguia no banco da sabotagem anterior se o clone falhasse — consertados. E a suspeita:
    o 42501 agora nomeia o OBJETO (`/acl-tabela:sales_orders`), não só a camada.
11. **O corte por versão ≠ "não absorvido"**: 5 retardatárias (versão antiga, mergeadas depois do dump)
    medidas, nenhuma toca objeto guardado — documentado na lib, com a instrução para o re-dump.
12. **A rodada em `pt_BR.UTF-8` não é 2ª evidência**: o script fixa `LC_ALL=C` antes de tudo. Rodada por
    exigência e registrada como tal.

Fora do escopo, confirmado por ele: anon e authenticated têm TRUNCATE/TRIGGER nas tabelas do canal (o
default do Supabase); TRUNCATE não passa pela RLS, mas não há caminho pelo PostgREST. Não substitui o
Codex; cobre o intervalo.

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
- **O DEFAULT PRIVILEGES também é ACL.** Reproduzir o ACL dos objetos que existem não basta: o objeto que
  a próxima migration RECRIA nasce do default — e o de prod dá EXECUTE explícito ao anon, que o
  `REVOKE … FROM PUBLIC` não tira. Sem ele, a armadilha do DROP+CREATE ficava verde aqui e aberta lá.
- **Fixar o locale dentro do script é a defesa certa — e torna a 2ª rodada redundante.** Registre a
  rodada em `pt_BR.UTF-8` pelo que ela é, não como evidência independente.
