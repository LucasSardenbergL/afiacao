# Portal Sayerlack — Robustez e Reconciliação de Estado: Plano de Implementação

> ⚠️ **ATUALIZAÇÃO 2026-05-30 (reconciliação com sessões paralelas — LEIA PRIMEIRO):**
> Ao re-basear pra a main, descobri que **OUTRA sessão já fez o núcleo da Fase 1** (PRs #468/#470/#473):
> #468 "aprovar = disparar na hora" + **motor `sayerlack_retry_orfaos`** (substitui meu Fix 1.3, melhor);
> #470 **claim atômico** (fecha a corrida de duplo-disparo que eu ia consultar); #473 removeu o lote-retry morto.
> **Decisão (eu + Codex): descartei Fix 1.1/1.2/1.3.** O 1.3 é obsoleto; 1.1 (cancelar limpa portal) e 1.2
> (`erro_nao_retentavel→falha_envio`) viraram **cleanup futuro de higiene** (o motor já ignora cancelados; a
> Fase 2 tira o falso-positivo sem mexer na máquina de estados recém-estabilizada).
> **Fase 0 (reset) e Fase 2 (filtros acionáveis nos checks) é o que entreguei.** Migration
> `20260530200000_data_health_checks_acionaveis.sql` (#493).
>
> ⚠️ **ATUALIZAÇÃO 2026-05-30 (2) — minha Fase 2 REGREDIU o #490 (cascata multi-sessão), CORRIGIDA:**
> Enquanto eu fazia a Fase 2 (#493), OUTRA sessão entregou o **#490** (`20260530190000_data_health_portal_push.sql`):
> **promoveu disparo/portal ao push E dividiu `reposicao_portal` em dois** — `reposicao_portal_pipeline`
> (automático DEVERIA drenar) × `reposicao_portal_humano` (precisa de gente) — recriando `data_health_watchdog`
> + `fin_sync_heartbeat` com o IN-list ampliado (6→9 fontes no push). Minha #493 partiu do corpo do #460/#194751
> (sem o split), então **reverteu o `_data_health_compute` pro `reposicao_portal` único** e **NÃO** recriou
> watchdog/heartbeat → o watchdog do #490 ficou procurando `reposicao_portal_pipeline`/`_humano` que o compute
> não produzia mais = **push de portal quebrado**. **Fix-forward:** `20260530210000_data_health_restaura_portal_split.sql`
> = **#490 VERBATIM** (SQL idêntico, só cabeçalho anti-cascata) — supersede a #493 por timestamp + CREATE OR REPLACE.
> O split pipeline/humano é estritamente MAIS acionável que o filtro de check-único da #493 (que o split já subsume),
> e o `reposicao_disparo` é idêntico nas duas → restaurar #490 não perde nada. Validado em Postgres 17 efêmero
> (14 checks, watchdog/heartbeat OK).
>
> ✅ **Fix 1.1 (higiene de cancelamento) ENTREGUE nesta PR:** `20260530210001_cancelar_pedido_limpa_portal.sql`
> (RPC `cancelar_pedido_sugerido` agora zera `status_envio_portal='nao_aplicavel'` + `portal_proximo_retry_em=NULL`,
> guard `disparado/concluido_recebido` preservado, corpo verbatim do schema-snapshot 843-866 + 2 linhas) +
> espelho no frontend (`useDetalhesModal.ts`, bloco de cancelamento por remoção de todos os itens). Artefatos
> antigos guardados em `/tmp/fase1-ref/`.
>
> **LIÇÃO (reforçada):** re-checar `gh pr list`/main ANTES de cada fase, não só no início (§14). Esta saga foi
> um caso-escola DUPLO: o `_data_health_compute` é arquivo quente multi-sessão; 3 sessões o tocaram em paralelo
> (#460, #490, #493) e a regressão por CREATE OR REPLACE de corpo velho é silenciosa. Mitigação: cabeçalho que
> manda a próxima sessão "partir DESTA migração (maior timestamp)".

> **For agentic workers:** Use superpowers:executing-plans para executar fase a fase, com checkpoint de revisão entre fases. Cada fase que toca banco/edge **não** roda no merge — vira bloco SQL pro SQL Editor do Lovable (ritual `lovable-db-operator`) e/ou deploy manual de edge via chat do Lovable. Steps usam checkbox (`- [ ]`).

**Goal:** Fazer pedidos de compra ao portal Sayerlack pararem de travar silenciosamente — reconciliando os dois campos de estado, dando saída automática aos estados terminais, e limpando o falso-positivo do Sentinela — pra o founder disparar manualmente sem reincidir no backlog.

**Architecture:** O pedido tem dois campos de estado independentes (`pedido_compra_sugerido.status` e `.status_envio_portal`) que nunca são reconciliados. O conserto é em camadas: reset do passado (SQL ad-hoc) → reconciliar estados na origem (RPC + edge) → parar o falso-positivo dos checks/telas → rede de segurança (alerta proativo) → robustez do envio (timeouts/retry).

**Tech Stack:** Supabase (Postgres + RPC `SECURITY DEFINER`), edge functions Deno (`disparar-pedidos-aprovados`, `enviar-pedido-portal-sayerlack`, `conciliar-pedido-portal`), Browserless (headless), React (`src/components/portalSayerlack/`, `AdminPortalSayerlack.tsx`), cron `pg_cron` (`sayerlack-portal-lote-retry */15`).

---

## Contexto / Causa-raiz (diagnóstico já feito)

Pedidos da RENNER SAYERLACK (OBEN) travam. Sintomas em prod: 4 em `aprovado_aguardando_disparo` (1 desde 22/04), 6+ presos no portal por timeout (`Waiting failed: 7000ms/15000ms exceeded`, `HTTP 408 do Browserless`), e cancelados que continuam contando como "pendentes".

A raiz é **dois campos de estado que nunca se reconciliam**:

1. **Cancelar não limpa o portal.** `cancelar_pedido_sugerido` ([schema-snapshot.sql:843-866](../../../supabase/schema-snapshot.sql)) seta `status='cancelado_humano'` e **nunca** toca `status_envio_portal` → cancelado fica `pendente_envio_portal` pra sempre.
2. **Terminais sem saída.** `aplicarTransicao` em [enviar-pedido-portal-sayerlack/index.ts:1723-1754](../../../supabase/functions/enviar-pedido-portal-sayerlack/index.ts) só escreve colunas `portal_*`, nunca `status`. `erro_nao_retentavel` (esgotou `MAX_TENTATIVAS=3`, ou SKU sem mapeamento) deixa o pedido em `aprovado_aguardando_disparo` parecendo "aguardando". `indeterminado_requer_conciliacao`/`aceito_portal_sem_protocolo` só saem por conciliação manual. Órfão de ciclo antigo: o cron de disparo só processa `data_ciclo=hoje` ([disparar:1001](../../../supabase/functions/disparar-pedidos-aprovados/index.ts)).
3. **Retry de lote pode não alcançar os presos.** `envio_portal_lock_candidatos` ([schema:1393-1421](../../../supabase/schema-snapshot.sql)) exige `status='disparado'`. Mas pra Sayerlack o `status` só vira `disparado` **depois** do Omie ser registrado pós-portal (`registrarPedidoOmieAposPortal`, enviar:1820); antes disso fica `aprovado_aguardando_disparo`. Logo um portal falho fica fora do retry. **A confirmar na Fase 1.**
4. **Timeouts do portal externo.** Browserless `HARD_CEILING_MS=280000`, `budgetFor` por passo (7000=save-item, 15000=login/nav), 408=gateway. O portal escala com nº de SKUs. Mitigável, não eliminável.
5. **Checks/telas contam lixo.** O check `reposicao_portal` (em `public._data_health_compute`, migration `20260528194751`, PR #460) e [AdminPortalSayerlack.tsx:98](../../../src/pages/AdminPortalSayerlack.tsx) filtram só `status_envio_portal`, sem excluir cancelado/expirado/terminal.

## Constraints do repo (não-negociáveis)

- **Lovable não aplica migrations no merge.** Toda mudança de banco vira bloco SQL pro SQL Editor + query de validação (ritual `lovable-db-operator`). O founder não tem terminal/CLI pro backend.
- **Edge functions deployadas manualmente** via chat do Lovable, **após o merge** (deployar antes pega a main velha — lição #383/#433).
- **Money-path:** TDD em helper puro espelhado verbatim no Deno; consult codex no design; validar em Postgres efêmero quando possível.
- **NÃO mexer em `supabase/migrations/`** além de adicionar arquivos novos.
- Idioma pt-BR. Specs/planos em `docs/superpowers/`.

---

## Fase 0 — Reset do backlog (executável JÁ)

**O quê:** arquivar todo pedido de `data_ciclo < hoje` que não foi concluído, e limpar o `status_envio_portal` sujo (inclusive dos já-cancelados). Preserva disparados/concluídos e os de hoje. **NÃO é migration versionada** (é UPDATE operacional de uma vez) — entregue como bloco SQL pro SQL Editor.

**Validado em Postgres 17 efêmero** com 6 casos (ativo antigo→arquiva, cancelado-sujo→limpa portal sem mudar status, disparado→intacto, de-hoje→intacto, terminal-preso→arquiva, já-limpo→idempotente; re-rodar afeta 0 linhas).

- [ ] **Step 1: PREVIEW — founder roda primeiro e confere a contagem/lista**

🟣 Lovable → SQL Editor → cola → Run:

```sql
SELECT id, empresa, fornecedor_nome, data_ciclo, status, status_envio_portal, valor_total
FROM public.pedido_compra_sugerido
WHERE data_ciclo < CURRENT_DATE
  AND status NOT IN ('disparado','concluido_recebido')
  AND (status NOT IN ('cancelado','cancelado_humano','expirado_sem_aprovacao')
       OR status_envio_portal IS DISTINCT FROM 'nao_aplicavel'
       OR portal_proximo_retry_em IS NOT NULL)
ORDER BY data_ciclo, id;
```

Confere se a lista bate com o esperado (os presos de trás). Se algum aí você ainda quer, anota o `id` (vai disparar manual depois).

- [ ] **Step 2: RESET — só depois de conferir o preview**

🟣 Lovable → SQL Editor → cola → Run:

```sql
UPDATE public.pedido_compra_sugerido
SET status = CASE WHEN status IN ('cancelado','cancelado_humano','expirado_sem_aprovacao') THEN status ELSE 'cancelado_humano' END,
    cancelado_por = CASE WHEN status IN ('cancelado','cancelado_humano','expirado_sem_aprovacao') THEN cancelado_por ELSE 'reset-operacional' END,
    cancelado_em = CASE WHEN status IN ('cancelado','cancelado_humano','expirado_sem_aprovacao') THEN cancelado_em ELSE now() END,
    justificativa_cancelamento = CASE WHEN status IN ('cancelado','cancelado_humano','expirado_sem_aprovacao') THEN justificativa_cancelamento ELSE 'Reset operacional: backlog pré-fix do portal Sayerlack descartado' END,
    status_envio_portal = 'nao_aplicavel',
    portal_proximo_retry_em = NULL,
    atualizado_em = now()
WHERE data_ciclo < CURRENT_DATE
  AND status NOT IN ('disparado','concluido_recebido')
  AND (status NOT IN ('cancelado','cancelado_humano','expirado_sem_aprovacao')
       OR status_envio_portal IS DISTINCT FROM 'nao_aplicavel'
       OR portal_proximo_retry_em IS NOT NULL);
```

- [ ] **Step 3: VALIDAÇÃO pós-reset**

🟣 Lovable → SQL Editor → cola → Run:

```sql
SELECT
  (SELECT count(*) FROM public.pedido_compra_sugerido
     WHERE data_ciclo < CURRENT_DATE AND status='aprovado_aguardando_disparo') AS disparo_antigos_restantes,
  (SELECT count(*) FROM public.pedido_compra_sugerido
     WHERE data_ciclo < CURRENT_DATE AND status_envio_portal='pendente_envio_portal') AS portal_antigos_restantes;
```

Esperado: ambos `0`. Os checks `reposicao_disparo`/`reposicao_portal` zeram pro passado no próximo `*/30` do Sentinela. Sem alteração de schema, sem deploy.

---

## Fase 1 — Reconciliar os estados (coração do "não repetir")

> **Status (2026-05-30):** investigação 1.0 ✅ — confirmado que pra Sayerlack o `status` só vira `disparado` PÓS-Omie (`disparar:697`); um pedido que falha no portal fica em `aprovado_aguardando_disparo`, e o lock de retry (`envio_portal_lock_candidatos`) exige `status='disparado'` → nunca o alcança. **1.1 e 1.2 ENTREGUES (Fase 1a, PR próprio):** validados em Postgres efêmero + 1689 testes verdes. **1.3 ADIADO (Fase 1b):** ao detalhar, achei uma corrida real entre o disparo síncrono (acabou de setar `pendente_envio_portal` + enfileirou o background) e o lote-retry pegando o mesmo pedido — precisa de Codex consult dedicado (provável desenho seguro: o lock aceitar `aprovado_aguardando_disparo` SÓ com `erro_retentavel`, que é espaçado por `portal_proximo_retry_em`, nunca `pendente_envio_portal` recém-enfileirado).

**Arquivos (Fase 1a entregue):** RPC `cancelar_pedido_sugerido` (migration `20260530153609`); edge `enviar-pedido-portal-sayerlack` (`aplicarTransicao`); helper `src/lib/reposicao/portal-estado.ts` + teste; front `src/components/reposicao/pedidos/useDetalhesModal.ts`.

- [x] **Step 1.0 — Investigação** (concluída — ver Status acima).
- [x] **Step 1.1 — `cancelar_pedido_sugerido` limpa o portal:** migration `CREATE OR REPLACE` + `status_envio_portal='nao_aplicavel', portal_proximo_retry_em=NULL`; espelhado no front (`useDetalhesModal`). Validado em Postgres efêmero (cancela+limpa; bloqueia disparado; trata inexistente).
- [x] **Step 1.2 — terminal não-retentável propaga `status`:** helper `statusPedidoAposTerminalPortal` (TDD, 5 testes) espelhado verbatim na edge; `aplicarTransicao` seta `status='falha_envio'` quando `erro_nao_retentavel`. `falha_envio` é estado existente, aceito pelo disparo manual (`disparar:1000`) e ignorado pelo cron automático.
- [ ] **Step 1.3 — Fase 1b (FOLLOW-UP, requer Codex consult):** lock de retry alcançar os pedidos pré-Omie sem criar a corrida com o disparo síncrono.
- [ ] **Step 1.4 — apply (Fase 1a):** migration `20260530153609` via SQL Editor (ritual lovable-db-operator) + redeploy de `enviar-pedido-portal-sayerlack` via chat do Lovable **após o merge** (confirmar por comportamento).

**Critério de pronto da Fase 1a:** cancelar sempre limpa o portal; pedido que falha em definitivo sai de `aprovado_aguardando_disparo`. **Pendente (1b):** retry automático alcançar os retentáveis pré-Omie.

---

## Fase 2 — Parar o falso-positivo (defesa em profundidade)

**Arquivos:** `public._data_health_compute` (migration nova, sobre a `20260528194751` do PR #460); `src/pages/AdminPortalSayerlack.tsx:98,46`; `src/components/portalSayerlack/{PendentesTab,KpiCards}.tsx`.

- [ ] **Step 2.1 — checks excluem terminais/cancelados:** no check `reposicao_portal`, mudar o filtro pra `status_envio_portal='pendente_envio_portal' AND status NOT IN ('cancelado','cancelado_humano','expirado_sem_aprovacao')`. `reposicao_disparo` já filtra `status='aprovado_aguardando_disparo'` (com a Fase 1, terminais saem dele sozinhos). Migration via SQL Editor + query de validação.
- [ ] **Step 2.2 — abas/KPIs:** `AdminPortalSayerlack.tsx:98` e KpiCards excluem `status IN ('cancelado','cancelado_humano','expirado_sem_aprovacao')` da contagem de "pendentes". TDD nos helpers de filtro se houver; senão teste de componente. Sem deploy de banco (frontend).

**Critério de pronto:** um pedido cancelado nunca aparece como "pendente" em check, aba ou KPI.

---

## Fase 3 — Rede de segurança (avisar antes de virar backlog)

**Arquivos:** `data_health_watchdog`/`fin_sync_heartbeat` (migration nova) OU promover `reposicao_disparo`/`reposicao_portal` ao push do watchdog; caminho de saída na UI (`PortalDetailDrawer`).

- [ ] **Step 3.1 — alerta proativo:** decidir (consult codex) entre (a) promover os 2 checks de ação ao `IN` do `data_health_watchdog` (hoje são dashboard+heartbeat só), agora que o reset + Fase 1 garantem que a fila reflete problema real, OU (b) um check novo "pedido em terminal preso há > N dias". Threshold calibrado com dado de prod (evitar o falso-alarme da lição §10).
- [ ] **Step 3.2 — caminho de saída na UI:** botões explícitos no drawer pra `indeterminado_requer_conciliacao`/`erro_nao_retentavel` (conciliar / re-disparar / cancelar), já que hoje só saem por intervenção manual achada a dedo.

**Critério de pronto:** um pedido que cai num terminal preso gera alerta (email) na transição, e tem botão de saída na tela.

---

## Fase 4 — Robustez do envio (mitigar timeouts)

**Arquivos:** `disparar-pedidos-aprovados/index.ts:57` (`SPLIT_CHUNK_SIZE`); `enviar-pedido-portal-sayerlack/index.ts` (retry do flow); config Browserless (infra).

- [ ] **Step 4.1 — split menor:** reduzir `SPLIT_CHUNK_SIZE` (hoje 20 SKUs) pra diminuir o tempo por envio. Medir a distribuição de nº de SKUs dos pedidos que deram timeout antes de escolher o valor.
- [ ] **Step 4.2 — retry do flow inteiro:** hoje só o save-item re-tenta 1× (enviar:894). Avaliar retry/backoff do envio inteiro em `tempFail`, idempotente (cuidado: não duplicar no portal — só re-tentar quando NÃO houve aceite parcial).
- [ ] **Step 4.3 — Browserless (decisão do founder):** avaliar plano com mais budget/concorrência. Infra/custo — fora do código.

**Critério de pronto:** taxa de timeout do portal medida antes/depois cai; o que ainda falhar cai num terminal COM alerta (Fase 3), não em limbo.

---

## Sequência e dependências

`Fase 0` (independente, já) → `Fase 1` (origem) → `Fase 2` (defesa) → `Fase 3` (visibilidade) → `Fase 4` (frequência). Fases 1-3 entregam o "não repetir essa conversa". Cada fase = seu próprio PR + apply manual no Lovable, validada antes da próxima.

## Self-review (cobertura do diagnóstico)

- Causa-raiz 1 (cancelar não limpa) → Fase 1.1 + Fase 0 (passado).
- Causa-raiz 2 (terminais sem saída) → Fase 1.2 + Fase 3.2.
- Causa-raiz 3 (retry não alcança) → Fase 1.0 (confirmar) + 1.1/1.2.
- Causa-raiz 4 (timeouts) → Fase 4.
- Causa-raiz 5 (checks/telas contam lixo) → Fase 2 (e o PR #460 já tratou o `last_error` vazando, problema irmão).
