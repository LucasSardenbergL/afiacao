# O reprocess da Oben ficou 6 dias parado por UM pedido coerente (2026-09-14)

**Em 3 linhas.** De 2026-09-08 20:15Z a 2026-09-14 o reprocess de pedidos da Oben (`sync-reprocess`)
falhou em **74 ciclos operacionais e 6 estratégicos**, todos no mesmo pedido, `7b6f5f03…` (Omie
12180025234, nº 12723), cujo estado GRAVADO era coerente. A divergência nascia dentro da transação de
`reconciliar_pedidos_omie`, e o cheque do agregado (DEFERRED) só a via no COMMIT, fora da subtransação
por pedido. Por isso derrubava a página, a run e os estágios seguintes. Nenhum sensor lê
`sync_reprocess_log`. O conserto é o **#2496** (outra sessão). Esta entrega é o diagnóstico independente,
a validação cruzada por execução e a resposta de por que ninguém foi avisado.

Diário irmão (o conserto e o desconto por linha):
[`reconciliacao-desconto-da-linha-e-coerencia-por-pedido.md`](reconciliacao-desconto-da-linha-e-coerencia-por-pedido.md)
(chega com o #2496). Antecessores: #2384 (passivo do agregado), #2469 (total líquido).

## Linha do tempo (UTC, medida via `psql-ro`)

| Quando | Fato | Como se sabe |
|---|---|---|
| 07/09 12:17 | `order_items.omie_codigo_item` criada | `xmin` do `pg_attribute` × `cron.job_run_details` |
| 08/09 09:38 | triggers `trg_pedido_venda_coerencia_{cab,lin}` e verificador aplicados | `xmin` 9944845, o mesmo nos três |
| 08/09 12:00 | pedido 7b6f criado, com 1 item | `created_at`; `sales_price_history` só tem esse item |
| 08/09 16:15 | run adota a identidade da linha 1 (`12180025235`) | `xmin` da linha |
| 08/09 18:15 | último `complete`: linhas 2 e 3 gravadas com `codigo_item` novos (`12180164256`, `12180213789`) | `xmin` = o do cabeçalho |
| 08/09 | NF 9884 emitida: 2 × 586,30 = **1.172,60 = soma gravada** | `fin_contas_receber` |
| 08/09 20:15 | 1ª falha; daí em diante 74 `operational/orders` + 6 `strategic/orders`, **todas com o 7b6f** | `sync_reprocess_log.error_message` |
| desde 08/09 | `inventory` (operacional) e `products`/`inventory` (estratégico) sem nenhuma linha | o estágio de pedidos lança antes |
| 10/09 00:42 | RPC recriada pela `20260908215704` (sem relação com o incidente) | `xmin` 10007016 |
| 14/09 22:16 | 1º ciclo com as edges do #2469 (v1.7) no ar: **falha igual** | log |
| 14/09 ~23:18 | #2496 aberto (draft) por outra sessão, com o conserto | `gh` |

## O mecanismo (reproduzido por execução em PG17, corpos byte-idênticos aos de prod)

1. **O cheque escapa da subtransação.** O verificador `pedido_venda_exigir_coerencia` roda em
   CONSTRAINT TRIGGER `DEFERRABLE INITIALLY DEFERRED`. A RPC reconcilia cada pedido num
   `BEGIN … EXCEPTION WHEN data_exception OR integrity_constraint_violation`, mas o cheque só dispara no
   COMMIT da chamada. Resultado medido: a RPC **devolve `falhas: []`**, o COMMIT lança 23514, e o pedido
   de controle coerente processado ANTES na mesma página é desfeito junto.
2. **O nível 1 do casamento não conferia o SKU.** O casamento por `omie_codigo_item` gravava
   quantidade, preço, desconto, `product_id` e hash, mas **nunca `omie_codigo_produto`**. O nível 2
   (por SKU) garante "par ⇒ mesmo SKU" por construção; o nível 1 não garantia. Diferenças executadas:

   | Cenário | O que o Omie manda | Divergência no COMMIT |
   |---|---|---|
   | H1a | a mesma identidade com OUTRO produto | `order_items (8689744102,4,87,0)` × `jsonb (8689744199,4,87,0)` — o SKU velho fica na linha |
   | H1b | identidades PERMUTADAS entre duas linhas | quantidade e preço trocados por SKU |
   | H1c | como H1a, com `product_id` NULL dos dois lados | idem; aqui "só gravar o SKU no SET" não basta, porque o no-op não compara SKU |
   | H4 | item do det sem `codigo_produto` | só o jsonb tem `(NULL,1,0,0)` |

3. **E um caso que NÃO falhava, e por isso é pior (H1d).** Duas linhas de conteúdo idêntico com as
   identidades permutadas passavam no cheque, porque ele compara SKU, quantidade, preço e desconto e não
   compara `product_id`. O corpo antigo **commitava o `product_id` de um produto no SKU do outro**, em
   silêncio. O #2496 fecha isso também (verificado).

## Por que ESTE pedido: eliminação medida

- **Estado gravado:** coerente (3 itens nos dois lados).
- **Censo de prod:** 0 pedidos gravados incoerentes em 31.357 com linhas. A query tem dente provado em
  PG17: acusa 0 no estado transcrito e 1 com incoerência forçada.
- **H4 fora:** 0 de 71.201 itens de jsonb de pedido Omie sem `omie_codigo_produto`, em todo o histórico.
- **"NULL de um lado, 0 do outro" fora:** 0 linhas de pedido Omie com `discount` NULL.
- **Tolerância 1e-6 do no-op:** inalcançável com os valores do Omie. O #2496 trocou por igualdade exata de
  qualquer forma.
- **O que sobra:** só a família "identidade de linha com SKU diferente" (H1a ou H1b) é alcançável e
  consistente com os `codigo_item` novos do mesmo dia e com a NF de mesmo total.
- **O que NÃO se sabe:** qual mutação exata o Omie fez. Não há payload persistido, webhook de venda,
  picking, NF-e de saída local nem leitura sancionada do Omie. A confirmação vem do 1º ciclo pós-conserto:
  comparar as linhas com o retrato de antes (§Verificação).

Retrato de antes (psql-ro, 2026-09-14 ~21:40Z), status `separacao`, total 1.172,60,
`omie_reconciliado_em` 2026-09-08 18:16:02.714Z:

| `omie_codigo_item` | `omie_codigo_produto` | qtd | preço |
|---|---|---|---|
| 12180025235 | 8689723679 (TINTA MORDENTE IMBUIA TM.3610.42FG) | 1 | 199,60 |
| 12180164256 | 11892839175 (DILUENTE PU DFA.4128LT) | 1 | 625,00 |
| 12180213789 | 8689744102 (THINNER DR.4403L5) | 4 | 87,00 |

## Duas sessões no mesmo incidente

Às 21:32Z, `gh pr list` não tinha nada sobre o caso. Esta sessão reproduziu o incidente e desenhou o
conserto: nível 1 exigindo o mesmo SKU, verificador dentro do bloco do pedido e restauração dos
contadores no handler. Chegou a gerar migration, gêmeo `db:aplicar` e prova de núcleo. O
**`wt:preflight --full`** (Passo 2.5 do `lovable-db-operator`) deu 🔴: outra worktree recriava a mesma
função. Era o #2496, aberto às ~23:18Z por uma sessão que achou o incidente no pré-flight do chip de
desconto por linha do #2469. Ele tinha o mesmo mecanismo e um desenho equivalente, com parecer Codex de
desenho.

**Decisão:** não pousar migration concorrente ("a última a rodar vence"). Os artefatos desta sessão
saíram da worktree. Uma migration não commitada parada lá apareceria como "EM VOO" no `wt:preflight` da
outra sessão. Em troca, **validação por execução** do #2496 com os cenários desta sessão: **31/31
verdes**. Cobre controle, mudança legítima de preço, H1a, H1b, H1c, H1d, H4 no nível da RPC (vira falha
23514 registrada, o controle commita e o 7b6f fica intacto), contadores que contam só o que commitou (e
iguais ao corpo antigo nos casos coerentes), idempotência e ACL. Os cenários que a prova do #2496 não
tinha (H1b, H1c, H1d) foram enviados à sessão dona.

A sessão dona anunciou incorporá-los à prova do #2496 (G13–G15, o contrafactual H4c na função antiga e
as sabotagens FG10/FG8b). Confira lá. **Desenho e prova do conserto moram no diário do #2496**; este
arquivo fica com o diagnóstico do 7b6f. Um único ponto de desenho vale guardar aqui, porque saiu desta
reprodução: gravar `omie_codigo_produto` no SET **sem** o SKU no predicado de decisão não fecha o H1c
(provado). O #2496 faz os dois.

**Lição (de processo).** A busca de PR no início da sessão não vê o PR que nasce durante ela. Antes de
ESCREVER migration que recria função quente, refaça `gh pr list` e procure a função nas outras worktrees
(`rg -l '<função>' ../*/supabase/migrations/`). Não deixe isso para o `wt:preflight`, que só roda com o
arquivo pronto, depois do custo.

## Por que nenhum sensor avisou (medido em prod)

- **`_data_health_compute` não lê `sync_reprocess_log`.** São 21 checks. O de pedidos (`vendas_pedidos`)
  mede o **sync incremental** (`fin_sync_log`, `sync_pedidos`), que estava verde. O `sync_state_saude`
  enxergaria erro autodeclarado, mas a edge não escreve `sync_state`: o marcador `orders` saiu como fóssil
  na `20260824232212`.
- **`data_health_watchdog`** só consome o compute. Às 22:30Z: `checks_avaliados=21, checks_falhos=0`.
- **`fin_sync_heartbeat`** só resume `fin_alertas`/`fin_sync_log`.
- **A ação `get_health` da própria edge** lê a tabela, mas não tem limiar, não escreve e ninguém a chama.
- **`cron.job_run_details`** dizia `succeeded` (só o enfileiramento). O `net._http_response` tinha HTTP 500
  com a mensagem, mas retém poucas horas.
- **Resultado:** a reconciliação é outra trilha, e nada a vigia. Mesma cegueira no estratégico.
- **Conserto:** chip "Criar sensor de saúde do sync-reprocess no data_health". Check por
  `(account, reprocess_type, entity_type)`, com as 3 funções acopladas recriadas juntas.

## Estado dos deploys (ledger `pendencias:deploy`, 2026-09-14 ~23:45Z)

`sync-reprocess` e `omie-vendas-sync` em `v1.7-subtotal-liquido-pela-regua`, atestadas pela sonda. As
duas edges do #2469 estão no ar. O conserto do incidente depende do apply da migration do #2496, que
destrava com a v1.7, e depois do deploy da v1.8 dele.

## Verificação (depois do apply do #2496) — read-only, `psql-ro`

1. O próximo ciclo operacional fecha `complete` nos DOIS estágios. Atenção: `complete` com `error_message`
   = falha por pedido registrada, não sucesso limpo.

   ```sql
   SELECT created_at, entity_type, status, left(coalesce(error_message, ''), 160) AS erro,
          metadata->'falhas' AS falhas, metadata->'desconto_ilegivel' AS desconto_ilegivel
   FROM sync_reprocess_log
   WHERE account = 'oben' AND reprocess_type = 'operational' AND created_at > now() - interval '3 hours'
   ORDER BY created_at;
   ```

2. O 7b6f convergiu. Compare com o retrato de antes: a identidade `12180213789` com outro SKU confirma
   H1a; as identidades trocando de SKU entre si confirmam H1b.

   ```sql
   SELECT so.status, so.total, so.omie_reconciliado_em,
          string_agg(oi.omie_codigo_item || '>' || oi.omie_codigo_produto || ':' || oi.quantity || ':' || oi.unit_price,
                     ' ' ORDER BY oi.omie_codigo_item) AS linhas
   FROM sales_orders so JOIN order_items oi ON oi.sales_order_id = so.id
   WHERE so.id = '7b6f5f03-7cbf-4f13-9ed9-60126edb1d13'
   GROUP BY so.status, so.total, so.omie_reconciliado_em;
   ```

3. A verificação do #2469 na Oben: os pedidos com desconto convergem ao líquido e ficam após o ciclo
   seguinte, com `desconto_ilegivel` = 0. Hoje esse campo está **sem dado**: run em `error` não grava
   metadata. Baseline às 23:48:56Z: 415 pedidos Omie criados em 30 dias; **4 com desconto apurado, os 4
   com total BRUTO, 0 no líquido**; 357 com alguma linha de desconto não apurada.

   ```sql
   WITH ped AS (
     SELECT so.id, so.total,
            round(sum(oi.quantity * oi.unit_price), 2)                                 AS bruto,
            round(sum(oi.quantity * oi.unit_price - coalesce(oi.desconto_valor, 0)), 2) AS liquido_se_apurado,
            count(*) FILTER (WHERE oi.desconto_valor IS NULL) AS linhas_desc_null,
            count(*) FILTER (WHERE oi.desconto_valor > 0)     AS linhas_desc_pos,
            count(*) FILTER (WHERE oi.unit_price IS NULL)     AS linhas_sem_preco
     FROM sales_orders so JOIN order_items oi ON oi.sales_order_id = so.id
     WHERE so.account = 'oben' AND so.hash_payload LIKE 'omie\_%' AND so.created_at > now() - interval '30 days'
     GROUP BY so.id, so.total
   )
   SELECT count(*) AS pedidos_30d,
          count(*) FILTER (WHERE linhas_desc_pos > 0) AS com_desconto_apurado,
          count(*) FILTER (WHERE linhas_desc_pos > 0 AND linhas_desc_null = 0 AND linhas_sem_preco = 0
                                 AND abs(total - liquido_se_apurado) <= 0.01) AS com_desconto_total_liquido,
          count(*) FILTER (WHERE linhas_desc_pos > 0 AND abs(total - bruto) <= 0.01) AS com_desconto_total_bruto
   FROM ped;
   ```

## Segunda opinião

As duas sessões bateram em `COTA_ESGOTADA` do Codex: o token declara o plano `prolite`, e a janela
reabre em 2026-09-19 13:21. O #2496 carrega parecer de DESENHO e marca `REVISÃO INDEPENDENTE PENDENTE`
no código final. Caminho B no intervalo: a reprodução PG17 com os corpos de prod e a validação cruzada
entre as sessões, com cenários escritos independentemente. Auto-prova não substitui revisão
independente; o challenge retroativo continua devido.

## Armadilhas que morderam nesta sessão (instâncias de classes já documentadas)

- **`sed` de sabotagem sobre a migration INTEIRA** trocou também o marcador dentro da postcondição. Ela
  passou a procurar o texto sabotado e aprovou: falso verde. Sabotagem se ancora na linha do corpo.
- **`mktemp` do macOS com sufixo depois do `XXXXXX`** cria o nome literal, e a 2ª rodada colide.
- **`for …; do teste && { exit; }; done && mv …`** sai 1 quando o teste é falso, e o `&&` pula o `mv` sem
  aviso. O shell fabricou o veredito.
- **Helper que imprime "LANCOU" para qualquer erro** aprovaria o assert que espera lançar mesmo com erro
  de digitação no SQL do teste. O certo é casar a SQLSTATE.
