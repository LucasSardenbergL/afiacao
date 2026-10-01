# Gêmeos push/pull de `sales_orders` — contagem única na fonte

> Money-path (positivação/receita). Medido na prod via `psql-ro` em 2026-09-30.
> Decisões do founder na sessão de 2026-09-30/10-01. Antecedente:
> [positivacao-universo-canonico.md](../../historico/positivacao-universo-canonico.md) e o bullet
> "`sales_orders` tem GÊMEOS push/pull" de [database.md](../../agent/database.md) §5.

## 1. O problema

O pedido que o app empurra ao Omie é uma linha de `sales_orders` (`hash_payload` nulo, `omie_payload`
preenchido, status congelado em `'enviado'`). O importador (`omie-vendas-sync` → RPC
`criar_pedidos_com_itens`) traz o MESMO pedido como OUTRA linha (`hash_payload =
'omie_'||account||'_'||omie_pedido_id`, `order_date_kpi` = dInc do Omie). O importador e a
reconciliação casam só por `hash_payload`, então nunca enxergam a linha do app. Os gêmeos foram
desenho deliberado (`20260613120000_onda1_fase0_sales_orders_identidade.sql:17-27`: "re-unificar
push×pull … é trabalho de uma fase futura").

Hoje nenhum escritor do app grava `order_date_kpi`, e é esse kpi NULO que, por acidente, deduplica
os consumidores que datam só pelo kpi. O founder quer que o app passe a gravar o kpi (a venda
aparece na hora, sem esperar o import de ~2 h) — e isso reintroduziria a duplicata no ao vivo e
no congelado. Esta entrega é a dedup que torna o próximo passo seguro.

## 2. Medição (prod, 2026-09-30)

| | valor |
|---|---|
| pares `(account, omie_pedido_id)` com 2 linhas | **25** (50 linhas; máx 2 por chave) |
| linhas empurradas pelo app | 26 — **1 sem gêmeo** (`4c19af2a`, abr, R$ 314,40) |
| pares com kpi nas 2 linhas | **22** (06–22/abr; kpi do app veio do backfill de 25/05) |
| pares com kpi só na importada | 3 (jun ×2, ago ×1) |
| importadas sem kpi / sem pid | **0 / 0** (de 31.646) |
| linhas com `hash_payload` nulo | 28 (26 empurradas + 1 `orcamento` + 1 `rascunho`), **0** com `order_items` |

Soma contada em dobro:

| critério de data | abr | jun | ago |
|---|---|---|---|
| só `order_date_kpi` (universo canônico) | **R$ 12.840,46** (22 pares) | — | — |
| `COALESCE(kpi, created_at)` | R$ 12.840,46 | R$ 579,10 | R$ 767,00 |

**Efeito de tirar a linha do app que tem gêmeo, no canônico:** só abril muda — 14 cliente-mês,
−R$ 12.840,46; **0** clientes perdem positivação; **0** de 1.229 mudam a data da 1ª compra.

## 3. Correções de premissa (o retrato de 27/09 estava errado em quatro pontos)

1. **3 dos 25 pares não são a mesma venda.** ART MÓVEIS faturou R$ 527,20 no Omie como #10518; o
   app reenviou 2× (10:49/10:55 → #10520/#10521) e esses pedidos foram **reaproveitados no Omie**
   para FRANCCINO (R$ 600) e NILSON (R$ 560); idem LOHAN R$ 540 → JOSÉ AUGUSTO R$ 1.200. A ART
   conta essa venda 3× em abril. ⇒ depois do push a linha do app não é confiável nem no cliente:
   **a importada é a autoridade**. Totais divergem em 8 dos 25 pares.
2. **O congelado de abril NÃO está duplicado — está incompleto.** `carteira_positivacao_snapshot`
   de abril (gravado 25/05) tem exatamente os 15 clientes / R$ 13.154,86 das 23 linhas do app de
   abril; as importadas de abril vieram depois. Ao vivo: 167 clientes / R$ 509 mil. Maio também
   incompleto (104 × 186); jun quase bate; jul/ago batem.
3. **Margem/apriori/régua de preço não duplicam.** Passam por `order_items`, e a linha do app nunca
   tem `order_items` (0 de 28). A duplicata só existe em quem lê `sales_orders` direto: 16
   consumidores, dos quais **4 são só-kpi** (hero de positivação, loader do congelado, MTD por
   vendedor, vendas do dia) e **12** datam por `created_at`/`COALESCE` — esses contam a linha do
   app hoje e continuarão contando (fora do escopo; ver §9).
4. **Os gêmeos custam mais que receita** (fora do escopo, fase 2): o feed (`order_feed`) mostra as
   2 linhas; `listar_pedidos_a_separar` aceita qualquer uma das 2; editar pela linha do app deixa a
   importada velha até a reconciliação; editar pela importada perde vendedor/transportadora
   (`omie_payload` nulo).

## 4. Decisões (founder)

| # | decisão | escolha |
|---|---|---|
| D1 | alcance | **contagem única agora** (fase 2 = uma linha por venda, depois) |
| D2 | congelados de abr/mai | **manter como registro** — recongelar usaria a carteira de HOJE (`carregarCarteiraComElegibilidade(db)` não recebe mês) e nenhum leitor vivo os lê (a UTI lê os últimos 3 meses) |
| D3 | 2ª opinião | cota do Codex em 86% até 03/10 19:11 → **Caminho B no desenho + PR em DRAFT**; 1 Codex adversarial no diff (com a RÉGUA) quando a janela reabrir, e só então o apply |
| D4 | aplicação | **a sessão aplica** via `bun run db:aplicar` (envelope) e valida por `psql-ro` |

## 5. Desenho

**Princípio.** A importada é a venda. A linha do app continua existindo — recibo de envio: vendedor,
checkout, atendimento, WhatsApp, reserva, edição pelo id dela —, mas quando a importada do mesmo
`(account, omie_pedido_id)` existe ela sai do universo canônico perdendo o `order_date_kpi`.

### 5.1 Modelo e trava (vale para qualquer escritor)

- Coluna `sales_orders.gemeo_importado_id uuid REFERENCES sales_orders(id) ON DELETE SET NULL`:
  só na linha do app, apontando para a importada do mesmo pedido. **Derivada** — único escritor é
  o trigger da §5.2(1); qualquer valor escrito por fora é recalculado.
- Índice de apoio `idx_sales_orders_app_pedido_omie (account, omie_pedido_id) WHERE hash_payload IS
  NULL AND omie_pedido_id IS NOT NULL` (os UPDATEs dos triggers da importada não varrem a tabela).
- **Trava estrutural:** `uniq_sales_orders_kpi_por_pedido_omie UNIQUE (account, omie_pedido_id)
  WHERE omie_pedido_id IS NOT NULL AND order_date_kpi IS NOT NULL` — duas linhas do mesmo pedido
  Omie com kpi é impossível; a escrita que tentar falha com 23505 em vez de duplicar.
- CHECK `sales_orders_gemeo_e_recibo`: `gemeo_importado_id IS NULL OR (hash_payload IS NULL AND
  order_date_kpi IS NULL AND gemeo_importado_id <> id)`.

### 5.2 Triggers (`SECURITY DEFINER`, `SET search_path = public`; `EXECUTE` revogado de PUBLIC/anon/authenticated)

1. `trg_sales_orders_gemeo_app` — `BEFORE INSERT OR UPDATE OF omie_pedido_id, account,
   hash_payload, order_date_kpi, gemeo_importado_id … WHEN (NEW.hash_payload IS NULL)`: sem pid →
   ponteiro nulo; com pid → advisory lock da chave `(account, pid)`, procura a importada pelo hash
   canônico; achou → ponteiro := ela e kpi := NULL; não achou → ponteiro nulo (kpi intocado).
2. `trg_sales_orders_gemeo_importada_antes` — `BEFORE INSERT … WHEN (NEW.hash_payload LIKE
   'omie\_%')`: mesmo advisory lock; tira o kpi das linhas do app do mesmo pedido. Tem de ser
   BEFORE: o índice único é imediato e barraria a inserção. Dispara também quando o `INSERT … ON
   CONFLICT DO NOTHING` acaba não inserindo — coerente, porque a importada já existe.
3. `trg_sales_orders_gemeo_importada_depois` — `AFTER INSERT … WHEN (NEW.hash_payload LIKE
   'omie\_%')`: grava o ponteiro nas linhas do app (a FK exige a importada já inserida).

**Não muda:** o corpo de `criar_pedidos_com_itens` (o efeito vem pelo trigger), a reconciliação, a
edição (`aplicar_edicao_pedido_omie` não escreve nas colunas observadas), o feed e a separação.

**Corrida push × import** (só morde depois que o app gravar kpi): o write-back e o importador
pegam o mesmo advisory lock por `(account, pid)` e serializam; quem chega depois vê o commit do
outro. O que escapar cai no índice único: o importador captura por pedido (`EXCEPTION WHEN OTHERS`,
G8, com SQLSTATE no log) e o pedido volta na rodada seguinte.

**Deadlock residual (medido no spike, S9):** se o kpi for gravado num UPDATE POSTERIOR numa linha do
app que JÁ tem pid, concorrendo com a importação do mesmo pedido, a ordem de lock se inverte (tupla →
advisory × advisory → tupla) e o PG aborta um com 40P01. No spike a vítima foi o importador: rollback,
nenhuma duplicata, cura na próxima rodada. **Regra para o PR do kpi:** gravar o kpi no INSERT ou no
MESMO UPDATE do write-back que seta o pid — nunca num UPDATE depois.

### 5.3 Backlog, ordem e postcondição

Uma migration, sem `BEGIN/COMMIT` (o `db:aplicar` fornece a transação), idempotente:
coluna → índice de apoio → funções → triggers → backfill → índice único → CHECK → postcondição.

Backfill: `UPDATE` das linhas do app que têm importada: ponteiro := importada, kpi := NULL (25
ponteiros; 22 kpi zerados — os 3 recentes já eram nulos). Inclui os 3 pares reaproveitados. A venda
sem gêmeo fica como está.

Postcondição (`DO $post$ … RAISE EXCEPTION`): 0 pedidos `(account, pid)` com 2 linhas com kpi;
ponteiro ⇔ existe importada do mesmo pedido (nas linhas do app com pid); 0 linhas do app com
ponteiro e kpi; os 3 triggers, o índice único e o CHECK existem.

**Reversão:** o "antes" dos 22 kpi (id, data) fica registrado no histórico da entrega; desfazer =
founder no SQL Editor (DROP dos triggers/índice/CHECK/coluna + `UPDATE` dos 22 kpi).

### 5.4 Validação externa (2ª testemunha, `psql-ro`, depois do commit)

A mesma comparação cliente-mês da §2, agora contra a prod: canônico −R$ 12.840,46 em abril (14
cliente-mês) e **nada** em outro mês; positivados e "1ª compra" inalterados; 25 ponteiros; congelado
intocado (soma de `revenue_month` por mês idêntica à de antes).

## 6. Prova (`prove-sql-money-path`)

`db/test-gemeos-push-pull-contagem-unica.sh`, PG17 descartável via `db/lib/pg-harness.sh`, aplicando a
**migration real** e a **RPC real** `criar_pedidos_com_itens` (última migration que a define), com o
trigger de coerência da prod. Cenários:

- backlog: par idêntico; par reaproveitado (cliente diferente); par recente (kpi só na importada);
  app sem gêmeo; `orcamento`/`rascunho` sem pid → ponteiros e kpi conforme §5.3;
- import depois do push **com kpi no app** (o cenário do PR seguinte) via RPC real;
- push depois do import (write-back seta pid);
- reimport (`ON CONFLICT DO NOTHING`) idempotente; DELETE da importada → ponteiro nulo; reimport refaz;
- escrita direta de kpi em app marcada → trigger força NULL; sem o trigger, 2 kpi → **23505**;
- a RPC real sob o índice: pedido que bateria no índice é registrado pela G8 e não derruba o lote;
- invariante final: 0 `(account, pid)` com 2 kpi.

Falsificação camada por camada, com controle verde na MESMA invocação, cada sabotagem declarando o
assert que a acusa: sem trigger 1 → push-depois-do-import; sem trigger 2 → import com kpi no app
falha (G8/23505); sem trigger 3 → ponteiro ausente; sem índice → invariante estrutural; sem backfill
→ backlog. Rodada em `LC_ALL=C` e `pt_BR.UTF-8`.

## 7. Caminho B — auto-revisão adversária (REVISÃO INDEPENDENTE PENDENTE)

O Codex não foi consultado no desenho (exit 79, `SALDO_ALTO` 86%). Esta seção é a validação
própria, com o que foi EXECUTADO num PG17 descartável (spike, fora do repo) — não substitui a
revisão independente, que roda no diff quando a janela reabrir.

**RÉGUA:**
- *Unidade decisória:* a VENDA = pedido Omie `(account, omie_pedido_id)`; valor = `total` da
  importada (o que o Omie fatura); data = `order_date_kpi`. Alimenta positivação por farmer/mês (ao
  vivo e congelado), receita MTD por vendedor, vendas do dia.
- *Onde o sistema a expõe:* `get_minha_positivacao` → `_carteira_positivacao_for_owner`;
  `carteira_positivacao_snapshot` (edge mensal); `fetch-pedidos-mtd` → `useTeamRanking`; `useVendasZone`.
- *Denominador:* 31.674 linhas; 26 empurradas; 25 pares; 22 com kpi nos 2 lados; 3 de cliente
  divergente; 1 sem gêmeo; 16 consumidores diretos (4 só-kpi).
- *Como a prova falsifica:* §6 — cada camada sabotada sozinha avermelha o assert que declara.
- *Ordem irreversível:* migration (DDL + backfill de 25 linhas) numa transação com postcondição →
  validação externa → só então o PR do kpi. Nenhum DELETE; congelados não recalculados.

**Premissas atacadas e o que as sustenta:**

| premissa | evidência |
|---|---|
| a importada sempre tem kpi (senão a venda sumiria do canônico) | 0 de 31.646 sem kpi ou pid (prod) |
| BEFORE INSERT dispara em `INSERT … ON CONFLICT DO NOTHING` e pode alterar OUTRA linha | spike S1/S2: insere e marca; no conflito, nada quebra e o estado fica coerente |
| FK auto-referente `SET NULL` convive com o BEFORE UPDATE do ponteiro | spike S4: delete ok, ponteiro nulo, reimport refaz |
| o índice é trava de verdade, não decoração | spike S6: sem o trigger, 23505 |
| a corrida serializa nos dois sentidos | spike S7/S8: o lado que chega depois espera o lock e vê o commit |
| deadlock | spike S9: possível só com kpi gravado DEPOIS do pid; 40P01, sem duplicata (vira regra do PR do kpi) |
| marcar por `(account, pid)` acerta os 3 pares de cliente divergente | o Omie diz que aquele pid é outra venda; a venda real da ART existe como #10518 e segue contada |
| o gate de authz não exige cadastro das funções novas | `SENSITIVE_TABLES/COLUMNS` (`scripts/lib/authz-contract.ts:58-80`) não cobrem `sales_orders` nem as colunas tocadas |
| nenhum consumidor perde venda legítima | §2: 0 positivação, 0 "1ª compra"; só some o que é duplicata |

**Riscos aceitos:** os 12 consumidores por `created_at`/`COALESCE` seguem contando a linha do app (o
estado de hoje; §9); a ordem de listas por kpi muda para as 22 linhas de abril (cosmético); 25
`updated_at` avançam no backfill.

## 8. O que o PR do kpi do app ainda precisa resolver

1. Gravar o kpi no INSERT ou no MESMO UPDATE do write-back (regra do deadlock, §5.2) — valor = data
   de SP do instante da venda (`(created_at AT TIME ZONE 'America/Sao_Paulo')::date`), nunca UTC
   (o backfill de 25/05 errou 2 datas por isso).
2. Atribuição do ranking: `useTeamRanking` credita por `created_by`, e as importadas têm
   `created_by` de uma farmer (29.783) ou do master (1.863) — com kpi no app a venda apareceria para
   o vendedor e "migraria" quando a importada chegasse.
3. `SalesQuotes.tsx:198-201` regrava `'rascunho'` por cima do `'enviado'` depois do push.
4. Alternativa a avaliar: o próprio trigger da §5.2(1) derivar o kpi da linha do app sem gêmeo
   (status `'enviado'`), tirando os escritores TS do caminho.

## 9. Fora do escopo

- Fase 2 — uma linha por venda (o importador adota a linha do app): resolve feed, separação e edição.
- Erradicação dos 12 consumidores por `created_at`/`COALESCE` (chip existente) — depois do PR do kpi
  toda linha viva terá kpi, e "só kpi" deixa de perder venda.
- Sensor da venda empurrada que nunca voltou (chip existente) — inclui `4c19af2a`.
- Congelados de abr/mai incompletos — registrados, não recalculados (D2).

## 10. Pronto quando

- [ ] migration + prova (verde, falsificada nos 2 locales) + docs no PR **DRAFT**;
- [ ] Codex adversarial no diff (após 03/10 19:11), achados tratados;
- [ ] apply via `db:aplicar` com postcondição verde;
- [ ] validação externa `psql-ro` = §5.4;
- [ ] histórico (`docs/historico/`) com o "antes" dos 22 kpi e o bullet do `database.md` §5 atualizado.

Camadas de deploy: **só migration** (nenhuma edge, nenhum Publish). Quem aplica: a sessão (D4).
