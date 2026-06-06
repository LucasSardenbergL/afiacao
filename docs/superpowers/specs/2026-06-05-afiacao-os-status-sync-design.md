# Sincronização de andamento: pedido de afiação → etapa da OS no Omie (Colacor SC)

**Data:** 2026-06-05
**Status:** aprovado no brainstorm (founder + codex), aguardando review do spec
**Idioma:** pt-BR

---

## 1. Objetivo

Quando um pedido de afiação **anda** (muda de status no app), a **etapa (`cEtapa`)** da Ordem de Serviço correspondente no Omie da **Colacor SC** deve acompanhar **automaticamente e de forma confiável**.

Hoje a OS é criada no Omie (funciona), mas a etapa **nunca é atualizada** depois — fica congelada no estágio inicial. Esta feature liga esse sync.

**Não-objetivos (explícitos):**
- **Não** faturar / emitir NF de serviço. Faturamento segue manual, dentro do Omie, pelo founder.
- **Não** criar a OS (já existe via `sync_order`).
- **Não** sincronizar a aprovação do orçamento como evento de negócio (ela é só mais uma mudança de status, tratada pelo mesmo mecanismo).
- **Não** tocar na OS uma vez entregue (ver §4: `entregue` = mantém).

---

## 2. Contexto verificado (estado atual no código)

A integração afiação ↔ Omie **já existe** e aponta pra Colacor SC. Tudo abaixo está em `supabase/functions/omie-sync/index.ts` (verificado em `origin/main`):

- **Credenciais:** `OMIE_COLACOR_SC_APP_KEY` / `OMIE_COLACOR_SC_APP_SECRET` (empresa de serviços, regime simples).
- **Criação da OS** (`action: sync_order`, **staff-only**): chamada pelo wizard de pedido unificado (`src/services/orderSubmission/submitOrder.ts` → `src/services/omieService.ts::syncOrderToOmie`). Resolve/cria o cliente no Omie → cria a OS (`servicos/os/IncluirOS`) → grava em **`omie_ordens_servico`** → insere a linha em **`public.orders`** (status `pedido_recebido`) → email pra administração. **Confirmado pelo founder: a OS aparece de fato no Omie hoje.**
- **`alterarOrdemServicoOmie(...)`** (linha ~458): **existe mas está DORMENTE** (nenhum caller a invoca). Busca a OS por `order_id`, **remonta `ServicosPrestados` reenviando itens+preços do app**, mapeia status→`cEtapa` e chama `AlterarOS`.
- **`action: update_order`** (linha ~986): chama `alterarOrdemServicoOmie`, mas é **staff-JWT-only** (lê `userId` do JWT e exige `user_roles.role IN (master, employee)`). Cron/service_role (`userId` null) → **403**. Nenhum caller no front a usa.
- **`ConsultarOS`** (linha ~1229): **já é usado** na própria função (há interface `OmieConsultarOSResponse`) → o padrão "puxar a OS atual do Omie" é viável e tem precedente.
- **Auth helper** `_shared/auth.ts::authorizeCronOrStaff` → retorna `{ via: 'cron' | 'service_role' | 'staff', userId? }`. O `serve` já chama isso no topo; cada action faz seu gate interno.

### Tabelas

- **`public.orders`** (afiação): `id`, `user_id`, `items` (jsonb), `service_type`, `status`, `subtotal`, `delivery_fee`, `total`, `delivery_option`, `notes`, `created_at`, `updated_at`. **Sem coluna de empresa** (afiação é mono-empresa = Colacor SC).
- **`public.omie_ordens_servico`**: `order_id`, `omie_codigo_os` (nCodOS), `omie_numero_os` (cNumOS), `status` (`criado`/`atualizado`/`erro_atualizacao`), `payload_enviado`, `resposta_omie`, `created_at`, `updated_at`.

### Onde o status muda hoje (a superfície do gatilho)

- `src/pages/Admin.tsx:99` — handler do `KanbanBoard` (`onStatusChange`), cobre **todas** as transições de andamento via drag.
- `src/pages/OrderDetail.tsx:122` — aprovação do orçamento (`orcamento_enviado → aprovado`), feita pelo **cliente** (não-staff).

Como o `orders` só é inserido server-side (via `sync_order`) e o status muda por múltiplos caminhos (incl. cliente e SQL manual), o gatilho tem que ser no **banco**, não no front.

---

## 3. Arquitetura (Abordagem B — trigger → fila → cron → edge cron-authed)

Decisão do founder + codex. Espelha o idiom comprovado do repo pra escrita no Omie (que é flaky): **trigger → fila → cron (`pg_cron`) → edge gateada por `x-cron-secret`** + backoff + observabilidade. Client-side (A) perde evento e não cobre o cliente; `net.http_post` direto (C) acopla ao Omie flaky e falha em silêncio.

```
orders  (AFTER UPDATE OF status)
   │  trigger: etapa_alvo_novo = mapear_status_etapa(NEW.status)
   │           etapa_alvo_velho = mapear_status_etapa(OLD.status)
   │  enfileira SÓ se etapa_alvo_novo IS NOT NULL e ≠ etapa_alvo_velho   ← dedup por etapa
   ▼
afiacao_os_sync_fila   (UPSERT por order_id → 1 linha/pedido, sempre o alvo mais novo)
   ▼
cron  afiacao-os-sync  (*/5 * * * *, net.http_post COM timeout_milliseconds explícito)
   ▼
omie-sync  action "sync_os_status"  (gate: via === 'cron' | 'service_role')
   • pg_try_advisory_xact_lock (1 worker por vez)
   • SELECT da fila: pendentes com next_retry_em ≤ now(), ORDER BY criado_em, LIMIT 25
   • por item:
       - acha a OS em omie_ordens_servico (sem OS → erro recuperável: tentativas++, refila)
       - RECALCULA etapa do status ATUAL do orders (não confia na fila velha)
       - etapa_atual IS NULL  → noop, remove da fila  (ex.: virou 'entregue')
       - etapa_atual == last_etapa_sincronizada → noop, remove da fila  (idempotência)
       - senão → alterarEtapaOS(nCodOS, etapa_atual)  (status-only, §5)
            sucesso → grava last_etapa_sincronizada/last_status_sincronizado/last_sync_at,
                      remove da fila
            erro Omie (flaky) → tentativas++, next_retry_em = now()+backoff, last_sync_error
            teto de tentativas → status='erro', sai da fila (sinal pro watchdog)
```

**Por que recalcular na edge:** a fila pode estar velha (pedido andou de novo entre o enqueue e o drain). A verdade é o `orders.status` no momento do processamento. O `etapa_alvo` da fila serve só pra ordenar/priorizar.

---

## 4. Mapa status → etapa Omie (com os fixes do codex)

Helper puro **`mapearStatusEtapa(status: string): string | null`** (TS, TDD) — `null` = "não sincroniza, mantém a OS como está". Espelhado **verbatim** na função SQL `mapear_status_etapa(text)` e na edge.

| status do app | `cEtapa` | rótulo Omie | nota |
|---|---|---|---|
| `pedido_recebido`, `aguardando_coleta`, `orcamento_enviado`, `aprovado` | `'10'` | Aberta | explícito (não cai em default) |
| `em_triagem`, `em_afiacao`, `controle_qualidade` | `'20'` | Em andamento | |
| `pronto_entrega`, `em_rota` | `'30'` | Aguardando faturamento | |
| `entregue` | **`null`** | — | **mantém a etapa do Omie como está** (decisão do founder) |
| qualquer outro / desconhecido | `null` | — | fail-safe: não sincroniza status estranho |

**Fixes do codex embutidos:**
- 🔴 **(a) `entregue` NÃO vira `50` "Faturada".** Marcar Faturada sem NF fingiria um faturamento inexistente. Decisão do founder: **`entregue` = mantém** (`null`). O app sincroniza só o andamento operacional (10→20→30) e entrega a OS daí pra frente; faturamento/fechamento/cancelamento ficam manuais no Omie, e o app **nunca sobrescreve** uma etapa pós-entrega que o founder mexeu na mão.
- 🔴 **(b) status-only** (não reenviar serviços) — ver §5.
- Status que antes caíam no default (`orcamento_enviado`, `aprovado`, `controle_qualidade`) agora são **explícitos** no mapa (codex: não deixar virar comportamento acidental).

---

## 5. `alterarEtapaOS` — AlterarOS status-only (não sobrescreve serviços)

Função nova na edge. **Não** remonta `ServicosPrestados` a partir do app (o `alterarOrdemServicoOmie` antigo faz isso e fica **intacto** pro caso staff que quer reescrever a OS inteira via `update_order`).

```
alterarEtapaOS(nCodOS, etapaAlvo):
   os = ConsultarOS(nCodOS)                 // estrutura ATUAL do Omie
   AlterarOS({
     Cabecalho: { nCodOS, cEtapa: etapaAlvo },   // troca SÓ a etapa
     ServicosPrestados: os.ServicosPrestados,    // reenvia o que JÁ estava no Omie (preserva ajustes manuais)
     InformacoesAdicionais / Observacoes: preservados de `os`
   })
```

**Risco aberto / a validar na implementação:** o `AlterarOS` do Omie pode aceitar payload só com `Cabecalho.cEtapa` (sem `ServicosPrestados`). Se aceitar, a forma mínima é preferível (menos dados, menos risco). **Probe na implementação:** testar `AlterarOS` só-cabeçalho numa OS de teste; se o Omie exigir a estrutura, usar o caminho `ConsultarOS → patch → AlterarOS` acima (que é o seguro por default). De qualquer forma, **a fonte dos serviços é o Omie, nunca o app.**

---

## 6. Fila, retry e observabilidade

### Tabela `afiacao_os_sync_fila`
| coluna | tipo | nota |
|---|---|---|
| `order_id` | uuid PK | FK lógica p/ `orders.id`; UPSERT por aqui (1 linha/pedido) |
| `etapa_alvo` | text | etapa no momento do enqueue (só p/ ordenar/priorizar) |
| `status_app` | text | status do app no enqueue (debug) |
| `tentativas` | int default 0 | |
| `next_retry_em` | timestamptz default now() | item elegível quando `≤ now()` |
| `criado_em` / `atualizado_em` | timestamptz | |

- **RLS:** só `service_role` escreve; `pode_ver_carteira_completa`/staff lê (debug). Sem PII (só ids + status).
- **Backoff:** `next_retry_em = now() + least(power(2, tentativas), 30) * interval '1 min'`. Teto (ex.: `tentativas >= 6`) → não refila; marca como erro persistente (a linha sai da fila e o watchdog detecta a defasagem pelo `omie_ordens_servico`).
- **UPSERT por `order_id`** (codex): se o pedido andar rápido (`em_afiacao → pronto_entrega → em_rota`), a fila guarda só o alvo mais novo — não gasta chamada em etapa intermediária velha.

### Colunas novas em `omie_ordens_servico`
`last_etapa_sincronizada text`, `last_status_sincronizado text`, `last_sync_at timestamptz`, `last_sync_error text`. Dão idempotência (`alvo == last → noop`) e observabilidade.

### Watchdog (Sentinela de Saúde de Dados)
Novo check `afiacao_os_sync` no `data_health_watchdog` (idiom do repo): pedido cujo `mapear_status_etapa(orders.status)` ≠ `omie_ordens_servico.last_etapa_sincronizada` há > 30 min (tunável), **ou** fila com `tentativas` esgotadas. Push na transição ok→degradado (reusa `fin_alertas` + `fornecedor_alerta`). **Pode ser fast-follow** se o founder quiser o core primeiro — as colunas de observabilidade já entram agora, então o check é um add barato depois.

---

## 7. Auth da nova action

`sync_os_status` — gate interno **`via === 'cron' || via === 'service_role'`** (rejeita staff; é fluxo sistêmico de fila). `update_order` (staff-JWT) fica **intacta** (codex: separar "staff pediu" de "cron processa a fila"; reaproveita a função de domínio internamente onde fizer sentido). Cron manda `x-cron-secret` do Vault → `via: 'cron'`.

---

## 8. Migração + handoff Lovable (founder cola no SQL Editor)

Backend é manual (CLAUDE.md §5). Entrego inline, 1 bloco por etapa, com validação:
1. `CREATE TABLE afiacao_os_sync_fila` + RLS + grants.
2. `ALTER TABLE omie_ordens_servico ADD COLUMN last_etapa_sincronizada/...`.
3. `CREATE FUNCTION mapear_status_etapa(text)` (SQL, espelha o helper TS verbatim).
4. `CREATE TRIGGER` `AFTER UPDATE OF status ON orders` → enfileira só se etapa mudou (e ≠ null).
5. `cron.schedule('afiacao-os-sync', '*/5 * * * *', ...)` com `net.http_post` + **`timeout_milliseconds`** explícito + `x-cron-secret` do Vault.

A edge `omie-sync` (action `sync_os_status` + `alterarEtapaOS`) é deployada via chat do Lovable **depois do merge** (ler de `supabase/functions/omie-sync/index.ts` na main, deploy verbatim). PR avisa "⚠️ migration manual + redeploy de edge necessários".

Timestamp da migration: escolher um único não-colidente (checar `gh pr list`/migrations recém-mergeadas antes de fixar — §5).

---

## 9. Testes

- **`mapearStatusEtapa`** (helper puro, vitest, TDD): cada linha da §4 vira caso, incl. `entregue → null`, default-explícitos, e `status desconhecido → null`. É o oráculo do SQL e da edge (devem bater verbatim).
- Sem teste de UI (feature 100% backend/dados). QA real = observar no Omie da Colacor SC após mover um pedido de teste no kanban (founder), cruzando com `omie_ordens_servico.last_etapa_sincronizada`.

---

## 10. Riscos & decisões em aberto

| item | tratamento |
|---|---|
| `AlterarOS` exige `ServicosPrestados`? | Probe na implementação; default seguro = `ConsultarOS → patch cEtapa → AlterarOS` preservando os serviços do Omie (§5). |
| Founder mexe na etapa na mão no Omie | App só empurra quando SEU alvo muda (`alvo == last → noop`) e nunca toca pós-`entregue` → não briga com ajuste manual. |
| Omie flaky (SOAP broken/5xx/timeout) | Backoff na fila + teto de tentativas + watchdog. (O `callOmie` da função já tem retry/backoff próprio.) |
| Pedido sem `omie_ordens_servico` ainda | Erro recuperável: tentativas++, refila (a OS pode estar sendo criada). |
| Etapas customizadas no Omie da Colacor SC | Mapa usa as padrão (10/20/30). Se a Colacor SC tiver etapas próprias, trocar os códigos no helper (1 lugar). Founder verifica. |
| Regressão de status (raro) | App empurra a etapa do status atual; se houver "volta", reflete a volta. Aceitável. |

---

## 11. Unidades (resumo p/ o plano)

1. **Helper** `src/lib/afiacao/os-etapa.ts` — `mapearStatusEtapa(status)` (TDD).
2. **Migration** (SQL, manual via Lovable): tabela fila + colunas + `mapear_status_etapa` + trigger + cron.
3. **Edge** `omie-sync`: action `sync_os_status` + função `alterarEtapaOS` (status-only via ConsultarOS) — **não** mexer no `alterarOrdemServicoOmie`/`update_order` existentes.
4. **Watchdog** (fast-follow opcional): check `afiacao_os_sync` no `data_health_watchdog`.
