# Baixa de PO — Fase 0 (lista "Pedidos para baixar", sem escrita no Omie) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dar à equipe uma lista confiável dos pedidos de compra que o **motor ainda conta como "a caminho"** mas
cujas NFs já os cobriram (e das demais classes que pedem olho humano), e medir por SKU quanto "a caminho" fantasma
isso representa — sem nenhuma escrita no Omie.

**Architecture:** o `omie-sync-estoque` passa a registrar, por execução, o conjunto de POs que leu e quanto cada item
contribuiu para o `estoque_pendente_entrada` (PR0 — a evidência na unidade que cobra). O `omie-sync-nfes-recebidas`
passa a espelhar cada recebimento lido do Omie em versões imutáveis (PR(b) — o bloco `receipt`/`receipt_item` do
receipt-first ledger de 2026-08-13). Um classificador PURO cruza os dois e separa **cobertura** de **elegibilidade**
para encerrar (PR(c1)); uma página staff mostra o resultado com sensor (PR(c2)). Em paralelo: enum `ENCERRADO` isolado
(PR(a1)), ownership de `status` por domínio (PR(a2)) e proteção do "a caminho" contra etapa nova (PR(d)).

**Tech Stack:** Supabase Postgres (migrations custom aplicadas à mão, RLS, RPC SECURITY DEFINER/INVOKER), edges Deno
(`omie-sync-estoque`, `omie-sync-nfes-recebidas`), React 18 + TS strict + react-query + shadcn/ui, vitest, testes Deno,
provas SQL em PostgreSQL 17 (`db/`).

**Spec:** `docs/superpowers/specs/2026-09-26-baixa-pedido-compra-nf-concluida-design.md` — leia as §13 (medição em
prod), §14 (F1–F3), §15 (revisão) e §16 (parecer do Codex + calibração) antes de qualquer tarefa.

**Validação deste plano (2026-10-01, antes do commit):** o código dele foi EXECUTADO, não só lido.
TS: classificador (32 testes, 22 sabotagens vermelhas com controle verde), `montar-entrada` e `resumo` (6 testes) e
`tsc --strict` rc=0. Deno: os 2 helpers de edge (12 testes) com `deno test --no-remote`. SQL: as 5 migrations aplicadas
sobre o `schema-snapshot.sql` num PG17 descartável, mais os asserts A1–A4, o versionamento do recebimento, a RPC como
staff, não-staff e anon, e as 5 queries pós-deploy, todos com rc=0. A execução pegou 7 erros que a leitura deixou
passar: 4 comparações `empresa_reposicao = text`, 1 `bigint = text`, 1 import remoto em teste Deno e 1 versão de edge
já usada na main. Os números de linha (≈) valem para a main de 2026-10-01 — as âncoras de código foram conferidas.

## Global Constraints

- **Idioma:** código, rotas, commits, PRs e comentários em português brasileiro.
- **Nenhuma escrita no Omie nesta fase.** Proibido chamar `AlterarRecebimento`, `AlterarRecebimentoConcluido`,
  `AlterarEtapaRecebimento`, `ConcluirRecebimento`, `ReverterRecebimento`, `ExcluirRecebimento`, `AlteraPedCompra`,
  `UpsertPedCompra`, `ExcluirPedCompra`. Só leitura (`PesquisarPedCompra`, `ConsultarRecebimento`, `ListarRecebimentos`).
- **Money-path:** ausente ≠ zero; fail-closed; **1 writer por sinal**, em tabela/coluna dedicada (nunca jsonb
  multi-writer); ausência de um PO numa observação **nunca** vira "fechado" fora da janela de um run completo;
  `cheia` (cobertura) **não** é `elegivel` (dá para encerrar).
- **Unidade que cobra:** unidades de SKU no `sku_estoque_atual.estoque_pendente_entrada`. Toda medição de efeito é por
  SKU, na coorte fixa dos SKUs habilitados com PO etapa 15 (191 em 2026-09-26), nunca em R$ nem em contagem de PO.
- **Migrations:** skill `lovable-db-operator` obrigatória. Arquivo novo em `supabase/migrations/` com nome
  `$(date -u +%Y%m%d%H%M%S)_<slug>.sql` (maior que o da última migration); idempotente; `BEGIN; … COMMIT;` com bloco
  `DO $post$` de postcondição (exceto `ALTER TYPE … ADD VALUE`, que vai sozinho e sem transação); tabela nova sempre com
  RLS; `REVOKE` por NOME (`PUBLIC`, `anon`, `authenticated`); nunca editar migration existente; prova PG17 em
  `db/test-*.sh` registrada em `db/nucleo-ci.txt`; `bun run audit:migrations` + commit dos artefatos. **Merge ≠
  produção:** a aplicação é manual (envelope da sessão ou SQL Editor do founder) e validada por `psql-ro`.
- **Edges:** todo PR que muda edge bumpa o `VERSAO` em `supabase/functions/<edge>/versao.ts` (formato
  `^v\d+\.\d+-[a-z0-9-]+$`, slug nomeando a fatia; os números citados nas tasks valem para a main de 2026-10-01 — se
  ela já tiver bumpado, use a PRÓXIMA versão livre com o mesmo slug), regrava `bun run sonda:fingerprint -- --write` e passa nos 5 gates:
  `bun run test:edges`, `bun run edges:typecheck`, `bun run test`, `bun run sonda:bump`, `bun run sonda:fingerprint`
  (+ `bun lint`). Quem lê a edge como texto: `bun scripts/edges-guardrails-afetados.ts supabase/functions/<edge>/index.ts`.
  Deploy decidido por `bun run pendencias:deploy` (ledger), nunca pelo diff do PR.
- **Front:** filtros com `useUrlState`; `<PageSkeleton variant="list" />`; `<EmptyState tone="operational" …/>`;
  `<AvisoLeituraFalhou>` via `estadoDeLeitura`/`naoConsegui`; listas com `fetchAllPages` de `@/lib/postgrest` (capa de
  1.000 do PostgREST, inclusive em `.rpc()`); `track('<area>.<acao>')` de `@/lib/analytics`; arquivo novo em `src/`
  precisa de dono em `src/lib/modulos/manifesto.ts` (teste novo = caminho literal na lista `testes` do módulo
  `reposicao`).
- **Codex:** este plano já teve a consulta de DESENHO (spec §16). Cada PR tem o **adversarial no diff final**
  (`scripts/codex-async.sh` em background, reasoning `max`) e registra no corpo:
  `Codex: desenho=gpt-6-astra·max·327s·69.135 tokens (spec §16) · código=<rollout·pp> · extra=<gatilho|nenhum>`.
- **Multi-sessão:** `omie-sync-estoque` e `omie-sync-nfes-recebidas` são arquivos QUENTES. Antes de cada PR e de novo
  imediatamente antes do `gh pr create`: `git fetch && git log origin/main -- <arquivo>`, `gh pr list` e procurar o
  artefato com `git grep <símbolo-novo> origin/main`.
- **RAM:** prefixe `heavy` em `bun run test`/`typecheck`/`build` na máquina do founder.

---

## Mapa de arquivos

| PR | arquivo | responsabilidade |
|---|---|---|
| PR0 | `supabase/migrations/<ts>_reposicao_po_observado_pelo_motor.sql` | tabelas `reposicao_po_observado_run`/`_item` + RPC `reposicao_po_observado_publicar` (1 writer) + retenção 14 d |
| PR0 | `db/test-reposicao-po-observado.sh` | prova PG17 (publicação, CHECKs, retenção, ACL/RLS) |
| PR0 | `supabase/functions/omie-sync-estoque/observacao-po.ts` (+ `_test.ts`) | helper PURO: linha observada por item + motivo de exclusão + invariante "soma = pendente" |
| PR0 | `supabase/functions/omie-sync-estoque/index.ts`, `versao.ts` | coleta nos pontos de decisão da varredura; publicação best-effort |
| PR0 | `src/lib/reposicao/__tests__/observacao-po-edge.test.ts` | guarda textual: publicar é não-fatal e só depois do invariante |
| PR(b) | `supabase/migrations/<ts>_recebimento_omie_espelho_versionado.sql` | `recebimento_omie`/`recebimento_omie_item` versionados + RPC `recebimento_omie_publicar` + `recebimento_omie_para_revisitar` |
| PR(b) | `db/test-recebimento-omie.sh` | prova PG17 (versão nova × sem mudança × leitura velha × atomicidade × ACL) |
| PR(b) | `supabase/functions/omie-sync-nfes-recebidas/recebimento-omie.ts` (+ `_test.ts`) | helper PURO: detalhe do `ConsultarRecebimento` → cabeçalho + itens (leitura completa ou recusa) |
| PR(b) | `supabase/functions/omie-sync-nfes-recebidas/index.ts`, `versao.ts` | publica após cada `ConsultarRecebimento` bem-sucedido (casada OU órfã) + revisita limitada |
| PR(b) | `src/lib/reposicao/__tests__/recebimento-omie-edge.test.ts` | guarda textual: publicação não-fatal, também na órfã |
| PR(a1) | `supabase/migrations/<ts>_status_pedido_compra_encerrado.sql` | só o `ADD VALUE 'ENCERRADO'` |
| PR(a2) | `supabase/functions/omie-sync-nfes-recebidas/index.ts`, `versao.ts` | para de escrever `status` nas linhas de PO (> 0); segue dono das órfãs (< 0) |
| PR(a2) | `supabase/migrations/<ts>_aposenta_views_status_pedido_compra.sql` | aposenta `v_pedidos_em_aberto`/`v_leadtime_por_grupo` se `pg_depend` vazio |
| PR(c1) | `src/lib/reposicao/po-baixa/classificar-po.ts` | classificador PURO (validado: 32 testes, 22 sabotagens vermelhas) |
| PR(c1) | `src/lib/reposicao/__tests__/po-baixa-classificar.test.ts` | testes do classificador |
| PR(c1) | `supabase/migrations/<ts>_reposicao_pos_para_baixar.sql` + `db/test-reposicao-pos-para-baixar.sh` | RPC `SECURITY INVOKER` que monta as entradas (situação, itens, recebimentos, outros POs do contrato) |
| PR(c1) | `src/lib/reposicao/po-baixa/montar-entrada.ts` + `src/lib/reposicao/__tests__/po-baixa-montar-entrada.test.ts` | linha da RPC → entrada tipada do classificador (parse estrito) |
| PR(c2) | `src/components/reposicao/po-baixa/usePedidosParaBaixar.ts` | hook (fetchAllPages + classificação) |
| PR(c2) | `src/components/reposicao/po-baixa/PedidosBaixarTabela.tsx` + `resumo.ts` | tabela, filtros, cópia do motivo, contagem por classe |
| PR(c2) | `src/pages/AdminReposicaoPedidosBaixar.tsx`, `src/App.tsx`, `src/components/shell/CommandPalette.tsx`, `src/lib/routeCrumbs.ts` | página staff `admin/reposicao/pedidos-baixar` |
| PR(c2) | `src/pages/__tests__/AdminReposicaoPedidosBaixar.leitura.test.tsx`, `src/components/reposicao/po-baixa/__tests__/*.test.ts(x)` | testes de host e de componente |
| PR(d) | `supabase/functions/omie-sync-estoque/index.ts`, `versao.ts` + guarda textual | etapa aberta desconhecida com saldo bloqueia a publicação do pendente |

## Ordem e dependências

```text
PR0 ──► PR(b) ──► PR(c1) ──► PR(c2)
 │                  ▲
 ├──► PR(d) (mede etapas nos snapshots do PR0 antes de bloquear)
PR(a1) ──► PR(a2)          (independentes de PR0/PR(b); só não podem inverter entre si)
```

**Gate de investimento (depois do PR0 no ar por 7 dias):** rodar a query da Task 0.5. Se o "a caminho" fantasma
medido (unidades por SKU vindas de POs com NF concluída) for pequeno e sem concentração em SKU perto da ruptura, os
PRs (c1)/(c2) viram higiene de baixa prioridade e o founder decide se seguem (spec §16.2, fecho).

---

## PR0 — o `omie-sync-estoque` registra o conjunto que o motor contou

### Task 0.1: migration das tabelas de observação + RPC de publicação

**Files:**
- Create: `supabase/migrations/<ts>_reposicao_po_observado_pelo_motor.sql`

**Interfaces:**
- Produces: `public.reposicao_po_observado_run(run_id uuid PK, empresa, iniciado_em, concluido_em, janela_de date,
  janela_ate date, filtros jsonb, varredura_completa bool, pendente_aplicado bool, pedidos_lidos int, versao_edge,
  gravado_em)`; `public.reposicao_po_observado_item(run_id, omie_codigo_pedido bigint, seq_item int, numero_pedido,
  etapa, id_item bigint, sku_codigo_omie bigint, quantidade numeric, quantidade_recebida numeric, contribuicao numeric,
  exclusao text)`; `public.reposicao_po_observado_publicar(p_run jsonb, p_itens jsonb) RETURNS integer`.

- [ ] **Step 1: invocar a skill `lovable-db-operator`** e seguir o ritual dela para esta migration.

- [ ] **Step 2: escrever a migration**

```sql
-- Reposição — o omie-sync-estoque registra, POR EXECUÇÃO, os POs que leu no PesquisarPedCompra do "a caminho" e
-- quanto cada item CONTRIBUIU para o estoque_pendente_entrada (spec 2026-09-26-baixa-pedido-compra-nf-concluida
-- §15 item 2; Codex §16 achado 3). 1 writer: a edge omie-sync-estoque, via RPC SECURITY DEFINER. Leitura: staff.
-- A ausência de um PO aqui NUNCA significa "fechado no Omie" por si só: só vale dentro da janela de um run com
-- varredura_completa = true (quem lê decide; o classificador trata o resto como "desconhecido").
BEGIN;

CREATE TABLE IF NOT EXISTS public.reposicao_po_observado_run (
  run_id uuid PRIMARY KEY,
  empresa text NOT NULL CHECK (empresa IN ('OBEN', 'COLACOR')),
  iniciado_em timestamptz NOT NULL,
  concluido_em timestamptz NOT NULL,
  janela_de date NOT NULL,
  janela_ate date NOT NULL,
  filtros jsonb NOT NULL,
  varredura_completa boolean NOT NULL,
  pendente_aplicado boolean NOT NULL,
  pedidos_lidos integer NOT NULL CHECK (pedidos_lidos >= 0),
  versao_edge text NOT NULL,
  gravado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (concluido_em >= iniciado_em),
  CHECK (janela_ate >= janela_de)
);
CREATE INDEX IF NOT EXISTS idx_reposicao_po_observado_run_empresa
  ON public.reposicao_po_observado_run (empresa, concluido_em DESC);

CREATE TABLE IF NOT EXISTS public.reposicao_po_observado_item (
  run_id uuid NOT NULL REFERENCES public.reposicao_po_observado_run (run_id) ON DELETE CASCADE,
  omie_codigo_pedido bigint NOT NULL,
  seq_item integer NOT NULL CHECK (seq_item >= 0),
  numero_pedido text,
  etapa text,
  id_item bigint,
  sku_codigo_omie bigint,
  quantidade numeric,
  quantidade_recebida numeric,
  contribuicao numeric NOT NULL CHECK (contribuicao >= 0),
  exclusao text CHECK (exclusao IN ('dedup_app', 'etapa_nao_aberta', 'repetido_na_varredura', 'item_sem_sku',
                                    'sku_nao_habilitado', 'quantidade_invalida')),
  CHECK (exclusao IS NULL OR contribuicao = 0),
  PRIMARY KEY (run_id, omie_codigo_pedido, seq_item)
);
CREATE INDEX IF NOT EXISTS idx_reposicao_po_observado_item_po
  ON public.reposicao_po_observado_item (omie_codigo_pedido, run_id);

COMMENT ON TABLE public.reposicao_po_observado_run IS
  'Uma linha por execução do omie-sync-estoque (OBEN): janela, filtros e se a varredura/pendente valeram. Writer único: reposicao_po_observado_publicar.';
COMMENT ON TABLE public.reposicao_po_observado_item IS
  'Itens dos POs lidos no conjunto aberto do Omie e o que cada um contribuiu ao estoque_pendente_entrada (0 + exclusao quando não contou).';

ALTER TABLE public.reposicao_po_observado_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reposicao_po_observado_item ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reposicao_po_observado_run FROM PUBLIC;
REVOKE ALL ON public.reposicao_po_observado_run FROM anon;
REVOKE ALL ON public.reposicao_po_observado_run FROM authenticated;
REVOKE ALL ON public.reposicao_po_observado_item FROM PUBLIC;
REVOKE ALL ON public.reposicao_po_observado_item FROM anon;
REVOKE ALL ON public.reposicao_po_observado_item FROM authenticated;
GRANT SELECT ON public.reposicao_po_observado_run TO authenticated;
GRANT SELECT ON public.reposicao_po_observado_item TO authenticated;

DROP POLICY IF EXISTS "reposicao_po_observado_run_select_staff" ON public.reposicao_po_observado_run;
CREATE POLICY "reposicao_po_observado_run_select_staff" ON public.reposicao_po_observado_run FOR SELECT
  USING (public.has_role(auth.uid(), 'employee'::public.app_role) OR public.has_role(auth.uid(), 'master'::public.app_role));
DROP POLICY IF EXISTS "reposicao_po_observado_item_select_staff" ON public.reposicao_po_observado_item;
CREATE POLICY "reposicao_po_observado_item_select_staff" ON public.reposicao_po_observado_item FOR SELECT
  USING (public.has_role(auth.uid(), 'employee'::public.app_role) OR public.has_role(auth.uid(), 'master'::public.app_role));
-- Sem policy de INSERT/UPDATE/DELETE de propósito: sob RLS, ausência de policy é negação. Quem escreve é a RPC.

CREATE OR REPLACE FUNCTION public.reposicao_po_observado_publicar(p_run jsonb, p_itens jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_run_id uuid := (p_run->>'run_id')::uuid;
  v_n integer;
BEGIN
  IF v_run_id IS NULL THEN
    RAISE EXCEPTION 'reposicao_po_observado_publicar: run_id ausente' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_itens) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'reposicao_po_observado_publicar: p_itens não é array' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.reposicao_po_observado_run
    (run_id, empresa, iniciado_em, concluido_em, janela_de, janela_ate, filtros, varredura_completa,
     pendente_aplicado, pedidos_lidos, versao_edge)
  VALUES
    (v_run_id, p_run->>'empresa', (p_run->>'iniciado_em')::timestamptz, (p_run->>'concluido_em')::timestamptz,
     (p_run->>'janela_de')::date, (p_run->>'janela_ate')::date, p_run->'filtros',
     (p_run->>'varredura_completa')::boolean, (p_run->>'pendente_aplicado')::boolean,
     (p_run->>'pedidos_lidos')::integer, p_run->>'versao_edge');

  INSERT INTO public.reposicao_po_observado_item
    (run_id, omie_codigo_pedido, seq_item, numero_pedido, etapa, id_item, sku_codigo_omie, quantidade,
     quantidade_recebida, contribuicao, exclusao)
  SELECT v_run_id, (i->>'omie_codigo_pedido')::bigint, (i->>'seq_item')::integer, i->>'numero_pedido', i->>'etapa',
         (i->>'id_item')::bigint, (i->>'sku_codigo_omie')::bigint, (i->>'quantidade')::numeric,
         (i->>'quantidade_recebida')::numeric, (i->>'contribuicao')::numeric, i->>'exclusao'
  FROM jsonb_array_elements(p_itens) AS i;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- Retenção no MESMO writer: 14 dias bastam para as leituras de antes/depois por lote (spec §16, achado 9).
  DELETE FROM public.reposicao_po_observado_run
   WHERE empresa = p_run->>'empresa' AND concluido_em < now() - interval '14 days';

  RETURN v_n;
END
$fn$;

REVOKE ALL ON FUNCTION public.reposicao_po_observado_publicar(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_po_observado_publicar(jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.reposicao_po_observado_publicar(jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_po_observado_publicar(jsonb, jsonb) TO service_role;

DO $post$
BEGIN
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relrowsecurity
         AND c.relname IN ('reposicao_po_observado_run', 'reposicao_po_observado_item')) <> 2 THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: tabelas de observação ausentes ou sem RLS';
  END IF;
  IF has_table_privilege('anon', 'public.reposicao_po_observado_item', 'SELECT')
     OR has_table_privilege('authenticated', 'public.reposicao_po_observado_item', 'INSERT')
     OR has_table_privilege('authenticated', 'public.reposicao_po_observado_run', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: privilégio aberto nas tabelas de observação (REVOKE por nome não pegou)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.reposicao_po_observado_publicar(jsonb,jsonb)') AND prosecdef)
     OR has_function_privilege('anon', 'public.reposicao_po_observado_publicar(jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reposicao_po_observado_publicar(jsonb,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.reposicao_po_observado_publicar(jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: RPC de publicação ausente, sem SECURITY DEFINER ou com ACL errada';
  END IF;
  RAISE NOTICE 'reposicao_po_observado: tabelas com RLS, ACL fechada, RPC 1-writer — OK';
END
$post$;

COMMIT;
```

- [ ] **Step 3: escrever a prova PG17 `db/test-reposicao-po-observado.sh`.** Copie o esqueleto das linhas 1–45 de
  `db/test-alerta-pedido-minimo.sh` (troque `PORT` para uma porta livre em `db/nucleo-ci.txt`, os nomes de
  arquivo/banco e remova o stub de `cron.schedule`), sobrescreva `auth.uid()` como em
  `db/test-acoes-execucoes.sh:42` (lê `current_setting('test.uid', true)`), aplique a migration nova e rode:

```sql
DO $$
DECLARE d int; v_staff uuid := '00000000-0000-0000-0000-00000000aaaa';
BEGIN
  -- A1: publicação grava run + itens e devolve a contagem de itens
  SELECT public.reposicao_po_observado_publicar(
    jsonb_build_object('run_id', '11111111-1111-1111-1111-111111111111', 'empresa', 'OBEN',
      'iniciado_em', now() - interval '1 minute', 'concluido_em', now(), 'janela_de', current_date - 365,
      'janela_ate', current_date + 120, 'filtros', '{"lExibirPedidosEncerrados":"F"}'::jsonb,
      'varredura_completa', true, 'pendente_aplicado', true, 'pedidos_lidos', 2, 'versao_edge', 'v1.3-teste'),
    jsonb_build_array(
      jsonb_build_object('omie_codigo_pedido', 12000000001, 'seq_item', 0, 'numero_pedido', '1205', 'etapa', '15',
        'id_item', 12000000002, 'sku_codigo_omie', 8689791246, 'quantidade', 6, 'quantidade_recebida', 0,
        'contribuicao', 6, 'exclusao', null),
      jsonb_build_object('omie_codigo_pedido', 12000000009, 'seq_item', 0, 'numero_pedido', '1300', 'etapa', '15',
        'id_item', 12000000010, 'sku_codigo_omie', 8689791246, 'quantidade', 4, 'quantidade_recebida', 0,
        'contribuicao', 0, 'exclusao', 'dedup_app'))) INTO d;
  IF d <> 2 THEN RAISE EXCEPTION 'A1 FALHOU: esperava 2 itens publicados, veio %', d; END IF;
  RAISE NOTICE 'OK A1 — publicação grava run + itens';

  -- A2: CHECK — item excluído não pode contribuir
  BEGIN
    INSERT INTO public.reposicao_po_observado_item (run_id, omie_codigo_pedido, seq_item, contribuicao, exclusao)
    VALUES ('11111111-1111-1111-1111-111111111111', 12000000011, 0, 3, 'dedup_app');
    RAISE EXCEPTION 'A2 FALHOU: excluído com contribuição > 0 foi aceito';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK A2 — excluído não contribui';
  END;

  -- A3: retenção de 14 dias pelo mesmo writer
  INSERT INTO public.reposicao_po_observado_run (run_id, empresa, iniciado_em, concluido_em, janela_de, janela_ate,
    filtros, varredura_completa, pendente_aplicado, pedidos_lidos, versao_edge)
  VALUES ('22222222-2222-2222-2222-222222222222', 'OBEN', now() - interval '20 days', now() - interval '20 days',
    current_date - 400, current_date - 20, '{}'::jsonb, true, true, 0, 'v1.3-teste');
  PERFORM public.reposicao_po_observado_publicar(
    jsonb_build_object('run_id', '33333333-3333-3333-3333-333333333333', 'empresa', 'OBEN',
      'iniciado_em', now(), 'concluido_em', now(), 'janela_de', current_date - 365, 'janela_ate', current_date + 120,
      'filtros', '{}'::jsonb, 'varredura_completa', true, 'pendente_aplicado', true, 'pedidos_lidos', 0,
      'versao_edge', 'v1.3-teste'), '[]'::jsonb);
  IF EXISTS (SELECT 1 FROM public.reposicao_po_observado_run WHERE run_id = '22222222-2222-2222-2222-222222222222') THEN
    RAISE EXCEPTION 'A3 FALHOU: run de 20 dias sobreviveu à retenção';
  END IF;
  RAISE NOTICE 'OK A3 — retenção de 14 dias';

  -- A4: p_itens que não é array é recusado com 22023
  BEGIN
    PERFORM public.reposicao_po_observado_publicar(jsonb_build_object('run_id', gen_random_uuid()), '{}'::jsonb);
    RAISE EXCEPTION 'A4 FALHOU: p_itens objeto foi aceito';
  EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'OK A4 — p_itens inválido recusado';
  END;
END $$;
```

  Depois, fora do `DO`, os asserts de ACL/RLS (padrão de `db/test-acoes-execucoes.sh`): `SET ROLE authenticated` com
  `test.uid` de um usuário **sem** `user_roles` → `SELECT count(*)` nas duas tabelas = 0; com `user_roles.role =
  'employee'` → vê as linhas; `SET ROLE anon` → `SELECT public.reposicao_po_observado_publicar(...)` falha com
  `42501`; `SET ROLE authenticated` (staff) → a mesma chamada também falha com `42501`. Cada assert captura a SQLSTATE
  esperada e re-lança o resto (nunca `WHEN OTHERS THEN 'OK'`). Termine com `echo "✅ test-reposicao-po-observado: OK"`.

- [ ] **Step 4: rodar a prova e ver passar**

Run: `bash db/test-reposicao-po-observado.sh`
Expected: `NOTICE: OK A1` … `OK A4`, os asserts de ACL, e `✅ test-reposicao-po-observado: OK` com exit 0.

- [ ] **Step 5: falsificar** — commite, depois sabote uma camada por vez numa cópia (tire o `CHECK (exclusao IS NULL OR
  contribuicao = 0)`; tire o `DELETE` de retenção; troque `REVOKE … FROM authenticated` por nada) e exija VERMELHO em
  cada uma, com um controle sem sabotagem VERDE na mesma invocação. Registre em `db/nucleo-ci.txt`:
  `db/test-reposicao-po-observado.sh <n_asserts> falsificar=3`.

- [ ] **Step 6: `bun run audit:migrations` e commit**

```bash
git add supabase/migrations/*_reposicao_po_observado_pelo_motor.sql db/test-reposicao-po-observado.sh db/nucleo-ci.txt docs/migrations-audit.md
git commit -m "feat(reposicao): tabelas de observação do conjunto aberto que o motor contou + RPC 1-writer [money-path]"
```

### Task 0.2: helper puro de observação (TDD, Deno)

**Files:**
- Create: `supabase/functions/omie-sync-estoque/observacao-po.ts`
- Test: `supabase/functions/omie-sync-estoque/observacao-po_test.ts`

**Interfaces:**
- Produces: `observarPedido(cab, itens, exclusaoDoPedido, habilitado, parse): LinhaObservada[]`,
  `somarContribuicaoPorSku(linhas): Map<string, number>`,
  `observacaoBateComPendente(linhas, pendente: Map<string, number>): boolean`, tipos `LinhaObservada`,
  `MotivoExclusao`.
- Consumes: `parseQtd`/`parseRecebido` que o `index.ts` já usa (injetados — o helper nunca reimplementa o parse).

- [ ] **Step 1: escrever o teste Deno (falha: módulo não existe)**

  ⚠️ `bun run test:edges` roda com `--no-remote`: teste de edge NÃO pode ter import remoto (nem `jsr:`, nem `npm:`).
  A asserção é uma função local `igual(a, b, msg)` que lança `Error`. O arquivo completo:

```ts
import {
  observacaoBateComPendente,
  observarPedido,
  somarContribuicaoPorSku,
} from "./observacao-po.ts";

function igual<T>(real: T, esperado: T, msg: string): void {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a !== b) throw new Error(`${msg}\n  real:     ${a}\n  esperado: ${b}`);
}

// parse estrito equivalente ao da edge: string/number finita; resto → NaN
const parse = {
  parseQtd: (v: unknown) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) ? Number(v) : NaN,
  parseRecebido: (v: unknown) => (v === undefined ? 0 : (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) ? Number(v) : NaN),
};
const habilitados = new Set(["8689791246"]);
const has = (sku: string) => habilitados.has(sku);
const cab = { nCodPed: 12000000001, cNumero: "1205", cEtapa: "15" };

Deno.test("item contado: contribuição = saldo, sem exclusão", () => {
  const l = observarPedido(cab, [{ nCodItem: 5, nCodProd: 8689791246, nQtde: 6, nQtdeRec: 2 }], null, has, parse);
  igual(l.map((x) => [x.contribuicao, x.exclusao]), [[4, null]], "saldo 6 − 2");
});

Deno.test("PO do app (de-dup): todos os itens com contribuição 0 e motivo", () => {
  const l = observarPedido(cab, [{ nCodProd: 8689791246, nQtde: 6 }, { nCodProd: 1, nQtde: 1 }], "dedup_app", has, parse);
  igual(l.map((x) => [x.contribuicao, x.exclusao]), [[0, "dedup_app"], [0, "dedup_app"]], "de-dup");
});

Deno.test("etapa não aberta e repetido na varredura propagam o motivo do pedido", () => {
  igual(observarPedido(cab, [{ nCodProd: 8689791246, nQtde: 6 }], "etapa_nao_aberta", has, parse)[0].exclusao,
    "etapa_nao_aberta", "etapa");
  igual(observarPedido(cab, [{ nCodProd: 8689791246, nQtde: 6 }], "repetido_na_varredura", has, parse)[0].exclusao,
    "repetido_na_varredura", "repetido");
});

Deno.test("motivos por item: sem SKU, SKU não habilitado, quantidade inválida", () => {
  const l = observarPedido(cab, [
    { nCodProd: "", nQtde: 1 },
    { nCodProd: 777, nQtde: 1 },
    { nCodProd: 8689791246, nQtde: "" },
  ], null, has, parse);
  igual(l.map((x) => x.exclusao), ["item_sem_sku", "sku_nao_habilitado", "quantidade_invalida"], "motivos");
  igual(l.map((x) => x.contribuicao), [0, 0, 0], "nenhum contribui");
});

Deno.test("recebido acima do pedido não gera contribuição negativa", () => {
  igual(observarPedido(cab, [{ nCodProd: 8689791246, nQtde: 2, nQtdeRec: 5 }], null, has, parse)[0].contribuicao, 0, "max(0, …)");
});

Deno.test("seq_item é a posição do item no PO e os ids vêm como número", () => {
  const l = observarPedido(cab, [{ nCodItem: "12000000002", nCodProd: 8689791246, nQtde: 1 }, { nCodProd: 8689791246, nQtde: 1 }], null, has, parse);
  igual(l.map((x) => [x.seq_item, x.id_item, x.sku_codigo_omie, x.omie_codigo_pedido]),
    [[0, 12000000002, 8689791246, 12000000001], [1, null, 8689791246, 12000000001]], "ids");
});

Deno.test("invariante: soma por SKU bate com o pendente; diverge quando falta ou sobra", () => {
  const l = [
    ...observarPedido(cab, [{ nCodProd: 8689791246, nQtde: 6, nQtdeRec: 2 }], null, has, parse),
    ...observarPedido({ ...cab, nCodPed: 2 }, [{ nCodProd: 8689791246, nQtde: 3 }], "dedup_app", has, parse),
  ];
  igual([...somarContribuicaoPorSku(l)], [["8689791246", 4]], "soma");
  igual(observacaoBateComPendente(l, new Map([["8689791246", 4]])), true, "bate");
  igual(observacaoBateComPendente(l, new Map([["8689791246", 7]])), false, "pendente maior");
  igual(observacaoBateComPendente(l, new Map([["8689791246", 4], ["1", 1]])), false, "SKU a mais no pendente");
  igual(observacaoBateComPendente(l, new Map()), false, "pendente vazio");
});
```

- [ ] **Step 2: rodar e ver falhar**

Run: `bun run test:edges`
Expected: FAIL — `Module not found "file:///…/omie-sync-estoque/observacao-po.ts"`.

- [ ] **Step 3: implementar o helper**

```ts
// Observação do conjunto que o motor contou (spec 2026-09-26-baixa-pedido-compra-nf-concluida §15 item 2).
// PURO: sem I/O. A edge chama observarPedido em CADA ponto de decisão da varredura do "a caminho" e só publica
// se observacaoBateComPendente(...) — observação que diverge do pendente calculado não é publicada, porque mediria
// outra coisa que não o que o motor contou.

export type MotivoExclusaoPedido = "dedup_app" | "etapa_nao_aberta" | "repetido_na_varredura";
export type MotivoExclusao = MotivoExclusaoPedido | "item_sem_sku" | "sku_nao_habilitado" | "quantidade_invalida";

export interface LinhaObservada {
  omie_codigo_pedido: number;
  seq_item: number;
  numero_pedido: string | null;
  etapa: string | null;
  id_item: number | null;
  sku_codigo_omie: number | null;
  quantidade: number | null;
  quantidade_recebida: number | null;
  contribuicao: number;
  exclusao: MotivoExclusao | null;
}

export interface ItemPedidoOmie {
  nCodItem?: unknown;
  nCodProd?: unknown;
  nQtde?: unknown;
  nQtdeRec?: unknown;
}

export interface CabecalhoObservado {
  nCodPed: number;
  cNumero: string | null;
  cEtapa: string | null;
}

export interface ParseQuantidades {
  parseQtd: (v: unknown) => number;
  parseRecebido: (v: unknown) => number;
}

const EPSILON = 1e-9;

function inteiroOuNull(v: unknown): number | null {
  const texto = String(v ?? "").trim();
  if (texto === "") return null;
  const n = Number(texto);
  return Number.isSafeInteger(n) ? n : null;
}

function finitoOuNull(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

export function observarPedido(
  cab: CabecalhoObservado,
  itens: ItemPedidoOmie[],
  exclusaoDoPedido: MotivoExclusaoPedido | null,
  habilitado: (sku: string) => boolean,
  parse: ParseQuantidades,
): LinhaObservada[] {
  return itens.map((it, seq) => {
    const skuTexto = String(it.nCodProd ?? "").trim();
    const qtde = parse.parseQtd(it.nQtde);
    const recebido = parse.parseRecebido(it.nQtdeRec);
    const base = {
      omie_codigo_pedido: cab.nCodPed,
      seq_item: seq,
      numero_pedido: cab.cNumero,
      etapa: cab.cEtapa,
      id_item: inteiroOuNull(it.nCodItem),
      sku_codigo_omie: inteiroOuNull(it.nCodProd),
      quantidade: finitoOuNull(qtde),
      quantidade_recebida: finitoOuNull(recebido),
    };
    const excluido = (exclusao: MotivoExclusao): LinhaObservada => ({ ...base, contribuicao: 0, exclusao });
    if (exclusaoDoPedido !== null) return excluido(exclusaoDoPedido);
    if (!skuTexto) return excluido("item_sem_sku");
    if (!habilitado(skuTexto)) return excluido("sku_nao_habilitado");
    if (!Number.isFinite(qtde) || !Number.isFinite(recebido) || qtde < 0 || recebido < 0) {
      return excluido("quantidade_invalida");
    }
    return { ...base, contribuicao: Math.max(0, qtde - recebido), exclusao: null };
  });
}

export function somarContribuicaoPorSku(linhas: LinhaObservada[]): Map<string, number> {
  const soma = new Map<string, number>();
  for (const l of linhas) {
    if (l.exclusao !== null || l.sku_codigo_omie === null || l.contribuicao <= 0) continue;
    const sku = String(l.sku_codigo_omie);
    soma.set(sku, (soma.get(sku) ?? 0) + l.contribuicao);
  }
  return soma;
}

export function observacaoBateComPendente(linhas: LinhaObservada[], pendente: Map<string, number>): boolean {
  const soma = somarContribuicaoPorSku(linhas);
  const skus = new Set<string>([...soma.keys(), ...[...pendente.entries()].filter(([, v]) => v > 0).map(([k]) => k)]);
  if (skus.size === 0) return false; // observação vazia não prova nada — não publica
  for (const sku of skus) {
    if (Math.abs((soma.get(sku) ?? 0) - (pendente.get(sku) ?? 0)) > EPSILON) return false;
  }
  return true;
}
```

- [ ] **Step 4: rodar e ver passar**

Run: `bun run test:edges`
Expected: PASS (7 testes novos, os existentes seguem verdes).

- [ ] **Step 5: commit**

```bash
git add supabase/functions/omie-sync-estoque/observacao-po.ts supabase/functions/omie-sync-estoque/observacao-po_test.ts
git commit -m "feat(omie-sync-estoque): helper puro da observação do conjunto que o motor contou"
```

### Task 0.3: ligar a observação na edge (não-fatal, com invariante)

**Files:**
- Modify: `supabase/functions/omie-sync-estoque/index.ts` (`computePendenteViaPedidosCompra` ≈ :363-495; handler ≈
  :740-800 e o resumo ≈ :940-957)
- Modify: `supabase/functions/omie-sync-estoque/versao.ts` → `VERSAO = "v1.4-observa-conjunto-aberto"`
- Create: `src/lib/reposicao/__tests__/observacao-po-edge.test.ts`
- Modify: `src/lib/modulos/manifesto.ts` (módulo `reposicao`, lista `testes`)
- Regenerate: `supabase/functions/_shared/sonda-fingerprints.ts`

**Interfaces:**
- Consumes: Task 0.2 (`observarPedido`, `observacaoBateComPendente`, `LinhaObservada`); Task 0.1 (RPC).
- Produces: summary da edge com `observacao_publicada: boolean`, `observacao_motivo: string | null`.

- [ ] **Step 1: escrever a guarda textual (falha: a edge ainda não publica)**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

const fonte = removerComentarios(
  readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-sync-estoque/index.ts'), 'utf8'),
);

describe('omie-sync-estoque — observação do conjunto aberto', () => {
  it('só publica depois de conferir que a observação bate com o pendente calculado', () => {
    const iInvariante = fonte.indexOf('observacaoBateComPendente(');
    const iRpc = fonte.indexOf('"reposicao_po_observado_publicar"');
    expect(iInvariante).toBeGreaterThan(0);
    expect(iRpc).toBeGreaterThan(iInvariante);
  });

  it('a publicação é não-fatal: chamada dentro de try/catch e nunca antes do upsert do pendente', () => {
    const trecho = fonte.slice(fonte.lastIndexOf('try {', fonte.indexOf('"reposicao_po_observado_publicar"')));
    expect(trecho.indexOf('} catch')).toBeGreaterThan(0);
    expect(fonte.indexOf('"reposicao_po_observado_publicar"')).toBeGreaterThan(fonte.indexOf('from("sku_estoque_atual")'));
  });

  it('cada ponto de decisão da varredura registra o motivo', () => {
    for (const motivo of ['"dedup_app"', '"etapa_nao_aberta"', '"repetido_na_varredura"']) {
      expect(fonte).toContain(motivo);
    }
  });
});
```

  Acrescente `"src/lib/reposicao/__tests__/observacao-po-edge.test.ts",` à lista `testes` do módulo `reposicao` em
  `src/lib/modulos/manifesto.ts` (≈ :493-499).

- [ ] **Step 2: rodar e ver falhar**

Run: `heavy bun run test -- src/lib/reposicao/__tests__/observacao-po-edge.test.ts`
Expected: FAIL nos 3 testes (`observacaoBateComPendente(` não existe na edge).

- [ ] **Step 3: ligar a coleta nos pontos de decisão** — em `computePendenteViaPedidosCompra`:
  1. `import { observarPedido, type LinhaObservada } from "./observacao-po.ts";` no topo do arquivo.
  2. Antes do laço de páginas: `const observados: LinhaObservada[] = [];` e
     `const parseObs = { parseQtd, parseRecebido };` e `const habilitado = (sku: string) => habilitadoMap.has(sku);`.
  3. Dentro do laço por pedido, logo depois de calcular `etapa`, `cNumero`, `nCodPed`:
     `const cabObs = { nCodPed: Number(nCodPed), cNumero: cNumero || null, cEtapa: etapa || null };` e
     `const itensObs = ped?.produtos_consulta ?? [];`.
  4. No ramo `if (ehApp) { … continue; }`, antes do `continue`:
     `if (nCodPed) observados.push(...observarPedido(cabObs, itensObs, "dedup_app", habilitado, parseObs));`
  5. Troque `if (!ETAPAS_APROVADO_ABERTO.has(etapa)) continue;` por:

```ts
      if (!ETAPAS_APROVADO_ABERTO.has(etapa)) {
        if (nCodPed) observados.push(...observarPedido(cabObs, itensObs, "etapa_nao_aberta", habilitado, parseObs));
        continue;
      }
```

  6. Troque `if (aliases.some((a) => posComoManual.has(a))) continue;` por:

```ts
      if (aliases.some((a) => posComoManual.has(a))) {
        observados.push(...observarPedido(cabObs, itensObs, "repetido_na_varredura", habilitado, parseObs));
        continue;
      }
```

  7. Depois do laço de itens do pedido que CONTOU (logo após o bloco `if (itensComSku === 0) { … }`):
     `observados.push(...observarPedido(cabObs, itensObs, null, habilitado, parseObs));`
  8. Inclua `observados`, `janelaDe`, `janelaAte` e `varreduraCompleta` (verdadeiro só quando a paginação terminou na
     página vazia sem `problemas`) no objeto de retorno de `computePendenteViaPedidosCompra`.

- [ ] **Step 4: publicar depois do upsert do pendente, sem nunca derrubar o run** — no handler, depois do laço de
  upsert em `sku_estoque_atual`:

```ts
    let observacaoPublicada = false;
    let observacaoMotivo: string | null = null;
    if (empresa === "OBEN") {
      if (!observacaoBateComPendente(r.observados, pendenteEntrada)) {
        observacaoMotivo = "observacao_diverge_do_pendente";
        console.error(`[omie-sync-estoque] observação do conjunto aberto NÃO bate com o pendente — não publicada`);
      } else {
        try {
          const { error } = await supabase.rpc("reposicao_po_observado_publicar", {
            p_run: {
              run_id: crypto.randomUUID(),
              empresa,
              iniciado_em: inicioRunIso,
              concluido_em: new Date().toISOString(),
              janela_de: r.janelaDe,
              janela_ate: r.janelaAte,
              filtros: FILTROS_PENDENTE,
              varredura_completa: r.varreduraCompleta,
              pendente_aplicado: pendenteConfiavel,
              pedidos_lidos: new Set(r.observados.map((o) => o.omie_codigo_pedido)).size,
              versao_edge: VERSAO,
            },
            p_itens: r.observados,
          });
          if (error) observacaoMotivo = `rpc: ${error.message}`;
          else observacaoPublicada = true;
        } catch (err) {
          observacaoMotivo = err instanceof Error ? err.message : "falha sem mensagem";
        }
        if (!observacaoPublicada) console.error(`[omie-sync-estoque] observação não publicada: ${observacaoMotivo}`);
      }
    }
```

  `FILTROS_PENDENTE` é a constante com os 7 `lExibir*` exatos que o `PesquisarPedCompra` do "a caminho" envia (extraia
  do objeto literal de ≈ :276-282 para uma `const` no topo e use a mesma nos dois lugares); `inicioRunIso` é o
  `new Date().toISOString()` capturado no início do handler; `r` é o retorno de `computePendenteViaPedidosCompra`
  (renomeie a variável local se o handler usar outro nome). Some `observacao_publicada: observacaoPublicada` e
  `observacao_motivo: observacaoMotivo` ao `summary`. ⚠️ O gate `erro-object-object-gate.test.ts` baselina a contagem de
  `instanceof Error ? … : String(` — o `catch` acima usa outra forma de propósito; confira que a contagem não cresceu.

- [ ] **Step 5: bump + fingerprint + gates**

Run:
```bash
bun run sonda:fingerprint -- --write
bun run test:edges && bun run edges:typecheck && heavy bun run test && bun run sonda:bump && bun run sonda:fingerprint && bun lint
```
Expected: todos exit 0; o teste da Task 0.3 passa; `sonda:bump` aceita porque `versao.ts` mudou para
`v1.4-observa-conjunto-aberto`.

- [ ] **Step 6: Codex adversarial no diff** (`scripts/codex-async.sh -r max -` com o diff do PR, em background) e
  commit/PR com a nota de migration manual e a ordem: **migration antes da edge** (sem a RPC, a publicação falha e o
  run segue — mas o sensor não nasce).

```bash
git add supabase/functions/omie-sync-estoque/ supabase/functions/_shared/sonda-fingerprints.ts src/lib/reposicao/__tests__/observacao-po-edge.test.ts src/lib/modulos/manifesto.ts
git commit -m "feat(omie-sync-estoque): registra o conjunto aberto que o motor contou, não-fatal e com invariante [money-path]"
```

### Task 0.4: aplicar, deployar e atestar

- [ ] **Step 1:** aplicar a migration da Task 0.1 pelo ritual `lovable-db-operator` (envelope ou SQL Editor) e validar
  por fora:

```bash
~/.config/afiacao/psql-ro -X -v ON_ERROR_STOP=1 -c "SELECT to_regclass('public.reposicao_po_observado_run') IS NOT NULL AS run, to_regclass('public.reposicao_po_observado_item') IS NOT NULL AS item, has_function_privilege('service_role','public.reposicao_po_observado_publicar(jsonb,jsonb)','EXECUTE') AS rpc;" -c "\echo FIM-OK"
```
Expected: `t | t | t` e `FIM-OK`.

- [ ] **Step 2:** deploy da edge só depois do Step 1, pelo procedimento de `docs/agent/deploy.md` §"Deploy de edge
  pela SESSÃO (MCP)"; `bun run pendencias:deploy` tem de mostrar `omie-sync-estoque` em
  `v1.4-observa-conjunto-aberto` depois do próximo run (:40 das 9–19h UTC).

- [ ] **Step 3:** atestar que o run publicou E que a observação bate com o pendente gravado:

```sql
-- rodar com psql-ro -X -v ON_ERROR_STOP=1 -f; exigir o marcador no fim
WITH ultimo AS (
  SELECT * FROM reposicao_po_observado_run WHERE empresa = 'OBEN' ORDER BY concluido_em DESC LIMIT 1
), soma AS (
  SELECT o.sku_codigo_omie::text AS sku, sum(o.contribuicao) AS contribuicao
  FROM reposicao_po_observado_item o JOIN ultimo u ON u.run_id = o.run_id
  WHERE o.exclusao IS NULL GROUP BY 1
)
SELECT u.concluido_em, u.varredura_completa, u.pendente_aplicado, u.pedidos_lidos,
       count(*) FILTER (WHERE abs(coalesce(s.contribuicao, 0) - e.estoque_pendente_entrada) > 0.001) AS skus_divergentes
FROM ultimo u
CROSS JOIN sku_estoque_atual e
LEFT JOIN soma s ON s.sku = e.sku_codigo_omie::text
JOIN sku_parametros sp ON sp.empresa = 'OBEN' AND sp.sku_codigo_omie::text = e.sku_codigo_omie AND sp.habilitado_reposicao_automatica
WHERE e.empresa = 'OBEN'
GROUP BY 1, 2, 3, 4;
\echo FIM-MEDICAO-OK
```
Expected: `varredura_completa = t`, `pendente_aplicado = t`, `skus_divergentes = 0`, marcador presente.

### Task 0.5: medição exata do "a caminho" fantasma (o gate de investimento)

- [ ] **Step 1:** depois de 7 dias de runs, rodar e registrar no spec (seção nova "Medição exata — PR0"):

```sql
-- unidades que o motor conta por SKU, por grupo do PO no espelho (A = NF concluída), na coorte fixa de SKUs
WITH ultimo AS (
  SELECT run_id FROM reposicao_po_observado_run
  WHERE empresa = 'OBEN' AND varredura_completa AND pendente_aplicado
  ORDER BY concluido_em DESC LIMIT 1
), contrib AS (
  SELECT o.sku_codigo_omie, o.omie_codigo_pedido, o.contribuicao
  FROM reposicao_po_observado_item o JOIN ultimo u ON u.run_id = o.run_id
  WHERE o.exclusao IS NULL AND o.contribuicao > 0
)
SELECT CASE WHEN t.t4_data_recebimento IS NOT NULL THEN 'A_nf_concluida'
            WHEN t.t2_data_faturamento IS NOT NULL THEN 'A2_nf_faturada'
            WHEN t.id IS NULL THEN 'fora_do_espelho'
            ELSE 'sem_nf' END AS grupo,
       count(DISTINCT c.sku_codigo_omie) AS skus,
       count(DISTINCT c.omie_codigo_pedido) AS pos,
       round(sum(c.contribuicao), 2) AS unidades
FROM contrib c
LEFT JOIN purchase_orders_tracking t ON t.empresa = 'OBEN' AND t.omie_codigo_pedido = c.omie_codigo_pedido
GROUP BY 1 ORDER BY 1;
\echo FIM-MEDICAO-OK
```
Expected: `unidades` do grupo `A_nf_concluida` = o "a caminho" fantasma **medido** (substitui a estimativa de 165 un.
da spec §13.4). Cruze os SKUs desse grupo com `sku_estoque_atual.estoque_fisico` e com o ponto de pedido para ver se há
concentração perto da ruptura — é o critério do gate (spec §16.2).

---

## PR(b) — espelho versionado do recebimento (o `receipt`/`receipt_item` do ledger)

> Estas tabelas **são** os blocos `receipt` e `receipt_item` do receipt-first ledger (spec 2026-08-13 §6), com nome
> em pt-BR. Não reaproveitar `nfe_recebimentos`/`nfe_recebimento_itens`: são do fluxo de conferência do app,
> multi-writer, com 47 cabeçalhos e 0 itens em prod (2026-09-26).

### Task b.1: migration do espelho versionado + RPCs

**Files:**
- Create: `supabase/migrations/<ts>_recebimento_omie_espelho_versionado.sql`

**Interfaces:**
- Produces: `public.recebimento_omie(id bigserial PK, empresa, nid_receb bigint, versao int, corrente bool, lido_em,
  conteudo_hash, chave_nfe, fornecedor_codigo_omie, fornecedor_cnpj, numero_nfe, serie_nfe, emitida_em date, etapa,
  recebido bool, cancelado bool, devolvido bool, recebido_em timestamptz, registrado_em date, detalhe_bruto jsonb)`;
  `public.recebimento_omie_item(recebimento_id → recebimento_omie.id, sequencia, id_item_nfe, produto_omie_id,
  codigo_produto_nfe, descricao, unidade_nfe, quantidade_nfe, unidade_omie, quantidade_recebida, movimenta_estoque,
  local_estoque, ignorado, pedido_compra_xml, item_pedido_compra_xml, id_pedido_nativo, id_item_pedido_nativo)`;
  `public.recebimento_omie_publicar(p_empresa text, p_lido_em timestamptz, p_cabecalho jsonb, p_itens jsonb,
  p_detalhe jsonb) RETURNS text` ∈ {`nova_versao`, `sem_mudanca`, `leitura_velha`};
  `public.recebimento_omie_para_revisitar(p_empresa text, p_limite integer) RETURNS SETOF bigint`.

- [ ] **Step 1:** invocar `lovable-db-operator`.

- [ ] **Step 2: escrever a migration**

```sql
-- Espelho VERSIONADO do recebimento de NF-e do Omie (spec 2026-09-26-baixa-pedido-compra-nf-concluida §6/§15 item 9;
-- Codex §16 achado 6). São os blocos receipt/receipt_item do receipt-first ledger (spec 2026-08-13 §6).
-- Contrato: cada leitura COMPLETA de ConsultarRecebimento vira uma versão; conteúdo igual só renova lido_em; leitura
-- mais velha que a versão corrente é ignorada; falha de leitura não publica nada (a versão antiga fica, com lido_em
-- antigo — visível como velha, nunca como "recebimento vazio"). 1 writer: omie-sync-nfes-recebidas, via RPC.
BEGIN;

CREATE TABLE IF NOT EXISTS public.recebimento_omie (
  id bigserial PRIMARY KEY,
  empresa text NOT NULL CHECK (empresa IN ('OBEN', 'COLACOR')),
  nid_receb bigint NOT NULL CHECK (nid_receb > 0),
  versao integer NOT NULL CHECK (versao >= 1),
  corrente boolean NOT NULL,
  lido_em timestamptz NOT NULL,
  conteudo_hash text NOT NULL,
  chave_nfe text,
  fornecedor_codigo_omie bigint,
  fornecedor_cnpj text,
  numero_nfe text,
  serie_nfe text,
  emitida_em date,
  etapa text,
  recebido boolean NOT NULL,
  cancelado boolean NOT NULL,
  devolvido boolean,
  recebido_em timestamptz,
  registrado_em date,
  detalhe_bruto jsonb NOT NULL,
  UNIQUE (empresa, nid_receb, versao)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_recebimento_omie_corrente
  ON public.recebimento_omie (empresa, nid_receb) WHERE corrente;
CREATE INDEX IF NOT EXISTS idx_recebimento_omie_chave ON public.recebimento_omie (empresa, chave_nfe) WHERE corrente;

CREATE TABLE IF NOT EXISTS public.recebimento_omie_item (
  recebimento_id bigint NOT NULL REFERENCES public.recebimento_omie (id) ON DELETE CASCADE,
  sequencia integer NOT NULL,
  id_item_nfe bigint,
  produto_omie_id bigint,
  codigo_produto_nfe text,
  descricao text,
  unidade_nfe text,
  quantidade_nfe numeric,
  unidade_omie text,
  quantidade_recebida numeric,
  movimenta_estoque boolean,
  local_estoque bigint,
  ignorado boolean NOT NULL,
  pedido_compra_xml text,
  item_pedido_compra_xml integer,
  id_pedido_nativo bigint,
  id_item_pedido_nativo bigint,
  PRIMARY KEY (recebimento_id, sequencia)
);
CREATE INDEX IF NOT EXISTS idx_recebimento_omie_item_xped ON public.recebimento_omie_item (pedido_compra_xml);
CREATE INDEX IF NOT EXISTS idx_recebimento_omie_item_nativo ON public.recebimento_omie_item (id_item_pedido_nativo);

ALTER TABLE public.recebimento_omie ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recebimento_omie_item ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.recebimento_omie FROM PUBLIC;
REVOKE ALL ON public.recebimento_omie FROM anon;
REVOKE ALL ON public.recebimento_omie FROM authenticated;
REVOKE ALL ON public.recebimento_omie_item FROM PUBLIC;
REVOKE ALL ON public.recebimento_omie_item FROM anon;
REVOKE ALL ON public.recebimento_omie_item FROM authenticated;
GRANT SELECT ON public.recebimento_omie TO authenticated;
GRANT SELECT ON public.recebimento_omie_item TO authenticated;
DROP POLICY IF EXISTS "recebimento_omie_select_staff" ON public.recebimento_omie;
CREATE POLICY "recebimento_omie_select_staff" ON public.recebimento_omie FOR SELECT
  USING (public.has_role(auth.uid(), 'employee'::public.app_role) OR public.has_role(auth.uid(), 'master'::public.app_role));
DROP POLICY IF EXISTS "recebimento_omie_item_select_staff" ON public.recebimento_omie_item;
CREATE POLICY "recebimento_omie_item_select_staff" ON public.recebimento_omie_item FOR SELECT
  USING (public.has_role(auth.uid(), 'employee'::public.app_role) OR public.has_role(auth.uid(), 'master'::public.app_role));

CREATE OR REPLACE FUNCTION public.recebimento_omie_publicar(
  p_empresa text, p_lido_em timestamptz, p_cabecalho jsonb, p_itens jsonb, p_detalhe jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_nid bigint := (p_cabecalho->>'nid_receb')::bigint;
  v_hash text;
  v_atual record;
  v_id bigint;
BEGIN
  IF v_nid IS NULL OR v_nid <= 0 THEN
    RAISE EXCEPTION 'recebimento_omie_publicar: nid_receb inválido' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_itens) IS DISTINCT FROM 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'recebimento_omie_publicar: leitura sem itens não é leitura completa' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('recebimento_omie:' || p_empresa || ':' || v_nid::text, 0));

  v_hash := md5(p_cabecalho::text || '|' || p_itens::text);
  SELECT id, versao, lido_em, conteudo_hash INTO v_atual
    FROM public.recebimento_omie WHERE empresa = p_empresa AND nid_receb = v_nid AND corrente;

  IF FOUND AND p_lido_em <= v_atual.lido_em THEN
    RETURN 'leitura_velha';
  END IF;
  IF FOUND AND v_atual.conteudo_hash = v_hash THEN
    UPDATE public.recebimento_omie SET lido_em = p_lido_em WHERE id = v_atual.id;
    RETURN 'sem_mudanca';
  END IF;
  IF FOUND THEN
    UPDATE public.recebimento_omie SET corrente = false WHERE id = v_atual.id;
  END IF;

  INSERT INTO public.recebimento_omie
    (empresa, nid_receb, versao, corrente, lido_em, conteudo_hash, chave_nfe, fornecedor_codigo_omie, fornecedor_cnpj,
     numero_nfe, serie_nfe, emitida_em, etapa, recebido, cancelado, devolvido, recebido_em, registrado_em, detalhe_bruto)
  VALUES
    (p_empresa, v_nid, COALESCE(v_atual.versao, 0) + 1, true, p_lido_em, v_hash, p_cabecalho->>'chave_nfe',
     (p_cabecalho->>'fornecedor_codigo_omie')::bigint, p_cabecalho->>'fornecedor_cnpj', p_cabecalho->>'numero_nfe',
     p_cabecalho->>'serie_nfe', (p_cabecalho->>'emitida_em')::date, p_cabecalho->>'etapa',
     (p_cabecalho->>'recebido')::boolean, (p_cabecalho->>'cancelado')::boolean, (p_cabecalho->>'devolvido')::boolean,
     (p_cabecalho->>'recebido_em')::timestamptz, (p_cabecalho->>'registrado_em')::date, p_detalhe)
  RETURNING id INTO v_id;

  INSERT INTO public.recebimento_omie_item
    (recebimento_id, sequencia, id_item_nfe, produto_omie_id, codigo_produto_nfe, descricao, unidade_nfe,
     quantidade_nfe, unidade_omie, quantidade_recebida, movimenta_estoque, local_estoque, ignorado, pedido_compra_xml,
     item_pedido_compra_xml, id_pedido_nativo, id_item_pedido_nativo)
  SELECT v_id, (i->>'sequencia')::integer, (i->>'id_item_nfe')::bigint, (i->>'produto_omie_id')::bigint,
         i->>'codigo_produto_nfe', i->>'descricao', i->>'unidade_nfe', (i->>'quantidade_nfe')::numeric,
         i->>'unidade_omie', (i->>'quantidade_recebida')::numeric, (i->>'movimenta_estoque')::boolean,
         (i->>'local_estoque')::bigint, (i->>'ignorado')::boolean, i->>'pedido_compra_xml',
         (i->>'item_pedido_compra_xml')::integer, (i->>'id_pedido_nativo')::bigint,
         (i->>'id_item_pedido_nativo')::bigint
  FROM jsonb_array_elements(p_itens) AS i;

  RETURN 'nova_versao';
END
$fn$;

-- Quem revisitar: 1º recebimentos ligados (xPed/vínculo nativo) a POs que o motor contou no último run completo e que
-- ainda não têm versão; depois os de lido_em mais antigo. Sem webhook do Omie (0 eventos em 30 d), é assim que uma
-- reversão antiga aparece (Codex §16, achado 6).
CREATE OR REPLACE FUNCTION public.recebimento_omie_para_revisitar(p_empresa text, p_limite integer)
RETURNS SETOF bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH ultimo AS (
    SELECT run_id FROM public.reposicao_po_observado_run
    WHERE empresa = p_empresa AND varredura_completa ORDER BY concluido_em DESC LIMIT 1
  ), pos_contados AS (
    SELECT DISTINCT o.omie_codigo_pedido FROM public.reposicao_po_observado_item o JOIN ultimo u ON u.run_id = o.run_id
  ), candidatos AS (
    SELECT DISTINCT t.nid_receb
    FROM public.purchase_orders_tracking t JOIN pos_contados p ON p.omie_codigo_pedido = t.omie_codigo_pedido
    WHERE t.empresa::text = p_empresa AND t.nid_receb IS NOT NULL
    UNION
    SELECT DISTINCT r.nid_receb
    FROM public.recebimento_omie r
    JOIN public.recebimento_omie_item i ON i.recebimento_id = r.id
    JOIN public.purchase_orders_tracking t ON t.empresa::text = r.empresa AND t.numero_contrato_fornecedor = i.pedido_compra_xml
    JOIN pos_contados p ON p.omie_codigo_pedido = t.omie_codigo_pedido
    WHERE r.empresa = p_empresa AND r.corrente
  )
  SELECT c.nid_receb
  FROM candidatos c
  LEFT JOIN public.recebimento_omie r ON r.empresa = p_empresa AND r.nid_receb = c.nid_receb AND r.corrente
  ORDER BY (r.id IS NULL) DESC, r.lido_em ASC NULLS FIRST
  LIMIT greatest(p_limite, 0)
$fn$;

REVOKE ALL ON FUNCTION public.recebimento_omie_publicar(text, timestamptz, jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recebimento_omie_publicar(text, timestamptz, jsonb, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.recebimento_omie_publicar(text, timestamptz, jsonb, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recebimento_omie_publicar(text, timestamptz, jsonb, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.recebimento_omie_para_revisitar(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recebimento_omie_para_revisitar(text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.recebimento_omie_para_revisitar(text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recebimento_omie_para_revisitar(text, integer) TO service_role;

DO $post$
BEGIN
  IF to_regclass('public.reposicao_po_observado_run') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: dependência ausente — aplique antes a migration do PR0 (reposicao_po_observado)';
  END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relname IN ('recebimento_omie', 'recebimento_omie_item')) <> 2 THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: espelho do recebimento ausente ou sem RLS';
  END IF;
  IF to_regclass('public.uq_recebimento_omie_corrente') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: índice único da versão corrente ausente';
  END IF;
  IF has_function_privilege('authenticated', 'public.recebimento_omie_publicar(text,timestamptz,jsonb,jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.recebimento_omie_publicar(text,timestamptz,jsonb,jsonb,jsonb)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.recebimento_omie', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: escrita aberta no espelho do recebimento';
  END IF;
  RAISE NOTICE 'recebimento_omie: versionado, RLS staff, 1 writer — OK';
END
$post$;

COMMIT;
```

- [ ] **Step 3: prova PG17 `db/test-recebimento-omie.sh`** (mesmo esqueleto da Task 0.1, aplicando PR0 **e** esta
  migration). Asserts, cada um capturando a SQLSTATE exata quando é negativo:
  - B1 — 1ª publicação → `'nova_versao'`, `versao = 1`, `corrente`, N itens.
  - B2 — mesmo conteúdo com `p_lido_em` maior → `'sem_mudanca'`, continua 1 versão, `lido_em` avançou.
  - B3 — conteúdo diferente (`recebido: false`, reversão) → `'nova_versao'`, `versao = 2` corrente, a v1 com
    `corrente = false`, e os itens da v1 intactos (histórico).
  - B4 — `p_lido_em` menor que o da corrente → `'leitura_velha'`, nada muda.
  - B5 — `p_itens` com `sequencia` repetida → `unique_violation` (23505) e a v2 **segue** corrente (atomicidade).
  - B6 — `p_itens = '[]'` → `22023`.
  - B7 — `authenticated` sem papel não vê linhas; staff vê; `anon` e staff levam `42501` ao executar a publicação.
  Registre em `db/nucleo-ci.txt` com `falsificar=` ≥ 3 (sabote: o `IF … lido_em` da leitura velha; o
  `corrente = false` da versão antiga; o `jsonb_array_length = 0`).

- [ ] **Step 4:** `bash db/test-recebimento-omie.sh` → exit 0 e `✅`; falsificação vermelha em cada sabotagem com
  controle verde; `bun run audit:migrations`; commit.

### Task b.2: helper puro que lê o detalhe do recebimento (TDD, Deno)

**Files:**
- Create: `supabase/functions/omie-sync-nfes-recebidas/recebimento-omie.ts`
- Test: `supabase/functions/omie-sync-nfes-recebidas/recebimento-omie_test.ts`

**Interfaces:**
- Produces: `lerRecebimento(detalhe: unknown): LeituraRecebimento` com
  `LeituraRecebimento = { ok: true; cabecalho: CabecalhoRecebimento; itens: ItemRecebimentoLinha[] } | { ok: false; motivo: string }`
  — os nomes de campo de `CabecalhoRecebimento`/`ItemRecebimentoLinha` são EXATAMENTE as chaves que a RPC da Task b.1
  lê (`nid_receb`, `chave_nfe`, …, `id_item_pedido_nativo`).

- [ ] **Step 1: teste Deno (fixture com a FORMA real medida em prod na spec §13.5)**

```ts
import { lerRecebimento } from "./recebimento-omie.ts";

function igual<T>(real: T, esperado: T, msg: string): void {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a !== b) throw new Error(`${msg}\n  real:     ${a}\n  esperado: ${b}`);
}

function detalhe(extra: Record<string, unknown> = {}) {
  return {
    cabec: {
      nIdReceb: 12184222585, cChaveNFe: "42260961142865000691550010009510881000000000", cNumeroNFe: "000951088",
      cSerieNFe: "1", dEmissaoNFe: "15/09/2026", nIdFornecedor: 8689681266, cCNPJ_CPF: "61.142.865/0006-91",
      cEtapa: "80",
    },
    infoCadastro: { cRecebido: "S", cCancelada: "N", cDevolvido: "N", dRec: "17/09/2026", hRec: "14:05:00" },
    infoAdicionais: { dRegistro: "17/09/2026" },
    itensRecebimento: [
      {
        itensCabec: {
          nSequencia: 1, nIdItem: 991, nIdProduto: 8689791246, cCodigoProduto: "WJOI.7666GL", cDescricaoProduto: "VERNIZ",
          cUnidadeNfe: "L", nQtdeNFe: 19.44, nIdPedido: 0, nIdItPedido: 0, cIgnorarItem: "N",
        },
        itensAjustes: { cUnidade: "UN", nQtdeRecebida: 6, cNaoGerarMovEstoque: "N", codigo_local_estoque: 4235712 },
        itensInfoAdic: { nNumPedCompra: "2125314", cNumItPedCompra: 1 },
      },
    ],
    ...extra,
  };
}

Deno.test("leitura completa: cabeçalho e item com os nomes que a RPC lê", () => {
  const r = lerRecebimento(detalhe());
  if (!r.ok) throw new Error(`esperava ok: ${r.motivo}`);
  igual(r.cabecalho.nid_receb, 12184222585, "nid_receb");
  igual(r.cabecalho.recebido, true, "recebido");
  igual(r.cabecalho.recebido_em, "2026-09-17T14:05:00-03:00", "recebido_em com fuso de Brasília");
  igual(r.cabecalho.registrado_em, "2026-09-17", "registrado_em");
  igual(r.cabecalho.fornecedor_cnpj, "61142865000691", "CNPJ só dígitos");
  igual(r.itens[0], {
    sequencia: 1, id_item_nfe: 991, produto_omie_id: 8689791246, codigo_produto_nfe: "WJOI.7666GL",
    descricao: "VERNIZ", unidade_nfe: "L", quantidade_nfe: 19.44, unidade_omie: "UN", quantidade_recebida: 6,
    movimenta_estoque: true, local_estoque: 4235712, ignorado: false, pedido_compra_xml: "2125314",
    item_pedido_compra_xml: 1, id_pedido_nativo: null, id_item_pedido_nativo: null,
  }, "item");
});

Deno.test("sem nIdReceb, sem itens ou sequência repetida → recusa (não publica)", () => {
  igual(lerRecebimento(detalhe({ cabec: { nIdReceb: 0 } })).ok, false, "nIdReceb 0");
  igual(lerRecebimento(detalhe({ itensRecebimento: [] })).ok, false, "sem itens");
  const d = detalhe();
  const repetido = { ...d, itensRecebimento: [d.itensRecebimento[0], d.itensRecebimento[0]] };
  igual(lerRecebimento(repetido).ok, false, "sequência repetida");
  igual(lerRecebimento({ faultstring: "erro" }).ok, false, "fault");
});

Deno.test("ausente fica null — nunca vira 0 nem false", () => {
  const d = detalhe();
  const it = d.itensRecebimento[0];
  const semAjustes = { ...d, itensRecebimento: [{ itensCabec: it.itensCabec, itensInfoAdic: it.itensInfoAdic }] };
  const r = lerRecebimento(semAjustes);
  if (!r.ok) throw new Error(r.motivo);
  igual([r.itens[0].quantidade_recebida, r.itens[0].unidade_omie, r.itens[0].movimenta_estoque], [null, null, null], "ajustes ausentes");
});

Deno.test("xPed '0' e vazio viram null; vínculo nativo > 0 é preservado", () => {
  const d = detalhe();
  const it = d.itensRecebimento[0];
  const r = lerRecebimento({ ...d, itensRecebimento: [{ ...it, itensCabec: { ...it.itensCabec, nIdPedido: 55, nIdItPedido: 12034724346 }, itensInfoAdic: { nNumPedCompra: "0" } }] });
  if (!r.ok) throw new Error(r.motivo);
  igual([r.itens[0].pedido_compra_xml, r.itens[0].id_pedido_nativo, r.itens[0].id_item_pedido_nativo], [null, 55, 12034724346], "vínculos");
});

Deno.test("cNaoGerarMovEstoque 'S' → movimenta_estoque false; cIgnorarItem 'S' → ignorado", () => {
  const d = detalhe();
  const it = d.itensRecebimento[0];
  const r = lerRecebimento({ ...d, itensRecebimento: [{ ...it, itensCabec: { ...it.itensCabec, cIgnorarItem: "S" }, itensAjustes: { ...it.itensAjustes, cNaoGerarMovEstoque: "S" } }] });
  if (!r.ok) throw new Error(r.motivo);
  igual([r.itens[0].movimenta_estoque, r.itens[0].ignorado], [false, true], "flags");
});
```

- [ ] **Step 2:** `bun run test:edges` → FAIL (módulo inexistente).

- [ ] **Step 3: implementar**

```ts
// Leitura PURA do detalhe do ConsultarRecebimento → linhas do espelho versionado (spec 2026-09-26 §15 item 9).
// Só devolve ok:true para leitura COMPLETA; qualquer dúvida estrutural é recusa (a versão antiga fica no banco).
// Ausente fica null: nunca vira 0 nem false (money-path: ausente ≠ zero).

export interface CabecalhoRecebimento {
  nid_receb: number;
  chave_nfe: string | null;
  fornecedor_codigo_omie: number | null;
  fornecedor_cnpj: string | null;
  numero_nfe: string | null;
  serie_nfe: string | null;
  emitida_em: string | null;
  etapa: string | null;
  recebido: boolean;
  cancelado: boolean;
  devolvido: boolean | null;
  recebido_em: string | null;
  registrado_em: string | null;
}

export interface ItemRecebimentoLinha {
  sequencia: number;
  id_item_nfe: number | null;
  produto_omie_id: number | null;
  codigo_produto_nfe: string | null;
  descricao: string | null;
  unidade_nfe: string | null;
  quantidade_nfe: number | null;
  unidade_omie: string | null;
  quantidade_recebida: number | null;
  movimenta_estoque: boolean | null;
  local_estoque: number | null;
  ignorado: boolean;
  pedido_compra_xml: string | null;
  item_pedido_compra_xml: number | null;
  id_pedido_nativo: number | null;
  id_item_pedido_nativo: number | null;
}

export type LeituraRecebimento =
  | { ok: true; cabecalho: CabecalhoRecebimento; itens: ItemRecebimentoLinha[] }
  | { ok: false; motivo: string };

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function texto(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

function inteiroPositivo(v: unknown): number | null {
  const t = texto(v);
  if (t === null) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function numero(v: unknown): number | null {
  const t = texto(v);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function simNao(v: unknown): boolean | null {
  const t = texto(v)?.toUpperCase();
  return t === "S" ? true : t === "N" ? false : null;
}

function dataBr(v: unknown): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto(v) ?? "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function dataHoraBr(d: unknown, h: unknown): string | null {
  const data = dataBr(d);
  const hora = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(texto(h) ?? "");
  if (data === null || hora === null) return null;
  return `${data}T${hora[1]}:${hora[2]}:${hora[3] ?? "00"}-03:00`;
}

export function lerRecebimento(detalhe: unknown): LeituraRecebimento {
  const d = obj(detalhe);
  if (d === null || d.faultstring !== undefined) return { ok: false, motivo: "resposta sem detalhe" };
  const cabec = obj(d.cabec);
  const nid = inteiroPositivo(cabec?.nIdReceb);
  if (cabec === null || nid === null) return { ok: false, motivo: "nIdReceb ausente ou inválido" };
  const info = obj(d.infoCadastro);
  const recebido = simNao(info?.cRecebido);
  const cancelado = simNao(info?.cCancelada);
  if (recebido === null || cancelado === null) return { ok: false, motivo: "cRecebido/cCancelada ausentes" };
  if (!Array.isArray(d.itensRecebimento) || d.itensRecebimento.length === 0) {
    return { ok: false, motivo: "leitura sem itens" };
  }

  const itens: ItemRecebimentoLinha[] = [];
  const sequencias = new Set<number>();
  for (const bruto of d.itensRecebimento) {
    const it = obj(bruto);
    const c = obj(it?.itensCabec);
    const aj = obj(it?.itensAjustes);
    const ad = obj(it?.itensInfoAdic);
    const seq = inteiroPositivo(c?.nSequencia);
    if (c === null || seq === null) return { ok: false, motivo: "item sem nSequencia" };
    if (sequencias.has(seq)) return { ok: false, motivo: `nSequencia ${seq} repetida` };
    sequencias.add(seq);
    const naoGera = simNao(aj?.cNaoGerarMovEstoque);
    const xped = texto(ad?.nNumPedCompra);
    itens.push({
      sequencia: seq,
      id_item_nfe: inteiroPositivo(c.nIdItem),
      produto_omie_id: inteiroPositivo(c.nIdProduto),
      codigo_produto_nfe: texto(c.cCodigoProduto),
      descricao: texto(c.cDescricaoProduto),
      unidade_nfe: texto(c.cUnidadeNfe),
      quantidade_nfe: numero(c.nQtdeNFe),
      unidade_omie: texto(aj?.cUnidade),
      quantidade_recebida: numero(aj?.nQtdeRecebida),
      movimenta_estoque: naoGera === null ? null : !naoGera,
      local_estoque: inteiroPositivo(aj?.codigo_local_estoque),
      ignorado: simNao(c.cIgnorarItem) === true,
      pedido_compra_xml: xped === null || xped === "0" ? null : xped,
      item_pedido_compra_xml: inteiroPositivo(ad?.cNumItPedCompra),
      id_pedido_nativo: inteiroPositivo(c.nIdPedido),
      id_item_pedido_nativo: inteiroPositivo(c.nIdItPedido),
    });
  }

  const cnpj = texto(cabec.cCNPJ_CPF)?.replace(/\D/g, "") ?? null;
  return {
    ok: true,
    cabecalho: {
      nid_receb: nid,
      chave_nfe: texto(cabec.cChaveNFe),
      fornecedor_codigo_omie: inteiroPositivo(cabec.nIdFornecedor),
      fornecedor_cnpj: cnpj === "" ? null : cnpj,
      numero_nfe: texto(cabec.cNumeroNFe),
      serie_nfe: texto(cabec.cSerieNFe),
      emitida_em: dataBr(cabec.dEmissaoNFe),
      etapa: texto(cabec.cEtapa),
      recebido,
      cancelado,
      devolvido: simNao(info?.cDevolvido),
      recebido_em: dataHoraBr(info?.dRec, info?.hRec),
      registrado_em: dataBr(obj(d.infoAdicionais)?.dRegistro),
    },
    itens,
  };
}
```

- [ ] **Step 4:** `bun run test:edges` → PASS; commit.

### Task b.3: publicar em toda leitura completa (casada ou órfã) + revisita limitada

**Files:**
- Modify: `supabase/functions/omie-sync-nfes-recebidas/index.ts` (após o `ConsultarRecebimento` ≈ :537-556 e no
  backfill ≈ :679), `versao.ts` → `VERSAO = "v1.4-espelho-do-recebimento"`
- Create: `src/lib/reposicao/__tests__/recebimento-omie-edge.test.ts` (+ entrada no manifesto)

- [ ] **Step 1: guarda textual (falha antes da mudança)** — asserções: `lerRecebimento(` aparece antes de
  `"recebimento_omie_publicar"`; a chamada está dentro de `try { … } catch`; o ponto da publicação fica ANTES do ramo
  `if (vinculadasNestaNFe > 0) { … } else { … insertOrfa(` (isto é, publica também a órfã); e existe o parâmetro de
  body `revisitar_recebimentos`.

- [ ] **Step 2: publicar** — logo depois de `summary.consultas_detalhadas++;`:

```ts
        const leitura = lerRecebimento(detalhe);
        if (leitura.ok) {
          try {
            const { data: desfecho, error } = await supabase.rpc("recebimento_omie_publicar", {
              p_empresa: empresa,
              p_lido_em: new Date().toISOString(),
              p_cabecalho: leitura.cabecalho,
              p_itens: leitura.itens,
              p_detalhe: detalhe,
            });
            if (error) summary.recebimentos_nao_publicados++;
            else if (desfecho === "nova_versao") summary.recebimentos_versao_nova++;
            else summary.recebimentos_sem_mudanca++;
          } catch (errPub) {
            summary.recebimentos_nao_publicados++;
            console.error(`[sync-nfes] ${empresa} nIdReceb=${nIdReceb} publicação do espelho falhou: ${errPub instanceof Error ? errPub.message : "sem mensagem"}`);
          }
        } else {
          summary.recebimentos_leitura_incompleta++;
        }
```

  Declare os 4 contadores no `summary` (≈ :64) iniciando em 0. Repita o mesmo bloco no backfill (≈ :679).

- [ ] **Step 3: revisita limitada** — novo campo opcional de body `revisitar_recebimentos?: number` (default `15`,
  teto `50`). Depois do laço principal, se sobrar tempo no `deadline`: chamar
  `supabase.rpc("recebimento_omie_para_revisitar", { p_empresa: empresa, p_limite })`, e para cada `nid_receb`
  devolvido fazer o MESMO `callOmie(…, "ConsultarRecebimento", { nIdReceb }, deadline)` + o bloco do Step 2. Falha de
  consulta conta em `summary.erros` e não publica (a versão antiga fica).

- [ ] **Step 4:** bump, fingerprint, 5 gates + lint (mesmos comandos da Task 0.3 Step 5); Codex adversarial; commit/PR
  com a ordem **migration (b.1) antes da edge**.

### Task b.4: aplicar, deployar, backfill e validar cobertura

- [ ] **Step 1:** aplicar b.1 (ritual) e validar por `psql-ro` (`to_regclass` das 2 tabelas + ACL da RPC).
- [ ] **Step 2:** deploy da edge; atestar `v1.4-espelho-do-recebimento` no `pendencias:deploy`.
- [ ] **Step 3: backfill** — invocar a edge com `data_inicial`/`data_final` (dd/mm/aaaa) em fatias mensais de
  `19/01/2026` até hoje (o sync já aceita o período no body), respeitando o `deadline` e o consumo redundante (1 fatia
  por invocação, esperar o run terminar). Cada NF do período passa pelo `ConsultarRecebimento` normal e é publicada.
- [ ] **Step 4: validar cobertura** — POs do último run completo do PR0 com `t4` no espelho e SEM versão corrente em
  `recebimento_omie` para o seu `nid_receb` têm de ser **0**:

```sql
WITH ultimo AS (SELECT run_id FROM reposicao_po_observado_run WHERE empresa = 'OBEN' AND varredura_completa ORDER BY concluido_em DESC LIMIT 1)
SELECT count(DISTINCT t.omie_codigo_pedido) AS pos_com_nf_sem_espelho
FROM purchase_orders_tracking t
JOIN reposicao_po_observado_item o ON o.omie_codigo_pedido = t.omie_codigo_pedido
JOIN ultimo u ON u.run_id = o.run_id
LEFT JOIN recebimento_omie r ON r.empresa = t.empresa::text AND r.nid_receb = t.nid_receb AND r.corrente
WHERE t.empresa = 'OBEN' AND t.t4_data_recebimento IS NOT NULL AND r.id IS NULL;
\echo FIM-MEDICAO-OK
```
Expected: `0` e o marcador. Diferente de 0 → rodar a revisita (`revisitar_recebimentos` maior) até zerar.

---

## PR(a1) — `ENCERRADO` no enum, isolado

### Task a1.1: migration só com o `ADD VALUE`

**Files:**
- Create: `supabase/migrations/<ts>_status_pedido_compra_encerrado.sql`

- [ ] **Step 1:** invocar `lovable-db-operator`; conferir o precedente `supabase/migrations/20260518100000_commercial_role_add_values.sql`
  e `.claude/skills/lovable-db-operator/references/sql-house-style.md` (valor novo não pode ser USADO na mesma
  transação que o adiciona).

- [ ] **Step 2: escrever (sem `BEGIN`/`COMMIT`, sem nenhum uso do valor)**

```sql
-- status_pedido_compra ganha ENCERRADO (spec 2026-09-26-baixa-pedido-compra-nf-concluida §5; Codex §16 achado 5).
-- ISOLADA de propósito: o valor novo não pode ser usado na mesma transação que o adiciona, e o SQL Editor roda a
-- colagem inteira numa transação implícita. Nenhum writer, view ou default usa ENCERRADO antes desta migration
-- estar COMMITADA e verificada por fora (psql-ro). Reverter um writer depois NÃO remove o valor (enum não encolhe).
ALTER TYPE public.status_pedido_compra ADD VALUE IF NOT EXISTS 'ENCERRADO';
COMMENT ON TYPE public.status_pedido_compra IS
  'Status do espelho purchase_orders_tracking. ENCERRADO = PO encerrado no Omie (etapa 80 no mapa da edge). Writer por domínio: omie-sync-pedidos-compra nas linhas > 0; omie-sync-nfes-recebidas nas órfãs < 0.';
```

- [ ] **Step 3:** aplicar pelo ritual; validar em OUTRA sessão:

```bash
~/.config/afiacao/psql-ro -X -v ON_ERROR_STOP=1 -c "SELECT 'ENCERRADO' = ANY (enum_range(NULL::public.status_pedido_compra)::text[]) AS tem_encerrado;" -c "\echo FIM-OK"
```
Expected: `t` e `FIM-OK`. Registrar a aplicação manual no corpo do PR.

- [ ] **Step 4:** regenerar/atualizar `src/integrations/supabase/types.ts` (as duas ocorrências do enum, ≈ :21005-21011
  e ≈ :21196-21203 — ou conferir o commit "Lovable update" do bot), `heavy bun run typecheck`, commit.

---

## PR(a2) — ownership de `status` por domínio + views

### Task a2.1: o sync de NFs para de escrever `status` nas linhas de PO

**Files:**
- Modify: `supabase/functions/omie-sync-nfes-recebidas/index.ts` (`updateLinhasDoPedido` ≈ :320-370),
  `versao.ts` → `VERSAO = "v1.5-status-so-nas-orfas"` (ou a próxima livre depois do PR(b))
- Create: `src/lib/reposicao/__tests__/status-dono-por-dominio.test.ts` (+ manifesto)

- [ ] **Step 1: guarda textual (falha antes)** — no corpo de `updateLinhasDoPedido` (recorte entre
  `async function updateLinhasDoPedido(` e a próxima `async function`), `status` **não** aparece como chave do objeto de
  update; em `insertOrfa` continua aparecendo.

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

const fonte = removerComentarios(
  readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-sync-nfes-recebidas/index.ts'), 'utf8'),
);

function corpo(nome: string): string {
  const i = fonte.indexOf(`async function ${nome}(`);
  const j = fonte.indexOf('async function ', i + 1);
  return fonte.slice(i, j === -1 ? undefined : j);
}

describe('status do espelho — dono por domínio (spec 2026-09-26 §15 item 3)', () => {
  it('a atualização de linha de PO (> 0) não escreve status', () => {
    expect(corpo('updateLinhasDoPedido')).not.toMatch(/\bstatus\s*:/);
  });
  it('a órfã (< 0) continua recebendo status do sync de NFs', () => {
    expect(corpo('insertOrfa')).toMatch(/\bstatus\s*:/);
  });
});
```

- [ ] **Step 2:** remover a escrita de `status` (e o `finalStatus` que só a alimenta) de `updateLinhasDoPedido`,
  mantendo `t2`, `t4`, `nfe_*`, `transportadora_*` e `nid_receb`. Bump, fingerprint, gates, Codex, commit.

### Task a2.2: aposentar as views sem consumidor (só se nada depender delas)

**Files:**
- Create: `supabase/migrations/<ts>_aposenta_views_status_pedido_compra.sql`

- [ ] **Step 1: medir dependentes em prod** (se aparecer QUALQUER linha, pare e leve ao founder):

```sql
SELECT dependente.relname AS dependente, base.relname AS view_base
FROM pg_depend d
JOIN pg_rewrite rw ON rw.oid = d.objid
JOIN pg_class dependente ON dependente.oid = rw.ev_class
JOIN pg_class base ON base.oid = d.refobjid
WHERE base.relname IN ('v_pedidos_em_aberto', 'v_leadtime_por_grupo') AND dependente.oid <> base.oid;
\echo FIM-MEDICAO-OK
```
Expected: 0 linhas. Confirmar também `git grep -n "v_pedidos_em_aberto\|v_leadtime_por_grupo" -- src supabase/functions scripts`
= só `src/integrations/supabase/types.ts`.

- [ ] **Step 2: migration**

```sql
-- Aposenta as views sem consumidor que decidiam por status (spec 2026-09-26 §13.2 X1; Codex §16 achado 5).
-- Sem CASCADE: se algo passou a depender delas depois da medição, a migration FALHA em vez de levar junto.
BEGIN;
DROP VIEW IF EXISTS public.v_pedidos_em_aberto;
DROP VIEW IF EXISTS public.v_leadtime_por_grupo;
DO $post$
BEGIN
  IF to_regclass('public.v_pedidos_em_aberto') IS NOT NULL OR to_regclass('public.v_leadtime_por_grupo') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: view de status ainda existe';
  END IF;
  RAISE NOTICE 'views de status aposentadas — OK';
END
$post$;
COMMIT;
```

- [ ] **Step 3:** remover os tipos das views de `src/integrations/supabase/types.ts`, `heavy bun run typecheck`,
  `bun run audit:migrations`, commit/PR (nota de migration manual; guardar o `pg_get_viewdef` das duas no corpo do PR
  para recriação, se preciso).

---

## PR(c1) — classificador puro + montagem das entradas

### Task c1.1: classificador (TDD — código e testes já validados)

**Files:**
- Create: `src/lib/reposicao/po-baixa/classificar-po.ts`
- Test: `src/lib/reposicao/__tests__/po-baixa-classificar.test.ts`
- Modify: `src/lib/modulos/manifesto.ts` (teste novo na lista `testes` do módulo `reposicao`)

**Interfaces:**
- Produces: `classificarPedido(po: PedidoParaClassificar, recebimentos: Recebimento[], ctx: ContextoClassificacao): Resultado`
  e os tipos exportados abaixo. `Resultado.elegibilidade` só é não-nulo em `cheia`.

> Validado em 2026-09-26 (sessão do plano): 32 testes verdes; 22 sabotagens (uma barreira por vez, numa cópia, com
> controle verde na mesma invocação) todas vermelhas. Reproduza a falsificação ao implementar (Step 5).

- [ ] **Step 1: escrever o teste**

```ts
import { describe, expect, it } from 'vitest';

import {
  classificarPedido,
  type ContextoClassificacao,
  type ItemRecebimento,
  type PedidoParaClassificar,
  type Recebimento,
} from '@/lib/reposicao/po-baixa/classificar-po';

const CTX: ContextoClassificacao = {
  agora: '2026-09-26T12:00:00Z',
  inicioCoberturaNf: '2026-01-19T00:00:00Z',
  estoqueLidoEm: '2026-09-26T09:40:00Z',
  diasVencidoSemNf: 40,
  diasParcialEnvelhecido: 30,
};

function po(extra: Partial<PedidoParaClassificar> = {}): PedidoParaClassificar {
  return {
    numero: '1205',
    contrato: '2125314',
    situacao: 'aberto',
    previsao: '2026-09-10',
    criadoEm: '2026-09-01T10:00:00Z',
    itens: [{ idItem: 1, produto: 100, quantidade: 6, unidade: 'UN' }],
    outrosComMesmoContrato: [],
    ...extra,
  };
}

function item(extra: Partial<ItemRecebimento> = {}): ItemRecebimento {
  return {
    sequencia: 1,
    produto: 100,
    unidadeNfe: 'L',
    quantidadeNfe: 19.44,
    unidadeOmie: 'UN',
    quantidadeRecebida: 6,
    pedidoCompra: '2125314',
    idItemPedidoNativo: null,
    ignorado: false,
    movimentaEstoque: true,
    ...extra,
  };
}

function nf(extra: Partial<Recebimento> = {}): Recebimento {
  return {
    idReceb: 9001,
    chaveNfe: 'CHAVE-9001',
    recebido: true,
    cancelado: false,
    recebidoEm: '2026-09-17T14:00:00Z',
    itens: [item()],
    ...extra,
  };
}

describe('classificarPedido — situação', () => {
  it('situação não observada nunca vira aberto, mesmo com NF cobrindo tudo', () => {
    const r = classificarPedido(po({ situacao: 'desconhecido' }), [nf()], CTX);
    expect(r.classe).toBe('situacao_desconhecida');
  });

  it('PO fora do conjunto que o motor contou: nada a fazer', () => {
    const r = classificarPedido(po({ situacao: 'fechado' }), [nf()], CTX);
    expect(r.classe).toBe('ja_fechado_no_omie');
  });
});

describe('classificarPedido — cobertura', () => {
  it('1 NF concluída cobre o PO → cheia, elegível (físico lido depois da NF)', () => {
    const r = classificarPedido(po(), [nf()], CTX);
    expect(r).toMatchObject({ classe: 'cheia', elegibilidade: 'elegivel', recebimentos: [9001] });
  });

  it('D1: a soma de 2 NFs do mesmo contrato cobre o PO', () => {
    const a = nf({ idReceb: 1, chaveNfe: 'A', itens: [item({ quantidadeNfe: 9.72, quantidadeRecebida: 3 })] });
    const b = nf({ idReceb: 2, chaveNfe: 'B', itens: [item({ quantidadeNfe: 9.72, quantidadeRecebida: 3 })] });
    expect(classificarPedido(po(), [a, b], CTX).classe).toBe('cheia');
  });

  it('entrega a menos → parcial com o faltante por produto', () => {
    const r = classificarPedido(po(), [nf({ itens: [item({ quantidadeNfe: 12.96, quantidadeRecebida: 4 })] })], CTX);
    expect(r).toMatchObject({ classe: 'parcial', faltantes: [{ produto: 100, pedido: 6, recebido: 4 }] });
  });

  it('parcial sem NF nova há mais de N dias → parcial_envelhecido (investigar, não encerrar)', () => {
    const velha = nf({ recebidoEm: '2026-08-01T10:00:00Z', itens: [item({ quantidadeNfe: 12.96, quantidadeRecebida: 4 })] });
    expect(classificarPedido(po(), [velha], CTX).classe).toBe('parcial_envelhecido');
  });

  it('duas linhas do mesmo produto somam: 4 recebidos não cobrem 4 + 4', () => {
    const duasLinhas = po({
      itens: [
        { idItem: 1, produto: 100, quantidade: 4, unidade: 'UN' },
        { idItem: 2, produto: 100, quantidade: 4, unidade: 'UN' },
      ],
    });
    const r = classificarPedido(duasLinhas, [nf({ itens: [item({ quantidadeNfe: 12.96, quantidadeRecebida: 4 })] })], CTX);
    expect(r).toMatchObject({ classe: 'parcial', faltantes: [{ produto: 100, pedido: 8, recebido: 4 }] });
  });

  it('o mesmo idReceb reprocessado conta uma vez só', () => {
    const meia = nf({ itens: [item({ quantidadeNfe: 9.72, quantidadeRecebida: 3 })] });
    expect(classificarPedido(po(), [meia, meia], CTX).classe).toBe('parcial');
  });
});

describe('classificarPedido — NF que não conta', () => {
  it('NF cancelada não contribui', () => {
    expect(classificarPedido(po(), [nf({ cancelado: true })], CTX).classe).toBe('sem_evidencia');
  });

  it('NF revertida (cRecebido voltou a N) não contribui', () => {
    expect(classificarPedido(po(), [nf({ recebido: false })], CTX).classe).toBe('sem_evidencia');
  });

  it('item ignorado na NF não conta nem gera ambiguidade', () => {
    const r = classificarPedido(po(), [nf({ itens: [item(), item({ sequencia: 2, produto: null, ignorado: true })] })], CTX);
    expect(r.classe).toBe('cheia');
  });
});

describe('classificarPedido — ambiguidade (nunca vira cheia)', () => {
  it('PO sem itens não é "coberto por vacuidade"', () => {
    expect(classificarPedido(po({ itens: [] }), [nf()], CTX)).toMatchObject({ classe: 'ambigua', motivo: 'pedido_sem_itens' });
  });

  it('contrato repetido num PO FECHADO com produto em comum → duplicado', () => {
    const r = classificarPedido(po({ outrosComMesmoContrato: [{ numero: '1180', produtos: [100] }] }), [nf()], CTX);
    expect(r).toMatchObject({ classe: 'ambigua', motivo: 'contrato_duplicado' });
  });

  it('contrato repetido com produtos disjuntos → dividido', () => {
    const r = classificarPedido(po({ outrosComMesmoContrato: [{ numero: '1181', produtos: [200] }] }), [nf()], CTX);
    expect(r).toMatchObject({ classe: 'ambigua', motivo: 'contrato_dividido' });
  });

  it('a mesma chave de NF em dois idReceb não soma', () => {
    const a = nf({ idReceb: 1, chaveNfe: 'MESMA', itens: [item({ quantidadeNfe: 9.72, quantidadeRecebida: 3 })] });
    const b = nf({ idReceb: 2, chaveNfe: 'MESMA', itens: [item({ quantidadeNfe: 9.72, quantidadeRecebida: 3 })] });
    expect(classificarPedido(po(), [a, b], CTX)).toMatchObject({ classe: 'ambigua', motivo: 'nf_duplicada' });
  });

  it('quantidade recebida ausente não vira zero', () => {
    const r = classificarPedido(po(), [nf({ itens: [item({ quantidadeRecebida: null })] })], CTX);
    expect(r).toMatchObject({ classe: 'ambigua', motivo: 'quantidade_ausente' });
  });

  it('conversão não aplicada (6 L lançados como 6 UN) não cobre 6 UN', () => {
    const r = classificarPedido(po(), [nf({ itens: [item({ quantidadeNfe: 6, quantidadeRecebida: 6 })] })], CTX);
    expect(r).toMatchObject({ classe: 'ambigua', motivo: 'unidade_sem_conversao' });
  });

  it('unidade recebida diferente da unidade do PO → divergente', () => {
    const r = classificarPedido(po(), [nf({ itens: [item({ unidadeOmie: 'CX' })] })], CTX);
    expect(r).toMatchObject({ classe: 'ambigua', motivo: 'unidade_divergente' });
  });

  it('unidade do PO ausente → divergente (fator desconhecido não vira 1)', () => {
    const r = classificarPedido(po({ itens: [{ idItem: 1, produto: 100, quantidade: 6, unidade: null }] }), [nf()], CTX);
    expect(r).toMatchObject({ classe: 'ambigua', motivo: 'unidade_divergente' });
  });

  it('item da NF sem produto associado → ambígua', () => {
    const r = classificarPedido(po(), [nf({ itens: [item({ produto: null })] })], CTX);
    expect(r).toMatchObject({ classe: 'ambigua', motivo: 'produto_sem_associacao' });
  });

  it('item com o xPed do contrato mas produto fora do PO → ambígua', () => {
    const r = classificarPedido(po(), [nf({ itens: [item(), item({ sequencia: 2, produto: 999 })] })], CTX);
    expect(r).toMatchObject({ classe: 'ambigua', motivo: 'item_fora_do_pedido' });
  });

  it('vínculo nativo apontando outro item bloqueia a inferência pelo xPed', () => {
    const r = classificarPedido(po(), [nf({ itens: [item({ idItemPedidoNativo: 777 })] })], CTX);
    expect(r).toMatchObject({ classe: 'ambigua', motivo: 'vinculo_nativo_outro_item' });
  });
});

describe('classificarPedido — elegibilidade separada da cobertura', () => {
  it('cheia com físico lido ANTES da NF → aguardando_estoque', () => {
    const r = classificarPedido(po(), [nf({ recebidoEm: '2026-09-26T11:00:00Z' })], CTX);
    expect(r).toMatchObject({ classe: 'cheia', elegibilidade: 'aguardando_estoque' });
  });

  it('cheia sem leitura de físico confiável → aguardando_estoque', () => {
    const r = classificarPedido(po(), [nf()], { ...CTX, estoqueLidoEm: null });
    expect(r).toMatchObject({ classe: 'cheia', elegibilidade: 'aguardando_estoque' });
  });

  it('item que não movimenta estoque nunca é elegível', () => {
    const r = classificarPedido(po(), [nf({ itens: [item({ movimentaEstoque: false })] })], CTX);
    expect(r).toMatchObject({ classe: 'cheia', elegibilidade: 'nao_movimenta_estoque' });
  });

  it('movimentação não informada não é elegível', () => {
    const r = classificarPedido(po(), [nf({ itens: [item({ movimentaEstoque: null })] })], CTX);
    expect(r).toMatchObject({ classe: 'cheia', elegibilidade: 'movimentacao_desconhecida' });
  });

  it('data de recebimento ausente não é elegível', () => {
    const r = classificarPedido(po(), [nf({ recebidoEm: null })], CTX);
    expect(r).toMatchObject({ classe: 'cheia', elegibilidade: 'data_desconhecida' });
  });
});

describe('classificarPedido — sem evidência', () => {
  it('PO anterior à cobertura do sync de NF → não observado ("não sei")', () => {
    const r = classificarPedido(po({ criadoEm: '2025-10-01T00:00:00Z', previsao: '2025-10-20' }), [], CTX);
    expect(r).toMatchObject({ classe: 'nao_observado', motivo: 'anterior_a_cobertura' });
  });

  it('PO sem data de criação → não observado', () => {
    expect(classificarPedido(po({ criadoEm: null }), [], CTX).classe).toBe('nao_observado');
  });

  it('coberto, sem NF, previsão vencida há mais de N dias → vencido_sem_nf', () => {
    const r = classificarPedido(po({ criadoEm: '2026-05-01T00:00:00Z', previsao: '2026-05-20' }), [], CTX);
    expect(r).toMatchObject({ classe: 'vencido_sem_nf', motivo: 'previsao_vencida' });
  });

  it('sem contrato e vencido → vencido_sem_nf com motivo sem_contrato', () => {
    const r = classificarPedido(po({ contrato: null, criadoEm: '2026-05-01T00:00:00Z', previsao: '2026-05-20' }), [nf()], CTX);
    expect(r).toMatchObject({ classe: 'vencido_sem_nf', motivo: 'sem_contrato' });
  });

  it('no prazo, sem NF → sem_evidencia', () => {
    expect(classificarPedido(po(), [], CTX)).toMatchObject({ classe: 'sem_evidencia', motivo: 'no_prazo' });
  });
});
```

- [ ] **Step 2:** `heavy bun run test -- src/lib/reposicao/__tests__/po-baixa-classificar.test.ts` → FAIL (módulo
  inexistente).

- [ ] **Step 3: implementar o classificador**

```ts
// Classificador PURO da lista "Pedidos para baixar" (spec 2026-09-26-baixa-pedido-compra-nf-concluida
// §7, §15 e parecer Codex §16). Fail-closed: dado ausente nunca vira 0, evidência ambígua nunca vira
// `cheia`, situação não observada nunca vira "aberto", e COBERTURA não é ELEGIBILIDADE — `cheia` diz
// que a quantidade chegou; só `elegivel` diz que dá para encerrar sem tirar do "a caminho" o que o
// físico lido pelo motor ainda não mostra. A unidade que cobra é a unidade de SKU no "a caminho":
// errar para cima apaga "a caminho" legítimo (compra dupla); errar para baixo segura fantasma
// (compra suprimida). Só o 2º erro é tolerado, e ele sempre sai como classe explícita.

/** Pertença do PO ao conjunto que o motor contou (observado pelo omie-sync-estoque). */
export type EstadoSituacao = 'aberto' | 'fechado' | 'desconhecido';

export interface ItemPedido {
  /** nCodItem do PO no Omie. */
  idItem: number;
  /** nCodProd — produto Omie. */
  produto: number;
  /** nQtde, na unidade do produto no PO. */
  quantidade: number;
  /** cUnidade do item do PO (`null` = não informada). */
  unidade: string | null;
}

export interface ItemRecebimento {
  sequencia: number;
  /** nIdProduto — `null` = item da NF sem produto Omie associado. */
  produto: number | null;
  unidadeNfe: string | null;
  quantidadeNfe: number | null;
  /** itensAjustes.cUnidade — unidade Omie do recebimento. */
  unidadeOmie: string | null;
  /** itensAjustes.nQtdeRecebida — na unidade Omie SÓ se a conversão foi aplicada. */
  quantidadeRecebida: number | null;
  /** xPed da NF (itensInfoAdic.nNumPedCompra). */
  pedidoCompra: string | null;
  /** itensCabec.nIdItPedido — vínculo nativo com item de PO (`null`/0 = sem vínculo). */
  idItemPedidoNativo: number | null;
  /** itensCabec.cIgnorarItem = 'S'. */
  ignorado: boolean;
  /** `true` se o item gera movimento de estoque (itensAjustes.cNaoGerarMovEstoque ≠ 'S'); `null` = não informado. */
  movimentaEstoque: boolean | null;
}

export interface Recebimento {
  idReceb: number;
  /** cChaveNFe — a mesma chave em dois idReceb exige reconciliação antes de somar. */
  chaveNfe: string | null;
  /** infoCadastro.cRecebido = 'S' (estado CORRENTE — reversão volta a false). */
  recebido: boolean;
  /** infoCadastro.cCancelada = 'S'. */
  cancelado: boolean;
  /** Data/hora do recebimento (ISO) ou `null`. */
  recebidoEm: string | null;
  itens: ItemRecebimento[];
}

export interface OutroPedidoDoContrato {
  numero: string;
  produtos: number[];
}

export interface PedidoParaClassificar {
  numero: string;
  /** cContrato — o protocolo Sayerlack que a NF traz no xPed (já no escopo empresa + fornecedor). */
  contrato: string | null;
  situacao: EstadoSituacao;
  /** dDtPrevisao (ISO) ou `null`. */
  previsao: string | null;
  /** t1 — criação do PO (ISO) ou `null`. */
  criadoEm: string | null;
  itens: ItemPedido[];
  /** TODOS os outros POs com o mesmo contrato, empresa e fornecedor — abertos E fechados. */
  outrosComMesmoContrato: OutroPedidoDoContrato[];
}

export interface ContextoClassificacao {
  /** "Agora" (ISO). */
  agora: string;
  /** Início da cobertura observada do sync de NFs (ISO). Antes disso, "sem NF" = não observado. */
  inicioCoberturaNf: string;
  /** Leitura de físico mais recente que o motor usou (ISO), ou `null` se não houver leitura confiável. */
  estoqueLidoEm: string | null;
  /** Previsão vencida há mais que isto, sem NF casada → `vencido_sem_nf`. */
  diasVencidoSemNf: number;
  /** `parcial` sem NF nova há mais que isto → `parcial_envelhecido` (investigar; idade nunca completa quantidade). */
  diasParcialEnvelhecido: number;
}

export type Classe =
  | 'situacao_desconhecida'
  | 'ja_fechado_no_omie'
  | 'ambigua'
  | 'cheia'
  | 'parcial'
  | 'parcial_envelhecido'
  | 'vencido_sem_nf'
  | 'nao_observado'
  | 'sem_evidencia';

export type Motivo =
  | 'situacao_nao_observada'
  | 'situacao_fechada'
  | 'pedido_sem_itens'
  | 'contrato_duplicado'
  | 'contrato_dividido'
  | 'nf_duplicada'
  | 'vinculo_nativo_outro_item'
  | 'produto_sem_associacao'
  | 'item_fora_do_pedido'
  | 'quantidade_ausente'
  | 'unidade_sem_conversao'
  | 'unidade_divergente'
  | 'coberto_pelas_nfs'
  | 'saldo_pendente'
  | 'saldo_parado'
  | 'sem_contrato'
  | 'anterior_a_cobertura'
  | 'sem_data_de_criacao'
  | 'previsao_vencida'
  | 'no_prazo'
  | 'sem_previsao';

/** Só para `cheia`: dá para encerrar sem apagar do "a caminho" o que o físico lido ainda não mostra? */
export type Elegibilidade =
  | 'elegivel'
  | 'aguardando_estoque'
  | 'nao_movimenta_estoque'
  | 'movimentacao_desconhecida'
  | 'data_desconhecida';

export interface Faltante {
  produto: number;
  pedido: number;
  recebido: number;
}

export interface Resultado {
  classe: Classe;
  motivo: Motivo;
  /** `null` fora de `cheia`. */
  elegibilidade: Elegibilidade | null;
  /** Só em `parcial`/`parcial_envelhecido`: o que ainda falta chegar, por produto. */
  faltantes: Faltante[];
  /** idReceb das NFs concluídas que entraram na conta. */
  recebimentos: number[];
}

const DIA_MS = 86_400_000;
const EPSILON = 1e-9;

function resultado(classe: Classe, motivo: Motivo, extra: Partial<Resultado> = {}): Resultado {
  return { classe, motivo, elegibilidade: null, faltantes: [], recebimentos: [], ...extra };
}

function diasEntre(deIso: string, ateIso: string): number {
  return (Date.parse(ateIso) - Date.parse(deIso)) / DIA_MS;
}

function mesmaUnidade(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

function semEvidencia(po: PedidoParaClassificar, ctx: ContextoClassificacao, semContrato: boolean): Resultado {
  if (po.criadoEm === null) return resultado('nao_observado', 'sem_data_de_criacao');
  if (Date.parse(po.criadoEm) < Date.parse(ctx.inicioCoberturaNf)) {
    return resultado('nao_observado', 'anterior_a_cobertura');
  }
  if (po.previsao === null) return resultado('sem_evidencia', semContrato ? 'sem_contrato' : 'sem_previsao');
  if (diasEntre(po.previsao, ctx.agora) > ctx.diasVencidoSemNf) {
    return resultado('vencido_sem_nf', semContrato ? 'sem_contrato' : 'previsao_vencida');
  }
  return resultado('sem_evidencia', semContrato ? 'sem_contrato' : 'no_prazo');
}

function elegibilidadeDe(
  concluidas: Recebimento[],
  ligado: (i: ItemRecebimento) => boolean,
  ctx: ContextoClassificacao,
): Elegibilidade {
  const itens = concluidas.flatMap((r) => r.itens.filter(ligado));
  if (itens.some((i) => i.movimentaEstoque === false)) return 'nao_movimenta_estoque';
  if (itens.some((i) => i.movimentaEstoque === null)) return 'movimentacao_desconhecida';
  if (concluidas.some((r) => r.recebidoEm === null)) return 'data_desconhecida';
  const ultima = Math.max(...concluidas.map((r) => Date.parse(r.recebidoEm as string)));
  if (ctx.estoqueLidoEm === null || Date.parse(ctx.estoqueLidoEm) <= ultima) return 'aguardando_estoque';
  return 'elegivel';
}

export function classificarPedido(
  po: PedidoParaClassificar,
  recebimentos: Recebimento[],
  ctx: ContextoClassificacao,
): Resultado {
  if (po.situacao === 'desconhecido') return resultado('situacao_desconhecida', 'situacao_nao_observada');
  if (po.situacao === 'fechado') return resultado('ja_fechado_no_omie', 'situacao_fechada');
  if (po.itens.length === 0) return resultado('ambigua', 'pedido_sem_itens');
  if (po.contrato === null) return semEvidencia(po, ctx, true);

  if (po.outrosComMesmoContrato.length > 0) {
    const meus = new Set(po.itens.map((i) => i.produto));
    const divide = po.outrosComMesmoContrato.some((o) => o.produtos.some((p) => meus.has(p)));
    return resultado('ambigua', divide ? 'contrato_duplicado' : 'contrato_dividido');
  }

  const idsItens = new Set(po.itens.map((i) => i.idItem));
  const ligado = (i: ItemRecebimento) =>
    !i.ignorado &&
    (i.pedidoCompra === po.contrato || (i.idItemPedidoNativo !== null && idsItens.has(i.idItemPedidoNativo)));

  // Um idReceb conta uma vez só (reprocessamento não soma de novo); a mesma chave em dois idReceb
  // é a mesma NF vista duas vezes até que alguém reconcilie — nunca soma as duas.
  const porId = new Map<number, Recebimento>();
  for (const r of recebimentos) porId.set(r.idReceb, r);
  const concluidas = [...porId.values()].filter((r) => r.recebido && !r.cancelado && r.itens.some(ligado));
  const chaves = concluidas.map((r) => r.chaveNfe).filter((c): c is string => c !== null);
  if (new Set(chaves).size !== chaves.length) return resultado('ambigua', 'nf_duplicada');
  if (concluidas.length === 0) return semEvidencia(po, ctx, false);

  const unidadePorProduto = new Map<number, string | null>();
  for (const i of po.itens) unidadePorProduto.set(i.produto, i.unidade);

  const recebidoPorProduto = new Map<number, number>();
  for (const r of concluidas) {
    const sequencias = new Set<number>();
    for (const i of r.itens.filter(ligado)) {
      if (sequencias.has(i.sequencia)) return resultado('ambigua', 'nf_duplicada');
      sequencias.add(i.sequencia);
      if (i.idItemPedidoNativo !== null && i.idItemPedidoNativo !== 0 && !idsItens.has(i.idItemPedidoNativo)) {
        return resultado('ambigua', 'vinculo_nativo_outro_item');
      }
      if (i.produto === null) return resultado('ambigua', 'produto_sem_associacao');
      if (!unidadePorProduto.has(i.produto)) return resultado('ambigua', 'item_fora_do_pedido');
      if (i.quantidadeRecebida === null || !Number.isFinite(i.quantidadeRecebida) || i.quantidadeRecebida < 0) {
        return resultado('ambigua', 'quantidade_ausente');
      }
      if (
        i.unidadeNfe !== null && i.unidadeOmie !== null && !mesmaUnidade(i.unidadeNfe, i.unidadeOmie) &&
        i.quantidadeNfe !== null && Math.abs(i.quantidadeNfe - i.quantidadeRecebida) < EPSILON
      ) {
        return resultado('ambigua', 'unidade_sem_conversao');
      }
      const unidadePedido = unidadePorProduto.get(i.produto) ?? null;
      if (unidadePedido === null || i.unidadeOmie === null || !mesmaUnidade(unidadePedido, i.unidadeOmie)) {
        return resultado('ambigua', 'unidade_divergente');
      }
      recebidoPorProduto.set(i.produto, (recebidoPorProduto.get(i.produto) ?? 0) + i.quantidadeRecebida);
    }
  }

  // Duas linhas do mesmo produto no PO somam — a quantidade recebida é gasta uma vez só.
  const pedidoPorProduto = new Map<number, number>();
  for (const i of po.itens) pedidoPorProduto.set(i.produto, (pedidoPorProduto.get(i.produto) ?? 0) + i.quantidade);

  const faltantes: Faltante[] = [];
  for (const [produto, pedido] of pedidoPorProduto) {
    const recebido = recebidoPorProduto.get(produto) ?? 0;
    if (recebido + EPSILON < pedido) faltantes.push({ produto, pedido, recebido });
  }
  const ids = concluidas.map((r) => r.idReceb);
  if (faltantes.length === 0) {
    return resultado('cheia', 'coberto_pelas_nfs', { recebimentos: ids, elegibilidade: elegibilidadeDe(concluidas, ligado, ctx) });
  }

  const datas = concluidas.map((r) => r.recebidoEm).filter((d): d is string => d !== null);
  const ultima = datas.length > 0 ? Math.max(...datas.map((d) => Date.parse(d))) : null;
  const envelhecido = ultima !== null && (Date.parse(ctx.agora) - ultima) / DIA_MS > ctx.diasParcialEnvelhecido;
  return resultado(envelhecido ? 'parcial_envelhecido' : 'parcial', envelhecido ? 'saldo_parado' : 'saldo_pendente', {
    faltantes,
    recebimentos: ids,
  });
}
```

- [ ] **Step 4:** rodar → 32 PASS.

- [ ] **Step 5: falsificar** — commitar, depois, numa cópia do módulo e com um controle sem sabotagem na MESMA
  invocação, sabotar uma barreira por vez e exigir vermelho: `pedido_sem_itens`, contrato repetido, chave duplicada,
  de-dup por idReceb, NF cancelada, NF revertida, vínculo nativo, produto nulo, item fora do pedido, quantidade
  ausente, sem conversão, unidade divergente, soma das linhas do mesmo produto, faltante, envelhecido,
  não-movimenta, movimentação desconhecida, estoque antes da NF, sem leitura de estoque, anterior à cobertura,
  situação desconhecida, item ignorado (22 no total). Registre no PR a tabela `sabotagem → rc`.

- [ ] **Step 6:** manifesto (`"src/lib/reposicao/__tests__/po-baixa-classificar.test.ts",`) + commit.

### Task c1.2: RPC que monta as entradas (SECURITY INVOKER)

**Files:**
- Create: `supabase/migrations/<ts>_reposicao_pos_para_baixar.sql`, `db/test-reposicao-pos-para-baixar.sh`

**Interfaces:**
- Consumes: tabelas do PR0 e do PR(b); `purchase_orders_tracking`; `sync_state` (`entity_type =
  'reposicao_pendente_po'`, `account = lower(empresa)`).
- Produces: `public.reposicao_pos_para_baixar(p_empresa text DEFAULT 'OBEN') RETURNS TABLE(omie_codigo_pedido bigint,
  numero_pedido text, contrato text, fornecedor_codigo_omie bigint, previsao date, criado_em timestamptz, situacao text,
  situacao_observada_em timestamptz, contribuicao_motor numeric, itens jsonb, recebimentos jsonb,
  outros_mesmo_contrato jsonb, estoque_lido_em timestamptz)`. JSON com as chaves exatas que o `montar-entrada.ts`
  (Task c1.3) lê.

- [ ] **Step 1: migration**

```sql
-- Monta, por PO etapa 15 do espelho, a entrada do classificador da lista "Pedidos para baixar"
-- (spec 2026-09-26-baixa-pedido-compra-nf-concluida §15; Codex §16 achados 3, 7 e 8).
-- situacao: 'aberto' = o PO está no último run COMPLETO (e com pendente aplicado) que o omie-sync-estoque observou
-- nas últimas 24 h; 'fechado' = ausente desse run E com previsão dentro da janela dele; qualquer outra coisa =
-- 'desconhecido' (ausência fora da janela, ou sem run recente, NUNCA vira "fechado").
-- SECURITY INVOKER: staff lê pelas policies das tabelas; não-staff recebe 0 linhas.
BEGIN;

CREATE OR REPLACE FUNCTION public.reposicao_pos_para_baixar(p_empresa text DEFAULT 'OBEN')
RETURNS TABLE (
  omie_codigo_pedido bigint,
  numero_pedido text,
  contrato text,
  fornecedor_codigo_omie bigint,
  previsao date,
  criado_em timestamptz,
  situacao text,
  situacao_observada_em timestamptz,
  contribuicao_motor numeric,
  itens jsonb,
  recebimentos jsonb,
  outros_mesmo_contrato jsonb,
  estoque_lido_em timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  WITH run AS (
    SELECT r.run_id, r.concluido_em, r.janela_de, r.janela_ate
    FROM public.reposicao_po_observado_run r
    WHERE r.empresa = p_empresa AND r.varredura_completa AND r.pendente_aplicado
      AND r.concluido_em > now() - interval '24 hours'
    ORDER BY r.concluido_em DESC
    LIMIT 1
  ), obs AS (
    SELECT o.omie_codigo_pedido, sum(o.contribuicao) AS contribuicao
    FROM public.reposicao_po_observado_item o JOIN run ON run.run_id = o.run_id
    GROUP BY o.omie_codigo_pedido
  ), po AS (
    SELECT t.omie_codigo_pedido, t.numero_pedido, t.numero_contrato_fornecedor AS contrato, t.fornecedor_codigo_omie,
           t.data_previsao_original::date AS previsao, t.t1_data_pedido AS criado_em,
           coalesce(t.raw_data->'produtos_consulta', '[]'::jsonb) AS produtos
    FROM public.purchase_orders_tracking t
    WHERE t.empresa::text = p_empresa AND t.omie_codigo_pedido > 0
      AND t.raw_data->'cabecalho_consulta'->>'cEtapa' = '15'
  ), sit AS (
    SELECT po.*, obs.contribuicao,
      CASE
        WHEN NOT EXISTS (SELECT 1 FROM run) THEN 'desconhecido'
        WHEN obs.omie_codigo_pedido IS NOT NULL THEN 'aberto'
        WHEN po.previsao IS NOT NULL
             AND po.previsao BETWEEN (SELECT janela_de FROM run) AND (SELECT janela_ate FROM run) THEN 'fechado'
        ELSE 'desconhecido'
      END AS situacao
    FROM po LEFT JOIN obs ON obs.omie_codigo_pedido = po.omie_codigo_pedido
  )
  SELECT
    s.omie_codigo_pedido, s.numero_pedido, s.contrato, s.fornecedor_codigo_omie, s.previsao, s.criado_em,
    s.situacao,
    (SELECT concluido_em FROM run),
    coalesce(s.contribuicao, 0),
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'idItem', (e.p->>'nCodItem')::bigint, 'produto', (e.p->>'nCodProd')::bigint,
               'quantidade', (e.p->>'nQtde')::numeric, 'unidade', nullif(trim(e.p->>'cUnidade'), ''))
             ORDER BY e.ord)
      FROM jsonb_array_elements(s.produtos) WITH ORDINALITY AS e(p, ord)), '[]'::jsonb),
    CASE WHEN s.situacao = 'fechado' THEN '[]'::jsonb ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'idReceb', ro.nid_receb, 'chaveNfe', ro.chave_nfe, 'numeroNfe', ro.numero_nfe,
               'recebido', ro.recebido, 'cancelado', ro.cancelado, 'recebidoEm', ro.recebido_em,
               'itens', (SELECT jsonb_agg(jsonb_build_object(
                                  'sequencia', it.sequencia, 'produto', it.produto_omie_id,
                                  'unidadeNfe', it.unidade_nfe, 'quantidadeNfe', it.quantidade_nfe,
                                  'unidadeOmie', it.unidade_omie, 'quantidadeRecebida', it.quantidade_recebida,
                                  'pedidoCompra', it.pedido_compra_xml, 'idItemPedidoNativo', it.id_item_pedido_nativo,
                                  'ignorado', it.ignorado, 'movimentaEstoque', it.movimenta_estoque)
                                ORDER BY it.sequencia)
                         FROM public.recebimento_omie_item it WHERE it.recebimento_id = ro.id))
             ORDER BY ro.nid_receb)
      FROM public.recebimento_omie ro
      WHERE ro.empresa = p_empresa AND ro.corrente
        AND EXISTS (
          SELECT 1 FROM public.recebimento_omie_item li
          WHERE li.recebimento_id = ro.id
            AND ((s.contrato IS NOT NULL AND li.pedido_compra_xml = s.contrato)
                 OR li.id_item_pedido_nativo IN (SELECT (q->>'nCodItem')::bigint FROM jsonb_array_elements(s.produtos) q)))
    ), '[]'::jsonb) END,
    coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'numero', o.numero_pedido,
               'produtos', (SELECT coalesce(jsonb_agg(DISTINCT (q->>'nCodProd')::bigint), '[]'::jsonb)
                            FROM jsonb_array_elements(coalesce(o.raw_data->'produtos_consulta', '[]'::jsonb)) q)))
      FROM public.purchase_orders_tracking o
      WHERE o.empresa::text = p_empresa AND o.omie_codigo_pedido > 0 AND o.omie_codigo_pedido <> s.omie_codigo_pedido
        AND s.contrato IS NOT NULL AND o.numero_contrato_fornecedor = s.contrato
        AND o.fornecedor_codigo_omie IS NOT DISTINCT FROM s.fornecedor_codigo_omie), '[]'::jsonb),
    (SELECT st.last_sync_at FROM public.sync_state st
      WHERE st.entity_type = 'reposicao_pendente_po' AND st.account = lower(p_empresa))
  FROM sit s
$fn$;

REVOKE ALL ON FUNCTION public.reposicao_pos_para_baixar(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_pos_para_baixar(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.reposicao_pos_para_baixar(text) TO authenticated;

DO $post$
BEGIN
  IF to_regclass('public.recebimento_omie') IS NULL OR to_regclass('public.reposicao_po_observado_run') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: dependências ausentes — aplique antes as migrations do PR0 e do PR(b)';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.reposicao_pos_para_baixar(text)')) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: reposicao_pos_para_baixar ausente ou SECURITY DEFINER (tem de ser INVOKER)';
  END IF;
  IF has_function_privilege('anon', 'public.reposicao_pos_para_baixar(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: anon executa a RPC';
  END IF;
  RAISE NOTICE 'reposicao_pos_para_baixar: INVOKER, fechada para anon — OK';
END
$post$;

COMMIT;
```

- [ ] **Step 2: prova PG17 `db/test-reposicao-pos-para-baixar.sh`** — duas armadilhas medidas ao validar este plano:
  (1) o snapshot local NÃO tem o grant padrão do Supabase, então a RPC INVOKER dá `42501` para o staff — emule o de prod
  (medido 2026-10-01: `authenticated` e `anon` com `SELECT` em `purchase_orders_tracking` e `sync_state`; a RLS filtra)
  com `GRANT SELECT ON public.purchase_orders_tracking, public.sync_state TO authenticated, anon;` antes dos asserts;
  (2) a RPC usa o run completo MAIS RECENTE — limpe `reposicao_po_observado_run` antes de semear, senão um run de outro
  assert vence e o PO aparece `fechado`. Aplicar PR0, PR(b) e esta migration; semear 1
  PO etapa 15 (contrato `'2125314'`, 1 item `cUnidade 'UN'`), um run completo com o PO, um recebimento corrente com o
  item de `pedido_compra_xml = '2125314'`, e um segundo PO (fechado, etapa 15) com o MESMO contrato. Asserts:
  - C1 (staff): `situacao = 'aberto'`, `contribuicao_motor` = a do run, `recebimentos` com 1 NF e 1 item,
    `outros_mesmo_contrato` com o 2º PO e seus produtos.
  - C2: PO ausente do run com previsão dentro da janela → `'fechado'` e `recebimentos = '[]'`.
  - C3: PO ausente com previsão FORA da janela → `'desconhecido'`.
  - C4: run com `concluido_em` de 25 h atrás (único) → todos `'desconhecido'`.
  - C5: run com `pendente_aplicado = false` não conta como observação → `'desconhecido'`.
  - C6: `authenticated` sem papel → 0 linhas; `anon` → `42501` ao executar.
  Registre com `falsificar=` ≥ 3 (sabote: o filtro de 24 h; o `BETWEEN` da janela; o `pendente_aplicado`).

- [ ] **Step 3:** `bash db/test-reposicao-pos-para-baixar.sh` → exit 0; falsificação; `bun run audit:migrations`;
  acrescentar a assinatura em `src/integrations/supabase/types.ts` (seção `Functions`, no formato das RPCs vizinhas,
  `Args: { p_empresa?: string }`, `Returns` com as 13 colunas); `heavy bun run typecheck`; commit.

### Task c1.3: linha da RPC → entrada do classificador (parse estrito)

**Files:**
- Create: `src/lib/reposicao/po-baixa/montar-entrada.ts`
- Test: `src/lib/reposicao/__tests__/po-baixa-montar-entrada.test.ts` (+ manifesto)

**Interfaces:**
- Consumes: tipos da Task c1.1; colunas da RPC da Task c1.2.
- Produces: `LinhaPosParaBaixar` (as 13 colunas), `montarEntrada(l: LinhaPosParaBaixar): Montagem` com
  `Montagem = { ok: true; pedido: PedidoParaClassificar; recebimentos: Recebimento[]; estoqueLidoEm: string | null } | { ok: false; motivo: string }`.

- [ ] **Step 1: teste**

```ts
import { describe, expect, it } from 'vitest';

import { montarEntrada, type LinhaPosParaBaixar } from '@/lib/reposicao/po-baixa/montar-entrada';

function linha(extra: Partial<LinhaPosParaBaixar> = {}): LinhaPosParaBaixar {
  return {
    omie_codigo_pedido: 12000000001,
    numero_pedido: '1205',
    contrato: '2125314',
    fornecedor_codigo_omie: 8689681266,
    previsao: '2026-09-10',
    criado_em: '2026-09-01T10:00:00+00:00',
    situacao: 'aberto',
    situacao_observada_em: '2026-09-26T09:40:46+00:00',
    contribuicao_motor: 6,
    itens: [{ idItem: 1, produto: 100, quantidade: 6, unidade: 'UN' }],
    recebimentos: [{
      idReceb: 9001, chaveNfe: 'K', numeroNfe: '951088', recebido: true, cancelado: false,
      recebidoEm: '2026-09-17T14:00:00+00:00',
      itens: [{ sequencia: 1, produto: 100, unidadeNfe: 'L', quantidadeNfe: 19.44, unidadeOmie: 'UN',
        quantidadeRecebida: 6, pedidoCompra: '2125314', idItemPedidoNativo: null, ignorado: false, movimentaEstoque: true }],
    }],
    outros_mesmo_contrato: [],
    estoque_lido_em: '2026-09-26T09:40:46+00:00',
    ...extra,
  };
}

describe('montarEntrada', () => {
  it('linha válida vira entrada tipada do classificador', () => {
    const m = montarEntrada(linha());
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.pedido).toMatchObject({ numero: '1205', contrato: '2125314', situacao: 'aberto' });
    expect(m.pedido.itens).toEqual([{ idItem: 1, produto: 100, quantidade: 6, unidade: 'UN' }]);
    expect(m.recebimentos[0].itens[0]).toMatchObject({ quantidadeRecebida: 6, movimentaEstoque: true });
    expect(m.estoqueLidoEm).toBe('2026-09-26T09:40:46+00:00');
  });

  it('situação fora do vocabulário é recusada (não vira "aberto")', () => {
    expect(montarEntrada(linha({ situacao: 'talvez' })).ok).toBe(false);
  });

  it('item de PO sem quantidade é recusado (PO malformado não é classificado)', () => {
    expect(montarEntrada(linha({ itens: [{ idItem: 1, produto: 100, unidade: 'UN' }] })).ok).toBe(false);
  });

  it('quantidade recebida ausente passa como null (quem decide é o classificador)', () => {
    const r = linha();
    const recebimentos = [{ ...(r.recebimentos as Array<Record<string, unknown>>)[0],
      itens: [{ sequencia: 1, produto: 100, unidadeNfe: 'L', quantidadeNfe: 19.44, unidadeOmie: 'UN',
        quantidadeRecebida: null, pedidoCompra: '2125314', idItemPedidoNativo: null, ignorado: false, movimentaEstoque: true }] }];
    const m = montarEntrada(linha({ recebimentos }));
    expect(m.ok && m.recebimentos[0].itens[0].quantidadeRecebida).toBeNull();
  });

  it('recebimentos que não é array é recusado', () => {
    expect(montarEntrada(linha({ recebimentos: { a: 1 } })).ok).toBe(false);
  });
});
```

- [ ] **Step 2:** rodar → FAIL.

- [ ] **Step 3: implementar**

```ts
// Converte uma linha da RPC reposicao_pos_para_baixar na entrada do classificador (spec 2026-09-26 §15).
// Parse ESTRITO: estrutura inesperada recusa a linha inteira (o PO não é classificado e a tela conta a recusa);
// quantidade RECEBIDA ausente passa como null, porque é o classificador que decide o que ausência significa.

import type {
  EstadoSituacao,
  ItemPedido,
  ItemRecebimento,
  OutroPedidoDoContrato,
  PedidoParaClassificar,
  Recebimento,
} from '@/lib/reposicao/po-baixa/classificar-po';

export interface LinhaPosParaBaixar {
  omie_codigo_pedido: number;
  numero_pedido: string | null;
  contrato: string | null;
  fornecedor_codigo_omie: number | null;
  previsao: string | null;
  criado_em: string | null;
  situacao: string;
  situacao_observada_em: string | null;
  contribuicao_motor: number;
  itens: unknown;
  recebimentos: unknown;
  outros_mesmo_contrato: unknown;
  estoque_lido_em: string | null;
}

export type Montagem =
  | { ok: true; pedido: PedidoParaClassificar; recebimentos: Recebimento[]; estoqueLidoEm: string | null }
  | { ok: false; motivo: string };

class Recusa extends Error {}

const SITUACOES: ReadonlySet<string> = new Set(['aberto', 'fechado', 'desconhecido']);

function lista(v: unknown, oque: string): Record<string, unknown>[] {
  if (!Array.isArray(v)) throw new Recusa(`${oque} não é lista`);
  return v.map((x) => {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) throw new Recusa(`${oque} com elemento inválido`);
    return x as Record<string, unknown>;
  });
}

function numero(v: unknown, oque: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Recusa(`${oque} ausente ou inválido`);
  return v;
}

function numeroOuNull(v: unknown, oque: string): number | null {
  return v === null || v === undefined ? null : numero(v, oque);
}

function listaDeNumeros(v: unknown, oque: string): number[] {
  if (!Array.isArray(v)) throw new Recusa(`${oque} não é lista`);
  return v.map((x) => numero(x, oque));
}

function textoOuNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function boolOuNull(v: unknown, oque: string): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'boolean') throw new Recusa(`${oque} não é booleano`);
  return v;
}

export function montarEntrada(l: LinhaPosParaBaixar): Montagem {
  try {
    if (!SITUACOES.has(l.situacao)) throw new Recusa(`situação "${l.situacao}" fora do vocabulário`);
    const itens: ItemPedido[] = lista(l.itens, 'itens do PO').map((i) => ({
      idItem: numero(i.idItem, 'idItem'),
      produto: numero(i.produto, 'produto do PO'),
      quantidade: numero(i.quantidade, 'quantidade do PO'),
      unidade: textoOuNull(i.unidade),
    }));
    const recebimentos: Recebimento[] = lista(l.recebimentos, 'recebimentos').map((r) => ({
      idReceb: numero(r.idReceb, 'idReceb'),
      chaveNfe: textoOuNull(r.chaveNfe),
      recebido: boolOuNull(r.recebido, 'recebido') === true,
      cancelado: boolOuNull(r.cancelado, 'cancelado') === true,
      recebidoEm: textoOuNull(r.recebidoEm),
      itens: lista(r.itens ?? [], 'itens da NF').map((i): ItemRecebimento => ({
        sequencia: numero(i.sequencia, 'sequencia'),
        produto: numeroOuNull(i.produto, 'produto da NF'),
        unidadeNfe: textoOuNull(i.unidadeNfe),
        quantidadeNfe: numeroOuNull(i.quantidadeNfe, 'quantidadeNfe'),
        unidadeOmie: textoOuNull(i.unidadeOmie),
        quantidadeRecebida: numeroOuNull(i.quantidadeRecebida, 'quantidadeRecebida'),
        pedidoCompra: textoOuNull(i.pedidoCompra),
        idItemPedidoNativo: numeroOuNull(i.idItemPedidoNativo, 'idItemPedidoNativo'),
        ignorado: boolOuNull(i.ignorado, 'ignorado') === true,
        movimentaEstoque: boolOuNull(i.movimentaEstoque, 'movimentaEstoque'),
      })),
    }));
    const outros: OutroPedidoDoContrato[] = lista(l.outros_mesmo_contrato, 'outros POs do contrato').map((o) => ({
      numero: textoOuNull(o.numero) ?? '?',
      produtos: listaDeNumeros(o.produtos, 'produtos de outro PO'),
    }));
    return {
      ok: true,
      pedido: {
        numero: l.numero_pedido ?? String(l.omie_codigo_pedido),
        contrato: textoOuNull(l.contrato),
        situacao: l.situacao as EstadoSituacao,
        previsao: textoOuNull(l.previsao),
        criadoEm: textoOuNull(l.criado_em),
        itens,
        outrosComMesmoContrato: outros,
      },
      recebimentos,
      estoqueLidoEm: textoOuNull(l.estoque_lido_em),
    };
  } catch (e) {
    if (e instanceof Recusa) return { ok: false, motivo: e.message };
    throw e;
  }
}
```

- [ ] **Step 4:** rodar → PASS; manifesto; commit. PR(c1) = Tasks c1.1–c1.3 + Codex adversarial.

---

## PR(c2) — página "Pedidos para baixar" + sensor

### Task c2.1: hook + resumo por classe

**Files:**
- Create: `src/components/reposicao/po-baixa/usePedidosParaBaixar.ts`, `src/components/reposicao/po-baixa/resumo.ts`
- Test: `src/components/reposicao/po-baixa/__tests__/resumo.test.ts` (+ manifesto)

**Interfaces:**
- Produces: `usePedidosParaBaixar()` → `UseQueryResult<{ classificados: PedidoClassificado[]; recusadas: { omie_codigo_pedido: number; motivo: string }[] }>`;
  `PedidoClassificado = { linha: LinhaPosParaBaixar; resultado: Resultado }`;
  `contarPorClasse(itens: PedidoClassificado[]): Record<ChaveResumo, number>` com
  `ChaveResumo = 'cheia_elegivel' | 'cheia_aguardando' | 'parcial' | 'parcial_envelhecido' | 'ambigua' | 'vencido_sem_nf' | 'nao_observado' | 'sem_evidencia' | 'ja_fechado_no_omie' | 'situacao_desconhecida'`.

- [ ] **Step 1: teste do resumo**

```ts
import { describe, expect, it } from 'vitest';

import { contarPorClasse } from '@/components/reposicao/po-baixa/resumo';
import type { PedidoClassificado } from '@/components/reposicao/po-baixa/usePedidosParaBaixar';

function pc(classe: string, elegibilidade: string | null = null): PedidoClassificado {
  return { linha: {} as PedidoClassificado['linha'], resultado: { classe, elegibilidade, motivo: 'no_prazo', faltantes: [], recebimentos: [] } as PedidoClassificado['resultado'] };
}

describe('contarPorClasse', () => {
  it('separa cheia elegível de cheia aguardando e conta o resto por classe', () => {
    const r = contarPorClasse([pc('cheia', 'elegivel'), pc('cheia', 'aguardando_estoque'), pc('cheia', 'nao_movimenta_estoque'), pc('parcial'), pc('ja_fechado_no_omie')]);
    expect(r.cheia_elegivel).toBe(1);
    expect(r.cheia_aguardando).toBe(2);
    expect(r.parcial).toBe(1);
    expect(r.ja_fechado_no_omie).toBe(1);
    expect(r.ambigua).toBe(0);
  });
});
```

- [ ] **Step 2: implementar**

```ts
// src/components/reposicao/po-baixa/resumo.ts
import type { PedidoClassificado } from '@/components/reposicao/po-baixa/usePedidosParaBaixar';

export type ChaveResumo =
  | 'cheia_elegivel'
  | 'cheia_aguardando'
  | 'parcial'
  | 'parcial_envelhecido'
  | 'ambigua'
  | 'vencido_sem_nf'
  | 'nao_observado'
  | 'sem_evidencia'
  | 'ja_fechado_no_omie'
  | 'situacao_desconhecida';

export function chaveResumo(p: PedidoClassificado): ChaveResumo {
  const { classe, elegibilidade } = p.resultado;
  if (classe === 'cheia') return elegibilidade === 'elegivel' ? 'cheia_elegivel' : 'cheia_aguardando';
  return classe;
}

export function contarPorClasse(itens: PedidoClassificado[]): Record<ChaveResumo, number> {
  const base: Record<ChaveResumo, number> = {
    cheia_elegivel: 0, cheia_aguardando: 0, parcial: 0, parcial_envelhecido: 0, ambigua: 0,
    vencido_sem_nf: 0, nao_observado: 0, sem_evidencia: 0, ja_fechado_no_omie: 0, situacao_desconhecida: 0,
  };
  for (const p of itens) base[chaveResumo(p)] += 1;
  return base;
}
```

```ts
// src/components/reposicao/po-baixa/usePedidosParaBaixar.ts
import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import { classificarPedido, type Resultado } from '@/lib/reposicao/po-baixa/classificar-po';
import { montarEntrada, type LinhaPosParaBaixar } from '@/lib/reposicao/po-baixa/montar-entrada';

export interface PedidoClassificado {
  linha: LinhaPosParaBaixar;
  resultado: Resultado;
}

/** Menor `t2` do espelho (spec 2026-09-26 §13.2). Aproximação global — o Codex pediu cobertura efetiva (§16, achado 9). */
export const INICIO_COBERTURA_NF = '2026-01-19T00:00:00Z';
/** Lead time Oben máximo medido: 39 d (`omie-sync-estoque/index.ts:192`). */
export const DIAS_VENCIDO_SEM_NF = 40;
export const DIAS_PARCIAL_ENVELHECIDO = 30;

export function usePedidosParaBaixar() {
  return useQuery({
    queryKey: ['reposicao', 'pos-para-baixar', 'OBEN'],
    queryFn: async () => {
      const linhas = await fetchAllPages<LinhaPosParaBaixar>(
        (de, ate) =>
          supabase
            .rpc('reposicao_pos_para_baixar', { p_empresa: 'OBEN' })
            .order('omie_codigo_pedido', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: LinhaPosParaBaixar[] | null; error: unknown }>,
        'reposicao_pos_para_baixar',
      );
      const agora = new Date().toISOString();
      const classificados: PedidoClassificado[] = [];
      const recusadas: { omie_codigo_pedido: number; motivo: string }[] = [];
      for (const linha of linhas) {
        const m = montarEntrada(linha);
        if (!m.ok) {
          recusadas.push({ omie_codigo_pedido: linha.omie_codigo_pedido, motivo: m.motivo });
          continue;
        }
        classificados.push({
          linha,
          resultado: classificarPedido(m.pedido, m.recebimentos, {
            agora,
            inicioCoberturaNf: INICIO_COBERTURA_NF,
            estoqueLidoEm: m.estoqueLidoEm,
            diasVencidoSemNf: DIAS_VENCIDO_SEM_NF,
            diasParcialEnvelhecido: DIAS_PARCIAL_ENVELHECIDO,
          }),
        });
      }
      return { classificados, recusadas };
    },
  });
}
```

- [ ] **Step 3:** testes → PASS; manifesto; commit.

### Task c2.2: tabela, página, rota, Cmd-K e sensor

**Files:**
- Create: `src/components/reposicao/po-baixa/PedidosBaixarTabela.tsx`, `src/pages/AdminReposicaoPedidosBaixar.tsx`
- Modify: `src/App.tsx` (lazy ≈ :132-154; rota dentro do `RequireStaff`, perto de ≈ :373),
  `src/components/shell/CommandPalette.tsx` (≈ :97-103), `src/lib/routeCrumbs.ts` (≈ :33-38)
- Test: `src/components/reposicao/po-baixa/__tests__/PedidosBaixarTabela.test.tsx`,
  `src/pages/__tests__/AdminReposicaoPedidosBaixar.leitura.test.tsx` (+ manifesto)

- [ ] **Step 1: testes (falham: componentes inexistentes)** — tabela: com 1 `cheia/elegivel` e 1 `parcial`, mostra
  "Pronto para encerrar" só na primeira; o botão "Copiar motivo" chama `navigator.clipboard.writeText` com
  `Recebido pela(s) NF(s) 951088 — encerrado sem associação (Afiação)` e dispara
  `track('compras.po_baixa.motivo_copiado', { classe: 'cheia' })` (mock de `@/lib/analytics`). Página: com o hook
  mockado em `status: 'error'` renderiza `data-testid="aviso-leitura-pos-baixar"`; com lista vazia renderiza o
  `EmptyState`; com dados dispara UMA vez `track('compras.po_baixa.lista_vista', …)`.

- [ ] **Step 2: tabela**

```tsx
// src/components/reposicao/po-baixa/PedidosBaixarTabela.tsx
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { track } from '@/lib/analytics';
import { chaveResumo } from '@/components/reposicao/po-baixa/resumo';
import type { PedidoClassificado } from '@/components/reposicao/po-baixa/usePedidosParaBaixar';

const ROTULO: Record<string, string> = {
  cheia_elegivel: 'Pronto para encerrar',
  cheia_aguardando: 'Coberto — aguardando estoque',
  parcial: 'Parcial — saldo a caminho',
  parcial_envelhecido: 'Parcial parado — investigar saldo',
  ambigua: 'Ambíguo — conferir',
  vencido_sem_nf: 'Vencido sem NF',
  nao_observado: 'Não observado',
  sem_evidencia: 'Sem NF (no prazo)',
  ja_fechado_no_omie: 'Já fora do "a caminho"',
  situacao_desconhecida: 'Situação não observada',
};

function motivoParaOmie(p: PedidoClassificado): string {
  const nfs = Array.isArray(p.linha.recebimentos)
    ? (p.linha.recebimentos as Array<{ idReceb: number; numeroNfe?: string | null }>)
        .filter((r) => p.resultado.recebimentos.includes(r.idReceb))
        .map((r) => r.numeroNfe ?? String(r.idReceb))
    : [];
  return `Recebido pela(s) NF(s) ${nfs.join(', ')} — encerrado sem associação (Afiação)`;
}

export function PedidosBaixarTabela({ itens }: { itens: PedidoClassificado[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>PO</TableHead>
          <TableHead>Contrato</TableHead>
          <TableHead>Classe</TableHead>
          <TableHead className="text-right">Un. no "a caminho"</TableHead>
          <TableHead>Faltantes</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {itens.map((p) => {
          const chave = chaveResumo(p);
          return (
            <TableRow key={p.linha.omie_codigo_pedido}>
              <TableCell className="font-mono">{p.linha.numero_pedido ?? p.linha.omie_codigo_pedido}</TableCell>
              <TableCell className="font-mono">{p.linha.contrato ?? '—'}</TableCell>
              <TableCell>
                <Badge variant={chave === 'cheia_elegivel' ? 'default' : 'secondary'}>{ROTULO[chave]}</Badge>
                <span className="ml-2 text-xs text-muted-foreground">{p.resultado.motivo}</span>
              </TableCell>
              <TableCell className="text-right tabular-nums">{p.linha.contribuicao_motor}</TableCell>
              <TableCell className="text-xs">
                {p.resultado.faltantes.map((f) => `${f.produto}: ${f.recebido}/${f.pedido}`).join(' · ') || '—'}
              </TableCell>
              <TableCell>
                {chave === 'cheia_elegivel' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard.writeText(motivoParaOmie(p));
                      track('compras.po_baixa.motivo_copiado', { classe: p.resultado.classe });
                    }}
                  >
                    Copiar motivo
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 3: página**

```tsx
// src/pages/AdminReposicaoPedidosBaixar.tsx
import { useEffect, useMemo, useRef } from 'react';
import { PackageCheck } from 'lucide-react';

import { EmptyState } from '@/components/EmptyState';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { PedidosBaixarTabela } from '@/components/reposicao/po-baixa/PedidosBaixarTabela';
import { chaveResumo, contarPorClasse, type ChaveResumo } from '@/components/reposicao/po-baixa/resumo';
import { usePedidosParaBaixar } from '@/components/reposicao/po-baixa/usePedidosParaBaixar';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useUrlState } from '@/hooks/useUrlState';
import { track } from '@/lib/analytics';
import { estadoDeLeitura, naoConsegui } from '@/lib/leitura/estado-de-leitura';

const ORDEM: ChaveResumo[] = ['cheia_elegivel', 'cheia_aguardando', 'parcial_envelhecido', 'ambigua', 'vencido_sem_nf', 'parcial', 'nao_observado', 'sem_evidencia', 'situacao_desconhecida', 'ja_fechado_no_omie'];

export default function AdminReposicaoPedidosBaixar() {
  const consulta = usePedidosParaBaixar();
  const [filtros, setFiltros] = useUrlState({ classe: 'cheia_elegivel' });
  const estado = estadoDeLeitura(consulta);
  const dados = consulta.data;
  const resumo = useMemo(() => (dados ? contarPorClasse(dados.classificados) : null), [dados]);
  const enviado = useRef(false);

  useEffect(() => {
    if (!dados || !resumo || enviado.current) return;
    enviado.current = true;
    track('compras.po_baixa.lista_vista', { total: dados.classificados.length, recusadas: dados.recusadas.length, ...resumo });
  }, [dados, resumo]);

  if (naoConsegui(estado) && !dados) {
    return <AvisoLeituraFalhou oque="os pedidos para baixar" estado={estado} testId="aviso-leitura-pos-baixar" />;
  }
  if (!dados || !resumo) return <PageSkeleton variant="list" />;

  const visiveis = dados.classificados.filter((p) => chaveResumo(p) === filtros.classe);
  return (
    <div className="space-y-4">
      <h1 className="font-display text-2xl">Pedidos para baixar</h1>
      <p className="text-sm text-muted-foreground">
        Pedidos que o motor ainda conta como "a caminho", cruzados com as NFs já concluídas no Omie. Encerrar é
        irreversível no Omie: confira a entrada no estoque antes.
      </p>
      <div className="flex flex-wrap gap-2">
        {ORDEM.map((chave) => (
          <button
            key={chave}
            type="button"
            className={chave === filtros.classe ? 'font-semibold underline' : 'text-muted-foreground'}
            onClick={() => setFiltros({ classe: chave })}
          >
            {chave} ({resumo[chave]})
          </button>
        ))}
      </div>
      {dados.recusadas.length > 0 && (
        <p className="text-sm text-status-warning">{dados.recusadas.length} PO(s) com dado malformado não foram classificados.</p>
      )}
      {visiveis.length === 0 ? (
        <EmptyState tone="operational" icon={PackageCheck} title="Nada nesta classe" description="Troque o filtro acima." />
      ) : (
        <PedidosBaixarTabela itens={visiveis} />
      )}
    </div>
  );
}
```

  Os rótulos dos botões de filtro usam a chave crua de propósito na 1ª versão (a copy final é da revisão de design;
  não é dado).

- [ ] **Step 4: rota, Cmd-K e trilha** — `src/App.tsx`:
  `const AdminReposicaoPedidosBaixar = lazy(() => import("./pages/AdminReposicaoPedidosBaixar"));` no bloco de lazies
  e `<Route path="admin/reposicao/pedidos-baixar" element={<AdminReposicaoPedidosBaixar />} />` ao lado da rota
  `admin/reposicao/alertas`, DENTRO do `<Route element={<RequireStaff />}>`. `CommandPalette.tsx`:
  `{ id: 'nav.repo-pedidos-baixar', label: 'Pedidos para baixar', group: 'Reposição', icon: PackageCheck, keywords: ['baixa', 'encerrar', 'nf', 'pedido de compra'], perform: go('/admin/reposicao/pedidos-baixar') },`.
  `routeCrumbs.ts`: `{ path: "/admin/reposicao/pedidos-baixar", crumb: "Pedidos para baixar" },`.

- [ ] **Step 5:** `heavy bun run test`, `heavy bun run typecheck`, `bun lint`, `bunx knip`; Codex adversarial (gatilho
  (a) de design review também vale: página nova); commit/PR.

### Task c2.3: o sensor que decide (tabela × evento) e "quando medir"

- [ ] **Step 1:** documentar no corpo do PR e na spec o par de sinais:
  - **PostHog (uso, amostra censurada — `docs/agent/analytics.md` §4):** `compras.po_baixa.lista_vista` (1 por carga,
    com as contagens por classe) e `compras.po_baixa.motivo_copiado`.
  - **Banco (decide):** a série diária do "a caminho" fantasma da Task 0.5 (unidades contadas pelo motor vindas de POs
    com NF concluída), na coorte fixa de SKUs.
- [ ] **Step 2: "quando medir" (query, não recado)** — 14 dias depois do PR(c2) no ar, comparar a média diária das
  `unidades` do grupo `A_nf_concluida` (Task 0.5) nos 7 dias ANTES do lançamento com os 7 dias depois do 7º dia; junto,
  quantos POs com NF concluída saíram do conjunto aberto por semana (ausentes num run completo em que a previsão ainda
  estava na janela, presentes no run anterior). Registrar os dois números e o denominador (POs com NF concluída no
  conjunto aberto no início de cada semana) na spec. Sem melhora mensurável → a lista é só higiene; não há Fase 1.

---

## PR(d) — proteção do "a caminho" contra etapa nova (pré-requisito da Fase 2)

### Task d.1: medir as etapas do conjunto aberto (depende do PR0 no ar)

- [ ] **Step 1:**

```sql
WITH ultimo AS (SELECT run_id FROM reposicao_po_observado_run WHERE empresa = 'OBEN' AND varredura_completa ORDER BY concluido_em DESC LIMIT 1)
SELECT o.etapa, count(DISTINCT o.omie_codigo_pedido) AS pos,
       round(sum(greatest(coalesce(o.quantidade, 0) - coalesce(o.quantidade_recebida, 0), 0)), 2) AS saldo
FROM reposicao_po_observado_item o JOIN ultimo u ON u.run_id = o.run_id
GROUP BY 1 ORDER BY 1;
\echo FIM-MEDICAO-OK
```
Expected: só `10` e `15`. **Se aparecer qualquer outra etapa com saldo > 0, PARE** e leve ao founder: é decisão de
negócio contar ou não esse PO (bloquear agora congelaria o pendente de todos os SKUs).

### Task d.2: etapa aberta desconhecida com saldo bloqueia a publicação

**Files:**
- Modify: `supabase/functions/omie-sync-estoque/index.ts` (o ramo `if (!ETAPAS_APROVADO_ABERTO.has(etapa)) { … }` da
  Task 0.3), `versao.ts` → próxima versão livre com slug `etapa-desconhecida-bloqueia`
- Create: `src/lib/reposicao/__tests__/etapa-desconhecida-bloqueia.test.ts` (+ manifesto)

- [ ] **Step 1: guarda textual (falha antes)** — dentro do ramo de etapa não aberta, existe um `problemas.push(` cuja
  condição usa `ETAPAS_CONHECIDAS.has(etapa)` negado; e a observação `"etapa_nao_aberta"` continua sendo registrada.

- [ ] **Step 2: implementar** — no ramo da Task 0.3:

```ts
      if (!ETAPAS_APROVADO_ABERTO.has(etapa)) {
        const temSaldo = (ped?.produtos_consulta ?? []).some((it: { nQtde?: unknown; nQtdeRec?: unknown }) => {
          const q = parseQtd(it.nQtde), r = parseRecebido(it.nQtdeRec);
          return !quantidadesValidas(q, r) || saldoAReceber(q, r) > 0;
        });
        if (!ETAPAS_CONHECIDAS.has(etapa) && temSaldo) {
          problemas.push(`PO ${cNumero || nCodPed} com etapa DESCONHECIDA "${etapa}" e saldo a receber — pendente não publicado até a etapa ser classificada`);
        }
        if (nCodPed) observados.push(...observarPedido(cabObs, itensObs, "etapa_nao_aberta", habilitado, parseObs));
        continue;
      }
```

  Com `problemas` não vazio, o pendente não é aplicado (a coluna é PRESERVADA no upsert — mecanismo que já existe) e o
  marcador `reposicao_pendente_po` envelhece — o Sentinela vê o "a caminho" congelado.

- [ ] **Step 3:** bump, fingerprint, gates, Codex adversarial, commit/PR; deploy pelo ledger.

---

## Fora deste plano

- **Fase 1 (encerramento em lote):** só depois da D3 (spec §15) e da medição da Task c2.3. Encerrar é ação humana
  no Omie (não há método de API — spec §14 F1).
- **Fase 2 (associação nativa):** H-xPed e `AlterarRecebimento` com `ASSOCIAR-PEDIDO`, com o protocolo de piloto do
  Codex (spec §16, achado 11) e depois do PR(d).
- **Órfãs Sayerlack (42 em 90 d):** com o PR(b) no ar, o `xPed` de cada órfã passa a ficar guardado; a investigação
  (por que não casam com contrato) é uma medição separada, não código deste plano.
- **Cobertura efetiva do sync de NFs** (substituir `INICIO_COBERTURA_NF` global — Codex §16 achado 9): depende de o
  sync registrar as janelas que de fato leu; follow-up.

## Auto-revisão (spec × plano)

| exigência (spec/Codex) | onde |
|---|---|
| (a) enum `ENCERRADO` com `lovable-db-operator` | PR(a1), Task a1.1 |
| (a) precedência entre os writers de `status` | PR(a2), Task a2.1 (ownership por domínio — Codex achado 4) |
| (b) item de NF com `nNumPedCompra` = `receipt`/`receipt_item` do ledger, não tabela paralela | PR(b), Tasks b.1–b.4 |
| (c) lista com a classificação (§7) + sensor `compras.po_baixa.*` | PR(c1) + PR(c2), Tasks c1.1–c2.3 |
| situação observada antes da lista (§15 item 2; Codex achado 3) | PR0 |
| cobertura ≠ elegibilidade (Codex achado 8) | Task c1.1 (`elegibilidade`), Task c2.2 (só `cheia_elegivel` tem ação) |
| contrato em qualquer PO, PO sem itens, NF duplicada, unidade (Codex achado 7) | Task c1.1 (testes + 22 sabotagens) |
| recebimento versionado e revisitado (Codex achado 6) | Tasks b.1, b.3 |
| resíduo medido por SKU na coorte fixa (Codex achado 2) | Task 0.5, Task c2.3 |
| etapa nova não apaga saldo (Codex achado 10) | PR(d) |
| nenhuma escrita no Omie | Global Constraints; nenhuma task chama método de escrita |
