#!/usr/bin/env bash
# Valida 20260605130000_tarefas_leitura_na_instancia.sql num Postgres 17 descartável.
# Prova: (1) a migration APLICA limpa (view DROP+CREATE verbatim + materializador reproduzidos
# sem typo); (2) o backfill copia a faixa do template p/ a instância aberta; (3) a view EXPÕE
# leitura_* (b.* re-expandido); (4) o materializador copia leitura_* nas novas instâncias.
set -euo pipefail

PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5437
DATA="$(mktemp -d /tmp/pgtest-leitura.XXXXXX)/data"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-leitura.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres leitura_test
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d leitura_test "$@"; }

# 1) Schema mínimo que a migration referencia (estado PRÉ-UI3: tarefas SEM leitura_*)
P -v ON_ERROR_STOP=1 -q <<'SQL'
create table public.profiles (user_id uuid primary key);
create table public.calendario_feriados (data date primary key);
create table public.carteira_coverage (
  covered_user_id uuid, covering_user_id uuid, active boolean,
  valid_from timestamptz, valid_until timestamptz
);
create table public.tarefa_eventos (
  id bigint generated always as identity primary key,
  tarefa_id bigint, tipo_evento text, ator uuid, payload jsonb
);
create table public.tarefa_templates (
  id bigint primary key,
  descricao text, categoria text, customer_user_id uuid, assigned_to uuid, created_by uuid,
  empresa text, cadencia text, dias_semana int[], janela_fim time, tolerancia_dias int,
  requer_comprovacao boolean, tipo_comprovacao text, leitura_min numeric, leitura_max numeric,
  leitura_unidade text, supervisor_user_id uuid, ativo boolean
);
create table public.tarefas (
  id bigint generated always as identity primary key,
  descricao text, categoria text, customer_user_id uuid, assigned_to uuid, created_by uuid,
  empresa text, modo text, due_date date, backstop_days int default 7, tolerancia_dias int default 0,
  auto_satisfy_mode text, status text default 'aberta', template_id bigint,
  requer_comprovacao boolean, tipo_comprovacao text, janela_fim time, supervisor_user_id uuid,
  auditoria_status text default 'nao_requer', adiada_para timestamptz, escalado_em timestamptz,
  created_at timestamptz default now()
);
create table public.tarefa_satisfacao_candidatos (tarefa_id bigint, status text);

-- assignee com perfil (materializador não pula)
insert into public.profiles values ('11111111-1111-1111-1111-111111111111');

-- template de LEITURA, diário, ativo, faixa 7,0–7,5 pH
insert into public.tarefa_templates
  (id, descricao, categoria, assigned_to, created_by, empresa, cadencia, dias_semana, janela_fim,
   tolerancia_dias, requer_comprovacao, tipo_comprovacao, leitura_min, leitura_max, leitura_unidade, ativo)
values
  (1, 'Medir pH do tanque', 'outro', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-111111111111', 'oben', 'diaria', null, '17:00', 1,
   true, 'leitura', 7.0, 7.5, 'pH', true);

-- instância ABERTA de leitura no PASSADO (due_date distinto de hoje), SEM leitura_* (col não existe ainda)
insert into public.tarefas
  (descricao, categoria, assigned_to, created_by, empresa, modo, due_date, status, template_id,
   requer_comprovacao, tipo_comprovacao, janela_fim)
values
  ('Medir pH do tanque', 'outro', '11111111-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-111111111111', 'oben', 'data', current_date - 3, 'aberta', 1,
   true, 'leitura', '17:00');
SQL

echo "=== aplicando a migration UI-3 (20260605130000) ==="
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260605130000_tarefas_leitura_na_instancia.sql"

echo ""
echo "ASSERTS:"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE n int; mn numeric; un text; vmn numeric;
BEGIN
  -- A1: colunas criadas na instância
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_name='tarefas' AND column_name IN ('leitura_min','leitura_max','leitura_unidade');
  ASSERT n = 3, format('A1 esperava 3 colunas novas, veio %s', n);

  -- A2: backfill copiou a faixa do template p/ a instância aberta
  SELECT leitura_min, leitura_unidade INTO mn, un FROM public.tarefas WHERE template_id = 1 AND due_date = current_date - 3;
  ASSERT mn = 7.0 AND un = 'pH', format('A2 backfill esperava 7.0/pH, veio %s/%s', mn, un);

  -- A3: a view EXPÕE leitura_* (b.* re-expandido)
  SELECT leitura_min INTO vmn FROM public.v_tarefas_estado WHERE template_id = 1 AND due_date = current_date - 3;
  ASSERT vmn = 7.0, format('A3 view deveria expor leitura_min=7.0, veio %s', vmn);

  RAISE NOTICE 'A1..A3 OK: colunas + backfill + view expõe a faixa';

  -- A4: materializador copia leitura_* nas instâncias de HOJE
  PERFORM public.tarefas_materializar_recorrentes();
  SELECT leitura_min, leitura_unidade INTO mn, un FROM public.tarefas
    WHERE template_id = 1 AND due_date = current_date;
  ASSERT mn = 7.0 AND un = 'pH', format('A4 materializador esperava copiar 7.0/pH p/ hoje, veio %s/%s', mn, un);

  -- A5: a instância de hoje também aparece com a faixa na view
  SELECT leitura_min INTO vmn FROM public.v_tarefas_estado WHERE template_id = 1 AND due_date = current_date;
  ASSERT vmn = 7.0, format('A5 view (hoje) esperava 7.0, veio %s', vmn);

  RAISE NOTICE 'A4..A5 OK: materializador copia a faixa + view expõe nas novas instâncias';
END $$;
SQL

echo ""
echo "TODOS OS ASSERTS PASSARAM ✅  (UI-3: faixa na instância — sem gap de RLS de cobertura)"
