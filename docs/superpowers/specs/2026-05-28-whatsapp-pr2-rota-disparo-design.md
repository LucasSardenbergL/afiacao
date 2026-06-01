# PR2 — Motor de disparo por rota + unificação da lista de ligação (WhatsApp + voz)

**Data:** 2026-05-28
**Autor:** Lucas + Claude
**Status:** rascunho de design (aguardando: passe adversário do codex nos critérios §6 + aprovação do founder)
**Depende de:** PR1 (fundação inbox — `docs/superpowers/specs/2026-05-28-whatsapp-ia-orcamento-design.md`, já mergeado/PR #479)

---

## 1. Contexto e objetivo

Hoje a Colacor faz entregas por **rota fixa por dia da semana**. Na véspera da rota, duas vendedoras ligam para os clientes das cidades do dia seguinte, na ordem do **score** (motor de churn), pra puxar recompra. O motor de "pra quem ligar" **não conhece a rota** — só churn. E não há disparo proativo de WhatsApp.

**Objetivo do PR2:** criar um **motor único de contato por rota** que, na véspera de cada rota, gera a lista priorizada de clientes a contatar — por **WhatsApp (accept-a-proposal)** e por **ligação (vendedora)** — usando os **mesmos critérios de rota + valor econômico**, respeitando opt-in, cadência, gate econômico ("às vezes o cliente nem se paga") e o ramp da Meta. E **medir** durante 2–4 semanas pra decidir, com dado, se vale **automatizar mais** vs **contratar**.

Princípio herdado do v1 (não re-litigar): a IA **conversa e monta a cesta**, mas o **preço firme passa por gate humano**; a IA **nunca inventa SKU nem preço** (pricing determinístico do Omie); transparência (sem se passar por humano).

---

## 2. Modelo de rota (fonte única, compartilhada por WhatsApp + ligação)

### 2.1 Agenda fixa por dia da semana (informada pelo founder)

| Dia da semana | Rota de entrega (cidades) |
| --- | --- |
| **Segunda** | *(sem rota)* |
| **Terça** | Formiga, Pimenta, Piumhi, Capitólio |
| **Quarta** | Cláudio, Itaguara, Itaúna, Mateus Leme, Pará de Minas |
| **Quinta** | Bom Despacho, Abaeté, Martinho Campos, Pitangui, Luz, Nova Serrana, Pompéu |
| **Sexta** | São João del Rei, Santa Cruz (de Minas), Prados, Oliveira, Tiradentes, Carmo da Mata |
| **Todo dia** | **Divinópolis (MG)** + **Carmo do Cajuru** — motor diário (ver §10) |

> ⚠️ **Todas as cidades são MG.** A chave de cidade carrega **UF** pra desambiguar (existe `DIVINÓPOLIS (TO)` no banco que **deve ser excluída** — pedido explícito do founder). Ver §4.

### 2.2 Quando o contato acontece — "dia anterior" (D-1)

O contato é feito na **véspera** da rota ("ligamos para as cidades da rota do **dia seguinte**"). Mapeamento do dia de trabalho → rota que estamos preparando:

| Hoje (dia de trabalho) | Rota que preparamos hoje | Cidades-alvo do contato de hoje |
| --- | --- | --- |
| **Segunda** | Terça | Formiga, Pimenta, Piumhi, Capitólio **+ Div/Cajuru** |
| **Terça** | Quarta | Cláudio, Itaguara, Itaúna, Mateus Leme, Pará de Minas **+ Div/Cajuru** |
| **Quarta** | Quinta | Bom Despacho, Abaeté, Martinho Campos, Pitangui, Luz, Nova Serrana, Pompéu **+ Div/Cajuru** |
| **Quinta** | Sexta | São João del Rei, Santa Cruz, Prados, Oliveira, Tiradentes, Carmo da Mata **+ Div/Cajuru** |
| **Sexta** | *(seg sem rota → próxima é terça, longe demais p/ JIT)* | **só Div/Cajuru** |

- Segunda **não é dia ocioso**: é o dia de preparar a rota de terça.
- Sexta o motor de rota descansa (a próxima rota é terça — contatar 4 dias antes é estímulo JIT velho na entrega); Sexta roda **só Div/Cajuru**.
- **Feriado:** uma tabela de override (`route_calendar_override`) permite mover/cancelar a rota de uma data específica (a "rota do dia seguinte" pula feriado). Sem override, vale a agenda fixa por dia da semana.

### 2.3 Janela operacional do dia (7:30–17:00) e o corte de faturamento

Expediente: **7:30 → 17:00**, almoço **1h10**, café **15min**. O cliente que aceita a proposta hoje precisa ser **separado e faturado hoje** pra entrar no caminhão de amanhã. O founder exige **≥30min antes do fechamento (17:00)** pra faturar.

Consequência de design (dois controles configuráveis, não hard-code):
- **`disparo_inicio`** (default **07:30**): a IA pode começar cedo (o founder perguntou — sim, pode). Quanto mais cedo o cliente aceita, mais folga pra separação/faturamento.
- **`disparo_corte`** (default **15:30**): hora-limite pra **iniciar** uma conversa proativa que mire entrega amanhã. Depois disso, o risco de o cliente responder/fechar após o corte de faturamento (~16:30) e perder o caminhão fica alto. Após `disparo_corte`, o motor de rota **pausa novos disparos** do dia (conversas já abertas continuam; respostas inbound seguem sendo respondidas — janela de 24h).
- Esses valores ficam em `route_disparo_config` (1 linha, editável). Calibrar no piloto (§11).

---

## 3. Arquitetura — onde isso entra no código existente

Descoberta-chave da auditoria (greps 2026-05-28): **já existe um motor por cidade** — não precisamos reinventar.

| Camada | O que existe hoje | Papel no PR2 |
| --- | --- | --- |
| `customer_visit_scores` (tabela) | `customer_user_id, farmer_id (dono), city, visit_score, recuperacao/expansao/relacionamento/prospeccao_score, primary_mission, days_since_last_visit` | **Fonte por-cidade** da lista de rota. Já tem `city` populado + RLS por carteira (#329/#340). |
| `useMyVisitSuggestions` (hook) | agrupa candidatos **por cidade**, ranqueia por `visit_score` | **Template** do motor de rota (mesma mecânica de agrupar por cidade). |
| `customer_metrics_mv` (view) | `ticket_medio_90d, intervalo_medio_dias, dias_desde_ultima_compra, atraso_relativo, is_cold_start, faturamento_90d` | **Camada econômica** do `valor_da_ligacao` (§6). |
| `farmer_client_scores` + `useFarmerScoring` | priority = 0.40·churn + 0.30·recover + 0.20·expansion + 0.10·efic; **route-blind** | Motor de **churn** atual (o "pra quem ligar" do founder). Entra como **um dos sinais** do re-rank, **não** é mutado. |
| `carteira_assignments` | `customer_user_id → owner_user_id` (dono) | Atribuição da ligação à vendedora certa (já usado no `whatsapp-inbound`). |

**Decisão de unificação (não duplicar churn):** criar um hook novo **`useRouteContactList(date)`** (PR2a) que:
1. resolve as cidades-alvo de D-1 (§2.2) via `route_schedule` + override;
2. puxa candidatos dessas cidades de `customer_visit_scores` (city-scoped, já com RLS por carteira);
3. enriquece com `customer_metrics_mv` (econômico) + `farmer_client_scores` (churn/priority) por `customer_user_id`;
4. calcula `valor_da_ligacao` (§6) e aplica gates;
5. devolve **duas vistas do mesmo conjunto**: `whatsappQueue` (accept-a-proposal) e `callQueue` (vendedora), particionadas por critério (§6.3) e agrupadas por `farmer_id` (vendedora).

A **lógica de churn em `useFarmerScoring`/`farmer_client_scores` não muda** — ela vira insumo. O re-rank por rota é um **filtro+reordenação read-time** por cima (mesmo padrão que a impersonação usou: não mexe no motor, escopa na leitura).

---

## 4. Normalização de cidade (helper puro, TDD)

O banco guarda cidade como **`"FORMIGA (MG)"`** (`addresses.city`, e provavelmente `customer_visit_scores.city` herdou o mesmo formato). A agenda de rota guarda chaves canônicas. Precisamos casar os dois sem falso-positivo (Divinópolis MG×TO).

```ts
// src/lib/whatsapp/route-city.ts  (puro, testado)
export interface CityKey { city: string; uf: string } // ex.: { city: 'DIVINOPOLIS', uf: 'MG' }

export function normalizeCityKey(raw: string | null | undefined): CityKey | null
//  "FORMIGA (MG)"      → { city: 'FORMIGA', uf: 'MG' }
//  "Divinópolis/MG"    → { city: 'DIVINOPOLIS', uf: 'MG' }   (sem acento, upper)
//  "Divinópolis (TO)"  → { city: 'DIVINOPOLIS', uf: 'TO' }   (UF preserva → NÃO casa com a rota MG)
//  "Pitangui"          → { city: 'PITANGUI', uf: '' }        (sem UF → casa por city só com aviso)
//  null/""/lixo        → null

export function cityKeyEquals(a: CityKey, b: CityKey): boolean
//  casa por city; se AMBOS têm uf, exige uf igual (desambigua Divinópolis).
```

- Normalização: `trim` → upper → remove acento (`normalize('NFD')`) → extrai UF de `(MG)` / `/MG` / sufixo.
- **A rota só inclui cidades MG.** Candidato sem UF no banco casa por `city`, mas o motor **loga** quando faltou UF (pra higienizar cadastro). Candidato com UF≠MG numa cidade homônima (Divinópolis/TO) **não casa** → excluído por construção.
- ⚠️ **Dependência aberta:** validar o **formato e a grafia exata** das cidades da rota no banco (query já enviada ao founder; ver §13). A `route_schedule` será semeada com as chaves canônicas confirmadas.

---

## 5. Opt-in, STOP e cadência

### 5.1 Opt-in / STOP ("PARAR")
- `whatsapp_conversations.opt_in_status` (já existe na fundação, default `'unknown'`): `opt_in` | `opt_out` | `unknown`.
- Inbound com corpo normalizado ∈ {`PARAR`, `SAIR`, `STOP`, `CANCELAR`} → `opt_out` (helper puro `isStopKeyword`, testado) + confirma 1× e **nunca mais** dispara proativo.
- **Proativo só para `opt_in`.** `unknown` recebe **um** primeiro toque utilitário sob template aprovado durante o ramp (Meta permite mensagem utilitária; o cliente vira `opt_in` ao responder, ou `opt_out` no PARAR). Sem resposta após N toques → para (vira `unknown_silent`, fora da fila).

### 5.2 Cadência (anti-spam, por cliente)
- `proximo_contato_permitido_em` por conversa (ou derivado): **mínimo de dias** entre toques proativos. Default: `max(3, intervalo_medio_dias × 0.5)` — não cutucar antes da metade do ciclo de recompra típico do cliente.
- Cliente que **respondeu** hoje (janela 24h aberta) não recebe disparo proativo redundante — vira `callQueue`/atendimento humano.
- Cliente que **já fechou pedido** via IA hoje sai da fila (não re-ofertar).

---

## 6. Critérios da lista de ligação (núcleo — alvo do passe adversário do codex)

> **Status:** desenhado por mim a partir do framework "lucro por minuto restrito" que o codex validou na análise de capacidade (Task #22). **Ainda falta o passe adversário dedicado do codex** (bloqueado por OOM da máquina — rodar quando a RAM aliviar). As "perguntas abertas" no fim desta seção são os alvos desse passe.

### 6.1 Valor da ligação (ordenação)

Para cada candidato nas cidades de D-1:

```
valor_da_ligacao = P(converte | contato) × ticket_esperado × margem% × prontidao_recompra
```

- **P(converte|contato):** propensão. v1 = proxy de `farmer_client_scores`/`visit_score` normalizado [0,1] (calibrar com taxa real de conversão observada no piloto). Não inventar modelo novo na v1.
- **ticket_esperado:** `ticket_medio_90d` do `customer_metrics_mv` (fallback: mediana da carteira da vendedora; cold-start → ver §9).
- **margem%:** margem do mix típico do cliente (reusar o cockpit de lucro econômico A3 quando disponível; v1 = margem média da empresa por enquanto, marcada como aproximação).
- **prontidao_recompra:** função de `dias_desde_ultima_compra / intervalo_medio_dias` (= `atraso_relativo`): perto/após o ciclo → alto; muito antes do ciclo → baixo (cutucar cedo demais queima frequência sem vender).

Ordena `callQueue` e `whatsappQueue` por `valor_da_ligacao` desc.

### 6.2 Gate rígido (sai da fila)
- `valor_da_ligacao ≤ 0` (o cliente "nem se paga" — pedido do founder): **fora**. Inclui margem negativa conhecida (cliente problemático do cockpit de valor).
- Contatado proativamente **< cadência** (§5.2): **fora** (anti-spam).
- **Muito antes** do ciclo de recompra **E** baixa propensão: **fora** (JIT prematuro).
- `opt_out`: **fora**.
- Já fechou pedido hoje / janela 24h ativa com humano: **fora** do proativo.

### 6.3 Partição WhatsApp × ligação (mesmo conjunto, dois canais)
- **`whatsappQueue` (accept-a-proposal, IA):** o "miolo" — recompra previsível (cesta reconstruível do histórico), ticket médio, cadência due. A IA propõe a cesta pronta; resposta vira atendimento.
- **`callQueue` (vendedora):** **(a)** quem **respondeu** no WhatsApp e precisa de toque humano (negociação/preço firme), **(b)** **top expected-profit** da carteira (a vendedora liga pros maiores), **(c)** **negociação/preço** (desconto, prazo, item sem cesta clara). Ordenada por `valor_da_ligacao`.
- Um cliente pode estar nas duas (WhatsApp dispara cedo; se responder pedindo preço, sobe pra `callQueue`).

### 6.4 Reservas e armadilhas (anti rich-get-richer)
- **Reserva de ~20% da capacidade da vendedora pra win-back** (clientes em churn/sumindo na rota do dia) — senão o re-rank por lucro só fala com quem já compra muito e abandona recuperação.
- **Novos clientes (cold-start):** entram **sempre** (pedido explícito do founder — ver §9), por uma trilha própria (sem histórico → sem `prontidao_recompra`; usa boas-vindas/intro + cota mínima garantida na fila).
- **Armadilha consciente:** otimizar só `valor_da_ligacao` ignora win-back e aquisição. Por isso as duas cotas acima são **piso garantido**, aplicadas **antes** do corte por capacidade.

### 6.5 Passe adversário do codex — FEITO (2026-05-31)

Veredito do codex: **sem P1 matemático**; vários **P2 operacionais** que distorceriam o piloto. Decisão (Lucas + Claude + codex) — corrigir os baratos/seguros agora (helpers puros, frontend-only, sem deploy), adiar os que pedem dado real do piloto.

**✅ Corrigidos agora (`src/lib/whatsapp/contact-list.ts`, +3 testes; PR de hardening):**
- **#3 win-back por VALOR + piso** — era bug: o win-back era ordenado por profundidade de churn (`dias/intervalo`), então sumido **barato** passava na frente de quase-due **lucrativo**. Agora ordena por `valorDaLigacao` e só reserva win-back com `valor >= 70% do corte do top` (`WINBACK_VALUE_FLOOR_PCT`).
- **#7/#6 dedup de canal** — a `whatsappQueue` não excluía quem estava na `callQueue` (a IA falaria com quem a vendedora ligaria). Agora exclui: humano pega o topo, IA pega o resto elegível.
- **#4 guardrail cold-start %** — piso fixo de 3/dia virou `min(piso, ceil(cap × 10%))` (`COLD_START_MAX_PCT`) → não afoga a fila quando o cap é pequeno.
- **#2 nomenclatura** — doc no `valorDaLigacao`: é **valor esperado** (proxy), não lucro real (margem é constante na v1 → não afeta ranking, só escala).

**⏸️ Adiados (precisam de dado do piloto / são maiores — registrar como métrica):**
- **#1 dupla-contagem prontidão × pConverte** (P2) — ambos co-variam com recência. Direção é desejada (priorizar quem está due); extremos já contidos pelo gate `jit_prematuro` + reserva. De-viés preciso (tirar recência do `pConverte` OU abrandar `prontidao`) exige medir no piloto se a fila super-indexa em sumidos — **e mexer data-free quebraria o gate `jit_prematuro` (que usa `prontidao <= 0.3`)**. Monitorar.
- **#5 capacidade por TEMPO (min) em vez de contagem** (P2, quase-P1 pelo corte 16:30) — precisa de duração real por bucket (`farmer_calls.duracao`). Vira métrica do piloto + troca de `capacidadeLigacoes` (contagem) por orçamento de minutos no PR2c.
- **#6 roteamento fino por ticket** (alto-ticket → ligação; baixo/médio previsível → WhatsApp) — o dedup do #7 é a peça v1; routing fino depois.
- **#8 cadência por janela-de-rota** (em vez de `contatadoHaDias < 3`) — hoje **inerte** (`route_contact_log` vazio até o disparo). Wire no PR2c quando houver dado.

---

## 7. Disparo de WhatsApp (accept-a-proposal) + ramp da Meta

- **Accept-a-proposal:** a IA abre com a **cesta de recompra pré-montada** (do histórico/motor de reposição), não com "precisa de algo?" (benchmark BEES/Yalo: +~30% ticket). Preço determinístico do Omie; **preço firme com desconto/negociação → gate humano** (`callQueue`).
- **Template aprovado (Meta):** a abertura proativa fora da janela de 24h exige **template de marketing/utilitário aprovado**. Conteúdo task-specific (cotação/recompra) — permitido pós-jan/2026 (bots genéricos, não).
- **Ramp de tier da Meta:** começa em **~1.000 destinatários únicos/24h** → 10k → 100k conforme qualidade. O motor **pacing**: a fila proativa do dia respeita o teto do tier atual (`meta_tier_cap` em `route_disparo_config`). Pacing prioriza por `valor_da_ligacao` (gasta o cap nos melhores primeiro).
- **Janela de 24h:** inbound do cliente reabre 24h grátis. Disparo proativo consome template pago. O motor prefere responder em janela aberta (grátis) e só usa template quando necessário.

---

## 8. Schema novo (migration manual via Lovable — esboço, finaliza no plano)

```sql
-- route_schedule: agenda fixa por dia da semana (chaves canônicas city+uf)
CREATE TABLE public.route_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=domingo
  city text NOT NULL,      -- canônico, sem acento, upper (ex.: 'FORMIGA')
  uf text NOT NULL DEFAULT 'MG',
  is_daily boolean NOT NULL DEFAULT false,   -- Div/Cajuru: ignora weekday
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- route_calendar_override: feriado/exceção por data
CREATE TABLE public.route_calendar_override (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data date NOT NULL UNIQUE,
  cancela_rota boolean NOT NULL DEFAULT false,  -- feriado: não há rota nesse dia
  motivo text
);

-- route_disparo_config: 1 linha, controles do disparo
CREATE TABLE public.route_disparo_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),  -- singleton
  disparo_inicio time NOT NULL DEFAULT '07:30',
  disparo_corte  time NOT NULL DEFAULT '15:30',
  meta_tier_cap  int  NOT NULL DEFAULT 1000,
  win_back_reserva_pct numeric NOT NULL DEFAULT 0.20,
  cold_start_piso_dia  int NOT NULL DEFAULT 3
);

-- proativo log: idempotência + métricas do piloto
CREATE TABLE public.route_contact_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_rota date NOT NULL,
  customer_user_id uuid,
  farmer_id uuid,
  canal text NOT NULL CHECK (canal IN ('whatsapp','ligacao')),
  valor_da_ligacao numeric,
  status text,           -- enviado/respondido/convertido/sem_resposta/opt_out
  pedido_id uuid,        -- se converteu
  created_at timestamptz NOT NULL DEFAULT now()
);
```
+ RLS staff (employee/master), `opt_in_status` já na fundação. **Finalizar no plano** (PR2 bite-sized).

---

## 9. Novos clientes (cold-start) — confirmado pelo founder

"Novos clientes entrando no sistema serão incluídos nas ligações e mensagens diárias" → **sim**.
- `is_cold_start = true` no `customer_metrics_mv` → trilha de **boas-vindas/intro** (não recompra — não há histórico de cesta).
- Sem `intervalo_medio_dias`/`ticket_medio_90d` → `valor_da_ligacao` usa fallback de carteira; **cota mínima garantida** (`cold_start_piso_dia`, §8) pra não serem soterrados pelo re-rank de lucro.
- Entram pela cidade da rota como qualquer outro (se o cadastro tiver endereço/cidade).

---

## 10. Motor diário Divinópolis + Carmo do Cajuru

- `route_schedule.is_daily = true` pra essas duas cidades → entram na fila **todo dia útil** (inclusive sexta, quando o motor de rota descansa).
- Mesmos critérios (§6), mesmo opt-in/cadência. O founder confirmou que têm entrega diária → o estímulo JIT vale todo dia.

---

## 11. Piloto 2–4 semanas + métricas (decisão: automatizar mais vs contratar)

Conclusões da análise de capacidade (Task #22, framework do codex):
- Otimizar **lucro por minuto restrito** da vendedora, não alcance.
- Gargalo real pós-automação = **compressão operacional antes das 17:00** (separação/faturamento), não a IA.
- **Custo de automação por R$ de lucro bruto incremental** vs **custo de contratar** é a métrica de decisão.

Métricas do piloto (de `route_contact_log` + pedidos):
- **Conversão proativa** por canal (WhatsApp IA × ligação) e por faixa de `valor_da_ligacao`.
- **Ticket médio** proativo × baseline.
- **Lucro bruto incremental/dia** atribuível ao motor.
- **Minutos de vendedora** gastos × pedidos faturados a tempo (entraram no caminhão).
- **Taxa de "perdeu o caminhão"** (aceitou após o corte) → calibra `disparo_corte`.
- **Custo Meta/LLM/dia** (do §11 do design v1).

Decisão ao fim: se a IA satura o tier e o lucro/minuto da vendedora está no teto **e** ainda há demanda não-atendida nas cidades → **contratar**; se a automação ainda tem folga de cap e lucro marginal > custo → **automatizar mais** antes de contratar.

---

## 12. Faseamento (PRs pequenos, fundação-primeiro, phone-free onde der)

- **PR2a — Fundação de rota + lista de ligação (NÃO depende de 360dialog/telefone):**
  helpers puros (`normalizeCityKey`, `cityKeyEquals`, resolver D-1, `isStopKeyword`) com TDD; `route_schedule`/`route_calendar_override`/`route_disparo_config` (migration via Lovable, seed das cidades); hook `useRouteContactList(date)` (cidades D-1 → `customer_visit_scores` + `customer_metrics_mv` + `farmer_client_scores` → `valor_da_ligacao` + gates §6); **tela de lista de ligação por rota** pra vendedora (a `callQueue` agrupada por vendedora) — **isso já entrega valor hoje, sem WhatsApp**, porque conserta o "motor route-blind".
- **PR2b — Disparo WhatsApp accept-a-proposal (gated em conta 360dialog + número):**
  templates aprovados, opt-in/STOP, cadência, pacing por `meta_tier_cap`, janela 24h, `disparo_inicio`/`disparo_corte`. Reusa `whatsapp-send` (PR1).
- **PR2c — Motor diário Div/Cajuru + dashboard do piloto:**
  `is_daily`, `route_contact_log` → métricas §11, painel de decisão automatizar-vs-contratar.

> PR2a destrava o ganho imediato (lista de ligação por rota+lucro) **sem depender do celular** que o founder só pega no fim de semana. PR2b/c entram quando a 360dialog estiver onboardada.

---

## 13. Dependências abertas

1. ✅ **Passe adversário do codex nos critérios §6** — FEITO (2026-05-31). Sem P1; P2 corrigidos (#3/#4/#7/#2) + adiados (#1/#5/#6/#8) — ver §6.5.
2. **Validar grafia/formato das cidades da rota no banco** — query por-cidade já enviada ao founder; semear `route_schedule` com as chaves confirmadas. Confirmar exclusão de `DIVINÓPOLIS (TO)`.
3. **Conta 360dialog + número + secrets** (`D360_API_KEY`/`D360_BASE_URL`) — bloqueia PR2b (founder pega o celular no fim de semana).
4. **Templates Meta aprovados** (accept-a-proposal / boas-vindas) — submeter na 360dialog.
5. **Limpar dado de teste do smoke** do PR1: `DELETE FROM whatsapp_conversations WHERE phone_e164 = '5599999999999';` (SQL Editor).

---

## 14. Não-objetivos do PR2 (deferidos)

- IA de orçamento conversacional completa (extração+rerank+confiança) — **PR3** (já no design v1).
- Voz pelo WhatsApp (gravação/transcrição/LGPD) — inviável p/ SMB hoje (design `2026-05-28-ligar-whatsapp-cliente-design.md`).
- Modelo treinado de propensão — v1 usa proxy dos scores; treinar depois com dado do piloto.
- Roteamento por persona/menu (camada de acesso) — fechado no v1 (#221 fechado); fora de escopo.
