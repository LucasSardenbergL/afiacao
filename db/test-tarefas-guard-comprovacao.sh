#!/usr/bin/env bash
# Testa o trigger public.tarefas_guard_comprovacao num Postgres 17 local descartável.
#
# Prova o FIX do P1 (20260605120000): o guard antigo (bloco_d) só rodava quando
# coalesce(NEW.requer_comprovacao,false) → um operador podia BURLAR a trava com
#   UPDATE tarefas SET requer_comprovacao=false, status='concluida'  (num só UPDATE)
# pois NEW.requer_comprovacao=false fazia o guard pular tudo. O fix adiciona
# "OR coalesce(OLD.requer_comprovacao,false)" → roda o guard quando a tarefa EXIGIA
# prova antes, bloqueando o truque.
#
# current_user distingue RPC (postgres, allowlist → isenta) de operador (authenticated → enforça).
# NÃO testo a RLS aqui (a alcançabilidade via policy tarefas_update foi confirmada lendo o código);
# testo a LÓGICA do trigger: burla bloqueada + fluxos legítimos (adiar/cancelar/RPC/sem-prova) passam.
#
# Pré-requisitos: brew install postgresql@17   (mesmo boilerplate de db/verify-snapshot-replay.sh)
set -euo pipefail

PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5436
DATA="$(mktemp -d /tmp/pgtest-guard.XXXXXX)/data"
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
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-guard.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres guard_test
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d guard_test "$@"; }

# 1) Schema mínimo que o trigger referencia + role authenticated (simula o operador)
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated')
  THEN CREATE ROLE authenticated; END IF; END $$;
CREATE TABLE public.tarefas (
  id bigint PRIMARY KEY,
  status text NOT NULL DEFAULT 'aberta',
  requer_comprovacao boolean,
  comprovacao_url text,
  comprovacao_leitura numeric,
  comprovacao_em timestamptz,
  auditoria_status text NOT NULL DEFAULT 'nao_requer',
  auditada_por uuid,
  adiada_para timestamptz,
  motivo_adiamento text,
  updated_at timestamptz DEFAULT now()
);
GRANT SELECT, UPDATE ON public.tarefas TO authenticated;
SQL

# 2) FUNÇÃO ANTIGA (com o bug) + trigger — prova que a burla PASSA
P -v ON_ERROR_STOP=1 -q <<'SQL'
create or replace function public.tarefas_guard_comprovacao()
returns trigger language plpgsql security invoker as $$
begin
  if coalesce(new.requer_comprovacao, false) then   -- BUG: só NEW
    if new.status = 'concluida' and old.status is distinct from 'concluida'
       and current_user not in ('postgres','service_role','supabase_admin') then
      raise exception 'Tarefa com comprovação só conclui via concluir_com_comprovacao()';
    end if;
    if current_user not in ('postgres','service_role','supabase_admin') and (
         new.comprovacao_url is distinct from old.comprovacao_url
      or new.requer_comprovacao is distinct from old.requer_comprovacao
    ) then
      raise exception 'Campos de comprovação/auditoria só mudam via RPC';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_tarefas_guard_comprovacao on public.tarefas;
create trigger trg_tarefas_guard_comprovacao
  before update on public.tarefas for each row execute function public.tarefas_guard_comprovacao();

INSERT INTO public.tarefas (id, status, requer_comprovacao) VALUES (1, 'aberta', true);

DO $$
DECLARE st text;
BEGIN
  SET LOCAL ROLE authenticated;
  -- O1: a BURLA na função antiga — zerar requer_comprovacao + concluir num só UPDATE
  UPDATE public.tarefas SET requer_comprovacao = false, status = 'concluida' WHERE id = 1;
  RESET ROLE;
  SELECT status INTO st FROM public.tarefas WHERE id = 1;
  ASSERT st = 'concluida', format('O1 esperava bypass passar na fn ANTIGA, status=%L', st);
  RAISE NOTICE 'O1 OK (fn ANTIGA): burla PASSOU (status=concluida sem prova) — bug reproduzido';
END $$;
SQL

echo ""
echo "=== aplicando a migration do FIX (20260605120000) ==="
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260605120000_tarefas_guard_old_requer.sql"

# 3) FUNÇÃO NOVA (fix) — burla bloqueada + fluxos legítimos passam
echo ""
echo "ASSERTS (fn NOVA):"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- re-seed (ids distintos por teste p/ isolar estado)
INSERT INTO public.tarefas (id, status, requer_comprovacao) VALUES
  (10, 'aberta', true),   -- N1 burla combinada
  (11, 'aberta', true),   -- N2 concluir deixando requer=true
  (12, 'aberta', true),   -- N3 zerar requer sozinho
  (13, 'aberta', true),   -- N4 adiar (legítimo)
  (14, 'aberta', true),   -- N5 cancelar (legítimo)
  (15, 'aberta', true),   -- N6 RPC (postgres)
  (16, 'aberta', false);  -- N7 tarefa sem prova

-- N1: burla combinada (requer=false + concluida) → BLOQUEADA
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.tarefas SET requer_comprovacao = false, status = 'concluida' WHERE id = 10;
    RESET ROLE;
    RAISE EXCEPTION 'N1_FALHOU_BYPASS_PASSOU';
  EXCEPTION
    WHEN sqlstate 'P0001' THEN
      RESET ROLE;
      IF SQLERRM LIKE 'N1_FALHOU%' THEN RAISE EXCEPTION 'N1 FALHOU: a burla passou na fn NOVA (deveria bloquear)'; END IF;
      RAISE NOTICE 'N1 OK: burla combinada BLOQUEADA (%)', SQLERRM;
  END;
END $$;

-- N2: concluir deixando requer=true → BLOQUEADA (bloco de conclusão)
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.tarefas SET status = 'concluida' WHERE id = 11;
    RESET ROLE;
    RAISE EXCEPTION 'N2_FALHOU';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    RESET ROLE;
    IF SQLERRM LIKE 'N2_FALHOU%' THEN RAISE EXCEPTION 'N2 FALHOU: conclusão direta passou'; END IF;
    RAISE NOTICE 'N2 OK: conclusão direta BLOQUEADA (%)', SQLERRM;
  END;
END $$;

-- N3: zerar requer_comprovacao sozinho → BLOQUEADA (bloco de campos)
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.tarefas SET requer_comprovacao = false WHERE id = 12;
    RESET ROLE;
    RAISE EXCEPTION 'N3_FALHOU';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    RESET ROLE;
    IF SQLERRM LIKE 'N3_FALHOU%' THEN RAISE EXCEPTION 'N3 FALHOU: desligar requer passou'; END IF;
    RAISE NOTICE 'N3 OK: desligar requer_comprovacao BLOQUEADO (%)', SQLERRM;
  END;
END $$;

-- N4: ADIAR (legítimo) → PASSA
DO $$
DECLARE d timestamptz;
BEGIN
  SET LOCAL ROLE authenticated;
  UPDATE public.tarefas SET adiada_para = now() + interval '1 day', motivo_adiamento = 'cliente pediu' WHERE id = 13;
  RESET ROLE;
  SELECT adiada_para INTO d FROM public.tarefas WHERE id = 13;
  ASSERT d IS NOT NULL, 'N4 adiar deveria passar';
  RAISE NOTICE 'N4 OK: adiar (tarefa com prova) PASSOU';
END $$;

-- N5: CANCELAR (legítimo) → PASSA
DO $$
DECLARE st text;
BEGIN
  SET LOCAL ROLE authenticated;
  UPDATE public.tarefas SET status = 'cancelada' WHERE id = 14;
  RESET ROLE;
  SELECT status INTO st FROM public.tarefas WHERE id = 14;
  ASSERT st = 'cancelada', format('N5 cancelar deveria passar, status=%L', st);
  RAISE NOTICE 'N5 OK: cancelar (tarefa com prova) PASSOU';
END $$;

-- N6: RPC path (current_user=postgres) → PASSA (concluir com prova)
DO $$
DECLARE st text;
BEGIN
  -- sem SET ROLE → current_user=postgres (allowlist) = simula SECURITY DEFINER da RPC
  UPDATE public.tarefas SET status = 'concluida', comprovacao_url = 'uid/15/x.jpg', comprovacao_em = now() WHERE id = 15;
  SELECT status INTO st FROM public.tarefas WHERE id = 15;
  ASSERT st = 'concluida', format('N6 RPC deveria concluir, status=%L', st);
  RAISE NOTICE 'N6 OK: caminho RPC (postgres) concluiu com prova';
END $$;

-- N7: tarefa SEM prova (requer=false desde sempre) → conclusão direta PASSA
DO $$
DECLARE st text;
BEGIN
  SET LOCAL ROLE authenticated;
  UPDATE public.tarefas SET status = 'concluida' WHERE id = 16;
  RESET ROLE;
  SELECT status INTO st FROM public.tarefas WHERE id = 16;
  ASSERT st = 'concluida', format('N7 tarefa sem prova deveria concluir, status=%L', st);
  RAISE NOTICE 'N7 OK: tarefa sem comprovação conclui direto (guard não interfere)';
END $$;
SQL

echo ""
echo "TODOS OS ASSERTS PASSARAM ✅  (burla bloqueada na fn nova; adiar/cancelar/RPC/sem-prova OK)"
