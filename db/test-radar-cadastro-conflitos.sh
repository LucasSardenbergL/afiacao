#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — Radar: CONFLITO de cadastro Omie persistido no SERVIDOR                         ║
# ║  (migration 20261027160000 — achado 3 do Codex no PR #3293, desenho Codex 2026-10-27)           ║
# ║   bash db/test-radar-cadastro-conflitos.sh               (controle)                             ║
# ║   bash db/test-radar-cadastro-conflitos.sh --falsificar  (controle + sabotagens)                ║
# ║                                                                                                ║
# ║  Mundo: stubs de prod (radar_*, tarefas, gate de gestor, cap_carteira_ler, default privileges)  ║
# ║  → predecessoras reais até a 20261021120500 (v1 md5 2b3dbe0d… = PROD) → esta migration.         ║
# ║   B0  PRE recusa a v1 sem RD001/RD002 · aplica · re-aplica · atributos · ACL · RLS              ║
# ║   B1  v2 caminho feliz = v1 (grava; repetir = deduped)                                          ║
# ║   B2  v2 em RD001 → {ok:false} e o conflito FICA (lido de OUTRA sessão: resposta perdida)       ║
# ║   B3  conflito aberto BLOQUEIA (inclusive vínculo igual) sem contar ocorrência nova             ║
# ║   B4  v2 em RD002 → conflito com o CNPJ dono do código                                          ║
# ║   B5  registrar: re-conferência (RD003), sem exigir ledger, lookup aceito, dedupe por chave      ║
# ║   B6  estado: vínculo + conflitos abertos juntos                                                ║
# ║   B7  resolver: nota obrigatória, versão velha → RD004 (fica aberto), nova observação = novo id  ║
# ║   B8  gate gestor nas 4 RPCs · RLS (SET ROLE authenticated) · escrita direta e escritor negados  ║
# ║   B9  DUAS SESSÕES concorrentes, bloqueio OBSERVADO em pg_stat_activity antes de soltar A        ║
# ║   B10 anti-deriva: função STABLE (TRAVA), tabela sem as RPCs (PRE)                              ║
# ║  FALSIFICAÇÃO: uma camada por vez; as réguas "este" são recalculadas do corpo SABOTADO (senão   ║
# ║  todo mutante morreria na PÓS sem exercitar o assert funcional).                                ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261027160000_radar_cadastro_conflitos.sql"
IDEM="$REPO_ROOT/supabase/migrations/20261021120500_radar_cadastro_omie_idempotente.sql"
CONF="$REPO_ROOT/supabase/migrations/20261021120000_radar_cadastro_omie_confirmacao_servidor.sql"
ALNUM="$REPO_ROOT/supabase/migrations/20261019225545_radar_rpcs_cnpj_alfanumerico.sql"
CONTATO="$REPO_ROOT/supabase/migrations/20260612130000_radar_rpcs_contato.sql"
FATIA3="$REPO_ROOT/supabase/migrations/20260613190000_radar_fatia3.sql"
HOJE_SP="$REPO_ROOT/supabase/migrations/20260929001651_hoje_sp_sessao_utc_sete_funcoes.sql"
MD5_V1="2b3dbe0da01ac37b07b1cb5b76be139c"   # psql-ro 2026-10-27 15:39 UTC (= "este" da 20261021120500)
MD5_CONF="b537f95a00b83aab6bac3a5019ba380a" # "este" da 20261021120000

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="v2_relanca:B2a v2_sem_trava:B9b estado_sem_share:B9a v2_sem_bloqueio:B3a sem_reconf_vinculo:B5a sem_reconf_outro:B5b sem_dedupe:B5e resolver_sem_versao:B7b rls_aberta:B8d pos_sem_acl_tabela:B0a tabela_insert_aberto:B8e pre_aceita_v1_qualquer:B0r trava_sem_volatilidade:B10a"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-conflitos.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    if grep -q "^FAIL $a " "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho: $(grep -m1 "^FAIL $a " "$LOGDIR/$s.log" | cut -c1-120)"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5515}"
TMPD="$(mktemp -d "/tmp/pgtest-radar-conflitos.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL="${LC_ALL_TESTE:-C}" LANG="${LC_ALL_TESTE:-C}"
MIG_USADA="$TMPD/mig.sql"
TAREFA_VIVA="$TMPD/tarefa-viva.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

for f in "$MIG" "$IDEM" "$CONF" "$ALNUM" "$CONTATO" "$FATIA3" "$HOJE_SP"; do [ -f "$f" ] || { echo "migration nao encontrada: $f"; exit 1; }; done
cp "$MIG" "$MIG_USADA"
python3 -I - "$HOJE_SP" "$TAREFA_VIVA" <<'PY'
import sys
src, dst = sys.argv[1:]
s = open(src, encoding="utf-8").read()
ini = s.index("CREATE OR REPLACE FUNCTION public.radar_atribuir_tarefa(")
fim = s.index("$function$;", ini) + len("$function$;")
open(dst, "w", encoding="utf-8").write(s[ini:fim] + "\n")
PY

# sabotar ARQ DE PARA: troca literal (o padrão TEM de existir).
sabotar() {
  python3 -I - "$1" "$2" "$3" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
s = s.replace(de, para)
open(p, "w", encoding="utf-8").write(s)
PY
}
# Réguas "este" → md5 de cada corpo SABOTADO (calculado do arquivo, como o PG o guardará). Trocar por uma
# subconsulta do vivo faria a PRE aceitar QUALQUER predecessor.
neutralizar() {
  python3 -I - "$MIG_USADA" <<'PY'
import hashlib, re, sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
for m in re.finditer(r"CREATE OR REPLACE FUNCTION public\.(\w+)\(", s):
    nome = m.group(1)
    ini = s.index("AS $function$", m.end()) + len("AS $function$")
    h = hashlib.md5(s[ini:s.index("$function$;", ini)].encode("utf-8")).hexdigest()
    s = re.sub(r"'[0-9a-f]{32}' /\* este:" + re.escape(nome) + r" \*/", "'" + h + "' /* este:" + nome + " */", s)
open(p, "w", encoding="utf-8").write(s)
PY
}
POS_ACL_TABELA="    RAISE EXCEPTION 'POS FALHOU: ACL de radar_cadastro_conflitos divergente"
case "${SABOTAGEM:-}" in
  "") ;;
  v2_relanca)             sabotar "$MIG_USADA" "  RETURN jsonb_build_object('ok', false, 'bloqueado', false,
    'conflito', public._radar_cadastro_conflito_gravar(p_cnpj, v_motivo, p_codigo_cliente, v_msg, v_uid));" "  PERFORM public._radar_cadastro_conflito_gravar(p_cnpj, v_motivo, p_codigo_cliente, v_msg, v_uid);
  RAISE EXCEPTION '%', v_msg USING ERRCODE = 'RD001';"; neutralizar ;;
  v2_sem_trava)           sabotar "$MIG_USADA" "  PERFORM 1 FROM public.radar_empresas WHERE cnpj = p_cnpj FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  -- Conflito ABERTO" "  PERFORM 1 FROM public.radar_empresas WHERE cnpj = p_cnpj;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  -- Conflito ABERTO"; neutralizar ;;
  estado_sem_share)       sabotar "$MIG_USADA" "WHERE e.cnpj = p_cnpj FOR SHARE;" "WHERE e.cnpj = p_cnpj;"; neutralizar ;;
  v2_sem_bloqueio)        sabotar "$MIG_USADA" "  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'bloqueado', true" "  IF false THEN
    RETURN jsonb_build_object('ok', false, 'bloqueado', true"; neutralizar ;;
  sem_reconf_vinculo)     sabotar "$MIG_USADA" "  IF p_motivo = 'vinculo_divergente' AND (" "  IF false AND ("; neutralizar ;;
  sem_reconf_outro)       sabotar "$MIG_USADA" "  IF p_motivo = 'codigo_de_outro_cnpj' AND v_outro IS NULL THEN" "  IF false THEN"; neutralizar ;;
  sem_dedupe)             sabotar "$MIG_USADA" "DO UPDATE SET ocorrencias = t.ocorrencias + 1, versao = t.versao + 1," "DO UPDATE SET ocorrencias = t.ocorrencias, versao = t.versao,"; neutralizar ;;
  resolver_sem_versao)    sabotar "$MIG_USADA" "   WHERE id = p_id AND versao = p_versao_vista AND resolvido_em IS NULL" "   WHERE id = p_id AND resolvido_em IS NULL"; neutralizar ;;
  rls_aberta)             sabotar "$MIG_USADA" "  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))));" "  USING (true);" ;;
  pos_sem_acl_tabela)     sabotar "$MIG_USADA" "GRANT SELECT ON TABLE public.radar_cadastro_conflitos TO authenticated, service_role;" "GRANT SELECT, INSERT ON TABLE public.radar_cadastro_conflitos TO authenticated, service_role;" ;;
  tabela_insert_aberto)   sabotar "$MIG_USADA" "GRANT SELECT ON TABLE public.radar_cadastro_conflitos TO authenticated, service_role;" "GRANT SELECT, INSERT ON TABLE public.radar_cadastro_conflitos TO authenticated, service_role;"
                          sabotar "$MIG_USADA" "$POS_ACL_TABELA" "    RAISE NOTICE 'POS FALHOU: ACL de radar_cadastro_conflitos divergente"
                          sabotar "$MIG_USADA" "CREATE POLICY radar_cadastro_conflitos_select_gestor ON public.radar_cadastro_conflitos FOR SELECT TO authenticated" "CREATE POLICY radar_cadastro_conflitos_select_gestor ON public.radar_cadastro_conflitos FOR ALL TO authenticated"
                          sabotar "$MIG_USADA" "AND p.polname = 'radar_cadastro_conflitos_select_gestor' AND p.polcmd = 'r')" "AND p.polname = 'radar_cadastro_conflitos_select_gestor')" ;;
  pre_aceita_v1_qualquer) sabotar "$MIG_USADA" "  IF v_md5 IS DISTINCT FROM '$MD5_V1' THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_registrar_cadastro_omie vivo" "  IF false THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_registrar_cadastro_omie vivo" ;;
  trava_sem_volatilidade) sabotar "$MIG_USADA" "    IF r.provolatile <> 'v' THEN
      RAISE EXCEPTION 'TRAVA FALHOU" "    IF false THEN
      RAISE EXCEPTION 'TRAVA FALHOU" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"
este_de() { grep -oE "'[0-9a-f]{32}' /\* este:$1 \*/" "$MIG_USADA" | grep -oE '[0-9a-f]{32}' | head -1; }

"$PGBIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prova
P()  { "$PGBIN/psql" -X -h /tmp -p "$PORT" -U postgres -d prova -v ON_ERROR_STOP=1 -q "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1 $2"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL $1 $2"; }
eq()  { if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi; }
GESTOR='00000000-0000-0000-0000-0000000000a1'
VENDEDOR='00000000-0000-0000-0000-0000000000b2'
# Bloco que classifica o desfecho de UMA chamada num MARCADOR. RDxxx/42501 casam pela SQLSTATE (nunca pela
# mensagem); os RAISE P0001 conhecidos pelo prefixo da mensagem. Qualquer OUTRO erro relança — `WHEN OTHERS
# THEN 'OK'` é teatro. Resultados jsonb viram um resumo estável por forma.
classifica() { # $1 = expressão SQL que devolve jsonb
  cat <<SQL
DO \$x\$ DECLARE r jsonb; BEGIN
  r := $1;
  INSERT INTO pg_temp.res VALUES (CASE
    WHEN r ? 'conflito' THEN 'CONF:' || (r->>'bloqueado') || ':' || (r->'conflito'->>'motivo') || ':' || (r->'conflito'->>'ocorrencias') || ':' || (r->'conflito'->>'versao')
    WHEN r ? 'vinculo' THEN 'EST:' || COALESCE(r->>'vinculo', '-') || ':' || jsonb_array_length(r->'conflitos')
    WHEN r ? 'id' THEN 'REG:' || (r->>'motivo') || ':' || (r->>'ocorrencias') || ':' || (r->>'versao')
    WHEN r ? 'deduped' THEN 'OK:' || (r->>'deduped')
    WHEN r ? 'versao' THEN 'RES:' || (r->>'versao')
    ELSE 'FORMA:' || r::text END);
EXCEPTION
  WHEN SQLSTATE 'RD001' THEN INSERT INTO pg_temp.res VALUES ('RD001');
  WHEN SQLSTATE 'RD002' THEN INSERT INTO pg_temp.res VALUES ('RD002');
  WHEN SQLSTATE 'RD003' THEN INSERT INTO pg_temp.res VALUES ('RD003');
  WHEN SQLSTATE 'RD004' THEN INSERT INTO pg_temp.res VALUES ('RD004');
  WHEN insufficient_privilege THEN INSERT INTO pg_temp.res VALUES ('NEGADO');
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'forbidden:%' THEN INSERT INTO pg_temp.res VALUES ('FORBIDDEN');
    ELSIF SQLERRM LIKE 'RADAR_SEM_CONFIRMACAO_OMIE:%' THEN INSERT INTO pg_temp.res VALUES ('SEM_CONFIRMACAO');
    ELSIF SQLERRM LIKE 'nota obrigat%' THEN INSERT INTO pg_temp.res VALUES ('SEM_NOTA');
    ELSE RAISE; END IF;
END \$x\$;
SQL
}
# chamada UID EXPRESSÃO → marcador (sessão própria, autocommit).
chamada() {
  Pq <<SQL
SET test.uid = '$1';
CREATE TEMP TABLE res (k text);
$(classifica "$2")
SELECT k FROM pg_temp.res;
SQL
}
v2()  { echo "public.radar_registrar_cadastro_omie_v2('$1', '$2', false)"; }
est() { echo "public.radar_estado_cadastro_omie('$1')"; }
reg() { echo "public.radar_registrar_conflito_cadastro('$1', '$2', $3, 'visto no teste')"; }
res() { echo "public.radar_resolver_conflito_cadastro($1, $2, '$3')"; }
# em_sessao NOME EXPRESSÃO FIM SEGUNDOS — chama numa transação que fica ABERTA por SEGUNDOS e termina em COMMIT
# ou ROLLBACK (FIM). Roda em background; o marcador sai em $TMPD/NOME.out.
em_sessao() {
  "$PGBIN/psql" -X -h /tmp -p "$PORT" -U postgres -d prova -v ON_ERROR_STOP=1 -qtA > "$TMPD/$1.out" 2> "$TMPD/$1.err" <<SQL &
SET application_name = 'conf_$1';
SET test.uid = '$GESTOR';
CREATE TEMP TABLE res (k text);
BEGIN;
$(classifica "$2")
SELECT k FROM pg_temp.res;
SELECT pg_sleep($4);
$3;
SQL
}
espera_estado() {
  for _ in $(seq 1 100); do
    [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'conf_$1' AND ($2)")" = "1" ] && return 0
    sleep 0.1
  done
  return 1
}
EM_SLEEP="query LIKE '%pg_sleep%' AND wait_event = 'PgSleep'"
EM_LOCK="wait_event_type = 'Lock'"
# concorrente ID EXPR_A FIM_A EXPR_B → "marcadorA|marcadorB|B_esperou"
concorrente() {
  em_sessao "${1}A" "$2" "$3" 2
  if ! espera_estado "${1}A" "$EM_SLEEP"; then echo "A_NAO_CHEGOU"; wait; return; fi
  em_sessao "${1}B" "$4" COMMIT 0
  local esperou=nao
  espera_estado "${1}B" "$EM_LOCK" && esperou=sim
  wait
  echo "$(head -1 "$TMPD/${1}A.out")|$(head -1 "$TMPD/${1}B.out")|$esperou"
}
md5_de() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.$1')"; }
empresa() { Pq -c "SELECT ja_cliente||'/'||COALESCE(omie_codigo_cliente,'-')||'/'||prospeccao_status||'/'||(SELECT count(*) FROM public.radar_contatos k WHERE k.cnpj=e.cnpj AND k.acao='virou_cliente')||'/'||updated_at FROM public.radar_empresas e WHERE cnpj='$1'"; }
confirma() { Pq -c "SET ROLE service_role; INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES ('oben','$1','$2','$3'); RESET ROLE;" >/dev/null; }
# conflitos CNPJ → "id:motivo:K:V:outro:ocorr:versao:aberto" de cada registro, por id.
conflitos() { Pq -c "SELECT COALESCE(string_agg(id||':'||motivo||':'||COALESCE(codigo_recebido,'-')||':'||COALESCE(codigo_vinculado,'-')||':'||COALESCE(cnpj_do_codigo,'-')||':'||ocorrencias||':'||versao||':'||(resolvido_em IS NULL), ',' ORDER BY id), 'nenhum') FROM public.radar_cadastro_conflitos WHERE cnpj='$1'"; }
id_aberto() { Pq -c "SELECT id FROM public.radar_cadastro_conflitos WHERE cnpj='$1' AND resolvido_em IS NULL ORDER BY id LIMIT 1"; }
vinculo() { Pq -c "SET test.uid='$GESTOR'; SELECT public.radar_registrar_cadastro_omie('$1','$2',false)" >/dev/null; }

P <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sandbox_exec') THEN CREATE ROLE sandbox_exec NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='claude_ro') THEN CREATE ROLE claude_ro NOLOGIN; END IF;
END $$;
-- Default privileges de PROD (pg_default_acl do postgres em public, psql-ro 2026-10-21).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO sandbox_exec;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO claude_ro;
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  razao_social text, nome_fantasia text,
  cnae_principal text NOT NULL,
  data_abertura date,
  municipio_codigo text, municipio_nome text, uf text,
  telefone1 text, telefone2 text,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  prospeccao_atualizado_em timestamptz, descarte_motivo text,
  ja_cliente boolean NOT NULL DEFAULT false,
  ultimo_lote text NOT NULL,
  omie_codigo_cliente text, omie_cadastrado_em timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_municipios (
  codigo text PRIMARY KEY, nome text NOT NULL, uf text NOT NULL,
  lat double precision, lng double precision);
CREATE TABLE public.radar_contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj text NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'), acao text NOT NULL, nota text,
  criado_por uuid NOT NULL, status_anterior text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_ingest_state (
  mes_referencia text PRIMARY KEY, status text NOT NULL, novos integer);
CREATE TABLE public.tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  descricao text NOT NULL, categoria text NOT NULL, customer_user_id uuid,
  assigned_to uuid NOT NULL, created_by uuid NOT NULL, empresa text NOT NULL,
  modo text NOT NULL, due_date date, interacao_tipo text,
  auto_satisfy_mode text NOT NULL DEFAULT 'off', status text NOT NULL DEFAULT 'aberta',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
-- Stub da capability que a policy de leitura usa em prod (radar_empresas/radar_contatos usam a mesma).
CREATE OR REPLACE FUNCTION private.cap_carteira_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT public.pode_ver_carteira_completa(_uid) $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role, sandbox_exec, claude_ro;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.cap_carteira_ler(uuid) TO authenticated;
SQL
P -f "$CONTATO" >/dev/null
P -f "$FATIA3" >/dev/null
P -f "$TAREFA_VIVA" >/dev/null
P <<'SQL'
GRANT EXECUTE ON FUNCTION public.registrar_contato_radar(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.radar_atribuir_tarefa(text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) TO service_role;
SQL
P -f "$ALNUM" >/dev/null
P -f "$CONF" >/dev/null
P <<'SQL'
INSERT INTO public.test_gestores VALUES ('00000000-0000-0000-0000-0000000000a1');
INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, prospeccao_status) VALUES
  ('12ABC34501DE35', 'FELIZ ALFANUMERICA', '3101200', '2026-10', 'em_conversa'),
  ('11111111000111', 'DIVERGENTE', '3101200', '2026-10', 'em_conversa'),
  ('22222222000122', 'DONO DO CODIGO', '3101200', '2026-10', 'em_conversa'),
  ('33333333000133', 'QUER O CODIGO DO OUTRO', '3101200', '2026-10', 'em_conversa'),
  ('44444444000144', 'SEM VINCULO', '3101200', '2026-10', 'a_contatar'),
  ('55555555000155', 'CORRIDA ESTADO', '3101200', '2026-10', 'em_conversa'),
  ('66666666000166', 'CORRIDA REG REG', '3101200', '2026-10', 'em_conversa'),
  ('77777777000177', 'CORRIDA RESOLVER VENCE', '3101200', '2026-10', 'em_conversa'),
  ('88888888000188', 'CORRIDA REGISTRAR VENCE', '3101200', '2026-10', 'em_conversa'),
  ('99999999000199', 'CORRIDA ROLLBACK', '3101200', '2026-10', 'em_conversa');
SQL

echo "── B0 aplicação"
eq B0p "predecessor vivo ainda é a 20261021120000 (sem RD001/RD002)" "$(md5_de 'radar_registrar_cadastro_omie(text,text,boolean)')" "$MD5_CONF"
if P -f "$MIG_USADA" > "$TMPD/pre.log" 2>&1; then bad B0r "PRE aceitou a v1 sem RD001/RD002";
elif grep -q "PRE FALHOU: radar_registrar_cadastro_omie vivo (md5 $MD5_CONF)" "$TMPD/pre.log"; then ok B0r "PRE recusa a v1 sem RD001/RD002 (a v2 depende deles)";
else bad B0r "abortou fora do esperado: $(grep -m1 ERROR "$TMPD/pre.log" | cut -c1-160)"; fi
eq B0r2 "o aborto não deixou tabela nem v2" "$(Pq -c "SELECT (to_regclass('public.radar_cadastro_conflitos') IS NULL)::text||'/'||(to_regprocedure('public.radar_registrar_cadastro_omie_v2(text,text,boolean)') IS NULL)::text")" "true/true"
P -f "$IDEM" >/dev/null
eq B0p2 "v1 = PROD (20261021120500)" "$(md5_de 'radar_registrar_cadastro_omie(text,text,boolean)')" "$MD5_V1"
if P -f "$MIG_USADA" >"$TMPD/apply.log" 2>&1; then ok B0a "migration aplica (TRAVA → PRE → tabela/RLS → funções → PÓS)"; else bad B0a "migration abortou: $(grep -m1 -E 'ERROR|ERRO' "$TMPD/apply.log" | cut -c1-200)"; fi
if P -f "$MIG_USADA" >"$TMPD/apply2.log" 2>&1; then ok B0b "re-aplicar é no-op (PRE aceita 'este')"; else bad B0b "re-aplicar abortou: $(grep -m1 -E 'ERROR|ERRO' "$TMPD/apply2.log" | cut -c1-200)"; fi
eq B0c "v1 intocada" "$(md5_de 'radar_registrar_cadastro_omie(text,text,boolean)')" "$MD5_V1"
eq B0d "v2 = 'este', DEFINER, search_path=public, VOLATILE" \
  "$(Pq -c "SELECT md5(prosrc)||':'||prosecdef||':'||proconfig[1]||':'||provolatile::text FROM pg_proc WHERE oid = to_regprocedure('public.radar_registrar_cadastro_omie_v2(text,text,boolean)')")" "$(este_de radar_registrar_cadastro_omie_v2):true:search_path=public:v"
eq B0e "escritor interno: INVOKER, sem EXECUTE para anon/PUBLIC/authenticated/service_role" \
  "$(Pq -c "SELECT prosecdef||'/'||has_function_privilege('anon',p.oid,'EXECUTE')||'/'||has_function_privilege('public',p.oid,'EXECUTE')||'/'||has_function_privilege('authenticated',p.oid,'EXECUTE')||'/'||has_function_privilege('service_role',p.oid,'EXECUTE') FROM pg_proc p WHERE oid = to_regprocedure('public._radar_cadastro_conflito_gravar(text,text,text,text,uuid)')")" "false/false/false/false/false"
eq B0f "tabela com RLS e 1 policy (SELECT)" "$(Pq -c "SELECT relrowsecurity::text||'/'||(SELECT string_agg(polcmd::text, ',') FROM pg_policy WHERE polrelid=c.oid) FROM pg_class c WHERE oid='public.radar_cadastro_conflitos'::regclass")" "true/r"

echo "── B1 v2 caminho feliz (= v1)"
confirma 12ABC34501DE35 4242 incluir
eq B1a "1ª gravação pela v2 vincula" "$(chamada $GESTOR "$(v2 12ABC34501DE35 4242)")" "OK:false"
eq B1b "repetir pela v2 = deduped" "$(chamada $GESTOR "$(v2 12ABC34501DE35 4242)")" "OK:true"
eq B1c "nenhum conflito no caminho feliz" "$(conflitos 12ABC34501DE35)" "nenhum"
eq B1d "sem confirmação no ledger a v2 propaga a recusa da v1 (não é conflito)" "$(chamada $GESTOR "$(v2 44444444000144 9999)")/$(conflitos 44444444000144)" "SEM_CONFIRMACAO/nenhum"

echo "── B2 v2 em RD001 → {ok:false} e o conflito FICA"
confirma 11111111000111 500 incluir; vinculo 11111111000111 500
confirma 11111111000111 501 lookup
ANTES_D="$(empresa 11111111000111)"
eq B2a "vínculo 500, Omie confirmou 501 → CONF não-bloqueado, vinculo_divergente, 1ª ocorrência" "$(chamada $GESTOR "$(v2 11111111000111 501)")" "CONF:false:vinculo_divergente:1:1"
eq B2b "o registro está lá numa OUTRA sessão (resposta perdida não perde o aviso): K=501, V=500 pelo servidor" "$(conflitos 11111111000111 | cut -d: -f2-8)" "vinculo_divergente:501:500:-:1:1:true"
eq B2c "nada regravado na empresa" "$(empresa 11111111000111)" "$ANTES_D"

echo "── B3 conflito aberto BLOQUEIA (bloqueio não é observação nova)"
eq B3a "nova tentativa com o MESMO código → bloqueada, versão/ocorrências intactas" "$(chamada $GESTOR "$(v2 11111111000111 501)")" "CONF:true:vinculo_divergente:1:1"
eq B3b "até o vínculo IGUAL (500) fica bloqueado até um humano resolver" "$(chamada $GESTOR "$(v2 11111111000111 500)")" "CONF:true:vinculo_divergente:1:1"
eq B3c "continua 1 registro, 1 ocorrência" "$(conflitos 11111111000111 | cut -d: -f2-8)" "vinculo_divergente:501:500:-:1:1:true"

echo "── B4 v2 em RD002 → conflito com o CNPJ dono do código"
confirma 22222222000122 700 incluir; vinculo 22222222000122 700
confirma 33333333000133 700 lookup
eq B4a "(33…, 700) com 700 de 22… → CONF codigo_de_outro_cnpj" "$(chamada $GESTOR "$(v2 33333333000133 700)")" "CONF:false:codigo_de_outro_cnpj:1:1"
eq B4b "registro guarda o CNPJ dono do código e o vínculo nulo do lead" "$(conflitos 33333333000133 | cut -d: -f2-8)" "codigo_de_outro_cnpj:700:-:22222222000122:1:1:true"

echo "── B5 registrar (divergência vista fora da RPC)"
eq B5a "vinculo_divergente sem vínculo no servidor → RD003 (o servidor desmente)" "$(chamada $GESTOR "$(reg 44444444000144 vinculo_divergente "'123'")")/$(conflitos 44444444000144)" "RD003/nenhum"
eq B5a2 "vinculo_divergente com K = V → RD003" "$(chamada $GESTOR "$(reg 12ABC34501DE35 vinculo_divergente "'4242'")")/$(conflitos 12ABC34501DE35)" "RD003/nenhum"
eq B5b "codigo_de_outro_cnpj com código de ninguém → RD003" "$(chamada $GESTOR "$(reg 44444444000144 codigo_de_outro_cnpj "'31337'")")/$(conflitos 44444444000144)" "RD003/nenhum"
eq B5c "K≠V SEM ledger (ramo codigoVisto) é guardado — o ledger autoriza vínculo, não censura evidência" "$(chamada $GESTOR "$(reg 12ABC34501DE35 vinculo_divergente "'9090'")")" "REG:vinculo_divergente:1:1"
eq B5d "lookup_divergente sem código é aceito (relato da edge)" "$(chamada $GESTOR "$(reg 44444444000144 lookup_divergente NULL)")" "REG:lookup_divergente:1:1"
eq B5e "mesma chave de novo → MESMO registro, ocorrências e versão sobem" "$(chamada $GESTOR "$(reg 44444444000144 lookup_divergente "''")")/$(Pq -c "SELECT count(*) FROM public.radar_cadastro_conflitos WHERE cnpj='44444444000144'")" "REG:lookup_divergente:2:2/1"
eq B5g "lookup_ambiguo (Omie com 2+ códigos, edge v1.27) é aceito como relato" "$(chamada $GESTOR "$(reg 44444444000144 lookup_ambiguo NULL)")" "REG:lookup_ambiguo:1:1"
eq B5h "motivo fora da lista → recusa" "$(Pq -c "SET test.uid='$GESTOR'; DO \$x\$ BEGIN PERFORM $(reg 44444444000144 inventado NULL); EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'RECUSOU %', SQLERRM; END \$x\$;" 2>&1 | grep -c 'RECUSOU motivo inválido: inventado')" "1"
eq B5f "código malformado → recusa sem gravar" "$(Pq -c "SET test.uid='$GESTOR'; DO \$x\$ BEGIN PERFORM $(reg 55555555000155 lookup_divergente "'0123'"); EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'RECUSOU %', SQLERRM; END \$x\$;" 2>&1 | grep -c 'RECUSOU código Omie inválido')/$(conflitos 55555555000155)" "1/nenhum"

echo "── B6 estado = vínculo + conflitos abertos juntos"
eq B6a "lead com vínculo e 1 conflito" "$(chamada $GESTOR "$(est 11111111000111)")" "EST:500:1"
eq B6b "lead sem nada" "$(chamada $GESTOR "$(est 55555555000155)")" "EST:-:0"

echo "── B7 resolver"
ID_D="$(id_aberto 11111111000111)"
eq B7a "nota vazia → recusa" "$(chamada $GESTOR "$(res "$ID_D" 1 '  ')")" "SEM_NOTA"
eq B7b "versão vista velha (0) → RD004 e o conflito SEGUE aberto" "$(chamada $GESTOR "$(res "$ID_D" 0 'conferi')")/$(conflitos 11111111000111 | cut -d: -f8)" "RD004/true"
eq B7c "versão certa → resolvido (versão 2)" "$(chamada $GESTOR "$(res "$ID_D" 1 'conferi: Omie 500 é o certo')")" "RES:2"
eq B7d "resolver de novo (outra aba, versão 1) → RD004" "$(chamada $GESTOR "$(res "$ID_D" 1 'conferi')")" "RD004"
eq B7e "estado já não traz o resolvido; o lead destrava" "$(chamada $GESTOR "$(est 11111111000111)")/$(chamada $GESTOR "$(v2 11111111000111 500)")" "EST:500:0/OK:true"
eq B7f "nova observação da mesma chave depois de resolvido → OUTRO registro; o encerrado fica" "$(chamada $GESTOR "$(v2 11111111000111 501)")/$(Pq -c "SELECT count(*)||':'||count(*) FILTER (WHERE resolvido_em IS NULL)||':'||(max(id) > $ID_D) FROM public.radar_cadastro_conflitos WHERE cnpj='11111111000111'")" "CONF:false:vinculo_divergente:1:1/2:1:true"
eq B7g "o encerrado guarda quem, quando e a nota" "$(Pq -c "SELECT (resolvido_por = '$GESTOR')::text||'/'||(resolvido_em IS NOT NULL)::text||'/'||nota_resolucao FROM public.radar_cadastro_conflitos WHERE id=$ID_D")" "true/true/conferi: Omie 500 é o certo"

echo "── B8 gate, RLS e escrita direta"
eq B8a "não-gestor: v2 recusada" "$(chamada $VENDEDOR "$(v2 12ABC34501DE35 4242)")" "FORBIDDEN"
eq B8b "não-gestor: estado/registrar/resolver recusados" "$(chamada $VENDEDOR "$(est 12ABC34501DE35)")/$(chamada $VENDEDOR "$(reg 44444444000144 lookup_divergente NULL)")/$(chamada $VENDEDOR "$(res "$ID_D" 2 'x')")" "FORBIDDEN/FORBIDDEN/FORBIDDEN"
TOTAL="$(Pq -c "SELECT count(*) FROM public.radar_cadastro_conflitos")"
eq B8c "gestor lê TODOS sob SET ROLE authenticated" "$(Pq -c "SET test.uid='$GESTOR'; SET ROLE authenticated; SELECT count(*) FROM public.radar_cadastro_conflitos")" "$TOTAL"
eq B8d "não-gestor lê 0 sob SET ROLE authenticated" "$(Pq -c "SET test.uid='$VENDEDOR'; SET ROLE authenticated; SELECT count(*) FROM public.radar_cadastro_conflitos")" "0"
eq B8e "INSERT direto do gestor como authenticated → negado (42501), nada gravado" "$(Pq <<SQL
SET test.uid = '$GESTOR';
SET ROLE authenticated;
CREATE TEMP TABLE res (k text);
DO \$x\$ BEGIN
  INSERT INTO public.radar_cadastro_conflitos (cnpj, motivo, detalhe, criado_por, ultimo_por) VALUES ('55555555000155','lookup_divergente','forjado','$GESTOR','$GESTOR');
  INSERT INTO pg_temp.res VALUES ('GRAVOU');
EXCEPTION WHEN insufficient_privilege THEN INSERT INTO pg_temp.res VALUES ('NEGADO');
END \$x\$;
SELECT k FROM pg_temp.res;
SQL
)/$(Pq -c "SELECT count(*) FROM public.radar_cadastro_conflitos WHERE detalhe='forjado'")" "NEGADO/0"
eq B8f "o escritor interno não é chamável por authenticated (42501)" "$(Pq <<SQL
SET test.uid = '$GESTOR';
SET ROLE authenticated;
CREATE TEMP TABLE res (k text);
$(classifica "public._radar_cadastro_conflito_gravar('44444444000144','lookup_divergente',NULL,'forjado','$GESTOR')")
SELECT k FROM pg_temp.res;
SQL
)" "NEGADO"
eq B8g "UPDATE/DELETE diretos negados para authenticated" "$(Pq -c "SELECT has_table_privilege('authenticated','public.radar_cadastro_conflitos','UPDATE')||'/'||has_table_privilege('authenticated','public.radar_cadastro_conflitos','DELETE')||'/'||has_table_privilege('anon','public.radar_cadastro_conflitos','SELECT')")" "false/false/false"

echo "── B9 duas sessões concorrentes (o bloqueio é OBSERVADO antes de soltar A)"
confirma 55555555000155 800 incluir; vinculo 55555555000155 800; confirma 55555555000155 801 lookup
eq B9a "A: v2 em RD001 (tx aberta) × B: estado → B ESPERA e já vê o conflito de A" "$(concorrente est "$(v2 55555555000155 801)" COMMIT "$(est 55555555000155)")" "CONF:false:vinculo_divergente:1:1|EST:800:1|sim"
confirma 77777777000177 900 incluir; vinculo 77777777000177 900; confirma 77777777000177 901 lookup
eq B9b "A: v2 em RD001 × B: v2 (mesmo código) → B ESPERA e sai BLOQUEADO, sem 2ª ocorrência" "$(concorrente v2v2 "$(v2 77777777000177 901)" COMMIT "$(v2 77777777000177 901)")" "CONF:false:vinculo_divergente:1:1|CONF:true:vinculo_divergente:1:1|sim"
confirma 66666666000166 1000 incluir; vinculo 66666666000166 1000
eq B9c "registrar × registrar (mesma chave) → B espera, 1 registro com 2 ocorrências" "$(concorrente rr "$(reg 66666666000166 vinculo_divergente "'1001'")" COMMIT "$(reg 66666666000166 vinculo_divergente "'1001'")")" "REG:vinculo_divergente:1:1|REG:vinculo_divergente:2:2|sim"
ID_R="$(id_aberto 77777777000177)"
eq B9d "resolver VENCE (tx aberta) × registrar a mesma chave → B espera e abre OUTRO registro" "$(concorrente rv "$(res "$ID_R" 1 'conferi')" COMMIT "$(reg 77777777000177 vinculo_divergente "'901'")")/$(conflitos 77777777000177 | tr ',' '\n' | cut -d: -f8 | tr '\n' ' ')" "RES:2|REG:vinculo_divergente:1:1|sim/false true "
confirma 88888888000188 1100 incluir; vinculo 88888888000188 1100
Pq -c "SET test.uid='$GESTOR'; SELECT $(reg 88888888000188 vinculo_divergente "'1101'")" >/dev/null
ID_G="$(id_aberto 88888888000188)"
eq B9e "registrar VENCE (versão 2) × resolver com a versão 1 vista → B espera e recebe RD004; segue aberto" "$(concorrente gv "$(reg 88888888000188 vinculo_divergente "'1101'")" COMMIT "$(res "$ID_G" 1 'conferi')")/$(conflitos 88888888000188 | cut -d: -f6-8)" "REG:vinculo_divergente:2:2|RD004|sim/2:2:true"
confirma 99999999000199 1200 incluir; vinculo 99999999000199 1200; confirma 99999999000199 1201 lookup
eq B9f "A faz ROLLBACK de uma v2 em conflito → B espera e não vê conflito (o registro é da MESMA transação)" "$(concorrente rb "$(v2 99999999000199 1201)" ROLLBACK "$(est 99999999000199)")" "CONF:false:vinculo_divergente:1:1|EST:1200:0|sim"

echo "── B10 anti-deriva (re-aplicar com o vivo mexido ABORTA)"
aborta_em() {
  if P -f "$MIG_USADA" > "$TMPD/re.log" 2>&1; then bad "$1" "$2 — re-aplicar PASSOU";
  elif grep -q "$3" "$TMPD/re.log"; then ok "$1" "$2";
  else bad "$1" "$2 — abortou fora do esperado: $(grep -m1 ERROR "$TMPD/re.log" | cut -c1-140)"; fi
}
P -c "ALTER FUNCTION public.radar_estado_cadastro_omie(text) STABLE"
aborta_em B10a "estado STABLE no vivo → TRAVA FALHOU" "TRAVA FALHOU: radar_estado_cadastro_omie(text) não é VOLATILE"
P -c "ALTER FUNCTION public.radar_estado_cadastro_omie(text) VOLATILE"
P -c "DROP FUNCTION public.radar_resolver_conflito_cadastro(bigint,integer,text)"
aborta_em B10b "tabela sem o resolver → PRE FALHOU (procedência desconhecida)" "PRE FALHOU: radar_cadastro_conflitos já existe sem public.radar_resolver_conflito_cadastro"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "✅ test-radar-cadastro-conflitos: todos os asserts passaram"
[ "$FAIL" -eq 0 ]
