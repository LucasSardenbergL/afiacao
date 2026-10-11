#!/usr/bin/env bash
# Prova PG17 da migration db/2026-10-11-bucket-releases-sayersync.sql (bucket `releases` do SayerSync).
#
# O que prova, sob SET ROLE authenticated + GUC test.uid (a RLS filtra POR CIMA do grant):
#   · master INSERE e faz UPSERT (INSERT … ON CONFLICT DO UPDATE — é o que o storage-api faz no manifest);
#   · employee e customer: INSERT → 42501 (SQLSTATE exata; o resto é re-lançado); UPDATE → 0 linhas;
#   · anon (SET ROLE anon): INSERT → 42501;
#   · ninguém deleta (sem policy de DELETE — binário publicado é imutável);
#   · bucket público; migration idempotente (roda 2×).
# E FALSIFICA na mesma invocação: CONTROLE (migration intacta) tem de ficar verde ANTES; depois cada
# sabotagem (insert/update abertos a employee) tem de deixar a suíte VERMELHA.
#
# Pré-req: brew install postgresql@17.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="$REPO_ROOT/db/2026-10-11-bucket-releases-sayersync.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5447   # dedicada p/ não colidir com os outros db/test-*.sh
TMP="$(mktemp -d /tmp/pgtest-releases.XXXXXX)"
DATA="$TMP/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
[ -f "$MIGRATION" ] || { echo "migration ausente: $MIGRATION"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMP/pg.log" -w start >/dev/null

# Cada rodada (controle + sabotagens) ganha um banco limpo.
suite() {
  local db="$1" mig="$2"
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$db"
  local P=("$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1)

  "${P[@]}" <<'SQL'
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL, PRIMARY KEY (user_id, role));
CREATE OR REPLACE FUNCTION public.has_role(_uid uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role = _role);
$f$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, conteudo text,
  UNIQUE (bucket_id, name)
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon, authenticated;
-- Grant amplo de propósito: quem barra tem de ser a RLS, não a falta de GRANT.
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated;
INSERT INTO public.user_roles VALUES
  ('00000000-0000-0000-0000-00000000000a', 'master'),
  ('00000000-0000-0000-0000-00000000000b', 'employee'),
  ('00000000-0000-0000-0000-00000000000c', 'customer');
SQL

  # Aplica 2× — idempotência (a 2ª passa por ON CONFLICT / IF NOT EXISTS e a postcondição de novo).
  "${P[@]}" -f "$mig" || return 1
  "${P[@]}" -f "$mig" || return 1

  "${P[@]}" <<'SQL' || return 1
-- master: insere o .exe e faz upsert do manifest (2×, a 2ª é o UPDATE).
BEGIN;
SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
SET LOCAL ROLE authenticated;
INSERT INTO storage.objects (bucket_id, name, conteudo) VALUES ('releases', 'sayersync/sayersync-0.2.1.exe', 'bin');
INSERT INTO storage.objects (bucket_id, name, conteudo) VALUES ('releases', 'sayersync/manifest.json', 'v1')
  ON CONFLICT (bucket_id, name) DO UPDATE SET conteudo = excluded.conteudo;
INSERT INTO storage.objects (bucket_id, name, conteudo) VALUES ('releases', 'sayersync/manifest.json', 'v2')
  ON CONFLICT (bucket_id, name) DO UPDATE SET conteudo = excluded.conteudo;
DO $a$ BEGIN
  IF (SELECT conteudo FROM storage.objects WHERE name = 'sayersync/manifest.json') IS DISTINCT FROM 'v2' THEN
    RAISE EXCEPTION 'FALHA master: upsert do manifest nao gravou v2';
  END IF;
END $a$;
COMMIT;

-- employee / customer / anon: INSERT tem de dar 42501 — e SÓ 42501. Dois caminhos, que a RLS julga
-- por policies DIFERENTES: o .exe NOVO (só a de INSERT) e o upsert do manifest existente (cai no ramo
-- UPDATE). Testar só o upsert deixou a policy de INSERT sem testemunha — a falsificação pegou.
DO $a$
DECLARE r record; s record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('00000000-0000-0000-0000-00000000000b', 'authenticated', 'employee'),
      ('00000000-0000-0000-0000-00000000000c', 'authenticated', 'customer'),
      ('',                                     'anon',          'anon')) v(uid, papel, rotulo)
  LOOP
    FOR s IN SELECT * FROM (VALUES
        ('exe-novo', $q$INSERT INTO storage.objects (bucket_id, name, conteudo) VALUES ('releases', 'sayersync/sayersync-9.9.9.exe', 'pwn')$q$),
        ('upsert-manifest', $q$INSERT INTO storage.objects (bucket_id, name, conteudo) VALUES ('releases', 'sayersync/manifest.json', 'pwn')
                               ON CONFLICT (bucket_id, name) DO UPDATE SET conteudo = excluded.conteudo$q$)) v(caso, stmt)
    LOOP
      BEGIN
        PERFORM set_config('test.uid', r.uid, true);
        EXECUTE format('SET LOCAL ROLE %I', r.papel);
        EXECUTE s.stmt;
        RAISE EXCEPTION 'FALHA % (%): escrita no bucket releases PASSOU', r.rotulo, s.caso;
      EXCEPTION WHEN insufficient_privilege THEN
        NULL;  -- 42501 esperado; qualquer outra SQLSTATE (inclusive a FALHA acima) é re-lançada
      END;
      RESET ROLE;
    END LOOP;
  END LOOP;
END $a$;
RESET ROLE;

-- employee: UPDATE direto acha 0 linhas (USING master-only esconde a linha).
DO $a$
DECLARE n int;
BEGIN
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-00000000000b', true);
  SET LOCAL ROLE authenticated;
  UPDATE storage.objects SET conteudo = 'pwn' WHERE bucket_id = 'releases';
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  IF n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FALHA employee: UPDATE mutou % linha(s)', n; END IF;
END $a$;
RESET ROLE;

-- master: DELETE acha 0 linhas (sem policy de DELETE — publicado é imutável).
DO $a$
DECLARE n int;
BEGIN
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-00000000000a', true);
  SET LOCAL ROLE authenticated;
  DELETE FROM storage.objects WHERE bucket_id = 'releases';
  GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  IF n IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FALHA master: DELETE apagou % linha(s)', n; END IF;
END $a$;
RESET ROLE;

DO $a$ BEGIN
  IF (SELECT conteudo FROM storage.objects WHERE name = 'sayersync/manifest.json') IS DISTINCT FROM 'v2' THEN
    RAISE EXCEPTION 'FALHA: manifest mudou depois das tentativas negadas';
  END IF;
  IF (SELECT public FROM storage.buckets WHERE id = 'releases') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FALHA: bucket releases nao-publico';
  END IF;
END $a$;
SELECT 'SUITE_RELEASES_OK';
SQL
}

echo "→ CONTROLE: migration intacta tem de passar…"
SAIDA="$(suite controle "$MIGRATION" 2>&1)" || { echo "$SAIDA"; echo "❌ CONTROLE vermelho — a suíte não prova nada"; exit 1; }
grep -q "SUITE_RELEASES_OK" <<<"$SAIDA" || { echo "$SAIDA"; echo "❌ CONTROLE sem marcador"; exit 1; }
echo "  ✅ controle verde (master grava/upsert; employee/customer/anon 42501; UPDATE/DELETE 0 linhas)"

# Sabotagens: cada uma abre UMA camada a employee; a suíte tem de ficar vermelha.
falsifica() {
  local nome="$1" expr="$2" alvo="$TMP/sab-$1.sql"
  sed "$expr" "$MIGRATION" >"$alvo"
  cmp -s "$MIGRATION" "$alvo" && { echo "❌ sabotagem '$nome' não alterou nada (sed não casou)"; exit 1; }
  if SAIDA="$(suite "sab_$nome" "$alvo" 2>&1)" && grep -q "SUITE_RELEASES_OK" <<<"$SAIDA"; then
    echo "❌ sabotagem '$nome' ficou VERDE — a suíte não pega essa camada"; exit 1
  fi
  echo "  ✅ sabotagem '$nome' → vermelho"
}
echo "→ FALSIFICAÇÃO (mesma invocação do controle)…"
# `OR true` mantém o texto que a postcondição procura (has_role…master): o vermelho tem de vir da RLS,
# não da postcondição — senão a sabotagem prova a postcondição e deixa os asserts sem testemunha.
falsifica insert "/releases_insert_master ON/,/WITH CHECK/s/'master'::public.app_role))/'master'::public.app_role) OR true)/"
# Só a de UPDATE aberta fica VERDE, e é desenho: UPDATE sob RLS só enxerga linha que a SELECT mostra, e a
# SELECT é master-only — as duas são redundantes entre si no caminho de escrita (medido 2026-10-11).
# Abrir só a SELECT também fica verde (leitura já é pública pela rota /object/public). Por isso a
# sabotagem do ramo UPDATE abre as DUAS: é o menor buraco que expõe o manifest a employee.
falsifica update-e-select "/releases_update_master ON/,/WITH CHECK/s/'master'::public.app_role))/'master'::public.app_role) OR true)/;/releases_select_master ON/,/USING/s/'master'::public.app_role))/'master'::public.app_role) OR true)/"
falsifica privado "s/VALUES ('releases', 'releases', true,/VALUES ('releases', 'releases', false,/"

echo "✅ TEST_BUCKET_RELEASES_OK"
