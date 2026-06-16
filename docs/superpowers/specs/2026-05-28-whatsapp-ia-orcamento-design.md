# WhatsApp + IA — Disparo por rota & copiloto de orçamento (v1)

> Spec de design. Brainstorming conduzido em 2026-05-28 (Lucas + Claude + consult adversarial do Codex).
> Idioma: pt-BR. Caminho da fonte de verdade do schema: `supabase/schema-snapshot.sql`.

## 1. Contexto e objetivo

A Colacor vende em **rotas**: o caminhão entrega em clusters de cidades (ex.: Formiga, Pimenta, Piumhi, Capitólio/MG) em dias agendados. Antes de cada rota, o ideal seria **tocar todos os clientes daquelas cidades** pra puxar recompra. Hoje só **2 vendedoras** fazem isso por telefone, priorizadas pelo score existente — e a capacidade de telefone (~120 clientes/dia somando as duas) **não cobre nem uma rota** no dia anterior (uma rota de 4 cidades tem ~183 clientes ativos, 174 com telefone).

**Objetivo do projeto:** adicionar o WhatsApp como canal pra (a) **disparar um toque de abertura** pra todos os clientes (que valem) das cidades da rota de amanhã e (b) quando o cliente responde, a **IA lê a conversa, extrai os itens, precifica e monta um rascunho de orçamento** que a vendedora dona aprova e envia com **1 toque**.

**Divisão de trabalho que o produto materializa:**
- **WhatsApp = largura** (toca todos os clientes que valem, em escala, barato).
- **Ligação = profundidade** (a vendedora liga, na ordem do score, nos melhores e em quem respondeu).
- **IA = a ponte** (transforma a resposta informal num rascunho de orçamento pronto pra aprovar).

**Postura explícita (atualizada 2026-05-28):** a IA é **autônoma na conversa** (1º contato, qualificação, cross-sell/upsell dos engines) — o humano é **copiloto no DINHEIRO**: aprova só o orçamento (preço firme) antes de ir, e o subset seguro gradua pra autônomo. Bot de **tarefa estreita** (orçamento/pedido), nunca assistente genérico.

## 2. Decisões travadas (com o founder)

1. **Número central único** da empresa na **WhatsApp Cloud API oficial** (não os números pessoais das vendedoras). Conectividade via **BSP 360dialog** (mensalidade fixa, sem markup por mensagem; tira a dor de setup/cobrança/suporte).
2. **Automação = autônoma na conversa, gate humano só no DINHEIRO.** A IA faz o 1º contato, conversa, qualifica e sugere cross-sell/upsell sozinha (tarefa estreita). O humano (vendedora) aprova **só o ORÇAMENTO (preço firme)** antes de ir pro cliente — rápido, em lote. **One-tap só quando TODA linha tem SKU + quantidade + unidade + empresa fiscal + preço determinístico.** Gradua o **subset seguro** (repor o de sempre a preço de tabela) pra 100% autônomo quando a taxa de correção provar baixa. Cross-sell/upsell vêm dos **engines existentes** (cross-sell, bundles, próxima-melhor-ação) — a LLM só fraseia, não inventa recomendação.
3. **Inbox dentro do nosso OS**, porém **enxuta** (não BSP-grade): lista de threads, mensagens, atribuição, enviar texto/template, card de rascunho de orçamento, status de entrega/erro, fallback manual.
4. **v1 = orçamento de PRODUTO só, entrada texto + ÁUDIO.** Áudio do cliente é transcrito (ElevenLabs, já no stack) e cai no mesmo pipeline. Mensagem de serviço de afiação é classificada e **roteada pro humano** (IA de serviço entra na fase 3). **Imagem** entra depois (embalagem/código de barras primeiro — caso confiável; manuscrito por último).
5. **Empresa fiscal (qual dos 3 CNPJs fatura) resolve sozinha** pelo mapeamento produto→`account` que o fluxo de pedido já faz.
6. **Roteamento por atribuição OPERACIONAL** (quem de fato atende a rota/carteira), **separada da posse comercial/legal** (`carteira_assignments`). O founder é supervisor/fallback, não o destino padrão (ver §7 — risco P1).
7. **Disparo de saída gated por opt-in + ramp escalonado** (ver §8). Toque de abertura é **template `marketing` (~R$0,33)** — não `utility` — confirmado na fonte da Meta.
8. **A IA NUNCA é autoridade de preço nem inventa SKU.** Pipeline em estágios; preço sempre do serviço determinístico (Omie). Linha sem preço/sem match → **travada**, não enviável (§6).
9. **Observabilidade de falha é escopo de v1**, não enfeite (§9) — reaproveita o padrão do Sentinela de Saúde de Dados.
10. **Ordenamento = "IA abre todos; humano priorizado NA RESPOSTA" (Opção D, eu+codex 2026-05-28).** Não há tier estático de "humano-primeiro" por score. A IA faz o 1º contato em **todos** os clientes qualificados da rota; quando respondem, uma **fila dinâmica de prioridade** sobe pro topo da vendedora as conversas onde a mão humana muda dinheiro (ver §7). O score é **um** insumo, não a regra inteira.
11. **Transparência (sem impersonação).** A IA fala **como a Colacor** (tom caloroso/pessoal, usa histórico), aprende o **tom** do vendedor/cliente, mas **não finge ser uma pessoa específica nem nega ser automatizada** se perguntada. Posição prudente sob LGPD (Portaria ANPD 5/2024) e política da Meta; e protege a confiança B2B de longo prazo.

## 3. Restrições duras

- **Só API oficial.** Não dá pra ler o WhatsApp pessoal "como está" (scraping/lib não-oficial = risco de ban + ToS). O número central na Cloud API **sai do app WhatsApp comum**.
- **Regra Meta jan/2026:** bots de IA genéricos foram banidos; **bots de tarefa específica (orçamento/pedido/atendimento) seguem liberados** — nosso caso está no lado permitido. Não expor assistente de domínio aberto.
- **Pricing Meta (Brasil):** recebida do cliente e resposta livre dentro da **janela de 24h = grátis**; **template `marketing` ≈ R$0,33**, `utility` ≈ R$0,04 (mas reorder prompt = marketing). Custo de abertura é o único custo de mensageria relevante.
- **Qualidade do número:** a Meta dá nota de qualidade; disparo frio que vira bloqueio/denúncia **estrangula ou bane** o número. Ramp obrigatório.
- **LGPD:** mandar conteúdo de conversa pra LLM nos EUA é **transferência internacional** (consentimento + DPA + idealmente retenção-zero). **Opt-in obrigatório** pra disparo de saída.

## 4. Arquitetura v1

```
Cliente (WhatsApp)
     ⇅
WhatsApp Cloud API · número ÚNICO da empresa
     ⇅  (via 360dialog — só conectividade)
[edge] whatsapp-inbound
   - verifica assinatura do webhook (Meta/BSP)
   - dedup por message id
   - grava cru em whatsapp_webhook_events  → responde 2xx rápido
   - normaliza em whatsapp_conversations / whatsapp_messages
     ↓
Supabase Realtime ───────────────→  Inbox enxuta no OS (tela da vendedora)
     ↓ (mensagem nova do cliente, produto)
[edge] whatsapp-quote-draft  (pipeline em estágios — §6)
   normaliza → LLM extrai itens crus → candidatos (pg_trgm+histórico+apelidos)
   → ranqueia determinístico + LLM rerank → PREÇO determinístico (Omie)
   → portões de confiança → grava rascunho (com per-line confidence)
     ↓
Card "Rascunho de orçamento" na inbox → vendedora edita/confirma
     ↓  (1 toque — só se todas as linhas OK)
submitQuote (sales_orders status='orcamento')  +  envia msg pro cliente
     ↓  (se virar pedido)
submitOrder → omie-vendas-sync → PV no Omie (split por empresa automático)

[cron] whatsapp-route-outbound (motor de disparo por rota — §8)
   lê cidades da rota de amanhã → seleciona clientes opted_in + ativos + score
   → envia template de abertura (marketing) → resposta abre janela de 24h grátis
```

**Princípio de isolamento:** cada peça tem uma responsabilidade só e interface clara — `whatsapp-inbound` (ingestão), `whatsapp-quote-draft` (extração→rascunho), `whatsapp-route-outbound` (disparo), e a inbox (UI). Nenhuma delas é autoridade de preço; preço é do serviço de precificação existente.

### Caminhos de sombra (não-happy) que o v1 precisa tratar
- **Inbound sem cliente conhecido** (telefone não casa): cria conversa "não identificada", pede CNPJ/CPF, não tenta orçar; cai pro humano/fallback.
- **Webhook duplicado/reentregue:** dedup por `message_id` (idempotente).
- **LLM indisponível/timeout:** conversa fica na inbox **sem rascunho** (vendedora atende na mão); registra falha (§9).
- **Preço falha/inexistente:** linha travada com motivo; orçamento não fica one-tap.
- **Omie sync falha no envio do pedido:** status visível + retry + dead-letter + alerta (§9). Nunca falha silenciosa.

## 5. Modelo de dados (tabelas novas)

> Schema sob constraint do Lovable: migrations entregues via SQL Editor (ver CLAUDE.md §5). RLS em todas; service_role pras edge functions; staff-scoped por atribuição operacional na leitura.

- **`whatsapp_webhook_events`** — payload cru + `message_id` (unique, dedup) + `processed_at`. Espelha o padrão `omie_webhook_events`.
- **`whatsapp_conversations`** — `id`, `customer_user_id` (nullable até identificar), `phone_e164`, `assigned_operator_id` (atribuição operacional, §7), `status` (`aberta`|`aguardando_cliente`|`fechada`), `last_inbound_at` (controla janela de 24h), `last_message_at`, `opt_in_status` snapshot.
- **`whatsapp_messages`** — `id`, `conversation_id`, `direction` (`in`|`out`), `wa_message_id`, `type` (`text`|`audio`|`image`|`template`|`system`), `body`, `media_url`, `transcript` (áudio→texto, fase 2, linkado à fonte), `status` (`sent`|`delivered`|`read`|`failed`), `created_at`.
- **`whatsapp_quote_drafts`** — `id`, `conversation_id`, `customer_user_id`, `status` (`rascunho`|`enviado`|`descartado`), `linhas` (jsonb: por linha → texto_origem, sku_id|null, qtd, unidade, empresa_fiscal, preço, fonte_preço, **margem, lucro_econômico, piso_margem, origem** (reorder|gap|cliente), confidence, estado `prefilled|confirmar|unresolved`), `created_at`. Vira `sales_orders status='orcamento'` no envio (reusa `submitQuote`).
- **`whatsapp_opt_in`** — `customer_user_id`, `status` (`unknown`|`opted_in`|`opted_out`|`do_not_contact`), `source`, `legal_basis`, `operator_id`, `updated_at`. Base LGPD + supressão de STOP ("PARAR").
- **`sku_aliases`** — `frase_cliente` (normalizada) → `sku_id` (ou `service_id`), `scope` (`global`|`per_client` com `customer_user_id`), `created_by`, `created_at`. Alimenta candidatos + loop de aprendizado (§6.7).
- **`whatsapp_outbound_log`** — `customer_user_id`, `route_ref`, `template`, `sent_at`, `status`, `block_report_signal`. Mede ramp/qualidade e impõe cap por rota.

## 6. Pipeline de extração (pricing-safe, em estágios)

> Regra de ouro: **a LLM extrai e ranqueia; ela NÃO precifica nem inventa SKU.** Sem isso, a feature fica pior que ligar na mão.

1. **Normalizar entrada** — telefone→cliente; carregar `customer_user_id`, cidade, atribuição operacional, **histórico de compra (12–24m)**, tabela de preço permitida, `omie_codigo_cliente`, regra de empresa fiscal. **Áudio (v1):** transcrever via ElevenLabs, mantendo o transcript **linkado à fonte** (a vendedora pode reouvir). Texto e áudio convergem aqui; daqui pra frente o pipeline é idêntico.
2. **LLM só extrai itens crus** — saída: `texto_origem`, quantidade, unidade, dimensões, grão (grit), marca, embalagem, urgência, ambiguidade. **Sem `sku_id`, sem preço, sem campo inventado.**
3. **Geração de candidatos** — prior forte = histórico do cliente; `pg_trgm` sobre nomes de SKU + `sku_aliases` + descrições Omie + abreviações/dimensões/grãos/marcas; embeddings como recall **secundário** (não verdade primária).
4. **Ranking** — score determinístico (match de atributo exato + trigram + histórico + compatibilidade de unidade + SKU ativo); LLM **reordena só o top 5–10** com evidência à mostra. Nenhum candidato passa o limiar → **`unresolved`**.
5. **Preço** — chama o serviço de precificação existente por `client_id + sku_id + qtd`; retorna `preço`, `fonte`, `validade`, `empresa/tributo`, e **motivo de falha**. Preço falha → **linha travada**. Nunca pergunta preço pro Claude.
6. **Portões de confiança** — `≥0,90`: pré-preenchido (ainda visível); `0,70–0,89`: destacado pra confirmação humana; `<0,70`: `unresolved`, não pode one-tap. **Orçamento não aprova se qualquer linha não tiver SKU + qtd + unidade + preço + empresa fiscal.** **Guarda de margem (§11b):** o card mostra margem + lucro econômico (cockpit de valor); preço abaixo do **piso de margem** vira **exceção que exige humano** — a IA nunca desconta sozinha.
7. **Loop de aprendizado** — quando a vendedora corrige um match, salva `sku_alias`/evidência. Revisão semanal: frases não resolvidas, SKUs mais corrigidos, falhas de preço.

## 6b. Modelos de IA — seleção por tarefa

> Modelo certo pra cada tarefa, não um só pra tudo. **No v1: só Anthropic (Haiku + Sonnet) pro LLM + ElevenLabs pro STT.** Cada provedor novo = +1 DPA/transferência internacional (LGPD) + segredos + caminhos de falha; a Anthropic já está plugada nas edge functions.

| Tarefa | Modelo | Por quê |
|---|---|---|
| Classificar (produto/serviço/atendimento) | **Haiku** | trivial, barato (~R$0,05), rápido |
| Extrair itens (texto/áudio) + reordenar candidatos | **Sonnet** | é o passo que decide o acerto — precisa de precisão |
| Frasear conversa / cross-sell | **Haiku** (Sonnet se a venda pedir nuance) | linguagem natural simples |
| Transcrever áudio | **ElevenLabs (STT)** | NÃO é LLM; o Claude não transcreve áudio |
| Visão/imagem (fase 4) | reavaliar **Gemini / GPT-4o / Claude**; código de barras = **lib determinística** | multimodal forte; barcode sem IA = exato e grátis |

- **Opus NÃO no hot path** (caro demais pro volume por mensagem); reservado, se um dia, pra análise pesada offline — e mesmo essa o Sonnet costuma dar conta.
- **Model-agnostic:** o modelo é **config por tarefa**, não hardcoded → trocar/adicionar provedor (ex.: Gemini pra imagem na fase 4) sem reescrever o pipeline.
- **Calibrar com dado:** começa a extração no Sonnet; a taxa de correção (loop §6.7) diz se dá pra baixar pro Haiku e economizar sem perder acerto.
- **Cache de prompt:** contexto repetido (system prompt + instruções + dados do cliente) fica em cache (leitura ~90% mais barata) → derruba o custo ao longo da conversa.

## 7. Roteamento, atribuição operacional e priorização na resposta (risco P1)

### 7a. Atribuição operacional (quem é o dono da conversa)
A `carteira_assignments` **não é a verdade operacional**: na amostra, o founder aparece como dono de 145/183 clientes, mas quem trabalha são as 2 vendedoras (28 e 10). Rotear inbound por carteira jogaria tudo na fila do founder.

**Solução:** uma camada de **atribuição operacional** (`whatsapp_conversations.assigned_operator_id`):
- Regra primária: dona operacional da rota/cidade (a vendedora que de fato cobre aquela cidade).
- Fallback: rodízio entre as vendedoras ativas / "quem responder primeiro".
- Founder = **supervisor/fallback**, vê tudo, não é destino padrão.
- **Dependência:** definir/corrigir esse mapeamento (provável `operator_city_coverage` ou reuso de cobertura existente) — query nos dados reais na fase de plano.

### 7b. Fila dinâmica de prioridade NA RESPOSTA (Opção D — eu + codex)
**Não há tier estático de "humano-primeiro" por score.** A IA abre **todos** os clientes qualificados da rota. Quando respondem, uma **fila dinâmica** ordena o tempo escasso da vendedora pelas conversas onde a mão humana **muda dinheiro** — não por um score estático decidido antes do cliente demonstrar interesse.

`prioridade ≈ intenção_da_resposta × valor/margem_esperada × risco_de_relação × complexidade_de_negociação × urgência_da_rota`

A vendedora é puxada pra conversa (em vez de a IA fechar sozinha o subset seguro) quando bate um ou mais de:
- pedido de **alto valor/margem**; conta **estratégica/chave**;
- **fragilidade de relação** / reclamação recente;
- orçamento **grande/complexo**, substituição, preço fora do padrão, negociação provável;
- **resposta de alta intenção** ("preciso hoje", "manda o preço", "fecha", "quanto fica", "tô precisando");
- **risco de churn** (comprava e sumiu).

**Por que D vence A/B/C:** o gate de orçamento já existe pra TODO mundo — então um "humano-primeiro proativo" por score é redundante e desperdiça os ~120/dia em contas teoricamente valiosas que não iam comprar hoje. O valor escasso da vendedora é o **julgamento** (negociação/substituição/conta-chave), não dar "oi" primeiro.

**⚠️ Falha a blindar (a pior):** cliente **pronto pra comprar** esperar atrás de contas "importantes" que nem responderam. A fila precisa pesar **intenção viva** acima de valor estático, e ter SLA. Caps de capacidade por dia/vendedora ajustam o corte.

### 7c. Tom & transparência (decisão #11)
- ✅ **Aprende o tom** (caloroso, informal, regional, usa nome/histórico/jeito do vendedor) — é o que evita parecer robô frio.
- ⚠️ **Não impersona** uma pessoa específica nem **nega ser automatizada** se perguntada. A IA fala **como a Colacor**; a vendedora é claramente a dona da relação ("a Regina já confirma seu orçamento"). O número central da empresa torna isso natural (cliente já espera falar com "a Colacor", não com o celular pessoal). Posição prudente sob LGPD/Meta + protege confiança B2B.

## 8. Motor de disparo por rota + opt-in + ramp seguro

> Começar por **consentimento e qualidade**, não volume. Estourar a nota do número mata o canal.

- **Semana 0 — consentimento:** `whatsapp_opt_in` por cliente (`unknown|opted_in|opted_out|do_not_contact`) + source/data/operador/base legal. **STOP** ("PARAR" ou equivalente) suprime futuro imediatamente.
- **Semana 1 — piloto assistido:** 20–30 clientes opted_in de UMA rota, só ativos recentes de score alto. Template marketing honesto, sem desconto/urgência/link/imagem/follow-up repetido.
  - Exemplo: *"Oi, {{nome}}, a {{empresa}} passa em {{cidade}} amanhã. Se precisar repor lixas/ferramentas, responda por aqui que a {{vendedora}} já monta seu orçamento."*
- **Semana 2 — ramp:** 50–80/dia se bloqueio/denúncia baixos e respostas úteis; segmentar por cidade/recência; horário comercial, não tudo de uma vez.
- **Semana 3+ — escala de rota:** rota inteira só depois de medir entrega, resposta, opt-out, sinais de bloqueio/denúncia, conversão de orçamento/pedido, taxa de correção manual. **Cap por rota + auto-pausa em degradação de qualidade.**
- **Número:** único é aceitável nessa escala; manter número de contingência/fluxo de fallback. Não fracionar números cedo.

### 8b. Estratégia da janela de 24h (custo de mensageria ≈ zero no follow-up)
**Mecânica real:** a janela de 24h conta a partir da **última mensagem do CLIENTE** — cada resposta dele **reinicia o relógio**. Dentro da janela, **todas** as mensagens do negócio (incl. follow-up da IA) são **grátis**. Mensagem do negócio **NÃO estende** a janela (só a do cliente estende). Janela fecha após 24h de silêncio do cliente; **quando o cliente volta, a entrada dele reabre a janela de graça**.

**Implicações (o medo de "perder a janela" é quase infundado):**
- Conversa ativa (vai-e-volta) fica **grátis e viva** indefinidamente — a janela só morre no silêncio.
- Cliente que responde "só no outro dia" **reabre a janela de graça** com a resposta dele — não se perde o cliente; o orçamento segue válido independente da janela.
- Só se paga template quando **NÓS** queremos cutucar um cliente **mudo** com a janela fechada.

**Táticas (no v1):**
1. **Responder rápido** e mandar o orçamento ainda na janela (grátis).
2. **Validade no orçamento** ("válido até amanhã") → puxa a decisão pra dentro da janela.
3. **UMA cutuca bem-cronometrada** perto do fim da janela (~20–22h após a última msg do cliente) se não fechou: *"Seu orçamento tá de pé — quero já fechar?"* (grátis). **Não** disparar follow-up repetido (não estende a janela + derruba a nota do número).
4. **Re-engajar cliente mudo (janela fechada) com template UTILITY (~R$0,04), não marketing (~R$0,33):** um lembrete amarrado a um **orçamento que o cliente pediu** tem chance de ser classificado `utility` (transacional), diferente do disparo de abertura frio (marketing). Desenhar o template pra isso; a Meta decide a categoria. Ex.: *"Seu orçamento #123 segue válido — responda pra confirmar."*

**Resumo de custo por negócio:** abertura ~R$0,33 (1×/ciclo de rota) → conversa inteira **grátis** → no máximo 1 re-engajamento ~R$0,04 se o cliente sumir. O follow-up "até o último momento" é de graça **enquanto a janela está aberta** — e a disciplina (1 cutuca, útil) protege a nota do número.

## 9. Observabilidade & tratamento de erros (escopo de v1)

Dado o histórico de **falha silenciosa do sync Omie**, visibilidade vem ANTES de polir IA. Reaproveita o padrão do **Sentinela de Saúde de Dados** (`fin_alertas` + watchdog + push na transição ok→degradado):
- **Webhook:** atraso/erro de ingestão; eventos não processados.
- **Envio:** mensagens `failed`; template rejeitado; janela de 24h expirada.
- **Preço:** taxa de linhas travadas por falha de preço.
- **Omie sync:** rascunho/pedido que falha downstream → **status visível + retry + dead-letter + alerta**. Nunca silencioso.
- **Qualidade do número:** nota/bloqueio/denúncia monitorados; auto-pausa do disparo.

Toda exceção tem nome e destino (sem catch-all). Ex.: `WebhookSignatureInvalid` → 401 + log; `CustomerNotMatched` → conversa não-identificada; `PriceUnavailable` → linha travada com motivo; `OmieSyncFailed` → dead-letter + alerta.

## 10. Reaproveitamento (o que já existe)

Só a faixa WhatsApp↔inbox é nova. Reaproveita: `submitQuote` (orçamento local sem tocar Omie), `submitOrder`→`omie-vendas-sync` (PV + split por empresa), precificação por cliente (Omie), Anthropic em edge function (padrão `claude-spin-analyze`), `addresses.city` (cidade no formato `CIDADE (MG)`), normalização de telefone (`src/lib/phone`), padrão de webhook com segredo (`omie-webhook`), Realtime, planejador de rotas, score/sugestão de visita, e o padrão Sentinela de observabilidade.

## 11. Custos (resumo — ver detalhe na conversa de brainstorming)

- **BSP 360dialog:** ~R$274/mês fixo (sem markup por msg).
- **Toque de abertura:** template **marketing ~R$0,33/msg** (reorder = marketing, confirmado na Meta). Mensagem recebida + resposta em 24h = **grátis**.
- **IA por orçamento:** ~R$0,20–0,45 (Haiku/Sonnet; cache reduz).
- **Transcrição de áudio (v1):** STT ~R$0,03/min (ElevenLabs, já no stack) — bucket separado, não é Nvoip nem token de LLM. Notas de voz curtas = centavos.
- **Exemplo (1 rota, 174 c/ telefone, semanal):** ~R$247/mês toques + ~R$90 IA ≈ **~R$340/mês**.
- **Operação inteira (real, 2026-05-28): 2.974 clientes ativos com telefone em 216 cidades.** Custo-teto "tocar todo mundo toda semana": `2.974 × R$0,33 × 4,3` ≈ **R$4.220/mês de toques** + ~R$1.150 IA (≈30% respondem) + R$274 BSP ≈ **~R$5.600/mês** no full-scale. Cenário realista (score-gated ~60% da base) ≈ **~R$3.500/mês**. O ramp (§8) começa numa fração disso (piloto = poucas centenas de toques/mês) e cresce.
- **Nvoip (canal separado, telefone):** R$59–109/vendedora + minutos (tarifa a confirmar com o Nvoip).

## 11b. Alavancas de lucratividade (a IA como camada de execução)

> Princípio (eu + codex): a IA é a **execução** da inteligência comercial que já existe (ERP + engines). Otimizar **lucro econômico por rota/cliente/conversa**, não resposta/faturamento. "Não é um chatbot — é a camada de execução do cérebro que você já construiu."
>
> **Benchmarks copiados (pesquisa 2026):** AB InBev **BEES** (accept-a-proposal — 75% dos pedidos são propostas da IA aceitas, ~3% maiores), Coca-Cola FEMSA + **Yalo** (carrinho via WhatsApp do histórico, +30% no ticket, vendedor vira consultor), **Fastenal** (reposição consumo-disparada), **Grainger KeepStock** (lista de ação priorizada pro vendedor), **Würth/ORSY** (dono do ritual de reposição do consumível), **McMaster-Carr** (pedido a 1 toque), **McKinsey/Bain** (preço = alavanca nº1 → piso de margem; Mix/Gap white-space; inside sales pra cauda longa; win-back).

**No v1 (4 alavancas — esforço "S", só reaproveitam engines):**
1. **Abertura "accept-a-proposal" (maior alavanca de positivação).** Benchmark **BEES / Yalo-FEMSA**: **não pergunte "precisa de algo?" — PROPONHA o pedido pronto.** O disparo da rota manda o **carrinho pré-montado** do cliente — *"Seu de sempre: 3× lixa grão 120 + 2× cola X. A rota passa amanhã. Confirmo ou ajusto?"* — montado pelo **motor de reposição** + **intervalo de recompra** (`intervalo_medio_dias` + `dias_desde_ultima_compra`). Na BEES **75% dos pedidos são propostas da IA que o cliente só aceita** (pedido com IA ~3% maior); na Coca-FEMSA/Yalo o **ticket subiu +30%**. Refina a mensagem do motor de disparo (§8), não é peça nova.
2. **Guarda de margem no orçamento.** O card **mostra margem + lucro econômico** (cockpit de valor) e **trava o piso de margem**; a IA **nunca dá desconto sozinha** — desconto abaixo do piso é **exceção que exige humano** (mesmo gate do preço). É o equivalente de lucro à regra "nunca inventa preço".
3. **Fechar gap de cesta.** Na recompra, sugere **1–2 itens de alta margem** vindos do **cross-sell / Mix-Gap / bundles** (a LLM só fraseia). É o cross-sell mais barato — anexado a um pedido que já vai acontecer.
4. **Pass-through de aumento.** Segmento de disparo "compre antes de subir" **só pros clientes que compram o SKU** com aumento anunciado (`fornecedor_aumento_anunciado` + histórico). Urgência que **protege margem**. Respeita opt-in/qualidade/janela (§8).

**Roadmap (opt-in, depois do v1 provar):**
- **Fila de positivação priorizada por lucro econômico** (não tocar todos igual — ordena por EP esperado).
- **Steering Pix/prazo curto** (condição melhor no Pix em vez de desconto cego → menos custo de capital de giro → mais lucro econômico).
- **Substituição/trade-up consciente de margem** (item de baixa margem/indisponível → alternativa de melhor contribuição).
- **Política pra cliente de EP negativo** (restringe desconto/prazo, exige cesta mínima, reduz toque proativo).
- **World-class (o flywheel):** **aprendizado em loop** (cada conversa alimenta ranking/timing/oferta/script), **motor de política comercial** (preço/margem/crédito/prazo/estoque como regras), **cockpit de exceções** (humano só vê negociação/aprovação/quote travado).

**Armadilhas (não fazer):** desconto autônomo; disparo genérico pra base inteira (queima a nota do número); imagem no v1; CRM novo (a inteligência já está no ERP/engines); otimizar resposta/faturamento em vez de **lucro econômico**.

## 12. Fases (roadmap)

- **Fase 1 (v1):** API oficial via BSP + inbox enxuta no OS + opt-in/opt-out + disparo por rota (template marketing) + entrada **texto + áudio** (transcrição) + rascunho de orçamento **só produto** + preço determinístico + autonomia na conversa com gate humano no preço + **4 alavancas de lucro** (§11b: abertura JIT, guarda de margem, gap de cesta, pass-through de aumento) + **observabilidade** (webhook/envio/preço/Omie).
- **Fase 2:** melhor matching — aprendizado de apelidos, prior de histórico, analytics de correção, afinação dos portões de confiança.
- **Fase 3:** orçamento de **serviço de afiação** (classificador dedicado, portões de confiança próprios, confirmação humana de medidas).
- **Fase 4:** **imagem** — **embalagem/código de barras primeiro** (caso confiável; código de barras → SKU quase determinístico), **manuscrito por último** (ambiguidade alta). **Linha vinda de imagem é sempre "confirmar"** (humano olha), independente da confiança do modelo — é onde a falsa confiança mais aparece.

## 13. Não-objetivos (fora de escopo do v1)

- **Fechamento autônomo de orçamento** (preço firme sem humano) em caso ambíguo/não-padrão; one-tap em linha de baixa confiança. (A IA **conversa e pergunta sozinha** — isso É escopo; só o COMPROMISSO de preço fora do subset seguro exige humano.)
- **Desconto autônomo.** A IA nunca dá desconto abaixo do piso de margem sozinha — sempre exceção humana (§11b). Ela pode oferecer Pix/prazo/cesta/substituição (roadmap) antes de baixar preço.
- Orçamento de serviço por IA e ingestão de **imagem** (fases posteriores). **Áudio É v1.**
- Inbox BSP-grade (read receipts ricos, automações complexas), múltiplos números.
- Camada de menu/permissão por persona (segue o do supervisor; fora de escopo até existir fundação de acesso).

## 14. Questões em aberto / dependências

1. **Atribuição operacional** (§7): definir/corrigir o mapeamento cidade/rota→vendedora (query nos dados reais na fase de plano).
2. ~~Número da operação inteira~~ ✅ **resolvido (2026-05-28): 2.974 ativos c/ telefone em 216 cidades** → custo-teto ~R$5.600/mês full-scale, ~R$3.500/mês score-gated (§11).
3. **Tarifa Nvoip** por minuto (confirmar com o fornecedor — não está pública).
4. **DPA/retenção-zero com a Anthropic** (LGPD) — confirmar termos pro conteúdo de conversa.
5. **Onboarding 360dialog:** verificação do Business Manager, número dedicado, prazo.
6. **Refresh da `customer_metrics_mv`** (a `ativos_30d=0` indica métrica desatualizada) — não bloqueia, mas o "ativo" depende dela.

## 15. Critérios de sucesso (v1)

- Vendedora vê todas as respostas num lugar só e aprova orçamento de produto **mais rápido que ligar**.
- **Zero preço/SKU inventado** (preço sempre determinístico; linha sem match trava).
- Disparo por rota sem degradar a nota do número (bloqueio/denúncia abaixo do limiar; auto-pausa funciona).
- Falhas (webhook/envio/preço/Omie) **visíveis e alertadas** — nenhuma silenciosa.
- Cobertura: % de clientes ativos da rota tocados via WhatsApp ≫ os ~120/dia que o telefone alcança.
