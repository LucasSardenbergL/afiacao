# Telefonia — Roteamento de chamada entrante + Transferência manual (design)

> **Status:** design aprovado pelo founder (2026-06-06). Plano de implementação pendente.
> **Origem:** pedido do founder de "transferir uma chamada de uma vendedora para outra ou para outros usuários futuros", que ao detalhar revelou um requisito maior: **roteamento automático do número geral por carteira, com cascata de fallback**.
> **Segunda opinião:** 2 consults Codex (gpt-5.5, xhigh) nesta sessão — topologia/viabilidade do Nvoip + revisão adversária da arquitetura combinada. Revisão adversária do CÓDIGO fica retroativa (a fazer antes de mergear cada PR).

---

## 1. Contexto

A telefonia hoje é **WebRTC via JsSIP** (SIP over WebSocket) contra o ITSP **Nvoip**. Peças que já existem:

- `SipClient` (`src/lib/sip/sip-client.ts`) — wrapper do JsSIP. Guarda a `RTCSession` ativa em `currentSession`. Tem `connect`/`makeCall`/`acceptIncoming`/`rejectIncoming`/`hangUp`/`mute`. Estado `registered`. **Não usa `refer`/`hold`/`sendDTMF` ainda.**
- `WebRTCCallContext` (`src/contexts/WebRTCCallContext.tsx`) — expõe `makeCall`/`endCall`/`acceptIncoming`/`rejectIncoming`/`toggleMute`. Toca preroll LGPD. Loga em `call_log`. **Guarda `makeCall`/`acceptIncoming` com `isLensActive()`** (lente read-only do master — `WebRTCCallContext.tsx:322`/`:453`).
- `IncomingCallModal` (`src/components/call/IncomingCallModal.tsx`) — modal de chamada **entrante**; já identifica o cliente por telefone (`resolveCustomerByPhone`).
- `vendor_sip_credentials` — mapeia `user_id → ramal SIP` (`sip_user`/`sip_pass`/`sip_caller_id`). Servido pela edge `nvoip-sip-creds`. Tela admin `AdminVendorSipCredentials` em **`/admin/sip-credentials`** (hoje fora do menu). Fallback p/ ramal compartilhado (`NVOIP_SIP_USER`).
- `call_log` — registro de chamadas (inbound/outbound, status, missed, dedup por `sip_call_id`). Cron `call-log-missed-backstop` marca `ringing > 90s` como terminal.
- **"telefone → cliente → vendedor DONO"** já resolvido no sistema: `wa_owner_efetivo(customer)` (SECURITY DEFINER, considera cobertura de férias) + `carteira_assignments` + normalização BR (`normalizeBrPhone`/`waPhoneCandidates`).
- Supabase Realtime + integração WhatsApp (Cloud API via BSP 360dialog).

**Topologia (invariante que ancora tudo):** o cliente é um **telefone na rede pública (PSTN)**, não um navegador. O WebRTC só existe na perna **navegador da vendedora ↔ Nvoip**; a perna **Nvoip ↔ celular do cliente** é telefonia tradicional. Quem controla a perna do cliente é o provedor — **disso não se escapa**. Transferir/rotear a chamada do cliente sempre passa pelo Nvoip.

```
Vendedora (WebRTC) ──── Nvoip (B2BUA/gateway) ──── 📱 Cliente (PSTN)
       └── WebRTC ──┘            └── telefonia tradicional ──┘
```

---

## 2. Decisões de produto (com o founder)

| # | Decisão | Escolha |
|---|---------|---------|
| D1 | Escopo | **Duas frentes juntas:** (1) roteamento automático do número geral + (2) transferência manual mid-call. Compartilham fundação. |
| D2 | Estilo da transferência manual | **Cega + card de contexto** (não assistida). O destino recebe contexto via Realtime; attended adiado (v2). |
| D3 | Presença | **Online/offline honesto** na lista de destinos. |
| D4 | Destinos da transferência | **Pessoa→pessoa** (cada destino com ramal individual). Setor/fila adiado (entra pela mesma estrutura quando houver ramal de fila no Nvoip). |
| D5 | Roteamento por carteira ("owner-first") | **Versão degradada** (ring-all + destaque no app). NÃO investir em webhook/PABX no v1. Justificativa: equipe pequena (2 vendedoras) coordena socialmente; owner-first "duro" só compensa com equipe grande. |
| D6 | Cliente sem dono / desconhecido | **Todas as vendedoras tocam juntas** (quem atende primeiro pega), cascata p/ administrativo. |
| D7 | Cascata inteira sem atender | **Registra perdida + avisa no app + dispara WhatsApp automático.** |
| D8 | Validação Nvoip | Spike no app (sem chamado ao suporte) p/ a transferência. O "owner-first dinâmico" fica como **upgrade futuro opcional** (ticket Nvoip / PABX), não bloqueia. |

---

## 3. Viabilidade no Nvoip (achado do Codex)

O Codex pesquisou a documentação pública do Nvoip. Resultado:

**Confirmado na doc (o Nvoip FAZ):** Fluxo com Número Virtual + Menu + **Filas** com estratégias (ring-all, aleatório, mais ocioso…), **timeout de fila + transbordo** p/ outra fila/ação, "sem agentes" → ação final, transferência entre filas, estados SIP/ocupado/DND internos.

**NÃO documentado / incerto:** um **webhook HTTP síncrono por chamada** (Nvoip recebe a chamada → faz POST com ANI/DNIS/call-id pro nosso sistema → usa a resposta pra escolher o ramal). A "API de URA" deles parece ser CRUD da configuração global, **não** call-control em runtime. ⚠️ **Alterar a config global da URA por chamada seria errado** (2 chamadas simultâneas disputariam a mesma config).

**Conclusão:** a **cascata por tempo é viável** (filas estáticas no painel). O **"toca pra dona certa pela carteira" (owner-first dinâmico) é incerto** e provavelmente exigiria um PABX/B2BUA externo (Asterisk/FreePBX/3CX ou CPaaS com call-control) — infra nova fora de Lovable+Supabase. **Por isso o D5 (degradar) — owner-first dinâmico está fora do v1.**

> **Upgrade futuro (registrado, não no v1):** se o founder quiser owner-first "duro", o caminho é (a) abrir ticket no Nvoip perguntando **exatamente** se há nó Webhook/HTTP no Fluxo que faça POST por chamada e aceite o ramal de destino na resposta (pergunta redigida pelo Codex — ver §10), ou (b) PABX gerenciado. Sem isso, owner-first é teatro.

---

## 4. Arquitetura

### 4.1 Fundação compartilhada (vale p/ as 2 frentes)

- **Presença honesta** — 3 sinais separados, presença é *indício* não autoridade:
  - **Telefonia:** `sip_registered`, `in_call`, DND.
  - **App:** sessão ativa + heartbeat recente.
  - **Negócio:** férias/cobertura (já temos via `wa_owner_efetivo`/`carteira_coverage`).
  - Regra conservadora: `disponível = cobertura válida AND app heartbeat não expirado AND sip_registered AND não in_call AND não DND`.
- **"telefone → dono"** — reusa `wa_owner_efetivo` (já existe). RPC única indexada, rápida (alvo p95 ≤300ms se algum dia virar síncrona).
- **Ramais por pessoa** — reusa `vendor_sip_credentials` + nome do perfil; estende com flag "é destino" + categoria + role.
- **Registro = Postgres é a fonte da verdade; Realtime apenas notifica** (Realtime pode perder evento). Card lido do banco.
- **Card de contexto** no destino (quem está recebendo): "Fulano te passou o cliente X (carteira, último pedido…)".

### 4.2 Frente 1 — Roteamento do número geral (degradado)

Fluxo:

```
Cliente liga → (37) 3222-1035  [Número Virtual no Nvoip]
      │
      ▼
  Fila ring-all de VENDAS (Regina + Tatyana tocam JUNTAS)
   └─ o app de cada vendedora identifica o cliente (resolveCustomerByPhone)
      e DESTACA conforme quem é o dono:
        dono:    ⭐ "SEU cliente — atenda!"   (realce forte + som)
        outros:     "(cliente da Regina)"      (discreto)
      │  timeout da fila (ninguém atende)
      ▼
  Ramal do ADMINISTRATIVO
      │  timeout (não atende)
      ▼
  Terminal: chamada perdida
   └─ registra em call_log + alerta no app + WhatsApp automático
```

- **Onde vive a cascata:** no **Nvoip** (filas estáticas + timeout + transbordo), **não** em edge function. Config de painel (founder faz; spec lista o quê).
- **Tempos:** o "20s/10s" do requisito original se traduz, na degradada, em **timeout da fila de vendas** (todas juntas, ex. 20–30s) + **timeout do administrativo** (ex. 10s). Configuráveis no Nvoip. **Não existe mais "20s só pra dona"** — sem owner-first dinâmico, a dona não toca antes das outras (só recebe o destaque no app).
- **O "owner-first" é só o destaque no app** (D5). Todas as vendas tocam juntas; o app **não** tenta suprimir/rejeitar remotamente os INVITEs dos outros (frágil — aba suspensa, presença stale, respostas SIP concorrentes). Coordenação social entre as 2.
- **Reuso:** o destaque é uma melhoria no `IncomingCallModal` (que já identifica o cliente). Cada app compara `user.id` com o dono efetivo do cliente e renderiza dono vs não-dono.
- **Perdida + WhatsApp:** o navegador **não é autoridade** pra "ninguém atendeu" (cada JsSIP vê só sua perna). Fonte ideal = **evento de fim de chamada do Nvoip** (webhook de evento / CDR — mais comum que o de roteamento; confirmar). Fallback: heurística via `call_log` + o backstop de `ringing>90s` que já existe. WhatsApp via **outbox idempotente** (`unique(call_log_id, notification_type)`).

### 4.3 Frente 2 — Transferência manual (mid-call)

- Vendedora em ligação clica **"Transferir"** (no dialer dono da chamada — `callOwnerId`) → seletor de destinos (pessoas com ramal, agrupados por categoria, com bolinha de presença) → escolhe.
- **`SipClient.transferCall(ramal)`** — tenta o caminho ao vivo: **`*2`+ramal via DTMF** (documentado pelo Nvoip; `session.sendDTMF`) **e/ou `session.refer('sip:RAMAL@dominio')`** — qual usar é decidido pelo **spike** (gate). O REFER tem melhor rastreio (NOTIFY sipfrag); o `*2` é o caminho oficial do Nvoip.
- **Guard de lente:** `transferCall` checa `isLensActive()` e bloqueia na lente (igual `makeCall`).
- **Handoff registrado** (Postgres) + **card de contexto** no destino + **"ligar de volta"** como backstop manual (NÃO callback automático após timeout de REFER — risco de chamada dupla; é decisão explícita do humano).
- **Não depender da detecção de sucesso** do REFER (NOTIFY de ITSP costuma ser furado). O handoff + card + ligar-de-volta é a rede de segurança determinística.

---

## 5. Schema (enxuto — org única, sem multi-tenant)

> Filtrado da sugestão do Codex, cortando over-engineering. Detalhes finais se firmam no plano + skill `lovable-db-operator`.

- **`vendor_sip_credentials`** (estender): `is_transfer_destination boolean default false`, `transfer_category text` (`vendas`/`gestao`/`financeiro`/`separacao`/`tintometrico`/…), `role text` (`sales`/`admin`), `display_label text null` (default = nome do perfil), `fallback_order int null`.
- **`call_handoffs`** (transferência manual): `id`, `root_call_id`, `from_user_id`, `to_user_id`, `customer_user_id null`, `method` (`refer`/`dtmf`), `status` (`requested`/`executing`/`succeeded`/`failed`/`unknown`), `requested_at`, `completed_at null`, `failure_reason null`, `context jsonb`. +RLS staff.
- **`telephony_presence`** (sessão, não booleano por user — múltiplas abas): `session_id`, `user_id`, `sip_registered`, `app_connected`, `in_call`, `dnd`, `last_heartbeat_at`, `expires_at`. (Pode ser Realtime Presence + um espelho leve no Postgres p/ leitura confiável.)
- **`call_log`** (garantir campos de correlação): `root_call_id`, `provider_call_id`, `provider_leg_id null`, `answered_by_user_id null`, `final_disposition` (distinguir `missed` de `caller_abandoned`).
- **Outbox de notificação** (WhatsApp de perdida): `unique(call_log_id, notification_type)`.
- **`call_routing_settings`** (singleton, config da cascata — referências às filas do Nvoip + timeouts + `admin_user_id` + `missed_whatsapp_enabled`). Mantém o app ciente da config que vive no Nvoip.

> ⚠️ Migrations = aplicação **manual** no SQL Editor do Lovable (ver CLAUDE.md §5). Usar a skill `lovable-db-operator`.

---

## 6. Gates de viabilidade / validações empíricas

| Gate | Frente | Como validar | Se falhar |
|------|--------|--------------|-----------|
| `*2`/REFER funciona via WSS no ramal WebRTC | F2 | **Spike**: `transferCall` mínimo + 2 ramais de teste; observar resposta (202 vs 405/501), ramal B tocar, NOTIFYs, caller-id que B vê. Capturar log JsSIP (`Allow:`/`Supported:`). | Transferência manual cai no "ligar de volta" (handoff sem o leg ao vivo). |
| Nvoip avisa "chamada terminou sem atendimento" (evento/CDR) | F1 | Configurar a fila de teste + ver se há webhook de evento / consultar CDR. | Perdida+WhatsApp usa fallback heurístico via `call_log` (menos preciso). |
| Filas estáticas + timeout + transbordo | F1 | Montar no painel: `vendas ring-all → admin → terminal`; testar offline/ocupado/DND/no-answer/2-simultâneas/hangup. | (confirmado na doc; baixo risco) |
| "Ocupada passa na hora" | F1 | Teste real (depende de `486 Busy`/DND/call-waiting). | Aceitar que ocupado espera o timeout. |

> ⚠️ **Voicemail:** não pôr destinos pessoais com correio de voz na fila — o voicemail "atende" a perna e rouba a chamada.

---

## 7. Fases (ordem de menor risco)

1. **Configurar filas no Nvoip** (painel — founder; spec lista): `vendas ring-all → admin → terminal de perdida`. Testar os cenários de §6.
2. **Fundação:** presença honesta (SIP+app+negócio) + identificação do cliente na chamada entrante.
3. **Frente 1 (degradada):** destaque da dona no `IncomingCallModal` + perdida → `call_log` + WhatsApp (outbox idempotente; fonte de "perdida" = evento Nvoip ou fallback).
4. **Frente 2:** spike `*2`/REFER (gate) → `SipClient.transferCall` + `WebRTCCallContext.transferCall` (com guard de lente) → UI "Transferir" + seletor com presença → `call_handoffs` + card de contexto + "ligar de volta". Link da tela de ramais no menu + campos novos.

> F2 pode ser construída em paralelo enquanto a F1 (config Nvoip) decanta — mas F2 não deve mascarar que o owner-first dinâmico ficou fora (D5).

---

## 8. Não-objetivos (YAGNI no v1)

- **Owner-first dinâmico** (webhook por chamada / PABX) — degradado p/ ring-all + destaque (D5).
- **Transferência assistida** (com consulta) — v2.
- **Setor/fila como destino** — entra pela mesma estrutura quando houver ramal de fila no Nvoip (D4).
- IA recepcionista; ACD implementado em edge function; motor genérico de regras; score/least-idle; presença "perfeita"; supressão remota de INVITEs; multi-tenant; browser-relay (A como ponte de mídia — não é transferência).

---

## 9. Riscos e armadilhas (do Codex)

- **Dois atendem no ring-all** — só o Nvoip arbitra o primeiro `200 OK` e cancela as outras pernas. Não tentar no app.
- **Presença stale** — "online" não garante atendimento; ausência recente é sinal mais confiável que presença positiva.
- **ANI inconsistente** — preservar `ani_raw` + gerar E.164; **não inventar DDD ausente**. Número privado/restrito → tratar como desconhecido.
- **Telefone compartilhado por 2 clientes** → resultado ambíguo cai em **sem-dono**, não escolhe arbitrário. Cliente com vários telefones → modelar 1:N.
- **Webhook/consulta lenta** (se algum dia síncrona) → fail-open p/ ring-all de vendas; nunca derrubar; ringback antes/durante (nunca silêncio).
- **Loop de transbordo** → fluxo é DAG com máximo de etapas + terminal.
- **Eventos duplicados/fora de ordem** → upsert por `provider_call_id (+leg)`.
- **WhatsApp duplicado** → outbox `unique(call_log_id, notification_type)`.
- **`call_log` do navegador não é autoridade** pra missed — fechamento vem do Nvoip ou reconciliação.
- **REFER cria novas pernas** → manter `root_call_id`/`parent_leg_id`; handoff separado.
- **Lente read-only** → `transferCall` (e qualquer mutação SIP nova) tem que checar `isLensActive()`.

---

## 10. Pergunta exata ao suporte Nvoip (p/ o upgrade futuro de owner-first — fora do v1)

> "No recebimento de uma chamada em um Número Virtual, existe um nó Webhook/HTTP no Fluxo que faça POST, **antes do roteamento**, contendo ANI, DNIS e um call-id imutável, **aguarde a resposta** e permita escolher um usuário SIP ou fila diferente **para cada chamada**? (Não é editar a URA pela API — é call-control em runtime.) Favor enviar documentação, payload, formato da resposta, timeout, retries e destino de fallback. Também: há webhooks de **eventos** da chamada (ringing/answered/busy/no-answer/hangup) com assinatura e retries? O plano atual da conta suporta isso?"

---

## 11. Referências

- Codex consults (gpt-5.5, xhigh), 2026-06-06 — topologia/viabilidade + arquitetura combinada.
- [Nvoip: Fluxo e filas](https://suporte.nvoip.com.br/portal/pt/kb/articles/fluxo) · [Call Center/ring-all/presença](https://suporte.nvoip.com.br/portal/pt/kb/articles/como-usar-o-call-center-em-tempo-real-no-painel-nvoip) · [transferência `*2`](https://www.nvoip.com.br/blog/transferencia-de-ligacao/) · [API Nvoip](https://www.nvoip.com.br/api/) · [FreePBX](https://suporte.nvoip.com.br/portal/pt/kb/articles/como-configurar-o-freepbx)
- [JsSIP RTCSession (`refer`/`sendDTMF`)](https://jssip.net/documentation/api/session/) · [RFC 5589 — SIP Call Transfer](https://www.rfc-editor.org/info/rfc5589)
- Spec anterior: `docs/superpowers/specs/2026-05-23-central-telefonia-design.md`.
