# Retirar a exclusão de outlier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans para implementar task-a-task. Os passos usam checkbox (`- [ ]`).

**Goal:** Retirar a capacidade de "excluir" um outlier — a ação prometia remover a observação da estatística, mas nunca alcançou o motor de reposição; medido em prod, não há efeito para ligar.

**Architecture:** Duas camadas independentes. (1) SQL: `resolver_outlier` passa a aceitar só `'aceitar'` e para de gravar `observacoes_excluidas` — como essa tabela não tem grant algum, o SECURITY DEFINER é o **único** caminho de escrita, então tirar o INSERT a deixa permanentemente sem writer. (2) Frontend: somem o botão "Excluir", o excluir-em-lote e o card "Impacto se excluir"; resta um botão "Marcar como revisado". A linha de média do gráfico de leadtime, hoje alimentada pela RPC de impacto, passa a ser calculada a partir do próprio histórico já carregado.

**Tech Stack:** Postgres 17 (prova local) · Supabase/Lovable (apply manual) · React 18 + TS strict · vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-16-reposicao-exclusao-outlier-escopo-design.md`

## Global Constraints

- **Idioma:** código, rotas, commits e comentários em **pt-BR**.
- **Migration timestamp: `20260717020000`.** ⚠️ NÃO usar `20260717010000` — o PR #1366 (aberto, `claude/hopeful-kapitsa-d2d365`) já ocupa esse timestamp com `20260717010000_preco_medio_leadtime_efetivo.sql`.
- **Pré-flight obrigatório antes do `CREATE OR REPLACE`:** o #1357 foi aplicado à mão na prod em 2026-07-16 e a última função a recriar vence. O corpo verbatim da prod está reproduzido na Task 1; se divergir na hora do apply, **parar e reconferir** com `pg_get_functiondef`.
- **Não tocar** `supabase/migrations/` já existentes, `detectar_outliers_empresa`, nem a tabela `observacoes_excluidas` (DDL). Fora de escopo por decisão registrada no spec §4.1.
- **Não dropar** `estimar_impacto_exclusao_outlier` — só `COMMENT` de deprecada (a ordem de deploy do Lovable é manual; `DROP` com Publish atrasado quebraria o card em produção).
- **Deploy:** migration no SQL Editor + Publish do frontend. Sem edge function. `merge na main ≠ produção`.
- **Multi-sessão:** o PR #1212 (aberto) toca `src/components/reposicao/alertas/types.ts` na linha 8 (`export interface OutlierDetalhes` → `interface`). Nossas mudanças no mesmo arquivo são nas linhas ~50-63 — sem sobreposição, merge limpo esperado.
- **Shell:** `cmd | tail` engole o exit code → usar `> log 2>&1; echo $?`. Prefixar `heavy` em test/typecheck.
- **Repo público:** nada de contagens/volumes de produção, UUIDs, chaves de NFe ou nomes de fornecedor em commits/PRs.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `supabase/migrations/20260717020000_reposicao_exclusao_outlier_remover.sql` | `resolver_outlier` só aceita `aceitar`; para de gravar `observacoes_excluidas`; 3 COMMENTs de proveniência | Criar |
| `db/test-exclusao-outlier-removida.sh` | Prova PG17: positivo, negativo (SQLSTATE), invariante (tabela vazia), gate 42501, falsificação | Criar |
| `src/components/reposicao/alertas/types.ts` | `AcaoConfirm` perde `excluir`/`ignorar`; `ImpactoData` sai | Modificar |
| `src/pages/AdminReposicaoAlertas.tsx` | Sai a query de impacto e o recálculo pós-exclusão; entra `mediaLt` derivada do histórico | Modificar |
| `src/components/reposicao/alertas/AlertaDrillSheet.tsx` | Sai o card "4. Impacto se excluir"; 1 botão; texto honesto; usa `mediaLt` | Modificar |
| `src/components/reposicao/alertas/ConfirmacaoDialog.tsx` | Sai o aviso falso e o variant destructive | Modificar |
| `src/components/reposicao/alertas/AlertasFiltros.tsx` | Sai o botão "Excluir selecionados" | Modificar |
| `src/components/reposicao/alertas/__tests__/ConfirmacaoDialog.test.tsx` | O teste que assere a promessa falsa cai; entra o que prova a ausência dela | Modificar |
| `docs/agent/reposicao.md` | Lição durável: por que não reabrir esta frente | Modificar |

**Sem manifesto novo:** nenhum arquivo novo em `src/`; os dois criados são `supabase/migrations/**` e `db/**`, fora do glob do `manifesto.gate`.

**Intocados de propósito:** `StatsCards.tsx` e `badges.tsx` (o card "Excluídos hoje", o badge e o filtro `Excluído` continuam válidos — `detectar_skus_sem_grupo` segue gravando esse status por sistema no auto-resolve do `sku_sem_grupo`, e o histórico precisa renderizar).

---

## Task 1: Migration + prova PG17

**Files:**
- Create: `supabase/migrations/20260717020000_reposicao_exclusao_outlier_remover.sql`
- Create: `db/test-exclusao-outlier-removida.sh`

**Interfaces:**
- Consumes: nada (primeira task).
- Produces: `public.resolver_outlier(p_evento_id bigint, p_decisao text, p_justificativa text DEFAULT NULL, p_usuario_email text DEFAULT NULL) RETURNS jsonb` — aceita apenas `p_decisao = 'aceitar'`; qualquer outro valor levanta SQLSTATE `22023`. Retorna `{"evento_id": <id>, "novo_status": "aceito", "decisao": "aceitar"}`.

- [ ] **Step 1: Escrever o harness que falha**

Criar `db/test-exclusao-outlier-removida.sh`. O cabeçalho e o bootstrap PG17 seguem o padrão de `db/test-outliers-leadtime-stack-efetivo.sh` (mesmo `initdb`/`pg_ctl`/`cleanup`; só mudam `SLUG` e `PORT`).

```bash
#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — 20260717020000_reposicao_exclusao_outlier_remover.sql                ║
# ║      bash db/test-exclusao-outlier-removida.sh > /tmp/t.log 2>&1; echo $?     ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                              ║
# ║  O que se prova: 'excluir' deixou de existir e a tabela ficou SEM WRITER.     ║
# ║  Por que importa: gravar observacoes_excluidas sob semântica cosmética cria   ║
# ║  ORDENS LATENTES — um filtro futuro as aplicaria retroativamente à compra.    ║
# ║  A tabela não tem grant algum (conferido na prod), então o SECURITY DEFINER   ║
# ║  era o único caminho de escrita: sem o INSERT, ela fica vazia para sempre.    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="exclout"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# PRÉ-REQUISITOS — schema espelhado da PROD via psql-ro (2026-07-16), conferido
# em information_schema.columns + pg_constraint + pg_indexes (os dois últimos:
# um CREATE UNIQUE INDEX não aparece em pg_constraint; olhar só um esconde chave).
#   eventos_outlier: id bigserial PK · empresa/sku_codigo_omie/tipo/severidade text NOT NULL
#                    data_evento date NOT NULL · status text NOT NULL DEFAULT 'pendente'
#                    ⚠️ SEM CHECK em status (qualquer texto passa — não inventar CHECK aqui)
#   observacoes_excluidas: UNIQUE (empresa, sku_codigo_omie, tipo_observacao,
#                          data_observacao, referencia_original) · FK evento_outlier_id
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=_user_id AND ur.role=_role)
$f$;

CREATE TABLE public.eventos_outlier (
  id bigserial PRIMARY KEY,
  empresa text NOT NULL,
  sku_codigo_omie text NOT NULL,
  sku_descricao text,
  tipo text NOT NULL,
  severidade text NOT NULL,
  data_evento date NOT NULL,
  valor_observado numeric, valor_esperado numeric, desvios_padrao numeric,
  detalhes jsonb,
  status text NOT NULL DEFAULT 'pendente',
  decidido_em timestamptz, decidido_por text, justificativa_decisao text,
  detectado_em timestamptz DEFAULT now()
);

CREATE TABLE public.observacoes_excluidas (
  id bigserial PRIMARY KEY,
  empresa text NOT NULL,
  sku_codigo_omie text NOT NULL,
  tipo_observacao text NOT NULL,
  data_observacao date NOT NULL,
  referencia_original text,
  valor_excluido numeric,
  excluido_em timestamptz DEFAULT now(),
  excluido_por text,
  evento_outlier_id bigint REFERENCES public.eventos_outlier(id),
  justificativa text,
  UNIQUE (empresa, sku_codigo_omie, tipo_observacao, data_observacao, referencia_original)
);
SQL

# Corpo VERBATIM da prod (pg_get_functiondef, 2026-07-16, pós-#1357). É o "antes"
# que a migration substitui: sem isto o teste provaria o vácuo, não a mudança.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.resolver_outlier(p_evento_id bigint, p_decisao text, p_justificativa text DEFAULT NULL::text, p_usuario_email text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_evento RECORD;
  v_novo_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  IF p_decisao NOT IN ('aceitar', 'excluir', 'ignorar') THEN
    RAISE EXCEPTION 'Decisão inválida: %. Use aceitar/excluir/ignorar', p_decisao;
  END IF;
  SELECT * INTO v_evento FROM eventos_outlier WHERE id = p_evento_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Evento outlier % não encontrado', p_evento_id; END IF;
  IF v_evento.status != 'pendente' THEN RAISE EXCEPTION 'Evento já resolvido com status: %', v_evento.status; END IF;
  v_novo_status := CASE p_decisao WHEN 'aceitar' THEN 'aceito' WHEN 'excluir' THEN 'excluido' WHEN 'ignorar' THEN 'ignorado' END;
  UPDATE eventos_outlier SET status = v_novo_status, decidido_em = now(),
      decidido_por = p_usuario_email, justificativa_decisao = p_justificativa
  WHERE id = p_evento_id;
  IF p_decisao = 'excluir' THEN
    INSERT INTO observacoes_excluidas (
      empresa, sku_codigo_omie, tipo_observacao, data_observacao,
      referencia_original, valor_excluido, excluido_por, evento_outlier_id, justificativa
    ) VALUES (
      v_evento.empresa, v_evento.sku_codigo_omie,
      CASE WHEN v_evento.tipo = 'venda_atipica' THEN 'venda' ELSE 'leadtime' END,
      v_evento.data_evento,
      COALESCE(v_evento.detalhes->>'dedup_key', v_evento.detalhes->>'nfe',
               v_evento.detalhes->>'pedido_compra', v_evento.id::text),
      v_evento.valor_observado, p_usuario_email, v_evento.id, p_justificativa
    )
    ON CONFLICT (empresa, sku_codigo_omie, tipo_observacao, data_observacao, referencia_original)
    DO UPDATE SET valor_excluido = EXCLUDED.valor_excluido, excluido_por = EXCLUDED.excluido_por,
      justificativa = EXCLUDED.justificativa, excluido_em = now();
  END IF;
  RETURN jsonb_build_object('evento_id', p_evento_id, 'novo_status', v_novo_status, 'decisao', p_decisao);
END;
$function$;
SQL

# Sanidade do "antes": a função VELHA de fato grava. Se isto falhar, o stub está
# errado e todo o resto do teste vira teatro.
P -q <<'SQL'
INSERT INTO public.user_roles VALUES ('11111111-1111-1111-1111-111111111111','employee');
INSERT INTO public.eventos_outlier (id, empresa, sku_codigo_omie, tipo, severidade, data_evento, valor_observado, detalhes)
VALUES (901,'OBEN','5001','lt_atipico','atencao',DATE '2026-05-01', 40, '{"dedup_key":"nfe-aaa"}'::jsonb);
SET LOCAL test.uid = '11111111-1111-1111-1111-111111111111';
SELECT public.resolver_outlier(901,'excluir','one-off','tester@x');
SQL
eq "ANTES: a função velha gravava observacoes_excluidas" \
   "$(Pq -c "SELECT count(*) FROM public.observacoes_excluidas;")" "1"

# Limpa o resíduo do 'antes' — o invariante abaixo exige a tabela vazia.
P -q -c "DELETE FROM public.observacoes_excluidas; DELETE FROM public.eventos_outlier;"

echo "═══ aplicando a migration REAL ═══"
P -q -f "$REPO_ROOT/supabase/migrations/20260717020000_reposicao_exclusao_outlier_remover.sql"

P -q <<'SQL'
INSERT INTO public.eventos_outlier (id, empresa, sku_codigo_omie, tipo, severidade, data_evento, valor_observado, detalhes)
VALUES (1,'OBEN','5001','lt_atipico','atencao',DATE '2026-05-01', 40, '{"dedup_key":"nfe-aaa"}'::jsonb),
       (2,'OBEN','5002','venda_atipica','critico',DATE '2026-05-02', 500, '{"nfe":"nfe-bbb"}'::jsonb),
       (3,'OBEN','5003','lt_atipico','info',DATE '2026-05-03', 30, '{"dedup_key":"nfe-ccc"}'::jsonb);
SQL

# ── POSITIVO: 'aceitar' funciona e NÃO grava ─────────────────────────────────
P -q <<'SQL'
SET LOCAL test.uid = '11111111-1111-1111-1111-111111111111';
SELECT public.resolver_outlier(1,'aceitar','Vendas normais','tester@x');
SQL
eq "positivo: 'aceitar' marca o evento como aceito" \
   "$(Pq -c "SELECT status FROM public.eventos_outlier WHERE id=1;")" "aceito"
eq "positivo: 'aceitar' registra quem decidiu" \
   "$(Pq -c "SELECT decidido_por FROM public.eventos_outlier WHERE id=1;")" "tester@x"

# ── NEGATIVO: 'excluir' levanta a SQLSTATE ESPERADA e re-lança o resto ───────
# Nada de WHEN OTHERS THEN 'OK' — isso engoliria o erro real e ficaria verde à toa.
# A sentinela ('EXCLUIR_BARRADO') não repete o texto que o código emite (anti-teatro).
eq "negativo: 'excluir' é rejeitado com SQLSTATE 22023" "$(Pq <<'SQL'
SET LOCAL test.uid = '11111111-1111-1111-1111-111111111111';
DO $t$
BEGIN
  PERFORM public.resolver_outlier(2,'excluir','tenta excluir','tester@x');
  RAISE EXCEPTION 'FALHOU: excluir foi aceito';
EXCEPTION
  WHEN sqlstate '22023' THEN RAISE NOTICE 'EXCLUIR_BARRADO';
END $t$;
SELECT 'EXCLUIR_BARRADO';
SQL
)" "EXCLUIR_BARRADO"

eq "negativo: 'ignorar' também é rejeitado (22023)" "$(Pq <<'SQL'
SET LOCAL test.uid = '11111111-1111-1111-1111-111111111111';
DO $t$
BEGIN
  PERFORM public.resolver_outlier(3,'ignorar',NULL,'tester@x');
  RAISE EXCEPTION 'FALHOU: ignorar foi aceito';
EXCEPTION
  WHEN sqlstate '22023' THEN RAISE NOTICE 'IGNORAR_BARRADO';
END $t$;
SELECT 'IGNORAR_BARRADO';
SQL
)" "IGNORAR_BARRADO"

eq "negativo: evento rejeitado permanece PENDENTE (fail-closed, sem efeito parcial)" \
   "$(Pq -c "SELECT status FROM public.eventos_outlier WHERE id=2;")" "pendente"

# ── INVARIANTE: a tabela ficou SEM WRITER ────────────────────────────────────
eq "invariante: observacoes_excluidas continua VAZIA após todo o fluxo" \
   "$(Pq -c "SELECT count(*) FROM public.observacoes_excluidas;")" "0"
eq "invariante: nenhum caminho de código ainda cita observacoes_excluidas em resolver_outlier" \
   "$(Pq -c "SELECT (prosrc ILIKE '%observacoes_excluidas%')::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='resolver_outlier';")" "false"

# ── GATE preservado: não-staff segue barrado ────────────────────────────────
# psql é superuser e bypassaria RLS; aqui o gate é da própria função (has_role),
# então provamos trocando a GUC test.uid por um uid SEM role.
eq "gate: uid sem role staff → 42501" "$(Pq <<'SQL'
SET LOCAL test.uid = '99999999-9999-9999-9999-999999999999';
DO $t$
BEGIN
  PERFORM public.resolver_outlier(3,'aceitar',NULL,'intruso@x');
  RAISE EXCEPTION 'FALHOU: não-staff passou';
EXCEPTION
  WHEN sqlstate '42501' THEN RAISE NOTICE 'GATE_OK';
END $t$;
SELECT 'GATE_OK';
SQL
)" "GATE_OK"

eq "gate: auth.uid() NULL → 42501" "$(Pq <<'SQL'
DO $t$
BEGIN
  PERFORM public.resolver_outlier(3,'aceitar',NULL,'anon@x');
  RAISE EXCEPTION 'FALHOU: anônimo passou';
EXCEPTION
  WHEN sqlstate '42501' THEN RAISE NOTICE 'GATE_ANON_OK';
END $t$;
SELECT 'GATE_ANON_OK';
SQL
)" "GATE_ANON_OK"

echo
echo "═══ RESULTADO: $PASS ok · $FAIL falhas ═══"
[ "$FAIL" -eq 0 ] || exit 1
```

- [ ] **Step 2: Rodar o harness para ver falhar**

Run: `bash db/test-exclusao-outlier-removida.sh > /tmp/t1.log 2>&1; echo $?`
Expected: **exit ≠ 0**, com `/tmp/t1.log` acusando que a migration não existe (`No such file or directory` no `psql -f .../20260717020000_...sql`). É o vermelho correto: a prova existe antes da implementação.

- [ ] **Step 3: Escrever a migration**

Criar `supabase/migrations/20260717020000_reposicao_exclusao_outlier_remover.sql`:

```sql
-- Retirar a exclusão de outlier — a promessa era cosmética e não há efeito para ligar.
--
-- CONTEXTO: a tela oferecia "Excluir" afirmando "one-off, remove da estatística", com um
-- painel "σ atual → sem outlier". Nada disso acontecia: `observacoes_excluidas` não entra
-- em NENHUM ponto da cadeia que alimenta o motor
--   (v_sku_leadtime_estatisticas / v_sku_demanda_estatisticas → v_sku_parametros_sugeridos
--    → atualizar_parametros_numericos_skus → sku_parametros → gerar_pedidos_sugeridos_ciclo).
-- A tabela é lida por 2 funções apenas: este resolver (writer) e o anti-reflag de
-- detectar_outliers_empresa. Nenhuma view. Lacuna registrada como fora de escopo no #1357.
--
-- POR QUE RETIRAR EM VEZ DE LIGAR (medido em prod, read-only, antes de decidir):
--  • LEADTIME — excluir não move NADA. ss = ceil(z·sqrt(LT·σ_d² + d²·σ_LT²)): o termo do
--    leadtime é d²·σ_LT², e nos SKUs flagrados d é da ordem de 0,1/dia ⇒ ao quadrado,
--    esmaga o termo. Excluir derruba σ_LT pela metade ou mais (e baixa o LT médio) e
--    NEM ss NEM pp mudam — a queda efetiva em sigma_lt_d fica abaixo de 4% e o ceil()
--    come o resto. Quem domina a compra é o σ da DEMANDA (CV 3–5), não o leadtime.
--  • VENDA — excluir move DEMAIS: derruba `d`, que entra em pp = d·LT + … Efeito grande
--    aumenta o RISCO, não a legitimidade: um pedido que responde por boa parte da demanda
--    pode ser atípico e, ao mesmo tempo, o dado comercial mais importante da série.
--  • PREFERÊNCIA REVELADA — toda decisão humana já registrada nesta tela foi 'aceitar';
--    nenhuma exclusão jamais. E não é dado censurado: o 42703 afetava só o ramo de
--    leadtime; no de venda o painel de impacto FUNCIONAVA e mesmo assim a escolha foi
--    'aceitar' todas as vezes. 'ignorar' também nunca foi usado.
--
-- O QUE ESTA MIGRATION FAZ: `resolver_outlier` passa a aceitar somente 'aceitar' e para de
-- gravar `observacoes_excluidas`. Como a tabela NÃO TEM GRANT ALGUM para anon/authenticated/
-- service_role (conferido na prod), este SECURITY DEFINER era o ÚNICO caminho de escrita:
-- sem o INSERT, ela fica permanentemente vazia e sem writer. Isso é o ponto — gravar sob
-- semântica cosmética criaria ORDENS LATENTES que um filtro futuro aplicaria
-- RETROATIVAMENTE à compra. Um (A) futuro terá de introduzir semântica nova por migration
-- deliberada, em vez de herdar decisões velhas.
--
-- FORA DE ESCOPO, de propósito (spec §4.1): não dropa `observacoes_excluidas` (o anti-reflag
-- do detector a lê; NOT EXISTS sobre tabela vazia é inócuo), não toca
-- `detectar_outliers_empresa` (função quente, recém-aplicada pelo #1357), não dropa
-- `estimar_impacto_exclusao_outlier` (só COMMENT — migration e Publish do Lovable são
-- manuais e independentes; DROP com Publish atrasado quebraria o card em produção).
--
-- Base: pg_get_functiondef da PROD em 2026-07-16 (pós-#1357). Diferenças para o repo eram
-- só de comentário. Único delta funcional aqui: o gate de decisão e o INSERT.
-- Prova: db/test-exclusao-outlier-removida.sh (PG17, asserts + falsificação).
-- Spec: docs/superpowers/specs/2026-07-16-reposicao-exclusao-outlier-escopo-design.md

CREATE OR REPLACE FUNCTION public.resolver_outlier(p_evento_id bigint, p_decisao text, p_justificativa text DEFAULT NULL::text, p_usuario_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_evento RECORD;
BEGIN
  -- Gate de staff: byte-a-byte o da prod.
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  -- 'aceitar' é a única decisão. Rejeição EXPLÍCITA (não normalizar silenciosamente para
  -- 'aceitar'): na janela entre o apply e o Publish, a tela velha ainda mostra os botões
  -- antigos — ela tem de FALHAR FECHADA em vez de gravar sob semântica que não existe mais.
  -- ERRCODE explícito para o teste negativo capturar a condição certa e re-lançar o resto.
  IF p_decisao <> 'aceitar' THEN
    RAISE EXCEPTION 'Decisão inválida: %. Esta tela é de revisão: a observação permanece no cálculo — use aceitar.', p_decisao
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_evento FROM eventos_outlier WHERE id = p_evento_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento outlier % não encontrado', p_evento_id;
  END IF;
  IF v_evento.status != 'pendente' THEN
    RAISE EXCEPTION 'Evento já resolvido com status: %', v_evento.status;
  END IF;

  UPDATE eventos_outlier
  SET status = 'aceito', decidido_em = now(),
      decidido_por = p_usuario_email, justificativa_decisao = p_justificativa
  WHERE id = p_evento_id;

  RETURN jsonb_build_object('evento_id', p_evento_id, 'novo_status', 'aceito', 'decisao', p_decisao);
END;
$function$;

COMMENT ON FUNCTION public.resolver_outlier(bigint, text, text, text) IS
  'Registra a revisão humana de um evento de outlier. ACEITAR é a única decisão: a '
  'observação permanece no cálculo. ''excluir'' e ''ignorar'' foram REMOVIDOS (2026-07-16). '
  '''excluir'' nunca alcançou o motor (observacoes_excluidas não entra na cadeia de '
  'estatística) e, medido em prod, não há efeito para ligar no leadtime (ss/pp invariantes); '
  'no lado da venda o efeito seria grande demais para um botão sem gate. ''ignorar'' '
  'arquivava igual a ''aceitar'' e nunca foi usado. '
  'Spec: docs/superpowers/specs/2026-07-16-reposicao-exclusao-outlier-escopo-design.md';

COMMENT ON TABLE public.observacoes_excluidas IS
  'SEM WRITER desde 2026-07-16 — permanece vazia. Lida apenas pelo anti-reflag de '
  'detectar_outliers_empresa, onde o NOT EXISTS sobre tabela vazia é inócuo. NÃO '
  'reintroduzir escrita sem migration deliberada: gravar aqui sob semântica cosmética cria '
  'ordens latentes que um filtro futuro aplicaria retroativamente à compra. '
  'Spec: docs/superpowers/specs/2026-07-16-reposicao-exclusao-outlier-escopo-design.md';

COMMENT ON FUNCTION public.estimar_impacto_exclusao_outlier(bigint) IS
  'DEPRECADA (2026-07-16) — sem chamador. Estimava o impacto de uma exclusão que nunca '
  'alcançou o motor. NÃO usar como fonte de número: (a) a fórmula diverge da do motor '
  '(z fixo 1.65 × z por classe; sigma por-venda × sigma diário; 180d × 90d), (b) '
  'COALESCE(sigma,0) fabrica zero quando o desvio é desconhecido (viola ausente != zero), '
  '(c) não trata sku_inativado_omie/sku_reativado_omie — cai no ramo de leadtime, não acha '
  'dedup_key e devolve error, que a tela exibia como "Calculando..." para sempre. '
  'DROP pendente de faxina após o Publish confirmado. '
  'Spec: docs/superpowers/specs/2026-07-16-reposicao-exclusao-outlier-escopo-design.md';
```

- [ ] **Step 4: Rodar o harness para ver passar**

Run: `bash db/test-exclusao-outlier-removida.sh > /tmp/t1.log 2>&1; echo $?`
Expected: **exit 0**, com 9 linhas `✅` e `RESULTADO: 9 ok · 0 falhas`.

- [ ] **Step 5: Falsificar — provar que os asserts têm dente**

Sabotar a migration de propósito e exigir vermelho. Reintroduzir o INSERT temporariamente: no arquivo da migration, trocar

```sql
  IF p_decisao <> 'aceitar' THEN
```
por
```sql
  IF p_decisao NOT IN ('aceitar','excluir') THEN
```

Run: `bash db/test-exclusao-outlier-removida.sh > /tmp/t1-sabotado.log 2>&1; echo $?`
Expected: **exit 1**, com `❌ negativo: 'excluir' é rejeitado com SQLSTATE 22023`. Se ficar verde, o assert é teatro e o teste está errado — corrigir antes de seguir.

Depois **reverter a sabotagem** (voltar para `IF p_decisao <> 'aceitar' THEN`) e rodar de novo:
Run: `bash db/test-exclusao-outlier-removida.sh > /tmp/t1.log 2>&1; echo $?`
Expected: **exit 0**.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260717020000_reposicao_exclusao_outlier_remover.sql db/test-exclusao-outlier-removida.sh
git commit -m "fix(reposicao): resolver_outlier deixa de aceitar 'excluir' — tabela sem writer [money-path]

A exclusao prometia remover a observacao da estatistica e nunca alcancou o
motor. Medido em prod: no leadtime nao ha efeito para ligar (ss/pp invariantes,
o termo d^2*sigma_lt^2 e' esmagado por LT*sigma_d^2); na venda o efeito seria
grande demais para um botao sem gate. Toda decisao humana ja registrada foi
'aceitar'.

observacoes_excluidas nao tem grant algum, entao este SECURITY DEFINER era o
unico caminho de escrita: sem o INSERT ela fica sem writer. Esse e' o ponto —
gravar sob semantica cosmetica criaria ordens latentes que um filtro futuro
aplicaria retroativamente a' compra.

Rejeicao explicita (22023) em vez de normalizar para 'aceitar': na janela entre
o apply e o Publish a tela velha tem de falhar FECHADA.

Prova: db/test-exclusao-outlier-removida.sh (PG17, 9 asserts + falsificacao).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Frontend — remover a ação de excluir

**Files:**
- Modify: `src/components/reposicao/alertas/types.ts:50-63`
- Modify: `src/pages/AdminReposicaoAlertas.tsx` (query de impacto ~162-174; `resolverMut` ~239-273; render ~318-365)
- Modify: `src/components/reposicao/alertas/AlertaDrillSheet.tsx`
- Modify: `src/components/reposicao/alertas/ConfirmacaoDialog.tsx`
- Modify: `src/components/reposicao/alertas/AlertasFiltros.tsx`
- Modify: `src/components/reposicao/alertas/__tests__/ConfirmacaoDialog.test.tsx`

**Interfaces:**
- Consumes: `resolver_outlier` da Task 1 — só `p_decisao: "aceitar"`.
- Produces: `AcaoConfirm = { lote: boolean }` (o campo `tipo` some — não distingue mais nada e ninguém o lê). `AlertaDrillSheet` passa a receber `mediaLt?: number | null` no lugar de `impacto`; `onAcao: () => void` (sem parâmetro). `AlertasFiltros` perde a prop `onExcluirLote`. `ImpactoData` deixa de existir.

- [ ] **Step 1: Atualizar o teste do ConfirmacaoDialog (o que assere a mentira cai)**

Em `src/components/reposicao/alertas/__tests__/ConfirmacaoDialog.test.tsx`, substituir o arquivo inteiro:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmacaoDialog } from "../ConfirmacaoDialog";

function noop() { /* */ }

describe("ConfirmacaoDialog", () => {
  it("fechado (acaoConfirm=null) → não renderiza", () => {
    render(<ConfirmacaoDialog acaoConfirm={null} onClose={noop} selecionadosCount={0} justificativa="" setJustificativa={noop} onConfirm={noop} isPending={false} />);
    expect(screen.queryByText(/Confirmar/)).toBeNull();
  });

  it("lote → título, contagem e Confirmar dispara onConfirm", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmacaoDialog
        acaoConfirm={{ lote: true }}
        onClose={noop}
        selecionadosCount={4}
        justificativa=""
        setJustificativa={noop}
        onConfirm={onConfirm}
        isPending={false}
      />
    );
    expect(screen.getByText(/Marcar 4 alerta\(s\) como revisado\(s\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar/ }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("individual → descreve revisão, sem prometer efeito no cálculo", () => {
    render(
      <ConfirmacaoDialog
        acaoConfirm={{ lote: false }}
        onClose={noop}
        selecionadosCount={0}
        justificativa=""
        setJustificativa={noop}
        onConfirm={noop}
        isPending={false}
      />
    );
    expect(screen.getByText(/permanece no cálculo/)).toBeTruthy();
  });

  // Guarda de regressão: a promessa falsa não pode voltar. Havia um teste VERDE
  // (`expect(getByText(/remove os eventos do cálculo estatístico/)).toBeTruthy()`)
  // que institucionalizava a mentira — a tela afirmava um efeito que o motor nunca viu.
  it("não promete remover do cálculo nem recálculo automático", () => {
    render(
      <ConfirmacaoDialog
        acaoConfirm={{ lote: true }}
        onClose={noop}
        selecionadosCount={2}
        justificativa=""
        setJustificativa={noop}
        onConfirm={noop}
        isPending={false}
      />
    );
    expect(screen.queryByText(/remove os eventos do cálculo/)).toBeNull();
    expect(screen.queryByText(/recálculo automático/)).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar o teste para ver falhar**

Run: `heavy bun run test -- src/components/reposicao/alertas/__tests__/ConfirmacaoDialog.test.tsx > /tmp/t2.log 2>&1; echo $?`
Expected: **exit ≠ 0** — TS reclama que `tipo: "aceitar"` não casa mais e/ou os textos novos não existem no componente.

- [ ] **Step 3: `types.ts` — tirar `excluir`/`ignorar` e `ImpactoData`**

Em `src/components/reposicao/alertas/types.ts`, **remover** o bloco `ImpactoData` (linhas ~50-59):

```ts
export type ImpactoData = {
  error?: string;
  media_atual?: number | null;
  media_sem?: number | null;
  sigma_atual?: number | null;
  sigma_sem?: number | null;
  em_atual?: number | null;
  em_sem?: number | null;
  delta_em?: number;
} | null;
```

E **substituir** `AcaoConfirm` (linha ~63):

```ts
export type AcaoConfirm = { tipo: "aceitar" | "excluir" | "ignorar"; lote: boolean };
```
por:
```ts
// Sem `tipo`: 'aceitar' virou a única decisão, então o campo não distingue mais nada e
// ninguém o lê. 'excluir' saiu (prometia remover da estatística e nunca alcançou o motor —
// spec 2026-07-16); 'ignorar' saiu junto (arquivava igual a 'aceitar' e nunca foi usado).
// Resta só o que ainda decide layout e alvo: se a confirmação é de lote ou individual.
export type AcaoConfirm = { lote: boolean };
```

- [ ] **Step 4: `ConfirmacaoDialog.tsx` — texto honesto**

Substituir o arquivo inteiro:

```tsx
// Dialog de confirmação da revisão de um alerta de outlier.
// Extraído de src/pages/AdminReposicaoAlertas.tsx (god-component split).
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import type { AcaoConfirm } from "./types";

export function ConfirmacaoDialog({
  acaoConfirm, onClose, selecionadosCount, justificativa, setJustificativa, onConfirm, isPending,
}: {
  acaoConfirm: AcaoConfirm | null;
  onClose: () => void;
  selecionadosCount: number;
  justificativa: string;
  setJustificativa: (s: string) => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={!!acaoConfirm} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {acaoConfirm?.lote
              ? `Marcar ${selecionadosCount} alerta(s) como revisado(s)`
              : "Marcar alerta como revisado"}
          </DialogTitle>
          <DialogDescription>
            {acaoConfirm?.lote && "Críticos não estão incluídos. "}
            A observação permanece no cálculo — esta tela registra a revisão, não altera parâmetros de reposição.
          </DialogDescription>
        </DialogHeader>
        {acaoConfirm?.lote && (
          <div>
            <Label className="text-xs">Justificativa em lote (opcional)</Label>
            <Textarea rows={2} value={justificativa} onChange={(e) => setJustificativa(e.target.value)} />
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={onConfirm} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Rodar o teste do dialog para ver passar**

Run: `heavy bun run test -- src/components/reposicao/alertas/__tests__/ConfirmacaoDialog.test.tsx > /tmp/t2.log 2>&1; echo $?`
Expected: **exit 0**, 4 testes passando.

- [ ] **Step 6: `AlertasFiltros.tsx` — tirar o excluir-em-lote**

Remover a prop `onExcluirLote` da assinatura do componente e o botão. Substituir o bloco:

```tsx
            <Button size="sm" variant="default" onClick={onAceitarLote}>
              <CheckCircle2 className="h-4 w-4 mr-1" /> Aceitar selecionados
            </Button>
            <Button size="sm" variant="destructive" onClick={onExcluirLote}>
              <XCircle className="h-4 w-4 mr-1" /> Excluir selecionados
            </Button>
```
por:
```tsx
            <Button size="sm" variant="default" onClick={onAceitarLote}>
              <CheckCircle2 className="h-4 w-4 mr-1" /> Marcar como revisados
            </Button>
```

Remover `onExcluirLote: () => void;` do bloco de props e remover `XCircle` do import de `lucide-react` se não houver outro uso no arquivo (conferir com `grep -n "XCircle" src/components/reposicao/alertas/AlertasFiltros.tsx` antes de remover — deixar um import órfão quebra o lint).

O `<SelectItem value="excluido">Excluído</SelectItem>` do filtro de status **FICA**: `detectar_skus_sem_grupo` continua gravando esse status por sistema e o histórico precisa ser filtrável.

- [ ] **Step 7: `AlertaDrillSheet.tsx` — sai o card 4, resta 1 botão**

Trocar o import de tipos (remove `ImpactoData`):
```tsx
import { tipoLabel, fmt, type EventoOutlier, type SkuInfo, type ImpactoData, type GrupoRow } from "./types";
```
por
```tsx
import { tipoLabel, fmt, type EventoOutlier, type SkuInfo, type GrupoRow } from "./types";
```

Na assinatura do componente, trocar `impacto?: ImpactoData;` por `mediaLt?: number | null;` e `onAcao: (tipo: "aceitar" | "excluir" | "ignorar") => void;` por `onAcao: () => void;`. Idem no bloco de destructuring dos props (`impacto` → `mediaLt`).

Na `ReferenceLine` do gráfico de leadtime, trocar:
```tsx
                            {impacto?.media_atual != null && (
                              <ReferenceLine y={impacto.media_atual} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                            )}
```
por:
```tsx
                            {/* Média derivada do MESMO histórico que desenha os pontos. Antes vinha
                                da RPC estimar_impacto_exclusao_outlier, cuja janela e fórmula divergiam
                                do que o gráfico plota — e que sai junto com o card de impacto. */}
                            {mediaLt != null && (
                              <ReferenceLine y={mediaLt} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                            )}
```

**Remover inteiro** o bloco `{/* Seção 4 - Impacto (não aplicável a sku_sem_grupo) */}` (o `<Card>` com `4. Impacto se excluir`, linhas ~115-138).

Substituir a Seção 5 (decisão) inteira por:

```tsx
              {/* Seção 4 - Revisão (oculta para sku_sem_grupo, que tem fluxo próprio acima) */}
              {!isSemGrupo && drillEvento.status === "pendente" && (
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">4. Revisão</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <Label className="text-xs">Justificativa (opcional)</Label>
                      <Textarea
                        rows={2}
                        value={justificativa}
                        onChange={(e) => setJustificativa(e.target.value)}
                        placeholder="Ex: pedido excepcional cliente X, não se repete"
                      />
                    </div>
                    <Button className="w-full" onClick={() => onAcao()}>
                      <CheckCircle2 className="h-4 w-4 mr-1" /> Marcar como revisado
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Esta tela é de <strong>revisão</strong>: o alerta sai da fila e a observação
                      permanece no cálculo. Os parâmetros de reposição não são alterados por aqui.
                    </p>
                  </CardContent>
                </Card>
              )}
```

Ajustar o título da seção do gráfico de `3. Histórico` — permanece `3. Histórico` (a numeração fecha: 1 Contexto, 2 Dados do SKU, 3 Histórico, 4 Revisão).

Remover do import de `lucide-react` os ícones que ficaram sem uso: `XCircle` e `EyeOff` (conferir com `grep -n "XCircle\|EyeOff" src/components/reposicao/alertas/AlertaDrillSheet.tsx`). `Badge` também fica órfã se não houver outro uso — conferir antes de remover o import.

- [ ] **Step 8: `AdminReposicaoAlertas.tsx` — sai a query de impacto, entra `mediaLt`**

Remover `type ImpactoData` do import de tipos (linha ~11).

**Remover inteira** a query `impacto` (linhas ~162-174):
```tsx
  // Impacto previsto
  const { data: impacto } = useQuery<ImpactoData>({ ... });
```

Adicionar, logo depois da query `historico`, a média derivada do próprio histórico:

```tsx
  // Média do LT para a linha de referência do gráfico. Derivada do MESMO histórico que
  // desenha os pontos — antes vinha da RPC estimar_impacto_exclusao_outlier (removida do
  // fluxo), cuja fórmula e janela divergiam do que o gráfico plota.
  const mediaLt = useMemo(() => {
    if (drillEvento?.tipo === "venda_atipica") return null;
    const rows = (historico as Array<{ lt: number }> | null) ?? [];
    if (rows.length === 0) return null;
    return rows.reduce((acc, r) => acc + r.lt, 0) / rows.length;
  }, [historico, drillEvento?.tipo]);
```

No `resolverMut`, **remover** o recálculo pós-exclusão (linhas ~252-259):
```tsx
      // Recálculo automático após exclusão
      if (decisao === "excluir") {
        try {
          await supabase.rpc("atualizar_parametros_numericos_skus", { p_empresa: empresa });
        } catch (e) {
          console.warn("Recálculo falhou:", e);
        }
      }
```
(Era teatro: recalculava sobre a mesma base, sem relação com a decisão. O `atualizar_parametros_numericos_skus` do fluxo de `sku_sem_grupo`, na `atribuirGrupoMut` ~linha 223, **FICA** — ali o LT realmente muda ao classificar o SKU no grupo.)

Trocar a assinatura da mutation e o toast:
```tsx
    mutationFn: async ({ ids, decisao, just }: { ids: number[]; decisao: string; just: string }) => {
```
por
```tsx
    mutationFn: async ({ ids, just }: { ids: number[]; just: string }) => {
```
e dentro dela, a chamada passa `p_decisao: "aceitar"` fixo:
```tsx
        const { data, error } = await supabase.rpc("resolver_outlier", {
          p_evento_id: id,
          p_decisao: "aceitar",
          p_justificativa: just || undefined,
          p_usuario_email: user?.email || undefined,
        });
```

O `onSuccess` perde o ternário de decisão:
```tsx
    onSuccess: (_, vars) => {
      toast.success(`${vars.ids.length} alerta(s) marcado(s) como revisado(s)`);
```

Se `empresa` ficar sem uso após remover o recálculo, o lint acusa — conferir com `grep -n "empresa" src/pages/AdminReposicaoAlertas.tsx` e remover do destructuring do `useReposicaoEmpresa()` só se realmente não houver outro uso.

`executarAcao` perde o `decisao`:
```tsx
  const executarAcao = () => {
    if (!acaoConfirm) return;
    const ids = acaoConfirm.lote ? Array.from(selecionados) : drillEvento ? [drillEvento.id] : [];
    if (ids.length === 0) return;
    resolverMut.mutate({ ids, just: justificativa });
  };
```

No render, remover a prop `onExcluirLote` do `<AlertasFiltros>` e trocar `onAceitarLote`:
```tsx
        onAceitarLote={() => setAcaoConfirm({ tipo: "aceitar", lote: true })}
        onExcluirLote={() => setAcaoConfirm({ tipo: "excluir", lote: true })}
```
por
```tsx
        onAceitarLote={() => setAcaoConfirm({ lote: true })}
```

E trocar as props do `<AlertaDrillSheet>`:
```tsx
        impacto={impacto}
```
por
```tsx
        mediaLt={mediaLt}
```
e
```tsx
        onAcao={(tipo) => setAcaoConfirm({ tipo, lote: false })}
```
por
```tsx
        onAcao={() => setAcaoConfirm({ lote: false })}
```

- [ ] **Step 9: Typecheck + lint + suíte cheia**

Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo $?`
Expected: **exit 0**. Se acusar `ImpactoData` ou `AcaoConfirm`, sobrou referência — o log aponta o arquivo e a linha.

Run: `bun lint > /tmp/lint.log 2>&1; echo $?`
Expected: **exit 0**. Erro típico aqui é import órfão (`XCircle`, `EyeOff`, `Badge`, `ImpactoData`).

Run: `heavy bun run test -- src/components/reposicao/alertas > /tmp/t2.log 2>&1; echo $?`
Expected: **exit 0** — `ConfirmacaoDialog`, `StatsCards` e `badges` verdes (os dois últimos não deviam ter mudado; se quebraram, algo saiu que não devia sair).

- [ ] **Step 10: Commit**

```bash
git add src/pages/AdminReposicaoAlertas.tsx src/components/reposicao/alertas/
git commit -m "fix(reposicao): tela de alertas para de prometer que excluir muda o calculo

Somem o botao Excluir, o excluir-em-lote e o card 'Impacto se excluir'. Resta
'Marcar como revisado': o alerta sai da fila, a observacao permanece no calculo.

O card carregava 3 defeitos alem da promessa vazia: formula divergente da do
motor (z fixo 1.65 x z por classe; sigma por-venda x diario; 180d x 90d),
COALESCE(sigma,0) fabricando zero (viola ausente != zero), e 'Calculando...'
eterno — que era o estado NORMAL dos alertas sku_inativado_omie/sku_reativado_omie,
tipos que a RPC nem trata.

A linha de media do grafico de leadtime passa a sair do proprio historico que
desenha os pontos, em vez da RPC de impacto (cuja janela divergia do plotado).

Sai tambem o recalculo pos-exclusao: rodava sobre a mesma base, sem relacao com
a decisao. O recalculo do fluxo sku_sem_grupo FICA (ali o LT muda de verdade).

Badge/filtro/contador 'Excluido' FICAM: detectar_skus_sem_grupo ainda grava esse
status por sistema no auto-resolve.

Guarda de regressao no lugar do teste que assertava a mentira.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Lição durável em `docs/agent/reposicao.md`

**Files:**
- Modify: `docs/agent/reposicao.md` (seção `## Outras frentes`)

**Interfaces:**
- Consumes: as decisões das Tasks 1 e 2.
- Produces: nada de código — resíduo documental que impede reabrir a frente.

- [ ] **Step 1: Acrescentar a entrada**

Ao final da seção `## Outras frentes` de `docs/agent/reposicao.md`, acrescentar:

```markdown
- ⚠️ **[2026-07-16 · Claude+Codex xhigh] Exclusão de outlier RETIRADA — não reabrir sem os DOIS fatos novos.** A tela prometia "Excluir: one-off, remove da estatística" + painel "σ atual → sem outlier", mas `observacoes_excluidas` não entra em ponto algum da cadeia do motor (`v_sku_leadtime_estatisticas`/`v_sku_demanda_estatisticas` → `v_sku_parametros_sugeridos` → `atualizar_parametros_numericos_skus` → `sku_parametros` → motor); é lida só por `resolver_outlier` (writer) e pelo anti-reflag do `detectar_outliers_empresa`. **Medido antes de decidir:** (a) **no LEADTIME excluir não move NADA** — `ss = ceil(z·sqrt(LT·σ_d² + d²·σ_LT²))`; o termo do LT é `d²·σ_LT²` e nos SKUs flagrados `d`≈0,1/dia ⇒ ao quadrado esmaga o termo: excluir derruba σ_LT pela metade ou mais (e baixa o LT médio) e **ss e pp ficam idênticos** (queda efetiva em `sigma_lt_d` <4%; o `ceil()` come o resto). **Quem domina a compra é o σ da DEMANDA (CV 3–5), não o leadtime** — corolário que vale para QUALQUER frente que mire o leadtime. (b) **na VENDA excluir move demais** (derruba `d`, que entra em `pp = d·LT + …`, em até ~80%): efeito grande **aumenta o risco, não a legitimidade** — um pedido que responde por boa parte da demanda pode ser atípico E ser o dado comercial mais importante da série. (c) **cascata/outlier-chasing NÃO existe**: zero instâncias, e há teto matemático `z_max=(n−1)/√n` (nada cruza 2σ com n<6, nem 3σ com n<11) — a tese estava errada e foi a MEDIÇÃO que mostrou. (d) **preferência revelada:** toda decisão humana já registrada foi `aceitar`, nenhuma exclusão jamais — e **não é dado censurado** (o 42703 afetava só o ramo de leadtime; no de venda o painel funcionava e a escolha foi `aceitar` mesmo assim). **Fix:** `resolver_outlier` só aceita `'aceitar'` e parou de gravar — e como `observacoes_excluidas` **não tem grant algum**, o SECURITY DEFINER era o ÚNICO caminho de escrita ⇒ tabela sem writer. Isso é o ponto: gravar sob semântica cosmética criaria **ordens latentes** que um filtro futuro aplicaria **retroativamente** à compra. ⚠️ Ligar a exclusão ao motor seria **recalibrar a fórmula pela porta dos fundos**, um SKU por vez, sem medição nem fusível — a frente que a §Mínimo forçado já fechou. Reabrir só com exclusões humanas reais E repetidas **E** impacto downstream material (hoje temos o oposto dos dois). **Dívida deixada de propósito:** `estimar_impacto_exclusao_outlier` ficou órfã com `COMMENT` de deprecada (DROP só após Publish confirmado — migration e Publish do Lovable são independentes) e carrega 3 bugs se alguém a chamar: fórmula ≠ motor, `COALESCE(σ,0)` fabricando zero, e nenhum ramo para `sku_*_omie`. Spec `docs/superpowers/specs/2026-07-16-reposicao-exclusao-outlier-escopo-design.md` · migration `20260717020000` · prova `db/test-exclusao-outlier-removida.sh`.
```

- [ ] **Step 2: Conferir o tamanho do CLAUDE.md (o CI vigia)**

Run: `bun run claude:size > /tmp/size.log 2>&1; echo $?`
Expected: **exit 0**. O `CLAUDE.md` não foi tocado (a lição foi para `docs/agent/`, que é o destino correto pela política do repo) — este passo só confirma que nada vazou para lá.

- [ ] **Step 3: Commit**

```bash
git add docs/agent/reposicao.md
git commit -m "docs(reposicao): licao — excluir outlier de leadtime nao move a compra

Registra o que foi medido para a frente nao ser reaberta: o termo d^2*sigma_lt^2
e' esmagado por LT*sigma_d^2 nos intermitentes (d~0.1, CV 3-5), entao mexer no
leadtime nao move ss nem pp — quem domina e' o sigma da DEMANDA. Vale para
qualquer frente que mire o leadtime, nao so' para a exclusao.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Handoff de deploy (para o founder)

Ao abrir o PR, o corpo deve trazer (o auto-merge só cobre o merge; **merge ≠ produção**):

1. **SQL Editor do Lovable** — colar `supabase/migrations/20260717020000_reposicao_exclusao_outlier_remover.sql`.
2. **Publish** do frontend no editor do Lovable.
3. **Validação pós-apply** (roda por `psql-ro`, sem o founder):
```sql
-- 1. a função não cita mais a tabela  → esperado: false
SELECT prosrc ILIKE '%observacoes_excluidas%' FROM pg_proc p
JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='resolver_outlier';
-- 2. a tabela segue vazia → esperado: 0
SELECT count(*) FROM public.observacoes_excluidas;
-- 3. os COMMENTs entraram → esperado: 3 linhas não-nulas
SELECT obj_description('public.resolver_outlier(bigint,text,text,text)'::regprocedure) IS NOT NULL,
       obj_description('public.estimar_impacto_exclusao_outlier(bigint)'::regprocedure) IS NOT NULL,
       obj_description('public.observacoes_excluidas'::regclass) IS NOT NULL;
```
