# Captura mensal de preços Sayerlack (embalagem econômica) + sensor de reajuste via pedido real

**Data:** 2026-07-14
**Status:** design aprovado no chat (cadência/sensor ajustados pelo founder) — aguardando revisão da spec → writing-plans
**Módulo:** reposição / portal Sayerlack / embalagem econômica (money-path)
**Herda de:** `2026-06-04-embalagem-economica-design.md` (§3.2, §4, §10 — a "Fase 2" aprovada em junho é esta entrega) e `2026-06-04-sayerlack-scraping-pedido-design.md` (scrape do `#datatable_itens`).
**Arquivos-alvo:** edge nova `supabase/functions/sayerlack-captura-precos/`, `supabase/functions/disparar-pedidos-aprovados/index.ts` (sensor), helper puro novo `src/lib/reposicao/embalagem-captura-helpers.ts`, `src/pages/AdminReposicaoEmbalagem.tsx` + `src/components/reposicao/embalagem/*`, migrations (run-log, CHECK de fonte, cron, check do vigia).

## Problema

Os preços dos concentrados WP (QT×GL) que alimentam a tela de Embalagem econômica **e o motor** (troca estrita QT→GL exige preço-app ≤45d) são digitados à mão pelo founder, consultando o portal Sayerlack. Dois buracos:

1. **Staleness estrutural** — o preço manual envelhece; o motor quase nunca troca de embalagem porque o gate de 45d está vencido; a tela exige redigitação a cada compra manual.
2. **Embalagem inativada é invisível** — embalagem sem giro é inativada no portal (some da busca). Hoje ninguém percebe até precisar do preço; o founder então pede reativação ao representante e espera. Sem sinal, a comparação QT×GL fica cega de um lado.

## Decisões do founder (2026-07-14, no chat)

- **Cadência MENSAL, ~dia 10** (não diária): o reajuste Sayerlack é mensal; capturar todo dia é desperdício.
- **Sensor de reajuste via pedido real:** se um pedido **efetivado** contém um item WP com preço divergente do vigente registrado, "provavelmente todos os preços dos WP se alteraram" → atualizar o item pelo dado do pedido e disparar recaptura geral fora da janela mensal.
- **Inativada → badge na tela + email diário** (check no vigia de saúde de dados; NÃO entra na fila "precisa de atenção" — lição do ruído da fila particionada).
- **Comparativo: tabela-resumo de todos os WP** no topo da tela (um WP por linha, R$/QT por embalagem, delta %, frescor, status), mantendo os cards de consulta por quantidade abaixo.
- **Credencial:** founder pede ao representante um usuário de cotação **sem poder de efetivar**; até chegar, roda-se com o usuário atual parando sempre antes do Efetivar.

## O que já existe (nada disso é novo)

- **Transporte:** edge `enviar-pedido-portal-sayerlack` roda Browserless v2 (`/function`, Puppeteer), login `/login` (`#user`/`#password`), secrets `SAYERLACK_PORTAL_USER/PASS/URL`, `SAYERLACK_PORTAL_CLIENTE_CODIGO`, `BROWSERLESS_TOKEN`. Rascunho não-efetivado é estado **seguro conhecido** (`efetivarAttempted=false` → retentável; portal auto-expira rascunhos — spec de junho §3.2, confirmado pelo founder).
- **Scrape:** a edge de envio já lê o `#datatable_itens` (custo + Prz Ent, matching por header) e devolve `data.itens_capturados[]` no envelope ao `disparar-pedidos-aprovados`. ⚠️ A "captura A" de junho (sobrescrever `preco_unitario` dos itens) **nunca foi ligada** — o envelope existe, ninguém consome os totais. O sensor desta spec é o primeiro consumidor.
- **Persistência:** `sku_preco_fornecedor_capturado` (append-only, leitura = mais recente por SKU) já aceita `fonte IN ('manual_usuario','portal_capturado_ok','portal_capturado_parcial')`, `status IN ('ok','stale','falhou')`, `run_id`, `preco>0` (CHECK). 14 grupos / 28 SKUs OBEN ativos em `sku_embalagem_equivalencia`.
- **Kill-switch:** `company_config.embalagem_captura_automatica_habilitada` já existe em prod (`false`) — liga/desliga sem deploy.
- **Helper puro testado:** `src/lib/reposicao/sayerlack-scraping-pedido.ts` (`casarLinhasComItens`, `derivarCustos`, `parseBRL`) — reusar parsing/casamento.
- **Consumo:** tela (`useEmbalagemConsulta`, stale 24h via `embalagem_preco_stale_horas`) e motor (`embalagem_preco_motor_stale_dias`, default 45, config ausente em prod).

## Arquitetura — fases-PR

### Fase 0 — Spike de viabilidade (gate obrigatório herdado de junho)

Run manual, **1 grupo WP** (QT+GL, qtde 1): login → novo pedido → cliente → adiciona os 2 itens → lê preço no `#datatable_itens` → **limpa o rascunho explicitamente** (remover itens/descartar; não confiar só no auto-expire) → screenshot/trace como evidência. **Nunca** toca `#btnSalvarNovoPedido`.

**Sucesso =** preço QT/GL inequívoco (por lata, não por litro/subtotal) **e** rascunho limpo **e** verificação de que **nenhum PO nasceu** (portal + `purchase_orders_tracking`/Omie no dia). **Se falhar → scraping sai do roadmap** (fica o manual) — critério que o founder aprovou em junho. Motivo do gate: incidente ~R$82k com pedidos órfãos/duplicados no portal.

Aproveitar o spike para: (a) verificar se o portal tem gestão de usuários/perfis (informa a Fase 3); (b) provocar uma busca por embalagem **inativada** conhecida e registrar o comportamento do select2 (resultado vazio esperado).

Implementação: edge descartável `sayerlack-captura-precos` já no shape final mas com `modo:'spike'` (1 grupo, staff-only, sem cron) — o spike vira a semente da Fase 1, não código jogado fora.

### Fase 1 — Edge de captura + cron mensal + run-log

**Edge `sayerlack-captura-precos`** (SEPARADA do envio; compartilha só o padrão de login — **não existe caminho de código que alcance o Efetivar**):

1. Gate `authorizeCronOrStaff` + kill-switch (`embalagem_captura_automatica_habilitada=false` → 200 `{ok:false, motivo:'desligada'}`).
2. Lê os grupos ativos de `sku_embalagem_equivalencia` (oben) + de-para `sku_fornecedor_externo` → lista de `sku_portal` (28 hoje).
3. Um rascunho único: adiciona cada embalagem com **qtde 1**; select2 sem resultado → marca `nao_encontrado` e **SEGUE** (≠ fluxo de pedido, que aborta em `SKU_NOT_FOUND`); lê `#datatable_itens` uma vez ao final; **cleanup explícito** do rascunho.
4. Persistência (service-role):
   - preço lido → INSERT em `sku_preco_fornecedor_capturado` com `run_id` (`fonte` reflete a qualidade da LEITURA daquela linha: `'portal_capturado_ok'` = inequívoca; `'portal_capturado_parcial'` = degradada, ex. parsing com aviso; a parcialidade do RUN — nem todo mundo coberto — vive no `status` do run-log, não na fonte da linha); `preco>0` preservado — **ausente ≠ zero: linha sem preço NÃO existe nesta tabela**;
   - resultado por embalagem → **run-log novo** `sku_preco_captura_run` (run: id, iniciado/terminado, disparo `cron|manual|reajuste`, status, evidência) + `sku_preco_captura_run_item` (sku, resultado `ok|nao_encontrado|falha`, preco, detalhe). É daqui que UI/vigia leem inativação — a tabela de preço nunca registra ausência.
5. Salvaguardas (herdadas da spec de junho §10): lock (1 run ativo — marcador/advisory), retry só antes de inserir o 1º item, orçamento de tempo com aborto limpo (padrão da edge de envio), circuit-breaker (falha pós-login → não re-tenta no dia), `efetivarAttempted` conceitual = sempre false.

**Cron mensal com auto-retry:** `0 9 10-12 * *` (06:00 BRT dias 10, 11 e 12) via `net.http_post` **com `timeout_milliseconds` explícito**; a edge sai cedo se já houve run `ok` no mês corrente (guard no run-log). Botão **"Atualizar do portal"** (staff) na tela dispara a mesma edge.

**Config:** subir `embalagem_preco_stale_horas` 24→**960** (40d) — com cadência mensal, 24h marcaria stale o mês inteiro (ruído). Motor: 45d default já acomoda o ciclo dia-10→dia-10; um mês inteiro perdido → gate do motor veta a troca (fail-safe desejado) e o vigia avisa antes (Fase 2).

### Fase 1.5 — Sensor de reajuste no pedido real

No `disparar-pedidos-aprovados`, **pós-sucesso do portal**, passo best-effort (try/catch total — **nunca** quebra/atrasa o disparo), primeiro consumidor de `data.itens_capturados`:

1. Casa itens do pedido com linhas capturadas (`casarLinhasComItens` já existente); `preco_pedido = total_linha / qtde_final`.
2. Para cada item que TEM preço vigente em `sku_preco_fornecedor_capturado`: divergência relativa > **0,5%** (tolerância de arredondamento no helper) → reajuste detectado.
3. Ação: INSERT do preço novo daquele(s) item(ns) com **`fonte='pedido_real'`** (migration estende o CHECK) + dispara a edge de captura (`disparo='reajuste'`, fire-and-forget) com **debounce** (marcador `sync_state.sayerlack_recaptura_reajuste`; mínimo 7d entre recapturas por reajuste).
4. Item sem preço vigente registrado (fora dos grupos de embalagem): ignora — o sensor cobre os WP, não o catálogo.

Racional do founder: preço divergente num pedido real ⇒ a tabela WP inteira provavelmente mudou ⇒ não esperar o dia 10.

### Fase 2 — UI comparativa + vigia

- **Tabela-resumo** no topo de `AdminReposicaoEmbalagem`: um grupo WP por linha — R$/embalagem e R$/QT de QT e GL, **delta %** (galão vs quartinho por unidade-base), frescor (`capturado_em`), badge de status por embalagem: `ok` · `desatualizado` · **`não encontrada no portal → pedir reativação ao representante`** (status vem do último run-item; preço exibido = último válido, marcado com a data). Cards de consulta por quantidade continuam abaixo.
- **Check novo no vigia** (`data_health`): `embalagem_portal_nao_encontrada` (algum run-item recente `nao_encontrado`) + `embalagem_captura_atrasada` (último run `ok` > 40d). Ambos entram no email diário existente. Migration seguindo o padrão `data_health_check_*` (conjunto acoplado `_data_health_compute` — ver `sync.md`).
- Badge de status também nos cards atuais (a consulta já expõe `preco_status`; soma-se o resultado do run-log).

### Fase 3 — Credencial de cotação

Quando o usuário de cotação chegar: secrets novos (`SAYERLACK_COTACAO_USER/PASS`), a edge de captura passa a usá-los (fallback documentado para o usuário principal se ausentes). Risco de efetivação acidental → ~zero por permissão, não só por código.

## Modelo de dados (delta)

- **Nova** `sku_preco_captura_run` / `sku_preco_captura_run_item` (RLS: SELECT staff; escrita só service-role — edge). Colunas mínimas; evidência (screenshot/trace) como URL/texto na run.
- **CHECK de `fonte`** em `sku_preco_fornecedor_capturado` ganha `'pedido_real'` (migration `ALTER ... DROP CONSTRAINT/ADD CONSTRAINT` — pré-flight da definição em prod antes, padrão `CREATE OR REPLACE`-like).
- **Config:** `embalagem_preco_stale_horas` 24→960 (UPDATE de valor, sem schema).
- Cron novo `sayerlack-captura-precos-mensal` (`0 9 10-12 * *`).

## Provas (rituais do repo)

- **Helper puro** `embalagem-captura-helpers.ts`: decisão de status por embalagem, guard `qtde/total>0`, detecção de reajuste (tolerância 0,5%), decisão de debounce — vitest, espelho **verbatim** na edge (paridade byte-a-byte testada, padrão cost-ladder).
- **PG17 falsificado** (`prove-sql-money-path`) nas migrations: run-log + RLS (SET ROLE), CHECK novo de fonte (INSERT `pedido_real` passa; fonte inválida = SQLSTATE 23514), guard do cron mensal.
- **Codex challenge** no código do sensor + edge de captura antes do merge (money-path) — conduzido pelo Claude via `scripts/codex-async.sh`.
- **Deploy:** 3 camadas manuais Lovable (edge pelo chat, migrations no SQL Editor, Publish) — checklist via `lovable-deploy-verify` no fecho de cada fase.

## Efeito money-path declarado (aprovado de olhos abertos)

Com preço fresco (mensal + sensor), a **troca automática QT→GL do motor** — hoje quase sempre vetada por staleness — passa a operar de verdade: sugestões de compra podem trocar quartinho por galão quando o galão for mais barato por unidade-base (gate estrito existente: preço fresco + portal-map + catálogo OK). Mesma classe de efeito do auto-cadastro de pares (§reposicao.md (3)).

## Não-objetivos

- **Captura A completa de junho** (sobrescrever `preco_unitario`/`valor_linha` dos itens do pedido p/ o Omie sair com custo do portal) — continua válida como entrega separada; aqui os totais capturados só alimentam o sensor.
- Scraping de outros SKUs Sayerlack fora dos grupos de embalagem (extensível depois; YAGNI agora).
- Comparação com NF-e (3-way) e refino de impostos/frete condicionais (`preco_tipo` documenta o que o número representa).
- Histórico/moving average de preços na UI (a tabela é append-only; análise fica para quando houver série).

## Critérios de pronto

- **Fase 0:** evidência do spike com os 3 critérios (preço inequívoco, rascunho limpo, zero PO) OU decisão registrada de abortar o scraping.
- **Fase 1:** run mensal grava 28 preços `portal_capturado_ok` (ou `parcial` + run-items explicando), embalagem inativada aparece como `nao_encontrado` sem derrubar o run, kill-switch desliga sem deploy, cron dia 10 com auto-retry 11/12 e saída-cedo idempotente.
- **Fase 1.5:** pedido efetivado com preço divergente >0,5% gera INSERT `pedido_real` + recaptura com debounce; pedido com preço igual não gera nada; falha do sensor não afeta o disparo (prova: sabotar o sensor e o disparo segue).
- **Fase 2:** tabela-resumo com delta % e badges; email do vigia acusa `nao_encontrado` e captura atrasada.
