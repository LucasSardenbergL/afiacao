# Universo de pedidos: a classe nos objetos SQL

**2026-10-01.** Fecha o chip "Erradicar a classe do universo divergente", aberto no fecho de
[positivacao-universo-canonico.md](positivacao-universo-canonico.md). Skill `matar-classe`.
Migrations `20261001014000_universo_pedidos_caca.sql`, `…014100_universo_pedidos_recencia.sql` e
`…014200_universo_pedidos_preco.sql` (uma por domínio); prova `db/test-universo-pedidos-classe.sh`;
gate `scripts/universo-pedidos-sql-gate.test.ts`.

## A classe

A autoridade do universo de pedidos de VENDA é a denylist `status NOT IN ('cancelado','rascunho',
'pendente','orcamento')`, que anda junto com `deleted_at IS NULL` (`src/lib/farmer/universo-pedidos.ts`,
espelho Deno em `supabase/functions/_shared/universo-pedidos.ts`). A classe é **objeto SQL que lê
`public.sales_orders` aplicando outro universo**: sem filtro de status, denylist parcial, allowlist,
`IS DISTINCT FROM 'cancelado'`, `COALESCE(status,'')`, ou sem `deleted_at`.

Assinatura (o que o gate procura): a última definição de cada função/view/MV nas migrations; cada
`FROM`/`JOIN sales_orders <alias>` exige, no MESMO alias, a denylist com o conjunto da autoridade e
`deleted_at IS NULL` — contados por alias, porque duas leituras com `so` precisam de dois de cada.

## A medição (psql-ro, 2026-09-30 22:50 → 2026-10-01 01:20 UTC)

O levantamento estático do chip ("38 objetos, 22 divergentes, 14 money-path") foi refeito contra o
catálogo da prod. **38 objetos vivos leem `sales_orders` — e o modelo do gate acha os mesmos 38 nas
migrations.** A classificação final:

| | n | objetos |
|---|---|---|
| canônicos antes | 4 | `private.margem_cliente_agregada`, `_carteira_positivacao_for_owner`, `recommend_cluster_agregado`, `get_customer_sales_summary` |
| **corrigidos aqui** | **13** | preço 7 · recência 4 · caça 2 (abaixo) |
| canônico por parâmetro | 1 | `apriori_universo_snapshot` (recebe a lista e a VALIDA contra a autoridade) |
| lookup por id | 11 | ATP (5), picking por id, gatilho de item, total líquido (classificar), coerência, payload, tint no submit |
| escritor | 4 | edição, importador, conversão de total líquido, reconciliação Omie |
| propósito | 5 | `order_feed`, `selfservice_meus_pedidos`, `listar_pedidos_a_separar`, `get_whatsapp_funil`, `cockpit_itens_snapshot` |

O levantamento estático contava `apriori` como canônico (o texto não tem a lista; o contrato tem) e
deixava de fora `get_whatsapp_proposta_cotacao`, cujo comentário diz "último preço praticado
VÁLIDO" e cujo corpo não filtrava status **nem** `deleted_at` — é o preço que vai na proposta ao
CLIENTE.

**O denominador mudou o tamanho do problema.** Fora do universo canônico havia, na tabela inteira
(33.693 linhas), só **28 `cancelado`** (oben, todos com kpi e `omie_pedido_id`), **1 `orcamento`** e
**1 `rascunho`** (do app, sem kpi, sem itens). **0 apagados, 0 `pendente`.** `status` é NOT NULL
DEFAULT `'rascunho'` — o `COALESCE(status,'')` das funções de preço era cosmético. O efeito vivo,
medido por contrafactual no grão e na janela de cada objeto:

| domínio | objeto | antes | efeito vivo |
|---|---|---|---|
| preço | `get_regua_preco` | sem status | 33 itens de cancelados na janela de 180 d; 28/2.388 pares cliente×produto (4 SÓ com cancelado); 27/448 produtos nos comparáveis |
| preço | `get_regua_preco_customer360` | sem status | 14/7.294 pares com `preco_atual` de cancelado: 11 mudam (5 viram `sem_preco`) |
| preço | `get_whatsapp_proposta_cotacao` | sem status, sem `deleted_at` | 14/24.093 trios: 11 mudam (5 caem para tabela ou `sem_preco`) |
| preço | `get_ultimos_precos_cliente`, `medir_abaixo_piso_tier` | denylist de 2 | 0 |
| preço | `get_defasagem_cliente` | allowlist dos 4 de venda | 0 (iguais hoje; divergem com status novo) |
| tint | `tint_ultimo_preco_cliente` | `≠ cancelado`, sem `deleted_at` | 0 |
| recência | `private.customer_metrics_mv` | denylist de 2, sem `deleted_at`, data `COALESCE` | universo: 1 cliente (−R$ 4.660); + data só-kpi: 3 (90 d −R$ 767; 90–180 d −R$ 5.239,10) |
| recência | `melhoria`, `classificar`, `v_grupo_comercial` | 3 / sem `deleted_at` / allowlist | 0 (`cliente_grupo_membros` está vazia) |
| caça | `v_caca_compradores`, `v_caca_candidatos` | denylist de 2, data `COALESCE` | universo: 1 cliente (−1 pedido, −R$ 4.660); + data só-kpi: 3 (−4 pedidos, −R$ 6.006,10) |

As somas da recência com a data só-kpi batem **exatamente** com as da positivação (jun −R$ 5.239,10,
ago −R$ 767): é a mesma correção, vista de outro objeto.

## As decisões (founder, 2026-10-01)

- **Preço + tint:** canônico nas 7. A data de cada função não muda — só o universo.
- **Recência e caça:** canônico + data só `order_date_kpi` (a D2 da positivação). Estendida a
  `melhoria` e `v_grupo_comercial` (mesmo domínio), onde muda 0 linha hoje.
- **Feeds/operacionais:** divergência de propósito, declarada no registro do gate.
- **Aplicação:** comigo, via `db:aplicar` (ensaio → apply → validação por fora) — inclusive o
  `DROP` da MV antiga, que o envelope deixa com o founder: autorizado na rodada de decisões.
- **Codex:** cota em 86% (teto 85%) até 03/10 19:11 → **PRs em DRAFT** até a janela reabrir; aí
  desenho + adversarial por domínio, e só então o apply.

## Ordem e coordenação (o que a sessão encontrou no caminho)

- O #2659 (fuso SP das 7 funções, recria `get_regua_preco`) estava mergeado e **não aplicado** quando
  a sessão começou; a PRE dele exige o md5 EXATO do corpo de 29/09. Aplicar a régua antes abortaria as
  7 funções dele. O founder o aplicou às 00:58 UTC; a régua desta entrega parte desse corpo.
- O #2685 (fuso SP em 18 views; aberto) foi **aplicado às 00:04 UTC**, entre os dois despejos desta
  sessão, e recriou as 2 views da caça e a do grupo comercial. As migrations daqui partem do corpo
  vivo pós-#2685, capturado verbatim no fixture — não dependem da ordem de merge.

## O conserto

Uma migration por domínio, cada uma aplicável sozinha, no molde da 20260929001651: trava (ALTER sem
efeito) → PRE (md5 EXATO do vivo = predecessor medido; aceita o próprio corpo novo, então re-aplicar
é no-op) → `CREATE OR REPLACE` com o corpo VIVO e só a troca do predicado (gerada por troca exata
com contagem conferida, não recopiada) → POS (semântica antes do md5; config/ACL iguais aos de antes).

A MV não tem `CREATE OR REPLACE`: renomeia a antiga e o índice, cria a nova com o mesmo nome,
re-amarra a view-gate por `CREATE OR REPLACE` (preserva OID e ACL; o `WITH (security_invoker = off,
security_barrier = true)` é repetido), copia o ACL item a item por `aclexplode` (o que a prod tiver
no instante) e só então derruba a antiga, já sem dependentes. A query custa ~25 ms em prod.

O `order_date_kpi IS NOT NULL` explícito entra onde a contagem não compara data (cadência da MV,
`count(*)`/`sum` da caça e do grupo); na `melhoria` a janela de 12 meses já o faz, e predicado
redundante não se falsifica.

## A prova

`db/test-universo-pedidos-classe.sh` — PG17 com o schema-snapshot, os predecessores EXATOS da prod
(H01–H15: md5 dos 14 alvos e o ACL da MV iguais aos de prod) e as 3 migrations sob o search_path do
`aplicar_sql`. **117 asserts**, controle verde em 28,7 s no laptop:

- **bloco U** — para cada objeto e cada predicado (cancelado, rascunho, pendente, orcamento,
  faturado APAGADO), um cliente-sonda com um pedido válido (R$ 1) e um excluído SÓ por aquele
  predicado, de valor 10^k e com a data DENTRO da janela do objeto; vazamento aparece como linha a
  mais ou como a potência de 10 que nomeia o predicado. No 360 e na proposta o excluído é o MAIS
  RECENTE (prova que o preço muda, não só que some). O `cliente_tier_preco` só aceita tier A/B/C,
  então o abaixo-do-piso ganhou um par (empresa, tier) por predicado;
- **admissão** dos 4 status de venda em cada objeto (uma allowlist derruba algum);
- **gêmeo push/pull** onde a data virou só-kpi (MV, cadência, caça, melhoria, grupo);
- **status desconhecido** na defasagem e no grupo — onde allowlist e denylist divergem de verdade;
- **view-gate** da MV sob `authenticated` (staff lê 4, cliente lê 0) e o **REFRESH … CONCURRENTLY**
  do cron depois da troca;
- **bloco M** — re-aplicar as 3 é no-op; corpo estranho em função, view e MV → a PRE aborta e o
  rollback preserva o estranho e a vizinha (e, na MV, desfaz o RENAME).

A prova pegou três defeitos MEUS antes de chegarem à prod: a PRE da view-gate comparava o md5 do
deparse DEPOIS do RENAME (a gate segue a MV pelo OID e passa a dizer `_antiga` — nunca bateria);
uma inserção feita por regex engoliu o `;` de um statement da semente; e o `case` dentro de `$( … )`
quebra no bash 3.2 do macOS.

**`--falsificar`: controle verde (117 asserts) + 17/17 sabotagens vermelhas no assert certo, nos DOIS
locales (`C` e `pt_BR.UTF-8`, 2026-10-01).** As sabotagens de CORPO desligam a POS para o corpo
sabotado chegar ao banco — o dente que se prova é o do assert: uma por predicado em todos os objetos
de uma vez (cada uma vermelha nos 14 asserts daquele predicado e verde nos outros), o `kpi IS NOT
NULL` (vermelho nos 3 gêmeos onde ele é o único guarda), o fallback de data na melhoria, o universo
em só UMA das duas leituras da régua (em cada sentido) e só no preço do 360, e o corpo ANTIGO de cada
domínio (vermelho exatamente onde a prod vaza hoje, verde onde o antigo já excluía — a defasagem
antiga só fica vermelha no status desconhecido). As sabotagens `_pos` mantêm a POS e provam o dente
DELA: a data por `created_at` de volta, a cópia de ACL da MV pulada e o `WITH` da view-gate omitido
— as três abortam a migration. E `pre_cega` prova a PRE: com ela cega, os corpos estranhos do bloco M
são sobrescritos.

A primeira rodada de falsificação reprovou **5 sabotagens por defeito do TESTE, não da prova**: eu
tinha declarado vermelho no predicado apagado de duas sabotagens que só tiram o status (o
`deleted_at` da régua continua lá — o certo é verde), e o rótulo do assert de aplicação usava
alternância `\|` de BRE, que o `sed` do macOS não entende — a mensagem `POS: …` chegava com o
`ERROR:` dentro e virava "erro de execução" em vez de vermelho por resultado. O laço do repo, que
exige o assert DECLARADO e recusa erro não declarado, é o que transformou isso em vermelho em vez de
dente falso.

**Fora do CI:** o job `provas-sql` já leva 15–16 min de um teto de 20 na `main`; 18 rodadas com o
snapshot somariam ~3 min. Entra no núcleo o controle (117 asserts, ~29 s no laptop) e o
`--falsificar` fica `fora-do-ci` com o motivo na linha — o recibo é este parágrafo e o do PR.

## O gate

`scripts/universo-pedidos-sql-gate.test.ts` sobre o núcleo `scripts/lib/universo-pedidos-sql.ts`:
lê a autoridade do TS, modela a última definição de cada objeto e julga cada leitura. O que não é
universo de venda de propósito vive no `REGISTRO_UNIVERSO_PEDIDOS` (tipo + motivo), que só encolhe.

**Calibração (o passo 1 da skill):** sem as 3 migrations o gate acusa os 13; com elas, 0 — mesmo
denominador (38) nos dois lados. **A calibração pegou um furo do próprio gate:** a MV nasceu em
`public` (20260623140000) e foi movida para `private` por um `SET SCHEMA` dentro de um `DO`
(20260629120000); o modelo não seguia o movimento, a definição pré-fix sumia e o gate ficava verde
por cegueira. O modelo passou a re-tokenizar `DO` e seguir `SET SCHEMA`/`RENAME`.

**Limites declarados** (cabeçalho do núcleo): objeto só na prod e SQL fora de migration; replace
programático; identidade por nome (sobrecargas se fundem); alias lido no FROM/JOIN imediato. Para
eles, a varredura é a da prod:

```sql
SELECT n.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prokind IN ('f','p') AND p.prosrc ~* '\msales_orders\M'
UNION ALL
SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('v','m') AND pg_get_viewdef(c.oid, true) ~* '\msales_orders\M';
```

## A metade TS (chip)

A varredura do repo inteiro achou a mesma classe em 43 leituras de `sales_orders` no TypeScript e
nas edges: 4 canônicas, 16 divergentes, 7 money-path (receita MTD e ranking de vendedores com
denylist de 2, receita lifetime do Customer 360 sem filtro, auditoria de margem, cesta da proposta,
histórico de preços da ligação), com 5 constantes paralelas à autoridade como causa-raiz — inclusive
o consumidor do `cockpit_itens_snapshot` (`STATUS_NAO_FATURAVEL`, denylist de 2). Chip: **"Erradicar
universo de pedidos divergente em TS/edges"**.

## Lições

1. **Re-medir o levantamento muda o veredito, não só o número.** O "22 divergentes, 14 money-path"
   virou 13 corrigíveis + 5 de propósito — e o mais grave do lado do cliente (a proposta de WhatsApp)
   não estava na lista.
2. **O denominador decide a urgência.** Com 0 apagados e 0 pendentes, metade das divergências era
   defesa do futuro; o efeito vivo era de 28 pedidos cancelados, quase todo no domínio preço.
3. **Allowlist e denylist só divergem quando o vocabulário muda** — então é ali que a prova tem de
   olhar: um pedido com status desconhecido é o único seed que separa as duas formas.
4. **A calibração pré-fix pega o gate cego.** Objeto movido de schema dentro de um `DO` some de um
   modelo que só lê CREATE; sem exigir que o pré-fix reprove, o gate nasceria verde para a MV.
5. **Terreno quente se re-mede antes de escrever.** Duas sessões recriaram 4 dos 13 objetos durante
   esta medição; a PRE de md5 exato é o que transforma isso em aborto em vez de reversão silenciosa.
6. **A "última a recriar vence" também mora nos TESTES de calibração.** Os gates do fuso
   (`relogio-nu-da-sessao-gate.test.ts`) e do LIKE (`like-cru-em-migrations-gate.test.ts`) provam o
   dente tirando a migration de conserto e exigindo que os corpos voltem crus — o que pressupõe que
   ela é a ÚLTIMA a defini-los. As migrations daqui re-definem `get_regua_preco` e a `melhoria` por
   cima, herdando o conserto, e os dois contrafactuais pararam de reverter. A correção honesta é
   tirar junto a SUCESSORA que herda o conserto (com o porquê no teste), não afrouxar a asserção.
