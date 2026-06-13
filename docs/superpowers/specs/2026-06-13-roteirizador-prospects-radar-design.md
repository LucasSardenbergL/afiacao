# Roteirizador do Hunter — prospects do Radar no mapa de visitas (+ carteira + rota + check-in) — Design

**Data:** 2026-06-13 · **Status:** design em revisão (brainstorming com o founder; 2ª opinião do Codex pendente — esgotou a cota do Plus, volta 19:18, valida o check-in)
**Decisores:** founder (produto/escopo) + Claude (arquitetura)

---

## 1. Contexto e objetivo

O founder é o **hunter** — visita pessoalmente clientes antigos (carteira) **e** prospects novos. Hoje:
- O **Radar** (`/radar`) lista prospects e tem um mapa de **bolhas agregadas por cidade** — não dá pra ver a empresa individual nem montar visita.
- O **Roteirizador** (`/admin/route-planner`, gate `isStaff`) já é um **mapa de visitas com rota + check-in** — mas **só da carteira** (clientes existentes): plota no Leaflet, **geocodifica o endereço** (Nominatim/OpenStreetMap), otimiza a ordem (nearest-neighbor + prioridade por churn/relacionamento via `customer_visit_scores`) e registra check-in/out em `route_visits`.

**Objetivo:** trazer os **prospects do Radar** pra dentro do Roteirizador, pra o founder, numa **cidade**, ver clientes da carteira **+** prospects no mesmo mapa, montar **uma rota** com os dois e fazer **check-in** — um **mapa de visitas do hunter unificado**.

### Decisões do founder (2026-06-13)
| Decisão | Escolha |
| --- | --- |
| Onde juntar | **Estender o Roteirizador** existente (reusa mapa + rota + check-in + geocodificação) |
| Escopo v1 | **Já com rota do dia + check-in** (não só ver plotado) |
| Geocodificação | Sob-demanda por cidade (OpenStreetMap grátis), **cacheada** |

## 2. O que já existe (reuso — mapeado no código)

- **`RouteStop`** (`src/components/reposicao/routePlanner/types.ts`): `{ id, stopType, customerUserId, customerName, phone, address{street,number,neighborhood,city,state,zip_code}, lat?, lng?, priorityScore, priorityLabel, visitReason, ... }`.
- **`StopType`** + **`STOP_CONFIG`** (`constants.ts`): cor/ícone por tipo de parada.
- **`useRoutePlanner.ts`**: fontes `loadLogisticStops`/`loadCommercialStops`/`loadManualCustomers` → `allStops` (useMemo por `planningMode`) → **geocodificação** (Nominatim, in-memory, 1.1s/req, max 15) → `optimizedRoute` (nearest-neighbor + tiers). Check-in `handleCheckInStop(stop)` insere em `route_visits {customer_user_id, visited_by=auth.uid(), visit_type, check_in_at, lat/lng}`; `handleCheckOut` atualiza `{check_out_at, result, notes, revenue_generated, order_created}`.
- **`PlanningModeSelector`** (logística/comercial/híbrido/manual). **NÃO há seletor de cidade** (a criar).
- **Mapa** (`AdminRoutePlanner.tsx`): markers `L.divIcon` com `STOP_CONFIG[stopType].markerColor` + número da ordem + popup. Pin novo aparece automático ao adicionar o `stopType`.
- **`route_visits`**: `customer_user_id UUID NOT NULL`, RLS "Staff can manage" (admin/employee FOR ALL). Trigger `enqueue_visit_score_recalc_from_visit` já tem guard **`IF NEW.customer_user_id IS NOT NULL`** → linha sem cliente não enfileira scoring (seguro pra prospect).

## 3. Arquitetura (3 sub-PRs)

### 3.1 Sub-PR 1 — Geocodificação dos prospects (fundação)

- **Migration:** `ALTER radar_empresas ADD lat double precision, ADD lng double precision, ADD geocoded_em timestamptz, ADD geocode_status text` (`ok`/`falhou`/NULL). Cache: geocodifica 1× por empresa.
- **RPC `radar_salvar_geocode(p_cnpj, p_lat, p_lng, p_status)`** `SECURITY DEFINER` gestor/master (a escrita em `radar_empresas` é service_role-only; a RPC é a porta). Grava lat/lng + `geocoded_em=now()`.
- **Geocodificação no client** (reusa o padrão do `useRoutePlanner`): para os prospects de uma cidade **sem** cache, chama Nominatim (`https://nominatim.openstreetmap.org/search?format=json&q=<rua, num, cidade, uf, Brazil>&limit=1`), rate-limit 1.1s, e salva via `radar_salvar_geocode`. **Top-N por carga** (ex.: 30) — não geocodifica a cidade inteira de uma vez.
- **Honesto:** Nominatim é grátis mas lento (1/seg) e proíbe uso em massa → **nunca** geocodificar os 526k; só sob-demanda por cidade (dezenas). Endereço RFB ruim → erra (cai no centro da cidade) → `geocode_status='falhou'` e mostra o pino aproximado/centro + o endereço texto + link navegação.

### 3.2 Sub-PR 2 — Modo "Cidade" no Roteirizador (o "juntar")

- **`StopType` += `'prospect_visit'`** (cor amarela `#eab308`) em `types.ts`/`constants.ts` + `STOP_DURATION_MIN`.
- **`RouteStop` += `radarCnpj?: string`** (id do prospect; `customerUserId` fica `''` pro prospect).
- **`PlanningMode` += `'prospeccao'`** + botão no `PlanningModeSelector` ("Prospecção", ícone Target).
- **Seletor de cidade** (`CitySelector.tsx` novo): lista cidades com prospects (reusa `radar_contagem_por_municipio` — já dá cidade+UF+total). Founder escolhe → `selectedCity` (state novo no `useRoutePlanner`).
- **RPC `radar_prospects_para_rota(p_municipio_codigo, p_limit)`** `SECURITY DEFINER` gestor/master: retorna os prospects da cidade (status `a_contatar`/`em_conversa`, `ja_cliente=false`), com cnpj/razão/endereço/telefone/**lat/lng cacheado**, ordenados (a_contatar primeiro). Limite top-N.
- **`loadProspectStops(municipio)`** (espelha `loadManualCustomers`): RPC acima → `RouteStop[]` com `stopType:'prospect_visit'`, `radarCnpj=cnpj`, `customerUserId=''`, address do RFB, `lat/lng` se cacheado (senão a geocodificação do 3.1 preenche). `enrichWithPriority`.
- **Juntar a carteira da cidade:** no modo `prospeccao`, também carrega os **clientes da carteira daquela cidade** (reusa a query de `customer_visit_scores`/`addresses` filtrada por `city`) como `sales_visit` stops → o `allStops` do modo mistura **prospects (amarelo) + carteira (laranja)** → `optimizedRoute` roteiriza os dois juntos. É o "mapa de visitas da cidade".
- **Mapa:** automático (o `STOP_CONFIG` novo pinta o pin amarelo; popup do prospect mostra razão/CNAE/telefone + "navegar").

### 3.3 Sub-PR 3 — Check-in de prospect (+ reflexo no Radar) ⚠️ Codex valida

- **Migration:** `ALTER route_visits ALTER customer_user_id DROP NOT NULL, ADD radar_cnpj text` + CHECK `(customer_user_id IS NOT NULL OR radar_cnpj IS NOT NULL)` (toda visita tem um alvo). O trigger de scoring **já** guarda `customer_user_id IS NOT NULL` → prospect (cnpj, customer NULL) não enfileira scoring (correto).
- **`handleCheckInProspect(stop)`**: insere `route_visits {customer_user_id: NULL, radar_cnpj: stop.radarCnpj, visited_by: auth.uid(), visit_type: 'prospeccao', check_in_at, lat/lng}`. (A RLS "Staff can manage" permite; **Codex confirma se o #340 a apertou pra `visited_by`-scoped** — o check-in tem `visited_by=auth.uid()`, deve passar.)
- **Check-out de prospect reflete no Radar:** o `CheckoutDialog` (result/notes) → além de atualizar `route_visits`, chama **`registrar_contato_radar(cnpj, acao, nota)`** (Fatia 2): `result='pedido_fechado'` → não fecha cliente sozinho (cadastro Omie é ação deliberada) mas marca `em_conversa`/oferece "Cadastrar no Omie"; `result` de conversa → `em_conversa`; `sem_intencao` → `descartado` (com confirmação). Mantém o Radar em dia com o que aconteceu na visita.
- **Decisão a validar com Codex:** (a) `customer_user_id` nullable em `route_visits` é seguro vs todos os consumidores (queries que assumem NOT NULL?); (b) a RLS atual permite insert de prospect; (c) o reflexo no Radar (qual `result` → qual `acao`).

## 4. Acesso

Já é `isStaff` (master/farmer acham em **Admin → Roteirizador**). O founder (master) já tem acesso — só não sabia que existia. Nenhuma mudança de gate.

## 5. Validação

- **PG17** (`db/test-roteirizador-prospects.sh`): `radar_salvar_geocode` (gate, grava lat/lng), `radar_prospects_para_rota` (gate, retorna prospects da cidade com cache), `route_visits` nullable + CHECK (aceita prospect sem customer_user_id, rejeita visita sem alvo; trigger de scoring pula prospect).
- **Helper puro TDD:** prospect→RouteStop (shape), montagem da query Nominatim, `result`→`acao` do Radar.
- **CI:** typecheck/test/lint/build. Smoke no device (geolocation + Nominatim só funcionam no device real, não no preview/headless).

## 6. Entrega (3 sub-PRs; subagent-driven)

1. **Geocodificação** — migration (colunas + RPC `radar_salvar_geocode`) + geocodificação client cacheada + PG17.
2. **Modo Cidade** — StopType/PlanningMode/CitySelector + RPC `radar_prospects_para_rota` + `loadProspectStops` + carteira-da-cidade junto + mapa.
3. **Check-in de prospect** — migration `route_visits` nullable + `radar_cnpj` + `handleCheckInProspect` + reflexo no Radar. ⚠️ **Codex valida o design antes** (mexe em tabela existente + RLS #340).

## 7. Riscos / pontos honestos

- **Geocodificação Nominatim:** lenta (1/seg), proíbe massa → só sob-demanda por cidade, cacheada, top-N. Endereço RFB ruim erra o pino (mostra centro + texto). Se virar gargalo real → provider pago (Google Geocoding) é plugável depois.
- **`route_visits` nullable:** mexe em tabela com RLS endurecida (#340) e trigger de scoring — **Codex valida**; o guard `IF customer_user_id IS NOT NULL` do trigger já protege o scoring.
- **Rota com prospect sem geo:** prospect que não geocodificou não entra na rota (sem lat/lng) — mostrado numa lista "sem localização" com link de navegação manual.
- **Volume por cidade:** cidade grande (centenas de prospects) → top-N + o founder refina pelos filtros do Radar antes (CNAE etc.).

## 8. Não-objetivos da v1

- Geocodificar os 526k em massa (só sob-demanda por cidade).
- Acesso de vendedora ao Roteirizador (segue `isStaff`; distribuição via Tarefa é outra coisa).
- Otimização de rota multi-cidade / multi-dia (uma cidade por vez na v1).
- Provider de geocodificação pago (Nominatim grátis primeiro; plugável depois).
- Auto-cadastrar prospect no Omie no check-out (cadastro é ação deliberada do founder, já existe na Fatia 3).

## 9. Follow-ups

- Heatmap de densidade (prospects × carteira por cidade) pra decidir abrir cidade nova.
- Cron noturno geocodificando as cidades mais prováveis (pré-aquece o cache).
- Cruzar com `route_schedule` (cidade da rota de entrega de amanhã → sugerir prospecção lá).
- "Sem localização": geocodificação manual (arrastar o pino) pros endereços que o Nominatim erra.
