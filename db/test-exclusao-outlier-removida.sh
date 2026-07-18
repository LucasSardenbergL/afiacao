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

-- Stub mínimo só para o 3º COMMENT da migration não abortar o apply. Na prod esta
-- função EXISTE (é a estimar_impacto que a própria migration deprecia via COMMENT);
-- aqui ela não é exercida — só precisa existir para `COMMENT ON FUNCTION` casar a
-- assinatura. Provar a migration INTEIRA (os 3 COMMENTs inclusos) é o ponto.
CREATE OR REPLACE FUNCTION public.estimar_impacto_exclusao_outlier(p_evento_id bigint)
RETURNS jsonb LANGUAGE sql AS $f$ SELECT '{}'::jsonb $f$;
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
SET test.uid = '11111111-1111-1111-1111-111111111111';
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
SET test.uid = '11111111-1111-1111-1111-111111111111';
SELECT public.resolver_outlier(1,'aceitar','Vendas normais','tester@x');
SQL
eq "positivo: 'aceitar' marca o evento como aceito" \
   "$(Pq -c "SELECT status FROM public.eventos_outlier WHERE id=1;")" "aceito"
eq "positivo: 'aceitar' registra quem decidiu" \
   "$(Pq -c "SELECT decidido_por FROM public.eventos_outlier WHERE id=1;")" "tester@x"

# ── NEGATIVO: 'excluir' levanta a SQLSTATE ESPERADA e re-lança o resto ───────
# Nada de WHEN OTHERS THEN 'OK' — isso engoliria o erro real e ficaria verde à toa.
# A sentinela ('EXCLUIR_BARRADO') não repete o texto que o código emite (anti-teatro).
eq "negativo: 'excluir' é rejeitado com SQLSTATE 22023" "$(Pq -q <<'SQL'
SET test.uid = '11111111-1111-1111-1111-111111111111';
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

eq "negativo: 'ignorar' também é rejeitado (22023)" "$(Pq -q <<'SQL'
SET test.uid = '11111111-1111-1111-1111-111111111111';
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
eq "gate: uid sem role staff → 42501" "$(Pq -q <<'SQL'
SET test.uid = '99999999-9999-9999-9999-999999999999';
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

eq "gate: auth.uid() NULL → 42501" "$(Pq -q <<'SQL'
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
