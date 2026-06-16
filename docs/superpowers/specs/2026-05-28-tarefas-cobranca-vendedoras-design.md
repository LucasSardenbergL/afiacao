# Tarefas — Cobrança de Atividades das Vendedoras (Fase 1) — Design

> Status: **desenho aprovado pelo founder** (seção a seção, 2026-05-28). Próximo passo: plano de implementação (`writing-plans`).
> Validado em 3 consults adversariais com o codex (auto-baixa por transcrição + adições de alto valor + pré-mortem) — registro no fim do doc.

## 1. Contexto e problema

O founder visita clientes e, na visita, passa atividades pras vendedoras: **ligar** pro cliente, **oferecer** um item, **passar um preço**, **mandar dados por WhatsApp**. Hoje elas anotam em agenda física e **esquecem**. Não há mecanismo de lembrete nem de cobrança — o founder perde vendas e não tem visibilidade.

O app já tem ~70% da infra reaproveitável: registro de ligações (`farmer_calls`, com transcrição/análise/entidades), visitas/entregas (`route_visits`), carteira por vendedora (`carteira_assignments`) com cobertura de férias (`carteira_coverage`), pipeline de e-mail pro founder (`fornecedor_alerta` → cron `dispatch-notifications`), e o dashboard "Meu Dia" por papel comercial.

## 2. Objetivo da Fase 1

Um sistema **unificado** de Tarefas. A Fase 1 entrega **tarefas de cliente atribuídas às vendedoras + cobrança por e-mail ao founder**:

1. O founder cria tarefas tied a um cliente, atribuídas a uma vendedora, com prazo por **data fixa** ou por **próxima interação** (ligação/visita/entrega).
2. A vendedora é lembrada **in-app de forma saliente** (badge na sidebar + hoje/atrasadas no topo da Meu Dia) — não num card passivo que ela precisa procurar.
3. O app dá **baixa automática** quando há prova determinística; **propõe** baixa (1 toque pra confirmar) quando só detecta menção na transcrição.
4. Se a tarefa vence e passa a **tolerância** sem ser cumprida nem confirmada, o **founder recebe e-mail** de cobrança.
5. **Limite automático** (backstop ~7d) no modo interação — nada apodrece.
6. O **founder acompanha proativamente** numa lista enxuta "tarefas que criei + status" (não depende só do e-mail negativo).

### Não-objetivos (Fase 2, mas schema preparado)

- Tarefas **recorrentes** (ex: operador de tinta regula a máquina todo dia).
- **Trava de comprovação física** (foto da tela antes de poder concluir).
- Voz→tarefa (founder fala, o app monta a tarefa).
- Auto-baixa **silenciosa** por conteúdo de transcrição (fica sempre como sugestão na Fase 1).
- Dashboard de ROI / analytics de cobrança.

## 3. Decisões de produto (com rationale)

### 3.1 Dois modos de prazo + backstop automático
- **`data`**: o founder define uma data explícita (`due_date`).
- **`interacao`**: sem data; o prazo é a **próxima interação** com o cliente (`interacao_tipo` ∈ ligacao/visita/entrega, escolhido conforme o caso — hunter→ligação, farmer→visita/entrega). Pra nada apodrecer, há um **backstop**: `created_at + backstop_days` (padrão 7, **ajustável por tarefa**). Se a interação não rolar até o backstop, a tarefa vence e escala. O backstop é **fixo na criação** (não rola dia a dia); a interação **satisfaz/avalia** a tarefa, não a reagenda. **Adiar com motivo (3.6) é o único jeito de empurrar o vencimento.**

### 3.2 Tolerância (cobrança baseada em tolerância)
A vendedora é lembrada **primeiro** (in-app). O e-mail ao founder só dispara depois de `vencimento + tolerancia_dias`. A tolerância tem um **padrão global** (config; **1 dia**, aprovado pelo founder), mas é **gravada em cada tarefa na criação** — mudar o padrão depois **não reescreve** o passado.

### 3.3 Escada de certeza (auto-baixa) — decisão central
Detectar uma menção na transcrição **≠** tarefa cumprida (o cliente pode ter perguntado, ela pode ter recusado). Fechar tarefa com base nisso fura a cobrança. Regra (validada com codex):

| Sinal | Ação |
|---|---|
| **Determinístico** (ligação/visita/entrega registrada; WhatsApp enviado pelo botão da tarefa) | **Baixa automática**, sem perguntar. O evento **é** a tarefa. |
| **Conteúdo** (transcrição menciona o item/preço-alvo) | **Propõe** baixa na Meu Dia → vendedora confirma em **1 toque**. Nunca fecha sozinho. |
| **Invisível** (WhatsApp do celular pessoal, "outro" vago, baixa confiança) | **Manual** (ou o mesmo 1 toque). |

Para tarefas de **conteúdo** (oferecer/preço): quando a interação ligada acontece, em vez de fechar, o app cria uma **sugestão de conclusão** ("a ligação aconteceu — você ofereceu [X]? confirmar"). Se a transcrição tiver menção ao alvo, a sugestão fica mais forte ("**detectei** que você falou de [X]"). A menção é **reforço de sinal**, não porteira — o que vale é o 1 toque da vendedora.

> O e-mail de cobrança só é segurado/disparado pelo estado **confirmado**. Uma sugestão da IA sozinha **nunca** apaga nem dispara a cobrança.

### 3.4 WhatsApp via botão dentro da tarefa
Hoje **não há** envio de WhatsApp rastreável no app — só deeplink `wa.me` (`shareOrderViaWhatsApp`, botão de contato no Customer360) que abre o WhatsApp por fora; a coluna `farmer_calls.is_whatsapp` é lida mas **nunca gravada** pelo app. Logo, detectar "ela mandou" é impossível.

Saída: a **tarefa de WhatsApp carrega o botão de enviar**. O founder cola os dados ("manda isso pro cliente: ..."); a vendedora vê a tarefa com botão "Mandar no WhatsApp" que abre o WhatsApp com a mensagem pronta. **Tocar no botão dá a baixa** (`conclusao_origem='whatsapp'`) — envio e conclusão viram o mesmo toque, com rastro. Sem detecção, sem furo.

### 3.5 Cobrança por e-mail — conteúdo e agrupamento
- Dispara em `vencimento + tolerancia` para tarefas `aberta` com `escalado_em IS NULL` e que **não estão adiadas pro futuro**.
- **Agrupada por vendedora (efetiva) × empresa** (1 alerta por vendedora). `metadata` jsonb com a lista de tarefas, separando duas categorias:
  1. **Sem sinal nenhum** — ela não tocou e o app não detectou nada (negligência clara).
  2. **App detectou possível cumprimento, não confirmado** — ex: "na ligação de 12/05 o app percebeu menção a [item X], mas a tarefa segue aberta" (zona cinza — o founder julga).
- Carrega o **motivo do último adiamento** (se houver) e a **contagem de adiamentos** (de `tarefa_eventos`) — pra o founder enxergar adiamento legítimo vs. enrolação.
- **Cópia cuidadosa**: a categoria 2 é redigida como "possível cumprimento **não confirmado**", **nunca** "não fez" — a evidência é fraca e acusação errada destrói a confiança do founder no sinal (e o faz voltar pro WhatsApp paralelo).

### 3.6 Adiar com motivo (snooze)
A vendedora pode **remarcar** a tarefa com um motivo ("cliente pediu pra ligar semana que vem"): grava `adiada_para` + `motivo_adiamento`, registra evento. Enquanto adiada pro futuro, a tarefa **não fica "atrasada"** e **não escala**. Sem isso, o founder recebe alerta de "atraso" que era adiamento legítimo → e para de confiar no e-mail (mesmo problema de confiança da auto-baixa).
- **Sem cap rígido** de adiamentos (codex: nada de fluxo de aprovação). O abuso é **visível** (contagem de adiamentos no e-mail + audit em `tarefa_eventos`), não bloqueado.

### 3.7 Cobrança ciente de férias/cobertura — correção
Não cobrar quem está **de férias**. `carteira_coverage` define quem cobre quem (`covered_user_id` coberto por `covering_user_id`, com `active` + janela `valid_from`/`valid_until`). O **responsável efetivo** de uma tarefa = o cobridor ativo da `assigned_to`, se houver; senão a própria `assigned_to`. Lembrete in-app e cobrança usam o **responsável efetivo**.
- Fase 1 cobre só o **roteamento** de lembrete/cobrança. Gestão de delegação (UI) fica pra depois.

### 3.8 Criação rápida (founder)
A criação de tarefa é a metade founder-facing da Fase 1: **formulário rápido no celular**, podendo lançar **várias tarefas pro mesmo cliente numa visita** (como ele faz no papel hoje). Voz→tarefa fica pra depois.

### 3.9 Ciclo de vida (cancelar / editar) — correção básica, não task-manager
- **Cancelar** (criador/founder ou gestor/master), com motivo → `status='cancelada'`, registra evento. Cancelada **não** é atrasada nem escalável (some da pressão operacional).
- **Editar** enquanto `aberta` (criador/founder): prazo, tolerância, responsável, categoria, alvo. Cada mudança vira evento em `tarefa_eventos`.
- Editar/cancelar **depois de escalada** é permitido e **preserva o histórico** (o evento `escalada` fica; o e-mail já saiu).

## 4. Modelo de dados

### 4.1 `tarefas` (fonte da verdade)
| coluna | tipo | nota |
|---|---|---|
| `id` | uuid PK | |
| `descricao` | text NOT NULL | |
| `categoria` | text NOT NULL CHECK ∈ (ligar, oferecer, preco, whatsapp, outro) | |
| `customer_user_id` | uuid NOT NULL | tarefa é tied a cliente (Fase 1) |
| `assigned_to` | uuid NOT NULL | vendedora responsável |
| `created_by` | uuid NOT NULL | founder/gestor |
| `empresa` | text NOT NULL | |
| `modo` | text NOT NULL CHECK ∈ (data, interacao) | |
| `due_date` | date | preenchido sse `modo='data'` |
| `interacao_tipo` | text | preenchido sse `modo='interacao'`; ∈ (ligacao, visita, entrega) |
| `backstop_days` | int | default 7; usado sse `modo='interacao'` |
| `tolerancia_dias` | int NOT NULL | gravado na criação (do default global) |
| `adiada_para` | timestamptz | snooze |
| `motivo_adiamento` | text | snooze |
| `auto_satisfy_mode` | text NOT NULL default 'interacao' CHECK ∈ (off, interacao, conteudo) | como pode ser auto-satisfeita |
| `target_produto_id` | uuid | alvo estruturado (oferecer) |
| `target_texto` | text | alvo livre p/ matching de candidato |
| `target_preco_centavos` | bigint | alvo (preço) |
| `target_tags` | jsonb | extensível |
| `status` | text NOT NULL default 'aberta' CHECK ∈ (aberta, concluida, cancelada) | |
| `concluida_em` | timestamptz | |
| `concluida_por` | uuid | |
| `conclusao_origem` | text CHECK ∈ (manual, auto_interacao, sugestao_confirmada, whatsapp) | |
| `nota_conclusao` | text | |
| `escalado_em` | timestamptz | **fire-once** (idempotência da cobrança) |
| `template_id` | uuid | **gancho Fase 2** (recorrência); nullable |
| `requer_comprovacao` | boolean NOT NULL default false | **gancho Fase 2** (foto) |
| `comprovacao_url` | text | **gancho Fase 2** |
| `created_at` / `updated_at` | timestamptz | |

CHECKs de coerência de modo:
- `modo='data'` → `due_date NOT NULL` e `interacao_tipo IS NULL`.
- `modo='interacao'` → `interacao_tipo NOT NULL` e `due_date IS NULL`.

> **"atrasada" é DERIVADO**, não armazenado (ver view).
> **Lembrete in-app não tem coluna**: é surfacing read-time na Meu Dia (contínuo). Só a **escalação** (e-mail) precisa de timestamp (`escalado_em`). Se um dia houver push agendado, aí se adiciona `reminded_at`.
> **`auto_satisfy_mode` é derivado da `categoria` na criação** (o founder não escolhe direto): `ligar`→`interacao` (a ligação fecha); `oferecer`/`preco`→`conteudo` (a interação propõe, ela confirma); `whatsapp`→`off` (fecha pelo botão da tarefa); `outro`→`off` (manual). Editável se um caso fugir do padrão. `categoria` (a natureza do trabalho), `modo` (como o prazo funciona) e `interacao_tipo` (qual interação é o gatilho) são ortogonais — ex.: `categoria=oferecer`, `modo=interacao`, `interacao_tipo=ligacao`, `auto_satisfy_mode=conteudo` = "oferecer item X na próxima ligação".

### 4.2 `tarefa_satisfacao_candidatos` (evidências / sugestões)
O app **nunca fecha conteúdo sozinho**; registra candidatos aqui.
| coluna | tipo | nota |
|---|---|---|
| `id` | uuid PK | |
| `tarefa_id` | uuid FK NOT NULL | |
| `source_type` | text CHECK ∈ (farmer_call, route_visit, whatsapp, quote) | |
| `source_id` | uuid | id da ligação/visita |
| `mode` | text CHECK ∈ (interacao, conteudo) | |
| `confidence` | numeric | 0..1 (da entidade, quando conteúdo) |
| `motivo` | text | trecho/razão legível |
| `matched_payload` | jsonb | snippet/contexto da transcrição |
| `status` | text NOT NULL default 'pending' CHECK ∈ (pending, accepted, rejected, expired) | |
| `created_at` / `resolved_at` | timestamptz | |
| `resolved_by` | uuid | |

Idempotência: **UNIQUE (`tarefa_id`, `source_type`, `source_id`)** — o matcher não duplica candidato pra mesma fonte.

### 4.3 `tarefa_eventos` (auditoria)
`id`, `tarefa_id`, `tipo_evento` (criada, lembrete, adiada, sugestao_criada, sugestao_confirmada, sugestao_rejeitada, concluida_manual, concluida_auto, concluida_whatsapp, cancelada, escalada), `ator` (uuid nullable; null=sistema), `payload` jsonb, `created_at`.

### 4.4 View `v_tarefas_estado` (estado derivado)
Calcula por tarefa:
- `effective_due` = `COALESCE(adiada_para::date, due_date, (created_at + (backstop_days || ' days')::interval)::date)`.
- `responsavel_efetivo` = cobridor ativo de `assigned_to` (via `carteira_coverage`), senão `assigned_to`.
- `atrasada` = `status='aberta' AND now() > effective_due` (mostrada vermelha pra ela).
- `escalavel` = `status='aberta' AND now() > effective_due + tolerancia_dias AND escalado_em IS NULL`.
- `tem_sugestao_pendente` = EXISTS candidato `pending`.

`security_invoker=on`.

> **Fuso pinado em `America/Sao_Paulo`**: todo `::date` e comparação de "hoje"/vencimento usa o **dia local** (ex.: `(now() AT TIME ZONE 'America/Sao_Paulo')::date`), nunca UTC — senão "vence hoje" erra perto da meia-noite. A tolerância conta a partir do **fim do dia local** do vencimento.

## 5. Motor (pg_cron + SQL puro — sem trigger em tabela quente, sem edge function nova)

Padrão dos watchdogs que já rodam (`fin_sync_watchdog_check`). **Sem `net.http_post`** nos crons locais (sem armadilha do timeout de 5s); o e-mail sai pelo cron já existente `dispatch-notifications`. **Fuso:** o escalonamento das "18h" é **18h de Brasília** — `cron.schedule` em UTC precisa do offset (ou TZ explícita), e a janela de tolerância usa o dia local (ver 4.4).

### 5.1 Matcher (`tarefas_matcher_tick`, ~15 min)
Varre `farmer_calls`/`route_visits` desde o último tick (cursor por `created_at`/`check_in_at`). Casa interação com tarefas `aberta` por (`customer_user_id`, `interacao_tipo` ↔ tipo do evento) **cujo autor** (`farmer_calls.farmer_id` / `route_visits.visited_by`) seja a `assigned_to` **ou** seu cobridor ativo (a ligação da cobridora durante férias satisfaz a tarefa). Para cada match:
1. Se `auto_satisfy_mode='interacao'` → **fecha** (`status='concluida'`, `conclusao_origem='auto_interacao'`, `concluida_em=now()`), loga evento gravando no payload o `responsavel_efetivo` **vigente no momento do match** (anti-drift: se a cobertura mudar depois, o histórico explica quem era responsável quando). **Ligação só conta como atendida**: `interacao_tipo='ligacao'` exige `farmer_calls.call_result` de contato — **exclui** `sem_resposta`/`ocupado`/`caixa_postal`/`numero_errado` (senão ela disca, desliga e a tarefa fecha sozinha). Visita/entrega: o `check_in_at` já é presença.
2. Se `auto_satisfy_mode='conteudo'` → cria **candidato** (`mode='conteudo'`, `status='pending'`) — nunca fecha. Matching de alvo via `target_produto_id` (determinístico) ou `target_texto` vs. `entities_extracted` (type product/price) com `pg_trgm`/ILIKE normalizado como **score de candidato** (não autoridade de fechamento). Sem menção, ainda cria candidato "a interação aconteceu — confirmar?" (sinal fraco).
3. `auto_satisfy_mode='off'` → o matcher ignora (fechamento é pelo botão/manual).
4. Expira candidatos `pending` antigos (> N dias, tunável) → `expired`.

### 5.2 Escalonamento (`tarefas_escalonamento_tick`, diário ~18h)
1. Seleciona da view `escalavel = true`.
2. Agrupa por (`responsavel_efetivo`, `empresa`); pula quem está coberto-de-férias **sem** cobridor resolvido (raro; loga).
3. INSERT `fornecedor_alerta` (1 por grupo) com `metadata` = lista de tarefas separada em "sem sinal" vs "detectado-não-confirmado" + motivo/contagem de adiamento.
4. `UPDATE tarefas SET escalado_em = now()` (fire-once), loga evento `escalada`.

## 6. Surfacing

### 6.1 Vendedora (Meu Dia) — saliência é o ponto
O risco nº 1 (codex) é a tarefa ser **passiva**: se ela só vê quando abre a tela, vira log de auditoria, não muda comportamento. Mitigação Fase 1 reusando infra existente (**sem** canal de mensagem novo):
- **Badge na sidebar** (o app já tem badges numéricos em tempo real) com a contagem de hoje/atrasadas/sugestões pendentes.
- **Hoje / atrasadas fixadas no TOPO** da Meu Dia — nunca enterradas abaixo de rota/positivação. Regra: havendo tarefa due/atrasada, ela é o primeiro bloco. Atrasada = vermelha.
- **Sugestões pra confirmar** (candidatos `pending`) com estilo visual mais forte: "detectei [X] na ligação de hoje — confirma?" → 1 toque (`accepted` → `concluida`/`sugestao_confirmada`; `rejected` → segue aberta).
- Tarefa de **WhatsApp**: botão "Mandar no WhatsApp" (ver 3.4 + nota de evidência abaixo).
- Ação **Adiar** (com motivo).
- **Nudge contextual** (client-side): ao registrar ligação/visita pra cliente X, mostra tarefas abertas de X.
- Mostra as tarefas do `responsavel_efetivo` (inclui as cobertas durante férias de outra).

> **Nota de evidência do WhatsApp**: o `wa.me` só **abre** o WhatsApp com a mensagem pronta — o app não vê o "enviado". O toque fecha com `conclusao_origem='whatsapp'` = "ela disparou o envio pelos dados da tarefa", **não** prova de entrega. O founder vê esse origem (transparência > falsa certeza). Detecção real de envio / push pra ela = Fase 2.

### 6.2 Founder — visibilidade antes do e-mail (enxuta, não dashboard)
Lista read-only **"Tarefas que criei"** (`created_by = auth.uid()` + filtros básicos de status/prazo). Por tarefa: responsável efetivo, prazo/`effective_due`, atrasada, sugestão pendente, **se já foi escalada** (resolve o cego do fire-once — tarefa escalada-mas-ainda-aberta segue visível aqui mesmo o e-mail tendo saído 1x), e `conclusao_origem` (manual/auto/whatsapp) pro founder ler o nível de evidência. **Sem** analytics/kanban/comentários/prioridade.

Criação (founder): formulário rápido mobile, **multi-tarefa por cliente** numa visita.

## 7. RLS / segurança

- `tarefas`: SELECT = `master`/gestor OR `assigned_to = auth.uid()` OR cobre a `assigned_to` (reusa `carteira_visivel_para`/`carteira_coverage`). INSERT/assign = só `master`/gestor; `created_by = auth.uid()` no insert. UPDATE de conclusão/adiamento = responsável efetivo OR gestor/master.
- `tarefa_satisfacao_candidatos` / `tarefa_eventos`: seguem a visibilidade da tarefa-pai.
- `service_role` (cron) bypassa.
- Padrão do repo: `TO authenticated`, subqueries em `(select ...)` p/ initPlan, helper `pode_ver_carteira_completa` p/ gestor/master.

## 8. Integração com `fornecedor_alerta`

O CHECK de `tipo` **não inclui** `tarefa_atrasada`. **Preferido**: estender o CHECK (1 migration: DROP + ADD CONSTRAINT incluindo `tarefa_atrasada`) — mais limpo e consultável do que sobrecarregar `'outro'` (que o watchdog de sync já usa). `empresa` é NOT NULL → usar a empresa do grupo. `dispatch-notifications` **não filtra por tipo** → o e-mail sai sem mudar a edge function.

## 9. Edge cases

- **Tarefa de conteúdo em modo interação**: a interação acontecer **dispara avaliação**, não baixa → vira sugestão, não fecha sozinha.
- **Adiada além do backstop**: `adiada_para` manda no `effective_due` (snooze ganha do backstop).
- **Cliente sem perfil local** (só Omie): tarefa exige `customer_user_id` → criação só sobre cliente com perfil (mesma regra do `FarmerCalls`).
- **Vendedora coberta**: tarefas dela aparecem pra cobridora; cobrança vai pra cobridora.
- **Múltiplas interações** pra mesma tarefa: UNIQUE no candidato evita duplicar; auto_interacao fecha na 1ª.
- **WhatsApp pessoal**: não detectável → fica manual/1-toque.
- **Re-escalação**: `escalado_em` fire-once; não re-escala a mesma tarefa (sem spam diário).

## 10. O que NÃO entra (anti-scope-creep — codex)

Nada de gerenciador de tarefas completo: comentários, anexos, prioridades, kanban, dashboards, fluxo de aprovação, analytics de SLA, coaching por IA, relatório de ROI. Fase 1 fica afiada: **atribuir → lembrar → detectar → confirmar quando incerto → escalar depois da tolerância.**

## 11. Trabalho de migração (constraint do Lovable)

Tudo aplicado **manualmente** via SQL Editor do Lovable (sem CLI). Blocos esperados:
- **BLOCO A**: `tarefas` + CHECKs + índices.
- **BLOCO B**: `tarefa_satisfacao_candidatos` (+ UNIQUE) + `tarefa_eventos`.
- **BLOCO C**: view `v_tarefas_estado` + RLS de todas as tabelas.
- **BLOCO D**: funções `tarefas_matcher_tick` / `tarefas_escalonamento_tick` + `cron.schedule` (idempotente por nome) + extensão do CHECK de `fornecedor_alerta`.
- **BLOCO E**: seed do default global em `company_config` — **tolerância = 1 dia, backstop = 7 dias** (aprovados pelo founder).
Cada bloco com query de validação. Nota no PR: **"ATENÇÃO: migration manual necessária"**. **Sem edge function nova** na Fase 1 (matcher e escalonamento são SQL puro).

## 12. Registro de revisão com o codex

- **Consult 1 (auto-baixa por transcrição)**: P1 — não fechar conteúdo silenciosamente (menção = evidência, não cumprimento; "citar o item" não é sinal válido). Adotado: escada de certeza (determinístico fecha, inferido propõe); tabela de candidatos separada das colunas da tarefa; alvo estruturado; matcher SQL só gera candidato, fechamento exige 1 toque.
- **Consult 2 (adições de alto valor)**: rule-in Fase 1 — **adiar com motivo** (melhor adição: protege a confiança na cobrança), **férias/cobertura-aware** (correção), **criação rápida mobile** (form, não voz). Rule-out/depois — sugerir tarefa a partir de compromisso na ligação (ruidoso; só sugerir, nunca criar), "gerou pedido?" (ROI secundário), voz→tarefa. Trap: virar task manager completo.
- **Consult 3 (pré-mortem do spec)**: risco mais fundo = **saliência** (passivo vira só log de auditoria, não muda comportamento) → incorporado: badge na sidebar + fixar hoje/atrasadas no topo + sugestões mais fortes. P1 incorporados: **lista do founder** "tarefas que criei" (visibilidade antes do e-mail + resolve o cego do fire-once), **"ligar" só em ligação atendida** (anti-loophole), **ciclo de vida** (cancelar/editar auditado), **fuso America/Sao_Paulo**, **backstop fixo na criação**, **anti-drift de cobertura** (grava responsável no match), **cópia cuidadosa** do e-mail. Confirmado fora de escopo: push pra vendedora (sem canal de mensagem novo na Fase 1), cap de adiamento, cadência de re-escalação.
