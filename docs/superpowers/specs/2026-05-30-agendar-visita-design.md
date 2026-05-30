# Agendar visita — fila persistente de visitas datadas (Customer 360 → route planner)

**Data:** 2026-05-30
**Autor:** Lucas + Claude (design endurecido por consult adversária do codex)
**Status:** aprovado (escopo + abordagem travados; aguardando review do spec escrito)

---

## 1. Problema

Hoje o vendedor só visita os clientes que o **sistema de sugestão** (score `customer_visit_scores` → `useMyVisitSuggestions` → `pickDailyMix`) coloca na lista do dia. Quando ele julga interessante visitar um cliente **da carteira dele que o score não priorizou**, não há como registrar isso: o item "Agendar visita" no Customer 360 está **desabilitado ("em breve")**, o route planner só tem seleção manual **de sessão** (`useState`, não persiste), e `route_visits` só registra visitas **já realizadas** (check-in/check-out).

A feature dá ao vendedor uma **fila persistente de visitas agendadas (datadas)**, que ele cria manualmente "furando o filtro" do app, vê numa agenda "Próximas visitas", e que vira parada na rota do dia agendado.

## 2. Decisões travadas (Q&A com o founder)

1. **Modelo datado** — toda visita agendada tem `scheduled_date` (hoje ou futuro). Não é backlog sem data.
2. **Só carteira + cobertura** — o vendedor só agenda pra cliente que é dele (`carteira_assignments`) ou que ele cobre (`carteira_coverage`). Travado no banco via `carteira_visivel_para()`. "Furar o filtro" = visitar cliente seu que o score não sugeriu.
3. **Onde aparece** — (a) como **4ª fonte de paradas** no route planner na data agendada **e** (b) numa lista **"Próximas visitas"** ordenada por data.
4. **Ciclo de vida** — **check-in fecha a agendada automaticamente** (trigger): ao fazer check-in num cliente com agenda pendente pra aquela data, ela vira `realizada`. Pendente que passou da data sem check-in é **`atrasada`** (derivado, continua visível).
5. **Entrada na UI** — no **dropdown do Customer360View** (liga o item desabilitado) **e** no **header do CustomerHero** (botão ao lado de Ligar/WhatsApp/Novo pedido).
6. **Navegação** — botão **"Ir"** abre o **Waze** (fallback Google Maps) pro endereço/coordenadas do cliente.
7. **Check-in 1-toque** — como a agenda já tem cliente+data, o check-in é um toque (reusa o fluxo existente), sem digitar.

## 3. Escopo

### 3.1 Dentro do escopo
- Tabela nova `visitas_agendadas` (owner-scoped, endurecida — ver §4/§5).
- Trigger de reconciliação no `route_visits` (check-in fecha a agenda).
- UI: dialog de agendar (2 entradas), painel "Próximas visitas" no route planner, integração como 4ª fonte de paradas, botão "Ir" (Waze), check-in 1-toque.
- Helpers puros TDD: `navLink` (Waze/Maps) e `deriveVisitaStatus`.
- 1 migration aplicada manualmente via Lovable (ritual `lovable-db-operator`).

### 3.2 Fora de escopo (deferido)
- **Check-in/out automático por geofence** — inviável de forma confiável em web/PWA (background não funciona com app fechado; iOS não suporta; conflita com navegar no Waze, que joga nosso app pra segundo plano). **Spec própria depois**, com spike de viabilidade e a conversa honesta sobre app nativo.
- **Split `created_by`/`assigned_to`** (posse operacional separada do criador) — v2, só se reatribuição de carteira virar comum (ver §10).
- Geocoding de endereços que não têm coordenadas — usa fallback de endereço-texto no Waze (§7.4).

## 4. Modelo de dados — `visitas_agendadas`

| coluna | tipo | nota |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `customer_user_id` | uuid NOT NULL | cliente (`profiles.user_id`) |
| `scheduled_by` | uuid NOT NULL | vendedor que agendou = dono (auth.uid()) |
| `scheduled_date` | date NOT NULL | data-alvo (hoje ou futuro) |
| `status` | text NOT NULL default `pendente` | CHECK IN (`pendente`,`realizada`,`cancelada`) |
| `visit_type` | text NOT NULL default `comercial` | flexível (UI v1 fixa `comercial`) |
| `notes` | text | opcional (motivo) |
| `route_visit_id` | uuid → `route_visits(id)` | preenchido só pela reconciliação |
| `created_at`/`updated_at` | timestamptz NOT NULL default now() | `updated_at` por trigger |

- **`atrasada` é DERIVADO na aplicação** (`status='pendente' AND scheduled_date < hoje`), não é coluna.
- **Constraints/índices:**
  - `CHECK (status IN ('pendente','realizada','cancelada'))`.
  - Unique parcial anti-duplicata: `(customer_user_id, scheduled_by, scheduled_date) WHERE status='pendente'`.
  - Unique parcial `(route_visit_id) WHERE route_visit_id IS NOT NULL` — uma visita realizada fecha **no máximo uma** agenda.
  - Índices: `(scheduled_by, scheduled_date)`; parcial `(scheduled_by, scheduled_date) WHERE status='pendente'`.
  - FK `route_visit_id` default (NO ACTION/RESTRICT) — não deletamos `route_visits` (visita realizada é fato auditável).

## 5. Segurança — RLS + grants (endurecido pelo codex)

**Princípio (codex P1):** RLS sozinha não compara OLD vs NEW. Em vez de um trigger-guard de OLD/NEW, usamos **GRANT por coluna** pra tornar `scheduled_by`/`customer_user_id`/`route_visit_id` **imutáveis** pro vendedor — só a trigger de reconciliação (SECURITY DEFINER, roda como owner, ignora grant/RLS) os altera.

```sql
ALTER TABLE public.visitas_agendadas ENABLE ROW LEVEL SECURITY;

-- ⚠️ O Supabase concede privilégios DEFAULT em tabela nova do public pra anon/authenticated.
-- Sem REVOKE primeiro, o GRANT por coluna NÃO surte efeito (o UPDATE cheio default permanece).
-- (Lição CLAUDE.md §10: "REVOKE FROM PUBLIC não basta — anon/authenticated têm grant explícito".)
REVOKE ALL ON public.visitas_agendadas FROM anon, authenticated, PUBLIC;

-- Grants: vendedor só atualiza colunas "soft"; sem DELETE pra authenticated; anon sem nada.
GRANT SELECT, INSERT ON public.visitas_agendadas TO authenticated;
GRANT UPDATE (scheduled_date, visit_type, notes, status) ON public.visitas_agendadas TO authenticated;
-- (NENHUM grant de UPDATE em scheduled_by/customer_user_id/route_visit_id → imutáveis)
-- (NENHUM grant de DELETE pra authenticated → cancelar é status, não delete físico)
-- (NENHUM grant pra anon → tabela invisível na API pública)

-- SELECT: própria + time gestor/master
CREATE POLICY "vag_select_own" ON public.visitas_agendadas
  FOR SELECT TO authenticated
  USING (
    scheduled_by = (SELECT auth.uid())
    OR (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
  );

-- INSERT: própria + carteira/cobertura + estado inicial limpo
CREATE POLICY "vag_insert_own_carteira" ON public.visitas_agendadas
  FOR INSERT TO authenticated
  WITH CHECK (
    scheduled_by = (SELECT auth.uid())
    AND public.carteira_visivel_para(customer_user_id, (SELECT auth.uid()))
    AND status = 'pendente'
    AND route_visit_id IS NULL
  );

-- UPDATE: só remarcar/cancelar/editar nota da PRÓPRIA PENDENTE.
-- NÃO re-checa carteira (senão cliente reatribuído travaria o cancelamento da agenda velha).
CREATE POLICY "vag_update_own_pending" ON public.visitas_agendadas
  FOR UPDATE TO authenticated
  USING (
    scheduled_by = (SELECT auth.uid())
    AND status = 'pendente'
  )
  WITH CHECK (
    scheduled_by = (SELECT auth.uid())
    AND status IN ('pendente','cancelada')
    AND route_visit_id IS NULL
  );

-- DELETE: só gestor/master (limpeza administrativa).
CREATE POLICY "vag_delete_gestor" ON public.visitas_agendadas
  FOR DELETE TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));
```

- `service_role` bypassa RLS (engines). `(SELECT auth.uid())` = padrão initPlan recente.
- **Por que o vendedor não forja conclusão:** o GRANT bloqueia `route_visit_id` (não está na lista) e a WITH CHECK do UPDATE só aceita `status IN ('pendente','cancelada')` → ele **não consegue** setar `realizada` nem `route_visit_id` via PostgREST. `customer_user_id` imutável → não dá pra "mover" a agenda pra cliente fora da carteira.
- `carteira_visivel_para(uuid,uuid)` já é `STABLE SECURITY DEFINER SET search_path=public` (formato certo pra RLS); **não** alteramos seus grants (helper compartilhado por outras policies).

## 6. Reconciliação — check-in fecha a agenda

A função usa `scheduled_date <= NEW.visit_date` (cobre visitas **atrasadas**, não só o dia exato), fecha a pendente **mais antiga devida** (subquery ordenada por `scheduled_date ASC LIMIT 1`), exclui futuras (`scheduled_date > visit_date`), e é idempotente via `NOT EXISTS` (além da unique parcial em `route_visit_id`). Os guards externos `va.status='pendente' AND va.route_visit_id IS NULL` no UPDATE tornam check-ins concorrentes seguros: o 2º não sobrescreve o `route_visit_id` já gravado pelo 1º.

```sql
CREATE OR REPLACE FUNCTION public.reconcile_visita_agendada()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Fecha a agenda pendente DEVIDA (scheduled_date <= data do check-in) MAIS ANTIGA
  -- deste cliente+vendedor. O `<=` cobre visitas ATRASADAS (scheduled_date < hoje).
  -- Futuras (scheduled_date > visit_date) NÃO são fechadas.
  -- Os filtros externos `va.status='pendente' AND va.route_visit_id IS NULL` tornam
  -- um 2º check-in concorrente um no-op (não sobrescreve o route_visit_id do 1º).
  -- O NOT EXISTS impede um mesmo route_visit fechar uma 2ª agenda num re-disparo.
  UPDATE public.visitas_agendadas va
  SET status = 'realizada',
      route_visit_id = NEW.id,
      updated_at = now()
  WHERE va.id = (
    SELECT v.id FROM public.visitas_agendadas v
    WHERE v.customer_user_id = NEW.customer_user_id
      AND v.scheduled_by    = NEW.visited_by
      AND v.status = 'pendente'
      AND v.route_visit_id IS NULL
      AND v.scheduled_date <= NEW.visit_date
    ORDER BY v.scheduled_date ASC
    LIMIT 1
  )
  AND va.status = 'pendente'
  AND va.route_visit_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.visitas_agendadas v2 WHERE v2.route_visit_id = NEW.id
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reconcile_visita_agendada
  AFTER INSERT OR UPDATE OF check_in_at ON public.route_visits
  FOR EACH ROW
  WHEN (NEW.check_in_at IS NOT NULL)
  EXECUTE FUNCTION public.reconcile_visita_agendada();
```

- **`scheduled_date <= NEW.visit_date`**: cobre visitas atrasadas (agendadas pro passado, check-in feito hoje) — o bug original usava `=` e nunca reconciliava visitas em atraso porque `route_visits.visit_date` defaulta pra `CURRENT_DATE`. Futuras (`scheduled_date > visit_date`) **não** são fechadas.
- **Subquery + `ORDER BY scheduled_date ASC LIMIT 1`**: fecha a mais antiga devida quando há mais de uma pendente — comportamento determinístico e conservador (fecha só uma por check-in).
- **`va.status='pendente' AND va.route_visit_id IS NULL` (outer WHERE)**: guard de concorrência — um 2º check-in concorrente do mesmo cliente+vendedor encontra a linha já com `status='realizada'` e `route_visit_id` preenchido pelo 1º, e vira no-op. Sem esses dois filtros, o 2º UPDATE sobrescreveria o `route_visit_id` já gravado (link loss).
- **`NOT EXISTS`**: guard de idempotência extra — se o trigger re-disparar (UPDATE de `check_in_at`), não fecha uma 2ª agenda com o mesmo `route_visit_id` (a unique parcial `uq_vag_route_visit_id` também barraria no banco).
- `SECURITY DEFINER` + `SET search_path=public`: roda como owner (ignora GRANT por coluna e RLS), por isso consegue setar `realizada`+`route_visit_id`.
- Convive com o trigger existente `enqueue_visit_score_recalc_from_visit` (triggers independentes).
- **Comportamento de cobertura (v1):** se quem agendou (`scheduled_by` = dono) for diferente de quem faz o check-in (`visited_by` = cobertura), **não** reconcilia — a agenda do dono fica pendente. Aceitável v1 (a intenção do dono segue aberta); documentado.
- **Limitação v1:** visita feita **antes** da data agendada (`scheduled_date > hoje`) não auto-reconcilia — o vendedor cancela/remarca a futura na mão.

## 7. UI

### 7.1 Dialog "Agendar visita" (`AgendarVisitaDialog`)
- Entradas: **dropdown do `Customer360View`** (liga o item hoje desabilitado) **e** botão no **`CustomerHero`** (header 360°).
- Campos: data (default hoje, `min` = hoje), nota (opcional). `visit_type` fixo `comercial` na v1.
- Submit → mutation `agendar` (insert). Sucesso → toast + invalida "Próximas visitas". **Trata `unique_violation`** (código `23505`) → toast "Já existe visita pendente pra esse cliente nessa data".

### 7.2 Hook `useVisitasAgendadas`
- Query `proximasVisitas`: pendentes do vendedor (`scheduled_by = user.id`) por `scheduled_date ASC`.
- Mutations: `agendar` (insert), `remarcar` (update `scheduled_date`), `cancelar` (update `status='cancelada'`), `editarNota` (update `notes`). Todas com optimistic + rollback (padrão `tanstack-query` do repo) e tratamento de `unique_violation`.

### 7.3 Painel "Próximas visitas" (no route planner `/admin/route-planner`)
- Lista pendentes/atrasadas agrupadas: **Atrasadas** (destaque `status-warning`), **Hoje**, **Amanhã**, **Futuras**.
- Cada linha: nome do cliente, data, **"Ir"** (Waze), **check-in 1-toque**, remarcar, cancelar.
- **Integração na rota:** agendadas com `scheduled_date` = data de planejamento entram como **4ª fonte de paradas** (badge "Agendada") no `useRoutePlanner` (junto das logísticas/comerciais/manuais).

### 7.4 Navegação — helper puro `navLink(endereco, lat?, lng?)`
- Com coords: `https://waze.com/ul?ll=<lat>,<lng>&navigate=yes`.
- Sem coords: `https://waze.com/ul?q=<endereço URL-encoded>&navigate=yes`.
- Sem endereço **nem** coords → retorna `null` (botão "Ir" some). Fonte do endereço/coords: endereço default do cliente (o route planner já carrega isso em `loadManualCustomers`).

### 7.5 Check-in 1-toque
- Reusa o fluxo de check-in existente do `useRoutePlanner` (cria `route_visits` com `visited_by`/`customer_user_id`/`visit_date`) → a trigger §6 fecha a agenda. Extrair uma ação compartilhada `checkInCustomer(customerId)` se necessário pra chamar fora do fluxo de seleção da rota.

## 8. Migration + Lovable
- 1 migration `supabase/migrations/20260530NNNNNN_visitas_agendadas.sql` com: tabela + CHECK + índices/uniques + trigger `updated_at` + RLS + grants + função/trigger de reconciliação.
- **Apply manual via Lovable SQL Editor** (CLAUDE.md §5) — usar a skill **`lovable-db-operator`** pra empacotar: bloco(s) SQL prontos pra colar, query de validação pós-apply (count de tabela/policies/trigger/índices), nota de PR "⚠️ migration manual necessária", e regenerar o audit.
- Sem edge function. Sem cron. (A derivação de `atrasada` é em runtime; não precisa de job.)

## 9. Testes
- **Helpers puros (TDD vitest):**
  - `navLink(endereco, lat?, lng?)` — com coords, sem coords (q-fallback), sem nada (null), URL-encoding.
  - `deriveVisitaStatus(scheduled_date, status, hoje)` → `realizada`|`cancelada`|`atrasada`|`hoje`|`futura`.
- **Componentes/hook:** testes de `useVisitasAgendadas` (agendar/cancelar/remarcar, tratamento de `unique_violation`) onde fizer sentido.
- **QA manual no device** (o headless não renderiza a SPA): agendar pelos 2 pontos de entrada; ver na agenda; "Ir" abre Waze; check-in fecha a agenda; tentativa de duplicata mostra o toast certo.
- **Validação de segurança (manual, via Lovable SQL Editor):** confirmar que `authenticated` **não** consegue `UPDATE` de `route_visit_id`/`customer_user_id`/`status='realizada'` nem `DELETE` (testar com um JWT de vendedor).

## 10. Limitações v1 (documentadas)
- **Reatribuição de carteira:** se um cliente muda de dono, a agenda pendente que o vendedor antigo criou continua aparecendo **pra ele** (SELECT por `scheduled_by`). Ela não auto-reconcilia sob o check-in do novo dono (`visited_by` diferente). O vendedor antigo ainda consegue **cancelar** a própria agenda velha (a policy de UPDATE não re-checa carteira de propósito). v2: split `created_by`/`assigned_to` se isso incomodar.
- **Cobertura:** check-in de um vendedor de cobertura não fecha a agenda do dono (ver §6).
- **Geofence/auto check-in:** fora de escopo (spec própria).
- **`navLink`** depende do cliente ter endereço/coords; sem isso o botão "Ir" some.

## 11. Referências
- Consult adversária do codex (gpt-5.5, 2026-05-30): achados P1 (UPDATE mutável demais; `status`/`route_visit_id` forjáveis; sem DELETE pro vendedor), P2 (initPlan, trigger estreita+idempotente, unique em `route_visit_id`, índices), P3 (CHECK de status). Todos incorporados acima (o trigger-guard OLD/NEW foi substituído por **GRANT por coluna**, mais simples e equivalente).
- Padrões do repo: RLS por dono = `call_log` (`20260523120000`); carteira = `carteira_visivel_para`/`pode_ver_carteira_completa` (`20260524120000`); hardening recente = `20260526020000`/`20260526040000`.
