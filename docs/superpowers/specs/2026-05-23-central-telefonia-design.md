# Central de Telefonia — Design Spec

> **Data:** 2026-05-23
> **Status:** aprovado no brainstorming, pronto pra planejar
> **Autor:** brainstorming colaborativo (Lucas + Claude) com 2ª opinião do codex

## Goal

Uma página dedicada de telefonia ("Central de Telefonia") onde qualquer staff comercial pode **ligar para qualquer número** (não só clientes cadastrados) e ver o **histórico de chamadas com identificação de quem é (BINA)**: feitas, recebidas e perdidas. Hoje só dá pra ligar via link/dialer atrelado a um cliente cadastrado — não existe discador livre nem histórico de chamadas no app.

## Contexto técnico (estado atual)

- **2 backends de telefonia**, escolhidos por `useFeatureFlag('useWebRTCCall', false)` via `useCallBackend()`:
  - **Nvoip click-to-call** (default): edge function `nvoip-calls`, API `https://api.nvoip.com.br/v2` (OAuth). Liga pro ramal do vendedor, depois conecta o cliente.
  - **WebRTC** (opt-in): JsSIP sobre WSS. Navegador registra no ramal SIP e fala direto. `makeCall` captura áudio via `getUserMedia` + mixa preroll LGPD.
- **Inbound** só chega ao app via registro SIP do WebRTC: `src/lib/sip/sip-client.ts` emite `incomingCall`; `src/components/call/IncomingCallModal.tsx` (montado global em `AppShellLayout`) mostra Atender/Rejeitar.
- **BINA** já existe: `src/lib/call-session/resolve-customer.ts` → `resolveCustomerByPhone(phone)` busca `customer_contacts` (nome+cargo) por últimos-8-dígitos `ilike`, fallback `profiles.phone`. Retorna `{ customerUserId, contactName, contactCargo }` ou nulls.
- **`makeCall(phone: string)`** liga pra qualquer número — não precisa de cliente.
- **`farmer_calls`** (tabela existente) é **centrada em coaching/scoring de vendas**: dispara recálculo de score, é consumida pelo Customer 360/scoring, tem enums comerciais (`farmer_call_type`: reativacao/cross_sell/up_sell/follow_up; `farmer_call_result`: contato_sucesso/sem_resposta/ocupado/...). `customer_user_id` é nullable; tem `transcript`/`analyses`/`entities_extracted`/`call_backend`/`phone_dialed`. **Não tem `direction` nem estado telefônico.**
- **Limitação Nvoip confirmada:** a API v2 documentada (SDKs node/php oficiais) NÃO expõe CDR/listar-chamadas nem webhook de inbound. Só: oauth, balance, sms, `calls/` (ligar), `calls?callId=` (status de UMA), otp, wa/*. → histórico tem que ser **capturado app-side**, com schema preparado pra um sync futuro caso a Nvoip confirme CDR/webhook.

## Decisões do brainstorming

1. **Escopo:** Central de Telefonia completa (página dedicada), não só um discador rápido.
2. **Fonte do histórico:** captura **app-side agora** (o que passa pelo app com WebRTC registrado), schema pronto pra sync futuro do Nvoip. Completude com app fechado = Fase 2, **desprioritizada**.
3. **Visibilidade:** cada vendedor vê as próprias (RLS por `farmer_id`); gestor vê o time. **`commercial_role` NÃO tem `gestor`** — o gate de "Time" usa `gerencial`/`estrategico`/`super_admin` (commercial_role) ou app role `master`. (`persona-detect.ts` já mapeia `gerencial → persona gestor`.)
4. **Perdidas:** badge no item "Telefonia" do menu (contagem de **não-lidas**, conceito `acknowledged_at`) + aba Perdidas com "Ligar de volta".
5. **Critério de gravação (LGPD):** auto-gravação + preroll da Sara para **cliente OU fornecedor cadastrado**. Avulso/não-identificado = liga sem gravar por padrão, mas com **toggle manual "gravar"** (que dispara a Sara). **Invariante:** sempre que grava, a Sara toca antes. Fornecedor hoje é **dormente** (sem telefone no banco) → cai no toggle manual até existir esse dado.
6. **Caller-ID único da empresa:** todo outbound apresenta **um único número da empresa** pro cliente, independente do vendedor. Não comprar múltiplos DIDs; cliente já tem "o número da empresa" salvo. Vários números = problema. Adicionar vendedores não cria números novos.
7. **Modelo de dados:** tabela nova `call_log` (codex-validado), separada de `farmer_calls`.

## Arquitetura

### 1. Modelo de dados — nova tabela `public.call_log`

Fonte de verdade telefônica (operacional). `farmer_calls` continua sendo a tabela de coaching e se **liga** ao `call_log` quando a chamada vira conversa registrada.

Campos:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid PK default gen_random_uuid() | |
| `farmer_id` | uuid not null | quem fez/recebeu — base da RLS |
| `direction` | enum `call_direction` (`inbound`,`outbound`) | |
| `status` | enum `call_status` (`ringing`,`answered`,`missed`,`rejected`,`busy`,`failed`,`canceled`,`ended`) | estado telefônico (≠ resultado comercial) |
| `provider` | text check in (`nvoip_click_to_call`,`nvoip_sip`,`manual`) | |
| `provider_call_id` | text null | id da chamada no provedor (quando houver) |
| `sip_call_id` | text null | SIP Call-ID — chave de dedup |
| `customer_user_id` | uuid null | cliente, se BINA resolveu |
| `matched_contact_id` | uuid null | contato resolvido (customer_contacts) |
| `match_confidence` | text null (`exact`,`last8`,`none`) | rastro da BINA (não sobrescrever sem audit) |
| `phone_e164` | text null | número normalizado |
| `phone_raw` | text null | número original discado/recebido |
| `caller_id_used` | text null | número da empresa apresentado (auditoria do caller-ID único) |
| `recorded` | boolean not null default false | gravou? (indicador 🎙️) |
| `started_at` | timestamptz not null default now() | |
| `answered_at` | timestamptz null | |
| `ended_at` | timestamptz null | |
| `duration_seconds` | int not null default 0 | |
| `acknowledged_at` | timestamptz null | perdida "lida" (zera badge) |
| `source` | text not null default `app` (`app`,`cdr`,`webhook`,`backfill`) | prep p/ sync |
| `source_payload` | jsonb null | payload bruto do provedor (Fase 2) |
| `last_synced_at` | timestamptz null | prep p/ backfill idempotente |
| `farmer_call_id` | uuid null FK → farmer_calls(id) | liga à conversa de coaching |
| `created_at` | timestamptz not null default now() | |

Constraints/índices:
- `unique(provider, provider_call_id)` parcial `WHERE provider_call_id IS NOT NULL`.
- `unique(provider, sip_call_id)` parcial `WHERE sip_call_id IS NOT NULL`.
- índice `(farmer_id, started_at DESC)`.
- índice parcial p/ badge: `(farmer_id) WHERE direction='inbound' AND status='missed' AND acknowledged_at IS NULL`.

RLS (própria, NÃO herda a do `farmer_calls`):
- SELECT/INSERT/UPDATE do próprio: `farmer_id = auth.uid()`.
- SELECT do time (aba Time): `commercial_role IN ('gerencial','estrategico','super_admin')` OU app role `master` (via helper `has_role`). Reusar/estender o padrão de RLS já existente no projeto.

### 2. Lógica de captura — `src/lib/call-log/`

Lib fina que escreve via `supabase.from('call_log')` (RLS por `farmer_id`); sem edge function nova no caminho normal. Chamada de 3 pontos existentes: `WebRTCCallContext` (makeCall + fim), `IncomingCallModal` (inbound), fluxo Nvoip click-to-call.

**Saída (outbound):**
- Ao iniciar (manual ou click-to-call): `upsert` `{ direction:'outbound', status:'ringing', provider, phone_e164, phone_raw, caller_id_used, recorded }`. Vale WebRTC e Nvoip.
- Ao atender/encerrar: `update` → `answered`/`ended` + timestamps + `duration_seconds`.

**Entrada (inbound / perdida):**
- No INVITE (`incomingCall`): `upsert ... ON CONFLICT (provider, sip_call_id) DO NOTHING` → `{ direction:'inbound', status:'ringing' }`. BINA roda aqui e grava `customer_user_id`/`matched_contact_id`/`match_confidence`.
- Atendeu → `update status='answered' WHERE status='ringing'` (atômico: em multi-aba só quem atende ganha).
- Rejeitou → `rejected`. Caller desistiu (cancel/bye sem answer) → `missed`. Encerrou → `ended`+duração.

**Dedup multi-aba/dispositivo:** `unique(provider, sip_call_id)` + `ON CONFLICT DO NOTHING` garante uma linha; update condicional `WHERE status='ringing'`.

**Backstop perdida (aba fechou no toque):** cron `pg_cron` (1–2 min) marca `status='missed'` onde `status='ringing'` e `started_at < now() - interval '90 seconds'`. Caminho primário é imediato (evento cancel do SIP); cron é só rede de segurança. **Migration custom → aplicar manual no SQL Editor do Lovable.**

**Mudança no `sip-client.ts`:** propagar `sip_call_id` (header SIP Call-ID) + eventos `failed/ended/rejected/canceled` com causa (hoje só emite phone/displayName/receivedAt). Sem isso não há dedup nem fechamento de estado.

**Não misturar dimensões:** `call_log.status` (telefônico) ≠ `farmer_call_result` (comercial, fica no `farmer_calls`).

### 3. Critério de gravação (LGPD)

A BINA resolve o número **antes de conectar** (na discagem outbound ou no INVITE inbound). Regra:

| Situação | Preroll Sara | Gravação | Transcrição/copilot | `farmer_calls` | `call_log.recorded` |
|---|---|---|---|---|---|
| Resolve p/ **cliente cadastrado** | ✅ obrigatório | ✅ auto | ✅ | ✅ cria + linka | true |
| Resolve p/ **fornecedor cadastrado** | ✅ obrigatório | ✅ auto | ✅ | ✅ cria + linka | true |
| **Avulso / não-identificado** | só se ligar o toggle | opcional (toggle manual) | só se gravar | só se gravar | = toggle |

- **Invariante LGPD:** sempre que `recorded=true` (auto ou manual), a Sara toca ANTES de gravar.
- **Toggle manual "gravar":** disponível no discador e no card de chamada ativa, pra qualquer número não-identificado. Ligar o toggle dispara Sara + gravação (+ transcrição + linka `farmer_calls`).
- **Fornecedor dormente:** não há telefone de fornecedor no banco (`fornecedor_*` só tem nome/razão/CNPJ), então a BINA não auto-detecta fornecedor por enquanto — ele cai na regra do avulso (toggle manual). O ramo "fornecedor → auto-gravar" fica **pronto no código** (a função de resolução já contempla uma fonte de fornecedor), só ativando quando existir telefone de fornecedor cadastrado.
- Ponto de decisão num único lugar (lib de captura / makeCall), fácil de evoluir pra config por empresa.

### 4. Caller-ID único da empresa

- O número apresentado pro cliente em **todo outbound** vem de **uma config única de empresa** (ex.: chave `nvoip_outbound_caller_id` em `company_config`), NÃO do `vendor_sip_credentials.sip_caller_id` por vendedor.
- Cada vendedor mantém o próprio ramal (`sip_user`/`sip_pass`) pra auth + inbound; só o **caller-ID apresentado** é compartilhado.
- Gravar `caller_id_used` no `call_log` pra auditoria.
- **Dependência a confirmar com a Nvoip:** o caller-ID de saída é setável por chamada (param da API/SIP) ou é configurado no ramal/conta? Isso define se centralizamos no código (param) ou na config Nvoip de cada ramal (todos apontando pro mesmo DID).

### 5. UI — página `/telefonia`

Layout (tema claro, igual app):
- **Rail esquerdo fixo — Discador:** input de número + teclado numérico 3×4 + botão "Ligar" (verde). Mostra backend ativo (NVOIP/WEBRTC) e ✓ LGPD. Usa `useCallBackend().makeCall`.
- **Área direita — Histórico em abas:** Recentes · Recebidas · Perdidas (n) · Feitas · **Time** (só gestor/master).
  - Linha: ícone de direção (↗ saída / ↘ entrada; vermelho p/ perdida) · **BINA** (nome+cargo, ou "Desconhecido") · número · tempo relativo · status/duração · ação contextual.
  - Ação: cliente conhecido → "▸ ver cliente" (Customer 360) + religar; avulso → "religar" (+ "Salvar contato" = Fase 2). 🎙️ quando `recorded`.
- **Chamada ativa:** reusa `CallDialerView` (card de status com timer/mute/encerrar/LGPD) + **toggle "gravar"** quando o número não é identificado (cliente/fornecedor já gravam auto).
- **Sidebar:** item "Telefonia" com badge vermelho = perdidas não-lidas (`acknowledged_at IS NULL`); zera ao abrir a aba Perdidas ou ligar de volta.
- Acesso **staff-only** (não cliente logado).

Componentes (isolados, uma responsabilidade cada):
- `src/pages/Telefonia.tsx` — página/rota.
- `src/components/telefonia/DialPad.tsx` — discador livre.
- `src/components/telefonia/CallHistoryTabs.tsx` — abas + filtros.
- `src/components/telefonia/CallHistoryRow.tsx` — linha (BINA + ações).
- `src/hooks/useCallLog.ts` — query do histórico (react-query, paginado) + mutações de `acknowledge`.
- `src/lib/call-log/record.ts` — escrita do log (insert/upsert/update) consumida pelos contexts.
- Badge: estender o mecanismo de badges da sidebar (`AppShell.tsx`).

## Fases

**MVP (este spec):** `call_log` + RLS + enums; captura app-side (saída/entrada/perdida + cron backstop + dedup); `sip-client.ts` propagando `sip_call_id`+eventos; página `/telefonia` (discador + abas + BINA + badge); gravação gated por cliente cadastrado; caller-ID único de empresa.

**Fase 2 (depende da Nvoip, desprioritizada):** sync CDR/webhook (completa histórico com app fechado via upsert idempotente que o schema já comporta); "Salvar como contato" do avulso.

## Itens em aberto / dependências (não bloqueiam o MVP de código)

1. **Suporte Nvoip:** (a) existe CDR/relatório ou webhook de chamada (inbound + bilhetagem)? (define Fase 2); (b) caller-ID de saída é por chamada (param API/SIP) ou config do ramal? (define §4).
2. **Rollout de ramais por vendedor:** cada vendedor precisa do próprio ramal Nvoip + linha em `vendor_sip_credentials`; inbound com **um único DID** exige ring-group/fila na Nvoip (operacional/config Nvoip, fora do código).

## Fora de escopo (YAGNI — fazer só DEPOIS de tudo)

Auto-detecção/auto-gravação de **fornecedor** por telefone (sem dado no banco hoje — gravação manual via toggle cobre) · analytics avançado de time · gerar tarefa de follow-up na agenda a partir da perdida · "Salvar contato" (Fase 2) · qualquer integração Nvoip de CDR antes de confirmação do suporte.

## Touchpoints no código existente

- `src/contexts/WebRTCCallContext.tsx` — `makeCall`/`persist`/handlers inbound: chamar a lib de captura + aplicar critério de gravação.
- `src/components/call/IncomingCallModal.tsx` — escrever inbound no INVITE/answer/reject.
- `src/lib/sip/sip-client.ts` — propagar `sip_call_id` + eventos failed/ended/rejected/canceled.
- `src/hooks/useCallBackend.ts` / `src/components/call/Dialer.tsx` — o discador livre reusa `makeCall`.
- `src/components/call/CallDialerView.tsx` — reusado pra chamada ativa.
- `src/components/AppShell.tsx` — badge de perdidas + item de menu.
- `nvoip-sip-creds` / `company_config` — caller-ID único de empresa.
- Migration custom (`call_log` + enums + RLS + cron) → **aplicar manual no SQL Editor do Lovable** (ver CLAUDE.md §5).
