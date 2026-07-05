# PCP Fase 1B — M1: Núcleo de Execução (event-sourced) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Status:** v2 — **PÓS-painel tri-modelo (2026-07-05)**. Painel deu BLOCK no v1 com 5 P1 (3 confirmados por ≥2 modelos, 2 únicos Codex de alto sinal), convergência total. As correções C1–C7 (seção "Disposições do painel") são NORMATIVAS: o SQL de produção segue ELAS, não o v1 literal. Deploy é manual (SQL Editor do Lovable) — nunca em `supabase/migrations/`.

**Goal:** Registrar a execução do chão de fábrica das cintas (iniciar/finalizar OP + eventos de exceção com consumo-motivo) como um log append-only idempotente e offline-safe, do qual o estado da OP é uma projeção — resolvendo já a dor do Tingimix (consumo não registrado).

**Architecture:** Event-sourcing. `pcp_eventos_producao` é a fonte da verdade (append-only, `id = client_event_id` do device para idempotência). `production_orders` (tabela viva, já usada pela venda) EVOLUI com colunas nullable e vira uma **projeção materializada** do estado, recalculada por `fn_pcp_projetar_op` que aplica uma máquina de estados (FSM). RPCs `SECURITY DEFINER` staff-gated espelham o padrão idempotente de `confirmar_item_picking`.

**Tech Stack:** Supabase Postgres 17 (RLS por papel, SECURITY DEFINER com `auth.uid()`), provas PG17 executáveis com falsificação (`db/test-*.sh`), RPCs SQL-puras. Frontend (M3) reusa `src/lib/offline-queue.ts` + `ScanBar` — fora deste M1.

---

## Decisões de arquitetura (money-path — ALVO DO PAINEL)

O apontamento alimenta yield/custo/estoque ⇒ money-path. Estas 5 decisões precisam do Codex (challenge) + painel ANTES do código.

- **D1 — FSM na PROJEÇÃO (leitura), não na escrita.** Eventos são fatos: sempre aceitos (idempotência por `id`), nunca rejeitados na escrita. `fn_pcp_projetar_op` lê os eventos da OP ordenados, aplica a FSM e deriva o estado; uma transição inválida (finalizar sem iniciar, consumo pós-fecho, fim duplicado) **não avança o estado** e é sinalizada como anomalia auditável — o evento permanece registrado. *Racional:* device offline entrega eventos fora de ordem; rejeitar na escrita descartaria fatos legítimos. *Endurecimento #9 do Gate 0 vira:* a FSM rejeita a TRANSIÇÃO, não o registro.
  - **Alternativa a debater:** validar na escrita (rejeita o INSERT) — mais simples, mas perde eventos offline fora de ordem e acopla device↔ordem-de-chegada.

- **D2 — Idempotência: `id = client_event_id` (uuid do device) como PK + `ON CONFLICT DO NOTHING`.** Idêntico a `confirmar_item_picking`. Replay offline→online não duplica. O device gera `crypto.randomUUID()` no toque.

- **D3 — `production_orders` EVOLUI (colunas nullable), não tabela nova.** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (não-destrutivo, idempotável no SQL Editor). A projeção escreve `estado_projetado`/`iniciada_em`/`completed_at`. *Racional:* a tabela já é usada pela venda e pelas edges; duplicar em `pcp_ops` fragmentaria a verdade. *Risco a validar com o Codex:* a projeção (writer do estado) coexiste com a edge `omie-vendas-sync` que também escreve `status` — precisa de **1 writer por coluna** (a edge escreve `omie_*`; a projeção escreve `estado_projetado`; `status` legado é deixado ou migrado).

- **D4 — Ordenação de eventos por `client_ts` com desempate `server_ts`.** Clock skew do device é mitigado porque o pool final é **1 operador** (a OP é apontada por 1 device por vez). Multi-device na mesma OP → a FSM sinaliza conflito, não corrompe. *A debater:* usar sequência lógica (Lamport) vs. timestamp — YAGNI para 1 operador?

- **D5 — Governança do consumo-motivo (#6 do Gate 0), validada na RPC.** `motivo='producao'` exige `op_id` com OP existente; `motivo IN ('erro_formula','teste')` exige `componente_codigo` (o insumo-alvo) — não vira lixeira; `motivo='ajuste'` registra mas marca para revisão. Relatórios separam motivos não-produtivos.

---

## Disposições do painel tri-modelo (2026-07-05) — NORMATIVAS (o SQL segue estas, não o v1 literal)

**BLOCK do v1**: 3 P1 confirmados por ≥2 modelos + 2 P1 únicos Codex. Sem divergências (convergência valida event-sourcing + FSM-na-projeção; os furos são de blindagem). Correções obrigatórias antes do SQL de produção:

- **C1 — Lock por OP na projeção** *(race; Claude+Codex+Gemini P1)*. Início de `fn_pcp_projetar_op`: `PERFORM pg_advisory_xact_lock(hashtextextended(p_op_id::text, 0));` — serializa projeções concorrentes na mesma OP. Prova: 2 conexões concorrentes (iniciar‖finalizar) → `estado_projetado` final determinístico `concluida`.
- **C2 — Projeção NÃO escreve `completed_at`/`status`** *(2-writers; Claude+Codex+Gemini P1; evidência `supabase/functions/omie-vendas-sync/index.ts:2901` `.update({status:'completed', completed_at})`)*. A projeção escreve **só** `estado_projetado` + `iniciada_em` (colunas novas, dela exclusivas). `completed_at`/`status` seguem donos da edge Omie. Remove o `COALESCE(t_fim, completed_at)` do v1.
- **C3 — Fechar a superfície das RPCs** *(SECURITY DEFINER/PUBLIC + uid NULL; Codex P1 auth)*. `REVOKE ALL ON FUNCTION` de PUBLIC, anon, authenticated em TODAS as funções; `GRANT EXECUTE` só nos **wrappers** (`iniciar`/`finalizar`/`registrar_evento`) a authenticated; base interna e `fn_pcp_projetar_op` sem grant (chamadas via SECURITY DEFINER rodam como owner). Gate **fail-closed**: `IF v_uid IS NULL OR NOT (staff) THEN RAISE`. Prova: anon barrado, authenticated não-staff barrado.
- **C4 — `device_seq` + detecção de late-arrival** *(ordenação client_ts adulterável; Codex P2 + Gemini P1)*. Coluna `device_seq bigint NOT NULL` (monotônico por device, gerado no app). Projeção ordena por `(client_ts, device_seq, server_ts)`. Anomalia money-path INDEPENDENTE da reordenação: evento stock-impacting cujo `server_ts` é posterior a um `finalizar_op` já projetado ⇒ `late_arrival` (relógio atrasado não mascara). Prova: replay de `consumo_mp` com `client_ts` anterior mas `server_ts` posterior ao fecho → anomalia.
- **C5 — Idempotência valida payload** *(Codex P2)*. No conflito de `id`, comparar campos imutáveis (`op_id,tipo,componente_codigo,quantidade`); divergência ⇒ `RAISE EXCEPTION 'idempotency_key_reuse'` (não engole fato). Replay idêntico continua no-op. Prova: mesmo `event_id`, payload diferente → EXCEPTION.
- **C6 — Invariantes do `consumo_mp` + semântica com o backflush** *(Codex P1 + Claude P2 + Gemini P2)*. `consumo_mp` exige `componente_codigo` + `quantidade > 0` + `unidade` (qualquer motivo que mova estoque) e estado ∈ {`em_producao`,`pausada`}. **Semântica canônica (fecha a dupla-contagem):** o `consumo_mp` apontado é a FONTE real do yield; o backflush do M2 é DERIVADO da BOM, **idempotente por OP e recalculável** a cada evento (mesmo late-arrival) — reconcilia com o real, **não soma**. `motivo='producao'` só no domínio sem backflush linear (Tingimix); a cinta usa backflush reconciliado. Prova: consumo sem componente/qtd → EXCEPTION; consumo em `aguardando` → anomalia.
- **C7 — Provas que faltavam** *(test_gap; Codex P2)*. FSM **não-avança** em transição inválida com expected FIXO (finalizar-sem-iniciar ⇒ estado permanece `aguardando`, flag ⇒ `aguardando_anomalo` — sem "ou"); nova ZONA de concorrência (2 conexões + advisory lock); reuse de `event_id` com payload divergente; anon barrado; `late_arrival` por `server_ts`.

**Nota de produto (founder):** C6 decide que a **verdade do yield é o consumo apontado**, não o backflush teórico. O Tingimix (sua dor de "consumo não registrado") usa `consumo_mp` direto; a cinta usa backflush reconciliado com o apontado — sem baixa dupla. Isso amarra o M1 ao M2.

---

## File Structure

- **Create** `db/pcp-f1b-m1-execucao.sql` — DDL + projeção + RPCs. Um arquivo (idempotável, aplicado via SQL Editor), como `pcp-f1a-m2-nucleo.sql`.
- **Modify (via SQL, dentro do mesmo arquivo)** `production_orders` — `ALTER ADD COLUMN IF NOT EXISTS` (D3).
- **Create** `db/test-pcp-f1b-execucao.sh` — prova PG17 (idempotência, FSM com falsificação, RLS append-only, governança-motivo).
- **Modify** `docs/historico/pcp.md` — entrada do M1.

Tabelas novas: `pcp_etapas_catalogo` (roteiro por família, tempos NULL), `pcp_eventos_producao` (append-only). Nenhuma alteração de frontend neste M1.

---

## Task 1: DDL — catálogo de etapas + eventos append-only + evolução de `production_orders`

**Files:**
- Create: `db/pcp-f1b-m1-execucao.sql` (bloco 1)

- [ ] **Step 1: Escrever o DDL (dentro de `BEGIN; … COMMIT;`)**

```sql
-- ── 1) Catálogo de etapas do roteiro (por família). Tempos NASCEM NULL (ausente ≠ zero). ──
CREATE TABLE IF NOT EXISTS public.pcp_etapas_catalogo (
  familia   text NOT NULL,                          -- 'cinta' (1B: cintas-first)
  etapa     text NOT NULL,                          -- corte_rolo|guilhotina|esmeril|prensa|corte_multiplo
  ordem     int  NOT NULL,
  centro    text NOT NULL CHECK (centro IN ('slitter','pool_final')),
  bloqueante boolean NOT NULL DEFAULT false,        -- recurso crítico (prensa) — endurecimento #3
  tempo_padrao_seg numeric,                         -- NULL = desconhecido; nasce do apontamento
  PRIMARY KEY (familia, etapa)
);

-- Seed do roteiro da cinta (o gargalo declarado é 'da guilhotina em diante').
INSERT INTO public.pcp_etapas_catalogo (familia, etapa, ordem, centro, bloqueante) VALUES
  ('cinta','corte_rolo',     1,'slitter',    false),
  ('cinta','guilhotina',     2,'pool_final', false),
  ('cinta','esmeril',        3,'pool_final', false),
  ('cinta','prensa',         4,'pool_final', true),   -- prensa quebrada bloqueia promessa
  ('cinta','corte_multiplo', 5,'pool_final', false)
ON CONFLICT (familia, etapa) DO NOTHING;

-- ── 2) Log append-only de execução. id = client_event_id do device (idempotência D2). ──
CREATE TABLE IF NOT EXISTS public.pcp_eventos_producao (
  id        uuid PRIMARY KEY,                        -- crypto.randomUUID() no toque
  op_id     uuid NOT NULL REFERENCES public.production_orders(id),
  tipo      text NOT NULL CHECK (tipo IN ('iniciar_op','pausar','retomar','finalizar_op','refugo','consumo_mp')),
  motivo    text CHECK (motivo IN ('producao','erro_formula','teste','ajuste')),
  etapa     text,                                    -- opcional (futuro: apontamento por etapa)
  componente_codigo bigint,                          -- consumo_mp/refugo: qual insumo
  quantidade numeric,                                -- refugo/consumo: qtd (absoluta)
  unidade   text,
  nota      text,
  device_id text NOT NULL,                           -- escopo do client_event_id (D2/D4)
  account   text NOT NULL DEFAULT 'colacor',
  criado_por uuid,                                   -- auth.uid() server-side (anti-spoof)
  client_ts timestamptz NOT NULL,                    -- quando ocorreu no device (ordena a FSM — D4)
  server_ts timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pcp_eventos_op ON public.pcp_eventos_producao (op_id, client_ts, server_ts);

-- ── 3) production_orders EVOLUI (D3): colunas nullable, não-destrutivo. ──
ALTER TABLE public.production_orders
  ADD COLUMN IF NOT EXISTS origem          text,
  ADD COLUMN IF NOT EXISTS prioridade      int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS roteiro_familia text,
  ADD COLUMN IF NOT EXISTS iniciada_em     timestamptz,
  ADD COLUMN IF NOT EXISTS estado_projetado text;    -- writer ÚNICO = fn_pcp_projetar_op
-- CHECK de origem separado (ADD COLUMN + CHECK inline falha se a coluna já existир de re-colagem)
DO $$ BEGIN
  ALTER TABLE public.production_orders
    ADD CONSTRAINT pcp_po_origem_chk CHECK (origem IS NULL OR origem IN ('pedido_venda','sugestao_mts_rolo','sugestao_mts','manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
```

- [ ] **Step 2: Aplicar 2× no harness PG17 e provar idempotência** (Task 4 cobre; aqui só a intenção — re-colar no SQL Editor é rotina).

---

## Task 2: Projeção + FSM (`fn_pcp_projetar_op`) — o coração do D1

**Files:**
- Modify: `db/pcp-f1b-m1-execucao.sql` (bloco 2)

- [ ] **Step 1: Escrever a projeção (FSM na leitura)**

```sql
-- Deriva o estado da OP a partir dos eventos (append-only). Estados:
--   aguardando → em_producao → (pausada ↔ em_producao) → concluida
-- Transição inválida NÃO avança e marca anomalia (D1). Idempotente e pura sobre os eventos.
CREATE OR REPLACE FUNCTION public.fn_pcp_projetar_op(p_op_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ev record;
  estado text := 'aguardando';
  anomalia boolean := false;
  t_inicio timestamptz;
  t_fim timestamptz;
BEGIN
  FOR ev IN
    SELECT tipo, client_ts FROM pcp_eventos_producao
    WHERE op_id = p_op_id
    ORDER BY client_ts, server_ts,
      array_position(ARRAY['iniciar_op','retomar','pausar','refugo','consumo_mp','finalizar_op'], tipo)
  LOOP
    CASE ev.tipo
      WHEN 'iniciar_op' THEN
        IF estado = 'aguardando' THEN estado := 'em_producao'; t_inicio := ev.client_ts;
        ELSE anomalia := true; END IF;               -- iniciar duplo
      WHEN 'pausar' THEN
        IF estado = 'em_producao' THEN estado := 'pausada'; ELSE anomalia := true; END IF;
      WHEN 'retomar' THEN
        IF estado = 'pausada' THEN estado := 'em_producao'; ELSE anomalia := true; END IF;
      WHEN 'finalizar_op' THEN
        IF estado IN ('em_producao','pausada') THEN estado := 'concluida'; t_fim := ev.client_ts;
        ELSE anomalia := true; END IF;               -- finalizar sem iniciar / duplo
      WHEN 'refugo' THEN
        IF estado NOT IN ('em_producao','pausada') THEN anomalia := true; END IF;
      WHEN 'consumo_mp' THEN
        IF estado = 'concluida' THEN anomalia := true; END IF;  -- consumo pós-fecho
    END CASE;
  END LOOP;

  UPDATE public.production_orders
     SET estado_projetado = CASE WHEN anomalia THEN estado || '_anomalo' ELSE estado END,
         iniciada_em  = t_inicio,
         completed_at = COALESCE(t_fim, completed_at)
   WHERE id = p_op_id;
  RETURN CASE WHEN anomalia THEN estado || '_anomalo' ELSE estado END;
END $$;
```

- [ ] **Step 2:** Anotar para o painel: `completed_at = COALESCE(t_fim, completed_at)` preserva o valor da edge se o evento não trouxe fim — checar se colide com D3 (1 writer). Candidato a `estado_projetado` ser a ÚNICA coluna que a projeção toca.

---

## Task 3: RPCs idempotentes (iniciar/finalizar/registrar) — staff-gated (molde `confirmar_item_picking`)

**Files:**
- Modify: `db/pcp-f1b-m1-execucao.sql` (bloco 3)

- [ ] **Step 1: `fn_pcp_registrar_evento` (base) + wrappers iniciar/finalizar**

```sql
-- Base: INSERT idempotente + projeção. Gate de staff por auth.uid() (SECURITY DEFINER — current_user
-- seria o owner). Governança do motivo (D5). userId derivado server-side (anti-spoof).
CREATE OR REPLACE FUNCTION public.fn_pcp_registrar_evento(
  p_event_id uuid, p_op_id uuid, p_tipo text, p_device_id text, p_client_ts timestamptz,
  p_motivo text DEFAULT NULL, p_componente bigint DEFAULT NULL, p_quantidade numeric DEFAULT NULL,
  p_unidade text DEFAULT NULL, p_etapa text DEFAULT NULL, p_nota text DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NOT NULL
     AND NOT (has_role(v_uid,'master'::app_role) OR has_role(v_uid,'employee'::app_role)) THEN
    RAISE EXCEPTION 'fn_pcp_registrar_evento: apenas staff';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM production_orders WHERE id = p_op_id) THEN
    RAISE EXCEPTION 'OP % inexistente', p_op_id;
  END IF;
  -- D5: governança do consumo-motivo.
  IF p_tipo = 'consumo_mp' THEN
    IF p_motivo IS NULL THEN RAISE EXCEPTION 'consumo_mp exige motivo'; END IF;
    IF p_motivo IN ('erro_formula','teste') AND p_componente IS NULL THEN
      RAISE EXCEPTION 'motivo % exige componente_codigo (insumo-alvo)', p_motivo;
    END IF;
  END IF;
  INSERT INTO pcp_eventos_producao (id, op_id, tipo, motivo, etapa, componente_codigo,
    quantidade, unidade, nota, device_id, criado_por, client_ts)
  VALUES (p_event_id, p_op_id, p_tipo, p_motivo, p_etapa, p_componente,
    p_quantidade, p_unidade, p_nota, p_device_id, v_uid, p_client_ts)
  ON CONFLICT (id) DO NOTHING;                       -- D2: replay-safe
  RETURN fn_pcp_projetar_op(p_op_id);                -- D1: projeção deriva o estado
END $$;

CREATE OR REPLACE FUNCTION public.fn_pcp_iniciar_apontamento(
  p_event_id uuid, p_op_id uuid, p_device_id text, p_client_ts timestamptz)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT fn_pcp_registrar_evento(p_event_id, p_op_id, 'iniciar_op', p_device_id, p_client_ts);
$$;

CREATE OR REPLACE FUNCTION public.fn_pcp_finalizar_apontamento(
  p_event_id uuid, p_op_id uuid, p_device_id text, p_client_ts timestamptz)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT fn_pcp_registrar_evento(p_event_id, p_op_id, 'finalizar_op', p_device_id, p_client_ts);
$$;
```

- [ ] **Step 2: RLS + grants** (staff-read; escrita só via RPC; append-only — sem UPDATE/DELETE para authenticated)

```sql
ALTER TABLE public.pcp_etapas_catalogo   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pcp_eventos_producao  ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pcp_etapas_sel ON public.pcp_etapas_catalogo;
CREATE POLICY pcp_etapas_sel ON public.pcp_etapas_catalogo FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
DROP POLICY IF EXISTS pcp_eventos_sel ON public.pcp_eventos_producao;
CREATE POLICY pcp_eventos_sel ON public.pcp_eventos_producao FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
REVOKE ALL ON public.pcp_etapas_catalogo, public.pcp_eventos_producao FROM anon, authenticated;
GRANT SELECT ON public.pcp_etapas_catalogo, public.pcp_eventos_producao TO authenticated;
-- INSERT só pela RPC (SECURITY DEFINER = owner). Sem grant de INSERT/UPDATE/DELETE p/ authenticated → append-only de fato.
GRANT EXECUTE ON FUNCTION public.fn_pcp_iniciar_apontamento(uuid,uuid,text,timestamptz),
  public.fn_pcp_finalizar_apontamento(uuid,uuid,text,timestamptz) TO authenticated;
```

---

## Task 4: Prova PG17 com falsificação (`db/test-pcp-f1b-execucao.sh`)

**Files:**
- Create: `db/test-pcp-f1b-execucao.sh` (molde: `db/test-pcp-f1a-destilacao.sh` — mesmo harness `P()/Pq()`)

- [ ] **Step 1: Zonas de prova** (cada `eq` é um caso; PASS/FAIL contados)

```
ZONA 1: stubs (auth.uid, has_role, user_roles, app_role) + production_orders mínima + 1 OP fixture.
ZONA 2: aplica db/pcp-f1b-m1-execucao.sql 2× (idempotência do DDL — re-colar não quebra).
ZONA 3: FSM feliz — iniciar→estado 'em_producao'; finalizar→'concluida'; iniciada_em/completed_at gravados.
ZONA 4: idempotência (D2) — chamar iniciar 2× com MESMO p_event_id ⇒ 1 linha em pcp_eventos_producao.
ZONA 5: FSM falsifica (D1):
        - finalizar SEM iniciar ⇒ 'concluida_anomalo' (ou 'aguardando_anomalo' conforme regra) — DEVE marcar anomalia;
        - iniciar duplo (event_ids distintos) ⇒ anomalia;
        - consumo_mp após finalizar ⇒ anomalia;
        - SABOTAGEM: comentar o teste de anomalia e exigir que a prova fique VERMELHA.
ZONA 6: governança motivo (D5) — consumo_mp sem motivo ⇒ EXCEPTION; motivo='teste' sem componente ⇒ EXCEPTION; motivo='producao' ok.
ZONA 7: RLS/append-only — não-staff no helper ⇒ 'apenas staff'; UPDATE/DELETE cru em pcp_eventos_producao por authenticated ⇒ permission denied; staff SELECT ok, não-staff vê 0.
ZONA 8: ordenação (D4) — 2 eventos com client_ts fora de ordem de chegada ⇒ FSM ordena por client_ts (resultado estável).
```

- [ ] **Step 2: Rodar** `heavy bash db/test-pcp-f1b-execucao.sh > /tmp/t.log 2>&1; echo "exit=$?"` — Expected: `RESULTADO: PASS=N FAIL=0`.
- [ ] **Step 3: Falsificar** — sabotar 1 regra da FSM no SQL, re-rodar, exigir FAIL; reverter.
- [ ] **Step 4: Commit** `feat(pcp): F1B-M1 — núcleo de execução event-sourced (eventos + projeção FSM + RPCs)`.

---

## Task 5: Painel tri-modelo + pacote de deploy do founder

- [ ] **Step 1:** Rodar `triagem-3-modelos` (modo pr) sobre o diff do plano+SQL. Incorporar findings (esperado: challenge em D1/D3/D4).
- [ ] **Step 2:** Escrever o **passo-a-passo de deploy** (SQL Editor): colar `pcp-f1b-m1-execucao.sql`; verificar via psql-ro (`\d pcp_eventos_producao`, RLS on, colunas novas em production_orders, `fn_pcp_projetar_op` existe).
- [ ] **Step 3:** Diário em `docs/historico/pcp.md`.

---

## Self-Review (contra a spec §Camada 1 itens 6–9)

- **Item 6 (OP com etapas, origem, data prometida, prioridade):** ✅ `origem`/`prioridade`/`roteiro_familia` em production_orders + `pcp_etapas_catalogo`. `ready_by_date` já existe.
- **Item 7 (apontamento event-sourced offline por-OP + consumo-motivo + client_event_id idempotente + FSM na projeção):** ✅ `pcp_eventos_producao` + D1/D2/D5. Offline (M3) reusa `offline-queue.ts`.
- **Item 8 (backflush ao concluir):** ⏳ **fora do M1** — vai no M2 (o evento `finalizar_op` já existe como gatilho; o backflush teórico/yield é M2). Anotado.
- **Item 9 (OP impressa/barcode/etiqueta de rolo):** ⏳ fora do M1 (frontend/impressão) — M3.
- **Endurecimento #9 (máquina de estados rejeita transições):** ✅ D1 na projeção.
- **Endurecimento #6 (governança consumo-motivo):** ✅ D5 na RPC.
- **Endurecimento #3 (recurso bloqueante):** ✅ flag `bloqueante` no catálogo (uso pleno na capacidade, Fase 3).
- **Gap conhecido:** corte múltiplo (rota+coproduto+rateio, item Camada 0/§2) fica no **M2** junto do backflush. Registrado.
