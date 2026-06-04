# SLA de resposta do WhatsApp — indicador + alerta de "cliente sem resposta"

> Spec de design. Endurecido com **1 passe adversário do codex** (gpt-5.5, xhigh, sessão `019e9349`) — 6 `[P1]` + 8 `[P2]` incorporados. Data: 2026-06-04.

## 1. Problema & objetivo

Hoje o inbox do WhatsApp (`/whatsapp`, PR #479) não mostra **quanto tempo um cliente está sem resposta**. Quando o atendimento está sob comando humano (que é 100% dos casos hoje — não há IA respondendo sozinha), uma pergunta pode ficar horas no vácuo sem ninguém perceber.

**Objetivo:** indicador + alerta de "tempo sem resposta" por conversa, **escopado por vendedora dona do cliente**, com:
- nudge **em tempo real no app** pra cada vendedora (clientes DELA esperando);
- **painel de supervisão** pro founder/gestor (quem está deixando cliente no vácuo + balde "sem dono");
- **digest diário por e-mail** pro founder no fim do expediente.

Espelha o padrão já entregue na feature de **Tarefas** (card saliente na Meu Dia + supervisão + e-mail de cobrança via `fornecedor_alerta` → `dispatch-notifications`).

## 2. Por que é barato: o sinal já existe

`whatsapp_conversations` (`assigned_operator_id`, `status`, `last_inbound_at`) + `whatsapp_messages` (`direction`, `sender_user_id`, `wa_timestamp`, `created_at`) + Realtime já ligado nas duas tabelas. O "cérebro" do indicador é basicamente uma **função SQL + uma view**; o trabalho real é a métrica honesta, o relógio de expediente e onde isso grita.

## 3. Decisões (fechadas com o founder)

| # | Decisão |
|---|---------|
| 1 | **Consumidores: os dois.** Card na Meu Dia da vendedora + badge na sidebar (só as dela) + painel de supervisão founder/gestor + digest diário por e-mail pro founder. |
| 2 | **Métrica = desde a PRIMEIRA mensagem não respondida** (a `in` mais antiga depois da última resposta humana). Computada das `whatsapp_messages`, não do campo `status`. |
| 3 | **"Respondido" = um humano respondeu** (`direction='out' AND sender_user_id IS NOT NULL`). Exclui de graça blast de campanha e a futura resposta automática da IA (service_role, sem `sender_user_id`). |
| 4 | **Relógio = só horário comercial.** Default **seg–sex 07:30–17:30**, fuso `America/Sao_Paulo` (Brasil sem horário de verão desde 2019). **Configurável** no `company_config`. Feriados **não** tratados na v1. |
| 5 | **Limiares:** atenção (amarelo) **15 min**, atrasado (vermelho) **30 min** de minutos-úteis. Configuráveis. |
| 6 | **E-mail = digest diário** (~18h BRT), reusando o motor da Tarefas (cron SQL local → `fornecedor_alerta` tipo `whatsapp_sla` → `dispatch-notifications` → `NOTIFICATION_EMAIL_TO`). Sem e-mail em tempo real na v1. |
| 7 | **De quem é a conversa = dono ATUAL da carteira, derivado AO VIVO** (`carteira_assignments` por `customer_user_id` + cobertura/férias → responsável efetivo). **Não** confiar no `assigned_operator_id` (é congelado na criação). |
| 8 | **Escopo da vendedora = só na tela** (display-only) com toggle **Minhas / Todas**. RLS do inbox **não muda** (todo staff já lê tudo). Hardening de RLS fica fora de escopo (PR de segurança separado, se o founder quiser). |

## 4. Definição precisa da métrica (com os cuidados do codex)

Para cada conversa, determinar se está **esperando** e desde quando:

1. **Última resposta humana** (`last_human_out`): a mensagem `out` mais recente com `sender_user_id IS NOT NULL`, ordenada de forma determinística por `(coalesce(wa_timestamp, created_at), id)`. `[P2 codex: ordenação determinística]`
2. **Primeira não respondida** (`aguardando_desde`): a mensagem `in` mais antiga com `(coalesce(wa_timestamp, created_at), id)` **maior** que `last_human_out` (ou a `in` mais antiga absoluta, se nunca houve resposta humana), **excluindo** mensagens que são puro comando de opt-out (`PARAR/SAIR/STOP/CANCELAR/DESCADASTRAR` — reusa a lista canônica de `src/lib/whatsapp/`). `[P2 codex: STOP não fica vermelho eterno]`
3. **Âncora = `coalesce(wa_timestamp, created_at)`** da mensagem (hora real que o cliente mandou no WhatsApp, não a hora de processamento do webhook). `[P2 codex: wa_timestamp]`
4. **Não está esperando** (sai da view) quando: a última mensagem é uma resposta humana (`bola com o cliente`), **OU** `status='fechada'` `[P2 codex: fechada]`, **OU** o único `in` pendente é puro stop-keyword.

`opt_out` **não exclui** a conversa do SLA (cliente que mandou pergunta merece resposta, mesmo tendo saído de campanha) — só o stop-keyword **literal** não dispara. `[P2 codex]`

**Divergência registrada do codex:** ele sugeriu excluir todo `type='template'` de "respondido". Eu mantenho o discriminador em `sender_user_id IS NOT NULL` (um humano agiu) e **conto um template MANDADO pela vendedora como resposta válida** — ela engajou. O blast de campanha/IA já cai fora por ter `sender_user_id` nulo. Se o uso mostrar template-humano sendo abusado, revisitamos.

## 5. Arquitetura — SQL é a fonte única

### 5.1 Função `whatsapp_minutos_uteis`
```
whatsapp_minutos_uteis(
  p_desde     timestamptz,
  p_ate       timestamptz,
  p_h_inicio  time   default '07:30',
  p_h_fim     time   default '17:30',
  p_dias      int[]  default '{1,2,3,4,5}'   -- ISO DOW: 1=seg … 7=dom
) returns integer
```
- Soma só o tempo dentro de `[p_h_inicio, p_h_fim)` nos dias de `p_dias`, em `America/Sao_Paulo`. `[P2 codex: intervalos meio-abertos]`
- **0** se `p_desde >= p_ate` (mesmo instante / invertido). `[P2 codex]`
- Itera por **data local** (`AT TIME ZONE 'America/Sao_Paulo'`) de `date(desde)` a `date(ate)`; por dia útil, interseção de `[data+h_inicio, data+h_fim)` com `[desde, ate)`. Clamp por dia, pula sábado/domingo por ISO DOW.
- **Guard de iteração:** cap defensivo (ex.: se o span passar de ~400 dias, parar) — conversa órfã de anos não deve fazer o loop explodir. `[P2 codex]`
- Determinística e `IMMUTABLE`-ish (depende só dos args + regra de fuso fixa).

### 5.2 View `v_whatsapp_sla` (`security_invoker=on`)
- **Config lida UMA vez por query** (CTE `cfg` que faz cast+fallback dos valores do `company_config`), não dentro da função por linha. `[P2 codex: ler config 1×]`
- CTE `base`: aplica a métrica da §4 → conversas esperando, com `aguardando_desde`.
- CTE `owner` (derivação **ao vivo** — §6).
- `SELECT` final por conversa esperando: `conversation_id`, `customer_user_id`, `phone_e164`, `contact_name`, `owner_user_id` (efetivo, pode ser NULL = sem dono), `aguardando_desde`, `minutos_uteis_aguardando = whatsapp_minutos_uteis(aguardando_desde, now(), cfg…)`, `nivel` (`verde` < `cfg.atencao_min` ≤ `amarelo` < `cfg.atrasado_min` ≤ `vermelho`).
- `now()` por linha é OK no volume (dezenas–centenas de conversas ativas). `[P2 codex: perf fine]`

### 5.3 Front (Realtime + refetch leve)
- **Liveness:** Supabase Realtime nas tabelas (já ligado) **+ refetch a cada ~30s** pra o contador "tiquetaquear" (o `now()` da view dá minutos frescos a cada fetch). 30s basta num limiar de 15 min.
- Formatação ("18 min" / "1h05") em helper TS puro testado (`src/lib/whatsapp/sla-format.ts`).
- Sem cálculo de calendário no TS — a regra vive só no SQL (sem espelho TS↔SQL). `[codex: SQL-only é o caminho]`

## 6. Atrelamento conversa → cliente → vendedora (ao vivo)

Dois saltos, resolvidos **na hora da query** (por causa do `[P1 codex]`: o `assigned_operator_id` é gravado só na criação da conversa e **nunca atualiza**):

```
Conversa (phone_e164)
   │  match telefone  ⇄  profiles.phone   →  customer_user_id
   ▼
Cliente (customer_user_id)
   │  carteira_assignments: customer_user_id → owner_user_id
   │  + carteira_coverage (férias) → responsável efetivo
   ▼
Vendedora dona HOJE
```
- O `owner` da view vem de `carteira_assignments` (+ cobertura), **não** do campo congelado. Carteira mudou → no próximo fetch o SLA já mostra a nova dona; ninguém leva culpa alheia. `[P1 codex]`
- **Cada salto pode falhar** → `owner_user_id = NULL` = **"sem dono"**:
  - telefone não bate com cadastro → sem cliente;
  - cliente sem dono na carteira → sem vendedora.
- O balde "sem dono" é sinal útil em si (clientes do WhatsApp não atrelados a ninguém).

## 7. Config (`company_config`)

WhatsApp é o **número central** (org-level, não por empresa) → config **global**. Chaves (text k-v, com cast+fallback na CTE `cfg`): `[P2 codex: validar casts]`
- `whatsapp_sla_hora_inicio` = `07:30`
- `whatsapp_sla_hora_fim` = `17:30`
- `whatsapp_sla_dias` = `1,2,3,4,5`
- `whatsapp_sla_atencao_min` = `15`
- `whatsapp_sla_atrasado_min` = `30`
- `whatsapp_sla_digest_habilitado` = `true`

**Não** reusar `route_disparo_config` — é janela de **disparo de rota** (07:30–15:30), semântica diferente. `[P2 codex]`

## 8. As três superfícies

1. **Inbox `/whatsapp`** — cada conversa na lista ganha selo "esperando há Xmin" colorido por `nivel`. Win barato, vale sozinho.
2. **Meu Dia da vendedora** — card "🔴 N clientes seus esperando" (filtra a view por `owner_user_id = auth.uid()`), clica → abre o inbox. **Badge na sidebar** = contagem dela. **Toggle Minhas / Todas** (default Minhas). Em "Todas" ela enxerga inclusive os **sem dono** e pode pegar.
3. **Painel founder/gestor** (gated `pode_ver_carteira_completa`) — agregado **ao vivo** por vendedora (esperando / amarelos / vermelhos / pior tempo) + **balde "sem dono" em destaque** (badge, não só no digest — senão um cliente sem carteira espera o dia todo invisível). `[P2 codex: sem-dono tem que gritar]`

## 9. Digest por e-mail (Fase 2)

- **Cron SQL local** (~21h UTC / ~18h BRT) — chamada SQL local, sem `net.http_post` (sem a armadilha do timeout de 5s).
- Função `whatsapp_sla_digest_tick()`: agrega a view por vendedora + balde sem-dono → monta corpo → insere **1 linha** em `fornecedor_alerta`.
- **Idempotência:** tabela-guarda `whatsapp_sla_digest_log(data_local date primary key)` — insere a data local PRIMEIRO com `ON CONFLICT DO NOTHING`; só escreve o alerta se a inserção pegou (`FOUND`). Cron repetido/retry → **um e-mail por dia**. `[P1 codex: idempotência]`
- Insert no `fornecedor_alerta` com **todas** as colunas obrigatórias (`empresa`, `tipo`, `severidade`, `status`, **`titulo`**, `mensagem`) — `empresa='oben'` como carrier (padrão do `data_health_watchdog`); estende o **CHECK de `tipo`** com `whatsapp_sla` (igual a Tarefas no bloco D). `[P1 codex: titulo + CHECK]`
- **Destinatário = `NOTIFICATION_EMAIL_TO`** (founder). O `dispatch-notifications` manda todo pendente pra essa env, **não** por destinatário-da-linha. Roteamento por gestor seria mexer no dispatcher → **fora de escopo**. `[P1 codex: como o dispatch funciona]`
- Edição do `dispatch-notifications` (formatar o tipo novo) via chat do Lovable — mesma pendência que a Tarefas teve. **Minimizar:** o `mensagem` já vai pré-renderizado na linha, pro dispatcher só repassar.

## 10. Fases (entregar valor sem depender de deploy de edge)

- **Fase 1** (sem edge, sem e-mail): função + view + config + selos no inbox + card/badge da vendedora + painel do founder. **Zero dependência de Lovable além da migration.** Já vale.
- **Fase 2**: digest cron + e-mail (precisa do `dispatch-notifications` tratar o tipo novo).

## 11. Migration footprint (ritual `lovable-db-operator`)

Tudo via SQL Editor (Lovable não aplica migration custom sozinho):
1. Função `whatsapp_minutos_uteis`.
2. View `v_whatsapp_sla` (`security_invoker=on`).
3. Seed das chaves no `company_config`.
4. **Fase 2:** tabela `whatsapp_sla_digest_log` + função `whatsapp_sla_digest_tick` + cron + extensão do CHECK de `fornecedor_alerta.tipo` (`whatsapp_sla`).
5. Query de validação pós-apply (função existe, view retorna, chaves seedadas).
6. **Fase 2:** editar `dispatch-notifications` via chat do Lovable.

## 12. Testes

- **`whatsapp_minutos_uteis` em PostgreSQL 17 local** (método do picking-bridge): span inteiro fora do expediente; atravessa uma noite; multi-dia; só fim de semana; começa antes das 07:30; termina depois das 17:30; mesmo instante (0); `desde > ate` (0). Asserts de minutos exatos.
- **`v_whatsapp_sla` em PG17 local** com conversas/mensagens semeadas: esperando vs bola-com-cliente; template-out (sem sender) não conta como resposta; template-humano conta; stop-keyword excluído; `fechada` excluída; sem-dono aparece; owner derivado ao vivo + cobertura de férias; ordenação determinística com timestamps iguais.
- **Idempotência do digest:** rodar `whatsapp_sla_digest_tick()` duas vezes → uma linha em `fornecedor_alerta`.
- **Formatter TS** (`sla-format.ts`) — testes vitest ("18 min" / "1h05" / "0 min").

## 13. Não-objetivos da v1

- Hardening de RLS do inbox (display-only; possível PR de segurança separado).
- Roteamento de e-mail por gestor (mudança no `dispatch-notifications`).
- E-mail em tempo real ao estourar o vermelho (só digest diário).
- Calendário de feriados (relógio só seg–sex; feriado = dia normal na v1).
- E-mail pessoal de fim de dia por vendedora (só o digest do founder).
- Flag de controle IA↔humano (o predicado `sender_user_id IS NOT NULL` já protege; flag entra quando a IA autônoma for ao ar).
- Sábado de manhã (chave de config existe via `whatsapp_sla_dias`, default sem sábado).

## 14. Arquivos (estimativa)

- Migration `supabase/migrations/2026060XXXXXXX_whatsapp_sla.sql` (função + view + config) + (Fase 2) digest.
- `src/lib/whatsapp/sla-format.ts` (+ teste).
- `src/queries/useWhatsappSla.ts` (hook: view + Realtime + refetch 30s; toggle Minhas/Todas).
- `src/components/whatsapp/` — selo no inbox, card Meu Dia, painel supervisão, badge sidebar.
- Editar `src/pages/WhatsappInbox.tsx` (selo) + Meu Dia da vendedora + sidebar (badge) + `dispatch-notifications` (Fase 2, Lovable).

## 15. Referência do codex

Consult `019e9349` (gpt-5.5, xhigh). Veredito: "SQL como fonte única está certo; os pontos fracos eram ownership staleness, o que conta como resposta, idempotência do digest, e fingir que filtro de tela é segurança." Os 6 `[P1]` e 8 `[P2]` estão folded acima (cada um marcado no ponto onde entrou).
