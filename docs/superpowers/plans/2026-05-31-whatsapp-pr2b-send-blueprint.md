# PR2b-send — Blueprint do disparo real (wire-up das peças prontas)

**Data:** 2026-05-31
**Status:** blueprint (executável no "phone-day", quando o 360dialog estiver onboardado)
**Depende de:** spec `2026-05-28-whatsapp-pr2-rota-disparo-design.md` + as peças abaixo, TODAS já em produção.

> Propósito: na véspera de cada rota, disparar a proposta **accept-a-proposal** (cesta de recompra pronta) no WhatsApp pros clientes opt-in das cidades de amanhã, respeitando pacing/janela/teto Meta, com **preço firme do Omie** e **gate humano** na negociação. Este doc é o **mapa do wire-up** — não há engine nova a inventar, só compor.

## 1. Peças PRONTAS (em produção) que o PR2b-send compõe

| Peça | Onde | Papel no disparo |
| --- | --- | --- |
| Inbox + webhook | `whatsapp-inbound`/`whatsapp-send`, tabelas `whatsapp_*` (#479) | recebe/persiste; envia texto livre; janela 24h |
| Opt-in/STOP | `nextOptInStatus` no inbound (#513) | só dispara pra `opt_in` (e `unknown` 1º toque); respeita PARAR |
| Lista por rota | `useRouteContactList` + `buildContactList` (#505/#518) | **`whatsappQueue`** = quem a IA contata (dedup vs ligação, ordenado por valor) |
| Pacing | `selectDisparoBatch` (#513) | janela 07:30–15:30 + teto do tier Meta + desconta já-enviado |
| Cesta | `montarCestaRecompra` (#523) | o CONTEÚDO: cesta principal (due/freq, cap 8) + secundários |
| Config | tabela `route_disparo_config` (#505) | `disparo_inicio/corte`, `meta_tier_cap`, reservas |
| Log | tabela `route_contact_log` (#505) | idempotência + métricas do piloto (PR2c) |

## 2. Fluxo do orquestrador (phone-day)

```
cron D-1 de manhã (após disparo_inicio) →
  para cada cliente da whatsappQueue (useRouteContactList das cidades de amanhã):
    1. busca histórico de pedidos (order_items × sales_orders.order_date_kpi, status whitelist, account)
    2. montarCestaRecompra(historico, opts)  → principal[] + secundarios[]
    3. enriquece nomes dos SKU (omie_products) + VALIDA NO OMIE: SKU ativo + preço firme (+ estoque?)
       → descarta SKU morto/sem-preço (helper só emite candidato; a verdade de disponibilidade é aqui)
    4. selectDisparoBatch(fila, config, agora)  → respeita janela/cap/opt-out; pausa fora da janela
    5. formata a mensagem (cesta → texto, ver §3) e ENVIA via template Meta aprovado (whatsapp-send)
    6. grava route_contact_log (canal='whatsapp', valor, bucket, status='enviado', cesta proposta)
  resposta do cliente (inbound) → atendimento: aceitou → cria pedido (preço firme Omie);
    quer negociar/preço → sobe pra callQueue (GATE HUMANO no preço, regra do v1)
```

**Idempotência:** `route_contact_log` (data_rota, customer_user_id, canal) evita disparo duplo no mesmo dia/rota.

## 2b. ⛔ GATE DE ENVIO — revalidação no último segundo (codex, launch-readiness, P1)

> O preview gera a proposta de **dados sincronizados** (que podem estar velhos no momento do disparo). **Antes de CADA envio**, o edge `route-disparo` DEVE revalidar — **se qualquer item falhar, NÃO envia** (melhor perder um envio do que mandar proposta errada / queimar confiança):

1. **opt-in vigente** — `whatsapp_conversations.opt_in_status != 'opt_out'` (re-leitura; opt-out pode ter chegado depois da geração).
2. **cliente ainda elegível** na rota — `customer_user_id` ainda na `whatsappQueue` da rota de **amanhã** (re-resolver D-1 na hora; rota/feriado/cidade podem ter mudado).
3. **não comprou desde a geração** — sem pedido novo do cliente entre a geração e o disparo (senão a cesta está obsoleta / vira spam).
4. **SKU ainda ativo** — re-check `omie_products.ativo` (item pode ter sido descontinuado).
5. **preço firme disponível** — preço atual do Omie existe pra TODO item da cesta; sem preço → tira o item (ou não envia se esvaziar). **Preço vem do Omie no envio — nunca do preview.**
6. **status/janela** — janela 24h / `disparo_inicio`–`disparo_corte` ainda válidos; teto do tier Meta não estourado (`selectDisparoBatch` no momento do envio, não na geração).

**Regra de ouro:** a proposta do preview é **rascunho**; a verdade é revalidada no envio. Tudo o que falhar → pula o cliente e loga o motivo em `route_contact_log` (status='pulado_revalidacao', motivo).

## 3. O que falta CODAR no phone-day (rápido, sobre o que já existe)

- **Edge `route-disparo`** (ou estende `whatsapp-send`): o orquestrador §2. Espelha `selectDisparoBatch` (já testado) inline (Deno).
- **`formatarPropostaRecompra(cesta, nomesPorSku, opts)`** (helper puro, TDD): cesta → texto pt-BR (greeting + "você costuma comprar:" + lista com qty + CTA + "também costuma levar" secundário). **Produz a variável do template Meta** (ex.: `{{2}}` = lista). ⚠️ a COPY/brand-voice é decisão do founder (ver §4).
- **Hook/query de histórico** do cliente (order_items × sales_orders) — leitura paginada, account-scoped.
- **Cron** D-1 manhã (`net.http_post` do `route-disparo` com `timeout_milliseconds` explícito — lição §5 do CLAUDE.md).

## 4. Lição de casa do founder (GATED — destrava o phone-day)

1. **Conta 360dialog + número** + secrets `D360_API_KEY`/`D360_BASE_URL` no Lovable.
2. **Templates Meta aprovados** (submeter na 360dialog): accept-a-proposal (recompra) + boas-vindas (cold-start). Definem a estrutura de variáveis que o formatter preenche.
3. **Copy da proposta** (brand-voice Colacor) — o founder é dono das palavras; o formatter dá a estrutura, o founder ajusta o texto.
4. **Omie**: qual endpoint/campo valida **SKU ativo + preço firme** (+ estoque?) no envio — pra descartar SKU morto antes de propor (codex P1).
5. **Whitelist real de status** de `sales_orders.status` (vocabulário Omie) pra alimentar `montarCestaRecompra`.
6. **Redeploy do `whatsapp-inbound`** (opt-in do #513) + limpar dado de teste do smoke (`DELETE … phone_e164='5599999999999'`).

## 5. Não-objetivos / depois
- **PR2c**: dashboard do piloto 2–4 sem (conversão por canal/faixa, lucro/min, "perdeu o caminhão") sobre `route_contact_log` → decisão **automatizar mais vs contratar**.
- Cross-sell na proposta (camada extra de +ticket), devolução, sazonal 365d, capacidade-por-tempo, cadência-por-janela-de-rota (codex §6.5 adiados) — pós-piloto.
- PR3: IA de orçamento conversacional (extrai pedido de texto livre) — programa separado.
