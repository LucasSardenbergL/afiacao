# Roteirizador — "Visitas em campo" (hunter) separado de "Planejamento da equipe" — Design

**Data:** 2026-06-14 · **Status:** design aprovado na direção (brainstorming founder + Codex gpt-5.5); aguardando review do spec escrito
**Decisores:** founder (produto) + Claude (arquitetura) + Codex (2ª opinião)

---

## 1. Contexto e objetivo

O Roteirizador (`/admin/route-planner`, `useRoutePlanner`/`AdminRoutePlanner`) empilha 5 modos (Logística, Comercial, Híbrido, Manual, Prospecção) numa tela só, feita pra a equipe operacional inteira. O **founder é o hunter** (master): dirige e visita pessoalmente clientes da carteira **e** prospects novos, de cidade em cidade numa região. Pra ele a tela "está confusa as funcionalidades" — cheia de coisa que não é dele (cards de coleta/entrega, scoring comercial pesado que mostra "Calculando oportunidades comerciais…", filtro manhã/tarde, visitas agendadas).

**Objetivo:** dar ao hunter uma experiência **própria e limpa** — escolher **várias cidades**, ver **clientes + prospects** no mesmo mapa, **escolher quem visitar**, montar a rota do dia e registrar o resultado — sem refazer a tela da equipe.

### Decisões (founder, 2026-06-14)
| Tema | Decisão |
| --- | --- |
| Estrutura | **Separar** "Visitas em campo" (hunter) de "Planejamento da equipe" (operacional) — alternativa do Codex (P0), não só limpar um modo |
| Mapa | **Clientes + prospects juntos** (cores diferentes), com opção de filtrar |
| Multi-cidade | **Sim** — selecionar várias cidades de uma vez |
| Montar a rota | **O hunter escolhe quem visitar** — o mapa mostra todos os alvos; ele marca os do dia; só esses entram na rota otimizada |
| Foco da tela | "Os dois, em ordem": **decidir onde caçar** (quais cidades, quantos alvos) → **montar a rota** |
| Mapa base | **OpenStreetMap** (Google Maps pago está fora) |

---

## 2. Design

### 2.1 Navegação — dois contextos no lugar de cinco modos

No topo da tela, **2 contextos** (em vez do seletor único de 5 modos):

- **"Visitas em campo"** — a tela do hunter (seção 2.2). Gestor/master only (usa o Radar de prospects).
- **"Planejamento da equipe"** — abre o seletor atual (Logística / Comercial / Híbrido / Manual) e a tela como está hoje. Todo staff.

**Quem vê / default:**
- **Master:** vê os 2 contextos; **abre direto em "Visitas em campo"**.
- **Gestor comercial:** vê os 2; abre em "Planejamento da equipe" (comportamento atual), com acesso a "Campo".
- **Vendedor / separador / demais staff:** veem **só** "Planejamento da equipe" — **zero mudança** pra eles.

> Princípio do Codex: **permissões não são persona** — o master pode precisar da logística ocasionalmente, então o acesso continua, só sai do caminho dele. Não esconder global; aplicar por papel + contexto.

### 2.2 "Visitas em campo" — a tela do hunter

Componentes, de cima pra baixo (substitui o que o mockup aprovado mostrou):

1. **Seletor de cidades (multi).** Busca + lista com seleção (checkbox); cada cidade mostra a contagem de alvos (`Divinópolis — 24 clientes · 56 prospects`). As escolhidas viram **chips removíveis**. Reabrível pra comparar/adicionar. Quando a seleção gerar alvos demais → **aviso** "N alvos: refine as cidades ou use o filtro" (proteção de mapa/backend).
2. **Resumo de alvos + filtro.** `47 alvos: 12 clientes · 35 prospects`, com botão **Todos / Clientes / Prospects**.
3. **Mapa (OpenStreetMap).** Todos os alvos das cidades escolhidas: **cliente laranja, prospect amarelo, selecionado-pra-rota azul, visitado verde** (legenda fixa). Clique no pino → popup com dados mínimos + **"Adicionar à rota"**. Agrupar pinos (cluster) quando forem muitos fica pra v2.
4. **Lista de alvos** (espelha o mapa). Cada alvo com **"Adicionar à rota"** (e badge cliente/prospect).
5. **Rota de hoje.** **Só os alvos adicionados**, otimizada (nearest-neighbor existente). Cada parada: ligar · **registrar contato no Radar** (prospect, reusa `RadarOutcomeMenu`) · **check-in/checkout** (cliente, infra existente) · navegar. Botões "Abrir no Google Maps / Waze" da rota.

**Fluxo explícito:** escolher cidades → ver alvos (explorar) → **marcar quem visitar** → rota otimizada → visitar → registrar resultado. O mapa serve pra **explorar**; a rota contém **só os escolhidos** (decisão do founder).

### 2.3 "Planejamento da equipe" — intacto

Os modos Logística / Comercial / Híbrido / Manual e a tela atual (cards, scoring, agendadas, visitas de hoje) **não mudam** — só passam a viver dentro do contexto "Planejamento da equipe". O scoring pesado ("Calculando…") só roda quando alguém entra nesse contexto/modo comercial-híbrido — então o hunter **nunca** o dispara.

---

## 3. Backend

- **Prospects de várias cidades:** estender `radar_prospects_para_rota` pra aceitar **lista** de `municipio_codigo` (`text[]`), ou chamar por cidade e juntar no client. Decisão fina no plano; preferência por array (1 round-trip, top-N global).
- **Contagem por cidade (clientes + prospects):** `radar_contagem_por_municipio` (já em prod) dá os **prospects** por `municipio_codigo`. Os **clientes** vêm de `addresses` (texto livre `city`); cruzar TOM(RFB)↔texto é aproximado (mesmo `ilike` já usado em `loadCarteiraDaCidade`). v1: contagem de clientes por cidade via query/RPC dedicada, aceitando a imprecisão de acento/caixa (prospects são exatos por código).
- **Clientes de várias cidades:** estender `loadCarteiraDaCidade` (hoje 1 cidade) pra a lista escolhida, com teto determinístico (`.order('user_id').limit(N)`), como já blindado.
- **Sem mexer** no `useFarmerScoring` (money-path) — o contexto "Campo" simplesmente não o usa.

---

## 4. Escopo

**v1 (esta frente):**
- Navegação de 2 contextos (Campo / Equipe) + gating + default por papel.
- "Visitas em campo": multi-cidade (busca + checkbox + chips + contagem) · resumo + filtro Todos/Clientes/Prospects · mapa clientes+prospects · **seleção de alvos pra rota** (adicionar/remover) · rota só dos selecionados · registrar contato / check-in · Google Maps/Waze · aviso de "alvos demais".

**Não-objetivos (v2, se a dor aparecer):**
- Agrupar pinos (cluster) no mapa cheio.
- Otimização inteligente entre cidades distantes (hoje nearest-neighbor simples; mostrar distância/permitir reordenar blocos vem depois).
- Renomear/reagrupar os sub-modos da equipe.
- Carregamento por área do mapa (viewport).

---

## 5. Riscos / armadilhas (do Codex) e como trato

- **Permissões ≠ persona:** o master mantém acesso à logística (contexto "Equipe"), só não cai nela por padrão.
- **Multi-cidade sobrecarrega mapa/backend:** teto de alvos + aviso "refine" no v1; cluster/viewport no v2.
- **Rota entre cidades distantes pode ficar absurda:** v1 aceita o nearest-neighbor; sinalizar distância/reordenar é v2.
- **"Virou cliente" muda a cor do pino** (amarelo→laranja): preservar o alvo (não some da tela), só muda categoria — o `registrar_contato_radar` já mantém histórico em `radar_contatos`.
- **Maps/Waze tem limite de paradas:** o `RouteActionButtons` já capa em 25 e avisa.
- **TOM(RFB) × addresses.city (texto):** contagem/seleção de clientes por cidade é aproximada por `ilike` (acento/caixa) — aceito no v1; prospects são exatos por `municipio_codigo`.

---

## 6. Validação

- **Helpers puros TDD:** seleção de alvos pra rota (adicionar/remover/dedupe), montagem do resumo (contagem clientes/prospects), filtro Todos/Clientes/Prospects.
- **PG17** pras RPCs novas/estendidas (gate gestor/master, multi-cidade, REVOKE anon) — padrão das fatias do Radar.
- **CI:** typecheck strict · test · lint · build. **Smoke no device** (geolocation + OSM só no domínio publicado).
- **Sem regressão na equipe:** o contexto "Planejamento da equipe" renderiza a tela atual idêntica (Logística/Comercial/Híbrido/Manual).

---

## 7. Entrega

Subagent-driven, em sub-PRs:
1. **Navegação 2-contextos** (Campo/Equipe) + gating/default + "Equipe" = tela atual intacta.
2. **Multi-cidade** (seletor + contagem por cidade + chips + clientes/prospects de N cidades).
3. **Seleção de alvos + rota curada** (mapa/lista marca quem visitar; rota só dos selecionados; resumo + filtro).

Cada sub-PR com CI verde + (onde houver SQL) PG17. Migration manual + Publish ao final (a feature tem UI).
