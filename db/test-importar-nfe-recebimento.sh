#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════╗
# ║  test-importar-nfe-recebimento.sh — prova EXECUTADA da RPC transacional de recebimento   ║
# ║  de NF-e (db/2026-10-18-importar-nfe-recebimento-rpc.sql). Money-path: entrada de       ║
# ║  mercadoria.                                                                              ║
# ║                                                                                            ║
# ║  O que prova (PG17 descartável, SQL REAL do repo, aplicado 2× — idempotência):            ║
# ║   · importa cabeçalho+itens numa transação, com `origem`; reenvio idêntico = ja_importada ║
# ║     (N, nunca 2N); mesmo N com conteúdo diferente = divergente (cardinalidade não é       ║
# ║     certificado); repara `pendente` sem itens e sem sinais de uso (reparada_origem/_em,    ║
# ║     origem de criação intacta); bloqueia efetivado/em uso; lote vazio em cabeçalho novo    ║
# ║     = NFE03 sem gravar nada; NFE01/NFE02 por SQLSTATE (WHEN OTHERS re-lança);             ║
# ║     tipo que não cabe (ncm 9) aborta TUDO — nenhum cabeçalho órfão, reparo falho preserva ║
# ║     o cabeçalho anterior; UNIQUE(nfe_recebimento_id, sequencia) barra lote paralelo;       ║
# ║     ACL (anon/authenticated 42501 + has_function_privilege; service_role executa);         ║
# ║     falha registrada em nfe_importacao_falhas some no sucesso (mesma transação).          ║
# ║   · DUAS CONEXÕES, barreira OBSERVADA (pg_blocking_pids, nunca sleep):                     ║
# ║     webhook×sync na MESMA chave nova — a 2ª ESPERA e sai ja_importada, N itens;            ║
# ║     reconcile-no-meio — o UPDATE pendente→efetivado ESPERA o FOR UPDATE e, ao passar,      ║
# ║     promove um cabeçalho COM itens; reconcile ANTES → bloqueada.                           ║
# ║   · PRE anti-deriva: corpo vivo diferente → a aplicação aborta (A2) e nada muda.           ║
# ║                                                                                            ║
# ║  --falsificar: controle verde + 9 sabotagens num espelho em tmp (NUNCA no arquivo do       ║
# ║  repo), cada uma exigindo VERMELHO no assert ESPECÍFICO. Recibo:                           ║
# ║  `SABOTAGENS: <v> vermelhas / <f> falhas`.                                                 ║
# ║  Exit: 0 verde · 1 vermelho · 3 infra (barreira/âncora podre: nada a julgar).              ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL_REAL="$REPO_ROOT/db/2026-10-18-importar-nfe-recebimento-rpc.sql"
MODO=normal
[ "${1:-}" = "--falsificar" ] && MODO=falsificar
export PGVER=17
PORT="${PGPORT_TEST:-5497}"
SLUG="importar-nfe-recebimento"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
WORK="$(dirname "$DATA")/work"; mkdir -p "$WORK"
export LC_ALL=C LANG=C
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
[ -f "$SQL_REAL" ] || { echo "INFRA: SQL ausente em $SQL_REAL"; exit 3; }
# shellcheck disable=SC2329  # invocada pelo trap EXIT abaixo
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c autovacuum=off" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null

DBN="prove"
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$DBN" -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
PAPP() { local app="$1"; shift; env PGAPPNAME="$app" "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$DBN" -v ON_ERROR_STOP=1 -tA "$@"; }

# ── zona 1: o que a migration lê mas não cria (DDL de prod, 2026-10-18) ───────────────────────────
cat > "$WORK/prereq.sql" <<'SQL'
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- has_role de prod lê user_roles; aqui lê o GUC test.papel ('master'/'employee' = staff; outro = customer/anon).
CREATE OR REPLACE FUNCTION public.has_role(uid uuid, r public.app_role) RETURNS boolean LANGUAGE sql STABLE
  AS $f$ SELECT current_setting('test.papel', true) = r::text $f$;
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql
  AS $f$ BEGIN NEW.updated_at = now(); RETURN NEW; END $f$;
CREATE TABLE public.warehouses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE);
CREATE TABLE public.nfe_recebimentos (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    warehouse_id uuid NOT NULL REFERENCES public.warehouses(id),
    numero_nfe character varying(20) NOT NULL,
    serie_nfe character varying(5),
    chave_acesso character varying(44) NOT NULL UNIQUE,
    cnpj_emitente character varying(14) NOT NULL,
    razao_social_emitente text,
    data_emissao date,
    valor_total numeric(15,2),
    xml_completo text,
    status character varying(20) DEFAULT 'pendente'::character varying NOT NULL,
    omie_nfe_id bigint,
    omie_id_receb bigint,
    conferente_id uuid,
    conferido_at timestamp with time zone,
    efetivado_at timestamp with time zone,
    observacoes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    alterar_recebimento_ok boolean DEFAULT false NOT NULL,
    alterar_etapa_ok boolean DEFAULT false NOT NULL,
    concluir_recebimento_ok boolean DEFAULT false NOT NULL,
    cte_ok boolean DEFAULT false NOT NULL,
    efetivacao_erro text,
    efetivacao_tentativas integer DEFAULT 0 NOT NULL,
    efetivacao_lock_at timestamp with time zone
);
CREATE TABLE public.nfe_recebimento_itens (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    nfe_recebimento_id uuid NOT NULL REFERENCES public.nfe_recebimentos(id) ON DELETE CASCADE,
    sequencia integer NOT NULL,
    codigo_produto character varying(60),
    descricao text NOT NULL,
    ncm character varying(8),
    ean character varying(14),
    unidade_nfe character varying(10) NOT NULL,
    quantidade_nfe numeric(15,4) NOT NULL,
    valor_unitario numeric(15,4),
    valor_total numeric(15,2),
    unidade_estoque character varying(10),
    quantidade_convertida numeric(15,4),
    quantidade_conferida integer DEFAULT 0 NOT NULL,
    quantidade_esperada integer NOT NULL,
    status_item character varying(20) DEFAULT 'pendente'::character varying NOT NULL,
    observacao_divergencia text,
    produto_omie_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ajuste_estoque_ok boolean DEFAULT false NOT NULL,
    ajuste_estoque_omie_id text,
    ajuste_estoque_at timestamp with time zone
);
CREATE INDEX idx_nfe_recebimento_itens_nfe ON public.nfe_recebimento_itens USING btree (nfe_recebimento_id);
CREATE TRIGGER update_nfe_recebimentos_updated_at BEFORE UPDATE ON public.nfe_recebimentos
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.nfe_recebimentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nfe_recebimento_itens ENABLE ROW LEVEL SECURITY;
-- ACL de prod para o papel das edges (default do Supabase: service_role tem tudo; BYPASSRLS vem do stub).
GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
-- DEFAULT PRIVILEGES como na prod (Supabase): tabela nova nasce com ALL para anon/authenticated/service_role.
-- É o que fez o ensaio do db:aplicar abortar em A11 antes de o REVOKE entrar na migration — sem isto aqui,
-- a prova passava sem exercitar o REVOKE de authenticated.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
INSERT INTO public.warehouses (id, code) VALUES ('00000000-0000-0000-0000-00000000000b','OB'), ('00000000-0000-0000-0000-00000000000c','CC');
-- Construtores de payload (só do harness): cabeçalho e N itens 1..N (codigo P<i>, quantidade 10*i).
CREATE FUNCTION public.t_cab(chave text, wh uuid DEFAULT '00000000-0000-0000-0000-00000000000b', receb bigint DEFAULT 777) RETURNS jsonb LANGUAGE sql
  AS $f$ SELECT jsonb_build_object('warehouse_id', wh, 'numero_nfe', '123', 'serie_nfe', '1', 'chave_acesso', chave,
           'cnpj_emitente', '12345678000190', 'razao_social_emitente', 'Fornecedor', 'data_emissao', '2026-10-01',
           'valor_total', 99.9, 'xml_completo', NULL, 'status', 'efetivado', 'omie_nfe_id', 42, 'omie_id_receb', receb) $f$;
CREATE FUNCTION public.t_itens(n int, ncm text DEFAULT '29096090') RETURNS jsonb LANGUAGE sql
  AS $f$ SELECT coalesce(jsonb_agg(jsonb_build_object('sequencia', i, 'codigo_produto', 'P'||i, 'descricao', 'Item '||i,
           'ncm', ncm, 'ean', NULL, 'unidade_nfe', 'UN', 'quantidade_nfe', 10*i, 'valor_unitario', 1.5, 'valor_total', 15*i,
           'unidade_estoque', NULL, 'quantidade_convertida', NULL, 'quantidade_conferida', 99, 'quantidade_esperada', 10*i,
           'status_item', 'conferido', 'produto_omie_id', 1000+i, 'id', '11111111-1111-1111-1111-111111111111')), '[]'::jsonb)
         FROM generate_series(1, n) AS i $f$;
SQL

# ── sessões de fundo (A segura uma transação; B tenta passar) ─────────────────────────────────────
espera_arquivo() { local i=0; while [ "$i" -lt 300 ]; do [ -e "$1" ] && return 0; kill -0 "$2" 2>/dev/null || { [ -e "$1" ] && return 0; return 1; }; sleep 0.1; i=$((i+1)); done; return 2; }
abre_A() { # <sql da transação aberta> — fica em BEGIN até solta_A
  rm -f "$WORK/a.in" "$WORK/a.out" "$WORK/a.pronta"; mkfifo "$WORK/a.in"
  ( PAPP prova_A < "$WORK/a.in" > "$WORK/a.out" 2>&1; echo "RC_A=$?" >> "$WORK/a.out" ) &
  PID_A=$!
  exec 7> "$WORK/a.in"
  env printf '%s\n' "BEGIN;" "$1" "\\! touch $WORK/a.pronta" >&7 2>/dev/null || true
  espera_arquivo "$WORK/a.pronta" "$PID_A" || { echo "INFRA: sessão A não chegou à barreira"; cat "$WORK/a.out"; exit 3; }
}
solta_A() { env printf '%s\n' "COMMIT;" >&7 2>/dev/null || true; exec 7>&- 2>/dev/null || true; wait "$PID_A" 2>/dev/null || true; }
roda_B() { # <sql> — B em fundo; saída em b.out com RC_B
  rm -f "$WORK/b.out"
  ( PAPP prova_B -c "$1" > "$WORK/b.out" 2>&1; echo "RC_B=$?" >> "$WORK/b.out" ) &
  PID_B=$!
}
pid_de() { Pq -c "SELECT pid FROM pg_stat_activity WHERE application_name = '$1' AND datname = '$DBN' LIMIT 1"; }
# B está PRESO em A? Resposta POSITIVA (pid de A em pg_blocking_pids(B)), com teto e ramo "não sei".
observa_B() { # → BLOQUEADO | TERMINOU | SEM_VEREDITO
  local i=0 n pa; pa="$(pid_de prova_A)"
  while [ "$i" -lt 100 ]; do
    n="$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'prova_B' AND datname = '$DBN' AND ${pa:-0} = ANY(pg_blocking_pids(pid))" 2>/dev/null || echo 0)"
    [ "$n" = "1" ] && { echo BLOQUEADO; return; }
    kill -0 "$PID_B" 2>/dev/null || { echo TERMINOU; return; }
    sleep 0.1; i=$((i+1))
  done
  echo SEM_VEREDITO
}
espera_B() { wait "$PID_B" 2>/dev/null || true; }
saida_B() { grep -v '^RC_B=' "$WORK/b.out" | tr -d '\n'; }

# ── a suíte (reutilizada pelo controle e por cada sabotagem) ──────────────────────────────────────
PASS=0; FAIL=0; FALHAS=""
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); FALHAS="$FALHAS $1"; echo "  FAIL $1 — $2"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1" "esperado [$3], veio [$2]"; fi; }
# Negativo: o DO tem de LANÇAR a SQLSTATE esperada (o `RAISE 'NAO_LANCOU'` mata a vacuidade; WHEN OTHERS re-lança).
espera_sqlstate() { # <id> <sqlstate> <sql que deve falhar>
  if P -q -c "DO \$t\$ BEGIN $3; RAISE EXCEPTION 'NAO_LANCOU'; EXCEPTION WHEN SQLSTATE '$2' THEN NULL; WHEN OTHERS THEN RAISE; END \$t\$;" >"$WORK/neg.out" 2>&1
  then ok "$1 (SQLSTATE $2)"; else bad "$1" "não lançou $2: $(tail -1 "$WORK/neg.out" | cut -c1-160)"; fi
}
RPC="public.importar_nfe_recebimento"
chave() { printf '%044d' "$1"; }
res()   { printf '%s' "$1" | sed -n 's/.*"resultado": *"\([a-z_]*\)".*/\1/p'; }
campo() { printf '%s' "$1" | sed -n "s/.*\"$2\": *\([^,}]*\).*/\1/p" | tr -d '"'; }

suite() { # <arquivo sql a aplicar> <rótulo>
  local SQL="$1" ROT="$2" r k1 k2 k3 k4 k5 k6 k7 k8 k9 id n v
  PASS=0; FAIL=0; FALHAS=""
  "$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists "$DBN" >/dev/null
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$DBN"
  P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
  P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL
  P -q -f "$WORK/prereq.sql"
  echo "═══ $ROT — PG17 :$PORT · $(basename "$SQL") ═══"

  # A00 aplica o SQL REAL numa transação (como o db:aplicar) — e de novo (idempotente, PRE md5 igual).
  if P -1 -q -f "$SQL" >"$WORK/apply1.out" 2>&1; then ok "A00a aplicação 1 (uma transação)"; else bad "A00a" "aplicação falhou: $(grep -m1 -E 'ERROR|ERRO' "$WORK/apply1.out" | cut -c1-200)"; echo "PASS=$PASS  FAIL=$FAIL"; return 1; fi
  if P -1 -q -f "$SQL" >"$WORK/apply2.out" 2>&1; then ok "A00b re-aplicação é no-op (idempotente)"; else bad "A00b" "re-aplicação falhou: $(grep -m1 -E 'ERROR|ERRO' "$WORK/apply2.out" | cut -c1-200)"; fi

  k1="$(chave 1)"
  # A01 importa: cabeçalho + 3 itens, origem gravada, status FORÇADO pendente (payload dizia efetivado),
  #     conferência zerada e pendente (payload dizia 99/conferido), id do payload ignorado.
  r="$(Pq -c "SELECT $RPC(t_cab('$k1'), t_itens(3), 'sync')")"
  eq "A01a importada" "$(res "$r")" "importada"
  eq "A01b 3 itens no payload" "$(campo "$r" itens)" "3"
  id="$(campo "$r" id)"
  eq "A01c 3 itens gravados" "$(Pq -c "SELECT count(*) FROM nfe_recebimento_itens WHERE nfe_recebimento_id = '$id'")" "3"
  eq "A01d origem=sync · status=pendente · reparada_origem NULL" "$(Pq -c "SELECT origem||'·'||status||'·'||coalesce(reparada_origem,'∅') FROM nfe_recebimentos WHERE id = '$id'")" "sync·pendente·∅"
  eq "A01e conferência nasce 0/pendente (payload não manda)" "$(Pq -c "SELECT string_agg(DISTINCT quantidade_conferida||'/'||status_item, ',') FROM nfe_recebimento_itens WHERE nfe_recebimento_id = '$id'")" "0/pendente"
  eq "A01f id do payload ignorado (default)" "$(Pq -c "SELECT count(*) FROM nfe_recebimento_itens WHERE id = '11111111-1111-1111-1111-111111111111'")" "0"
  # A02 reenvio IDÊNTICO (resposta perdida + retry) → ja_importada, continua 3 (N, nunca 2N)
  r="$(Pq -c "SELECT $RPC(t_cab('$k1'), t_itens(3), 'webhook')")"
  eq "A02a reenvio idêntico = ja_importada" "$(res "$r")" "ja_importada"
  eq "A02b continua com 3 itens (nunca 2N)" "$(Pq -c "SELECT count(*) FROM nfe_recebimento_itens WHERE nfe_recebimento_id = '$id'")" "3"
  # A03 MESMA cardinalidade, OUTRO conteúdo (quantidade do item 2 diferente) → divergente, nada gravado
  r="$(Pq -c "SELECT $RPC(t_cab('$k1'), jsonb_set(t_itens(3), '{1,quantidade_nfe}', '21'), 'webhook')")"
  eq "A03a mesmo N, conteúdo diferente = divergente" "$(res "$r")" "divergente"
  eq "A03b motivo = conteudo dos itens" "$(campo "$r" motivo)" "conteudo dos itens"
  # A04 cardinalidade diferente → divergente {itens 3, esperados 2}
  r="$(Pq -c "SELECT $RPC(t_cab('$k1'), t_itens(2), 'sync')")"
  eq "A04a N diferente = divergente" "$(res "$r")" "divergente"
  eq "A04b esperados=2" "$(campo "$r" esperados)" "2"
  eq "A04c itens=3" "$(campo "$r" itens)" "3"
  # A05 payload sem itens sobre cabeçalho COM itens → NFE03 (vazio não certifica; adversarial: era a exceção ao conjunto)
  espera_sqlstate "A05 payload vazio sobre cabeçalho completo = NFE03 (não certifica)" "NFE03" "PERFORM $RPC(t_cab('$k1'), '[]'::jsonb, 'sync')"
  # A05b conjunto IGUAL mas cabeçalho de OUTRO armazém → divergente (compatibilidade vale antes de qualquer sucesso)
  r="$(Pq -c "SELECT $RPC(t_cab('$k1', '00000000-0000-0000-0000-00000000000c'), t_itens(3), 'webhook')")"
  eq "A05b conjunto igual + outro armazém = divergente (não certifica)" "$(res "$r")·$(campo "$r" motivo | cut -c1-9)" "divergente·cabecalho"
  r="$(Pq -c "SELECT $RPC(t_cab('$k1', '00000000-0000-0000-0000-00000000000b', 778), t_itens(3), 'webhook')")"
  eq "A05c conjunto igual + outro omie_id_receb = divergente" "$(res "$r")" "divergente"
  eq "A05d itens intactos (3)" "$(Pq -c "SELECT count(*) FROM nfe_recebimento_itens WHERE nfe_recebimento_id = '$id'")" "3"

  # A06 reparo: cabeçalho LEGADO pendente sem itens, origem NULL, omie_id_receb NULL → reparada;
  #     origem de criação segue NULL, reparada_origem=webhook, omie_id_receb preenchido (ausente→payload).
  k2="$(chave 2)"
  P -q -c "INSERT INTO nfe_recebimentos (warehouse_id, numero_nfe, chave_acesso, cnpj_emitente) VALUES ('00000000-0000-0000-0000-00000000000b','1','$k2','1')"
  r="$(Pq -c "SELECT $RPC(t_cab('$k2'), t_itens(2), 'webhook')")"
  eq "A06a legado pendente sem itens = reparada" "$(res "$r")" "reparada"
  eq "A06b 2 itens gravados" "$(Pq -c "SELECT count(*) FROM nfe_recebimento_itens i JOIN nfe_recebimentos r ON r.id = i.nfe_recebimento_id WHERE r.chave_acesso = '$k2'")" "2"
  eq "A06c origem segue NULL · reparada_origem=webhook · reparada_em preenchido · omie_id_receb preenchido" \
     "$(Pq -c "SELECT coalesce(origem,'∅')||'·'||reparada_origem||'·'||(reparada_em IS NOT NULL)||'·'||omie_id_receb FROM nfe_recebimentos WHERE chave_acesso = '$k2'")" "∅·webhook·true·777"
  # A07 bloqueada por STATUS não-pendente sem nenhum sinal de uso (falha_efetivacao, como o 1 de prod):
  #     só o gate de status segura — é ele que a sabotagem derruba. efetivado+efetivado_at está em A25.
  k3="$(chave 3)"
  P -q -c "INSERT INTO nfe_recebimentos (warehouse_id, numero_nfe, chave_acesso, cnpj_emitente, status) VALUES ('00000000-0000-0000-0000-00000000000b','1','$k3','1','falha_efetivacao')"
  r="$(Pq -c "SELECT $RPC(t_cab('$k3'), t_itens(2), 'webhook')")"
  eq "A07a falha_efetivacao sem itens = bloqueada" "$(res "$r")" "bloqueada"
  eq "A07b motivo = status falha_efetivacao" "$(campo "$r" motivo)" "status falha_efetivacao"
  eq "A07c nada gravado" "$(Pq -c "SELECT count(*) FROM nfe_recebimento_itens i JOIN nfe_recebimentos r ON r.id = i.nfe_recebimento_id WHERE r.chave_acesso = '$k3'")" "0"
  # A08 bloqueada por efetivacao_lock_at (pendente, em uso)
  k4="$(chave 4)"
  P -q -c "INSERT INTO nfe_recebimentos (warehouse_id, numero_nfe, chave_acesso, cnpj_emitente, efetivacao_lock_at) VALUES ('00000000-0000-0000-0000-00000000000b','1','$k4','1', now())"
  r="$(Pq -c "SELECT $RPC(t_cab('$k4'), t_itens(2), 'sync')")"
  eq "A08 pendente com lock de efetivação = bloqueada (em uso)" "$(res "$r")·$(campo "$r" motivo | cut -c1-6)" "bloqueada·em uso"
  # A09 reparo com cabeçalho de OUTRO armazém → divergente (não escolhe lado)
  k5="$(chave 5)"
  P -q -c "INSERT INTO nfe_recebimentos (warehouse_id, numero_nfe, chave_acesso, cnpj_emitente, omie_id_receb) VALUES ('00000000-0000-0000-0000-00000000000b','1','$k5','1', 777)"
  r="$(Pq -c "SELECT $RPC(t_cab('$k5', '00000000-0000-0000-0000-00000000000c'), t_itens(2), 'sync')")"
  eq "A09a outro armazém no reparo = divergente" "$(res "$r")" "divergente"
  r="$(Pq -c "SELECT $RPC(t_cab('$k5', '00000000-0000-0000-0000-00000000000b', 778), t_itens(2), 'sync')")"
  eq "A09b outro omie_id_receb no reparo = divergente" "$(res "$r")" "divergente"
  eq "A09c nada gravado" "$(Pq -c "SELECT count(*) FROM nfe_recebimento_itens i JOIN nfe_recebimentos r ON r.id = i.nfe_recebimento_id WHERE r.chave_acesso = '$k5'")" "0"
  # A10 sem itens no banco E no payload → NFE03 (nada gravado, nada certificado)
  espera_sqlstate "A10 vazio sobre vazio = NFE03" "NFE03" "PERFORM $RPC(t_cab('$k5'), '[]'::jsonb, 'sync')"

  # Negativos — SQLSTATE esperada, WHEN OTHERS re-lança.
  k6="$(chave 6)"
  espera_sqlstate "A11 chave com 43 dígitos = NFE01" "NFE01" "PERFORM $RPC(t_cab('$(printf '%043d' 6)'), t_itens(1), 'sync')"
  espera_sqlstate "A12 origem fora do vocabulário = NFE01" "NFE01" "PERFORM $RPC(t_cab('$k6'), t_itens(1), 'cron')"
  espera_sqlstate "A13 item sem sequência = NFE01" "NFE01" "PERFORM $RPC(t_cab('$k6'), (t_itens(1) - 0) || '[{\"descricao\":\"x\"}]'::jsonb, 'sync')"
  espera_sqlstate "A14 sequência repetida (\"01\" e 1 são a MESMA) = NFE02" "NFE02" "PERFORM $RPC(t_cab('$k6'), t_itens(1) || jsonb_set(t_itens(1), '{0,sequencia}', '\"01\"'), 'sync')"
  espera_sqlstate "A15 lote vazio em cabeçalho novo = NFE03" "NFE03" "PERFORM $RPC(t_cab('$k6'), '[]'::jsonb, 'sync')"
  espera_sqlstate "A15b lote JSON null em cabeçalho novo = NFE03" "NFE03" "PERFORM $RPC(t_cab('$k6'), 'null'::jsonb, 'sync')"
  espera_sqlstate "A16 itens não-array = NFE01" "NFE01" "PERFORM $RPC(t_cab('$k6'), '{}'::jsonb, 'sync')"
  eq "A17 nenhum cabeçalho ficou dos negativos (chave 6)" "$(Pq -c "SELECT count(*) FROM nfe_recebimentos WHERE chave_acesso = '$k6'")" "0"
  # A18 rollback total: ncm com 9 chars → 22001 na transação INTEIRA — nenhum cabeçalho órfão
  espera_sqlstate "A18a ncm de 9 chars = 22001 (string_data_right_truncation)" "22001" "PERFORM $RPC(t_cab('$k6'), t_itens(2, '290960901'), 'sync')"
  eq "A18b cabeçalho NÃO ficou (rollback total)" "$(Pq -c "SELECT count(*) FROM nfe_recebimentos WHERE chave_acesso = '$k6'")" "0"
  # A19 reparo que falha PRESERVA o cabeçalho anterior (não apaga trabalho de ninguém)
  k7="$(chave 7)"
  P -q -c "INSERT INTO nfe_recebimentos (warehouse_id, numero_nfe, chave_acesso, cnpj_emitente) VALUES ('00000000-0000-0000-0000-00000000000b','1','$k7','1')"
  espera_sqlstate "A19a reparo com ncm inválido = 22001" "22001" "PERFORM $RPC(t_cab('$k7'), t_itens(2, '290960901'), 'webhook')"
  eq "A19b cabeçalho anterior preservado, ainda sem itens e sem reparada_origem" "$(Pq -c "SELECT count(*)||'·'||coalesce(max(reparada_origem),'∅') FROM nfe_recebimentos WHERE chave_acesso = '$k7'")" "1·∅"
  # A20 UNIQUE direto: 2ª linha com o mesmo (recebimento, sequencia) por fora da RPC → 23505 NESSA constraint
  if P -q -c "DO \$t\$ BEGIN INSERT INTO nfe_recebimento_itens (nfe_recebimento_id, sequencia, descricao, unidade_nfe, quantidade_nfe, quantidade_esperada) VALUES ('$id', 1, 'dup', 'UN', 1, 1); RAISE EXCEPTION 'NAO_LANCOU'; EXCEPTION WHEN unique_violation THEN IF SQLERRM NOT LIKE '%nfe_recebimento_itens_recebimento_sequencia_key%' THEN RAISE; END IF; WHEN OTHERS THEN RAISE; END \$t\$;" >"$WORK/neg.out" 2>&1
  then ok "A20 UNIQUE(nfe_recebimento_id, sequencia) barra o 2º lote por fora da RPC"; else bad "A20" "lote duplicado passou ou outra constraint: $(tail -1 "$WORK/neg.out" | cut -c1-160)"; fi
  # A21 ACL: anon/authenticated 42501 (e has_function_privilege diz que NÃO podem); service_role executa
  espera_sqlstate "A21a anon = 42501" "42501" "SET LOCAL ROLE anon; PERFORM $RPC(t_cab('$k1'), t_itens(3), 'sync')"
  espera_sqlstate "A21b authenticated = 42501" "42501" "SET LOCAL ROLE authenticated; PERFORM $RPC(t_cab('$k1'), t_itens(3), 'sync')"
  eq "A21c has_function_privilege: public/anon/authenticated=f · service_role=t" \
     "$(Pq -c "SELECT has_function_privilege('public','$RPC(jsonb,jsonb,text)','EXECUTE')::text||has_function_privilege('anon','$RPC(jsonb,jsonb,text)','EXECUTE')::text||has_function_privilege('authenticated','$RPC(jsonb,jsonb,text)','EXECUTE')::text||has_function_privilege('service_role','$RPC(jsonb,jsonb,text)','EXECUTE')::text")" "falsefalsefalsetrue"
  r="$(Pq -c "SET ROLE service_role" -c "SELECT $RPC(t_cab('$k1'), t_itens(3), 'sync')" | tail -1)"
  eq "A21d service_role executa (ja_importada)" "$(res "$r")" "ja_importada"
  eq "A21e RPC é SECURITY INVOKER" "$(Pq -c "SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('$RPC(jsonb,jsonb,text)')")" "f"
  # A22 registro durável de falha some no SUCESSO (mesma transação)
  k8="$(chave 8)"
  P -q -c "INSERT INTO nfe_importacao_falhas (chave_acesso, origem, erro, sqlstate, tentativas) VALUES ('$k8','sync','ncm','22001',3)"
  r="$(Pq -c "SELECT $RPC(t_cab('$k8'), t_itens(1), 'sync')")"
  eq "A22a importou" "$(res "$r")" "importada"
  eq "A22b falha apagada no sucesso" "$(Pq -c "SELECT count(*) FROM nfe_importacao_falhas WHERE chave_acesso = '$k8'")" "0"
  eq "A22c nfe_importacao_falhas com RLS e 2 policies" "$(Pq -c "SELECT relrowsecurity||'·'||(SELECT count(*) FROM pg_policies WHERE tablename='nfe_importacao_falhas') FROM pg_class WHERE relname='nfe_importacao_falhas'")" "true·2"
  espera_sqlstate "A22d falha com chave inválida = 23514 (CHECK)" "23514" "INSERT INTO nfe_importacao_falhas (chave_acesso, origem, erro) VALUES ('abc','sync','x')"
  # A22e–h AUTORIZAÇÃO real (não só contar policies): staff lê · customer vê 0 · anon 42501 · authenticated não escreve · service_role escreve
  P -q -c "INSERT INTO nfe_importacao_falhas (chave_acesso, origem, erro) VALUES ('$(chave 99)','sync','seed')"
  # (`-1`: os -c numa transação só — fora dela o SET LOCAL é no-op e a leitura corre como superuser,
  #  e o assert do staff passaria por VACUIDADE; o do customer é o que denunciou.)
  eq "A22e staff (employee) lê o ledger" "$(Pq -1 -c "SET LOCAL ROLE authenticated" -c "SET LOCAL test.papel = 'employee'" -c "SELECT count(*) FROM nfe_importacao_falhas WHERE chave_acesso = '$(chave 99)'" | tail -1)" "1"
  eq "A22f customer vê 0 (RLS, não erro)" "$(Pq -1 -c "SET LOCAL ROLE authenticated" -c "SET LOCAL test.papel = 'customer'" -c "SELECT count(*) FROM nfe_importacao_falhas" | tail -1)" "0"
  eq "A22f' customer de verdade correu como authenticated (não superuser)" "$(Pq -1 -c "SET LOCAL ROLE authenticated" -c "SELECT current_user" | tail -1)" "authenticated"
  espera_sqlstate "A22g anon = 42501 na tabela" "42501" "SET LOCAL ROLE anon; PERFORM count(*) FROM nfe_importacao_falhas"
  espera_sqlstate "A22h authenticated (staff) NÃO escreve = 42501" "42501" "SET LOCAL ROLE authenticated; SET LOCAL test.papel = 'master'; INSERT INTO nfe_importacao_falhas (chave_acesso, origem, erro) VALUES ('$(chave 98)','sync','x')"
  eq "A22i service_role escreve (grant explícito + BYPASSRLS)" "$(Pq -c "SET ROLE service_role" -c "SELECT nfe_importacao_falha_registrar('$(chave 97)','webhook','NFE02','x')" | tail -1)" "1"

  # ── corridas: DUAS conexões, barreira OBSERVADA ─────────────────────────────────────────────
  # A23 webhook × sync na MESMA chave NOVA: A (sync) segura a transação com o cabeçalho inserido;
  #     B (webhook) tem de ficar PRESO em A (advisory lock — não há linha para FOR UPDATE), e ao
  #     soltar sai ja_importada com 3 itens. Sem o advisory: B não vê o cabeçalho, insere o seu,
  #     prende no índice UNIQUE e sai 23505 — nunca ja_importada.
  k9="$(chave 9)"
  abre_A "SELECT $RPC(t_cab('$k9'), t_itens(3), 'sync');"
  roda_B "SELECT $RPC(t_cab('$k9'), t_itens(3), 'webhook')"
  v="$(observa_B)"
  eq "A23a B (webhook) PRESO em A (sync) na chave nova — pg_blocking_pids" "$v" "BLOQUEADO"
  solta_A; espera_B
  r="$(saida_B)"
  eq "A23b B saiu ja_importada com 3 itens" "$(res "$r")·$(campo "$r" itens)" "ja_importada·3"
  eq "A23c total 3 itens (N, nunca 2N), 1 cabeçalho, origem=sync" "$(Pq -c "SELECT (SELECT count(*) FROM nfe_recebimento_itens i JOIN nfe_recebimentos r ON r.id=i.nfe_recebimento_id WHERE r.chave_acesso='$k9')||'·'||(SELECT count(*)||'·'||max(origem) FROM nfe_recebimentos WHERE chave_acesso='$k9')")" "3·1·sync"
  # A24 reconcile-no-meio: cabeçalho pendente sem itens; A repara e segura; B (reconcile) tenta
  #     promover pendente→efetivado e tem de ficar PRESO (FOR UPDATE); ao soltar, promove um
  #     cabeçalho COM itens (1 linha). Sem o FOR UPDATE, B não espera e commita efetivado enquanto A
  #     injeta itens — "B bloqueado" fica vermelho.
  k1="$(chave 10)"
  P -q -c "INSERT INTO nfe_recebimentos (warehouse_id, numero_nfe, chave_acesso, cnpj_emitente) VALUES ('00000000-0000-0000-0000-00000000000b','1','$k1','1')"
  abre_A "SELECT $RPC(t_cab('$k1'), t_itens(2), 'webhook');"
  roda_B "UPDATE nfe_recebimentos SET status = 'efetivado', efetivado_at = now() WHERE chave_acesso = '$k1' AND status = 'pendente' RETURNING id"
  v="$(observa_B)"
  eq "A24a reconcile PRESO no FOR UPDATE da RPC" "$v" "BLOQUEADO"
  solta_A; espera_B
  eq "A24b reconcile promoveu 1 linha depois do commit da RPC" "$(grep -c -E '^[0-9a-f-]{36}$' "$WORK/b.out" || true)" "1"
  eq "A24c cabeçalho efetivado COM 2 itens (nunca efetivado sem itens pela corrida)" "$(Pq -c "SELECT r.status||'·'||count(i.id) FROM nfe_recebimentos r LEFT JOIN nfe_recebimento_itens i ON i.nfe_recebimento_id=r.id WHERE r.chave_acesso='$k1' GROUP BY r.status")" "efetivado·2"
  # (Falsificação: sem o FOR UPDATE a RPC AINDA bloqueia — no UPDATE do reparo —, então "B preso" fica
  #  verde; o que fica vermelho é A24f: itens injetados num cabeçalho efetivado. E conceder EXECUTE a
  #  anon mantém o 42501 — vindo da TABELA, não da função —, então a testemunha é A21c, o
  #  has_function_privilege, nunca só o SQLSTATE.)
  # A24-B o reconcile segura PRIMEIRO (UPDATE sem commit); a RPC (B) tem de ficar PRESA no FOR UPDATE
  #       e, quando o reconcile commita, reler a tupla promovida → bloqueada, 0 itens. SEM o FOR
  #       UPDATE a RPC lê 'pendente' sem travar, prende só no UPDATE do reparo e, ao passar, injeta
  #       itens num cabeçalho efetivado (reparada) — a janela SELECT→UPDATE que o FOR UPDATE fecha.
  k1="$(chave 12)"
  P -q -c "INSERT INTO nfe_recebimentos (warehouse_id, numero_nfe, chave_acesso, cnpj_emitente) VALUES ('00000000-0000-0000-0000-00000000000b','1','$k1','1')"
  abre_A "UPDATE nfe_recebimentos SET status = 'efetivado', efetivado_at = now() WHERE chave_acesso = '$k1' AND status = 'pendente';"
  roda_B "SELECT $RPC(t_cab('$k1'), t_itens(2), 'webhook')"
  v="$(observa_B)"
  eq "A24d RPC PRESA no reconcile que segura a linha" "$v" "BLOQUEADO"
  solta_A; espera_B
  r="$(saida_B)"
  eq "A24e RPC releu a tupla promovida: bloqueada (status efetivado)" "$(res "$r")·$(campo "$r" motivo)" "bloqueada·status efetivado"
  eq "A24f nenhum item injetado no efetivado" "$(Pq -c "SELECT count(*) FROM nfe_recebimento_itens i JOIN nfe_recebimentos r ON r.id=i.nfe_recebimento_id WHERE r.chave_acesso='$k1'")" "0"
  # A25 reconcile ANTES: promovido e commitado antes da RPC → bloqueada (status efetivado)
  k1="$(chave 11)"
  P -q -c "INSERT INTO nfe_recebimentos (warehouse_id, numero_nfe, chave_acesso, cnpj_emitente) VALUES ('00000000-0000-0000-0000-00000000000b','1','$k1','1'); UPDATE nfe_recebimentos SET status='efetivado', efetivado_at=now() WHERE chave_acesso='$k1'"
  r="$(Pq -c "SELECT $RPC(t_cab('$k1'), t_itens(2), 'webhook')")"
  eq "A25 reconcile antes = bloqueada (status efetivado)" "$(res "$r")·$(campo "$r" motivo)" "bloqueada·status efetivado"

  # A27 registro de falha: tentativas+1 atômico, metadados preenchidos, ACL só service_role
  k1="$(chave 13)"
  eq "A27a 1ª falha = tentativas 1" "$(Pq -c "SELECT nfe_importacao_falha_registrar('$k1','sync','22001','ncm')")" "1"
  eq "A27b 2ª falha = tentativas 2 (incremento atômico)" "$(Pq -c "SELECT nfe_importacao_falha_registrar('$k1','webhook','NFE02','seq', NULL, 555)")" "2"
  eq "A27b' origem/erro/omie_id_receb atualizados" "$(Pq -c "SELECT origem||'·'||erro||'·'||omie_id_receb FROM nfe_importacao_falhas WHERE chave_acesso='$k1'")" "webhook·seq·555"
  espera_sqlstate "A27c anon não registra falha = 42501" "42501" "SET LOCAL ROLE anon; PERFORM nfe_importacao_falha_registrar('$k1','sync','x','y')"
  eq "A27d has_function_privilege do registrar: public/anon/authenticated=f · service_role=t" \
     "$(Pq -c "SELECT has_function_privilege('public','public.nfe_importacao_falha_registrar(text,text,text,text,uuid,bigint)','EXECUTE')::text||has_function_privilege('anon','public.nfe_importacao_falha_registrar(text,text,text,text,uuid,bigint)','EXECUTE')::text||has_function_privilege('authenticated','public.nfe_importacao_falha_registrar(text,text,text,text,uuid,bigint)','EXECUTE')::text||has_function_privilege('service_role','public.nfe_importacao_falha_registrar(text,text,text,text,uuid,bigint)','EXECUTE')::text")" "falsefalsefalsetrue"

  # A26 PRE anti-deriva: corpo vivo DIFERENTE → a re-aplicação aborta em A2 e o vivo não muda
  P -q -c "CREATE OR REPLACE FUNCTION $RPC(p_cabecalho jsonb, p_itens jsonb, p_origem text) RETURNS jsonb LANGUAGE plpgsql AS \$x\$ BEGIN RETURN '{\"resultado\":\"outro\"}'::jsonb; END \$x\$;"
  if P -1 -q -f "$SQL" >"$WORK/apply3.out" 2>&1; then bad "A26a" "re-aplicação sobre corpo DIFERENTE devia abortar (A2) e passou"; else
    if grep -q 'A2 FALHOU' "$WORK/apply3.out"; then ok "A26a corpo vivo diferente → aplicação aborta em A2"; else bad "A26a" "abortou por OUTRO motivo: $(grep -m1 -E 'ERROR|ERRO' "$WORK/apply3.out" | cut -c1-160)"; fi; fi
  eq "A26b o corpo vivo não foi tocado (rollback)" "$(Pq -c "SELECT ($RPC('{}'::jsonb,'[]'::jsonb,'x')->>'resultado')")" "outro"

  echo "──────────────────────────────"
  echo "PASS=$PASS  FAIL=$FAIL"
  [ "$FAIL" -eq 0 ]
}

if [ "$MODO" = "normal" ]; then
  if suite "$SQL_REAL" "prova"; then echo "✅ HARNESS VERDE"; exit 0; else echo "❌ HARNESS VERMELHO"; exit 1; fi
fi

# ── --falsificar: controle verde + sabotagens num ESPELHO (nunca no arquivo do repo) ──────────────
echo "═══ CONTROLE (SQL real) ═══"
if ! suite "$SQL_REAL" "controle" >"$WORK/controle.log" 2>&1; then echo "INFRA: o controle não ficou verde — sem linha de base, sabotar é teatro"; tail -20 "$WORK/controle.log"; exit 3; fi
echo "  controle verde ($(grep -o 'PASS=[0-9]*' "$WORK/controle.log"))"
VERMELHAS=0; FALHOU=0
# Cada sabotagem: nome:ASSERT_QUE_TEM_DE_FICAR_VERMELHO. O `case` abaixo traduz o nome em `sed` sobre um
# ESPELHO (nunca no arquivo do repo); a suíte roda inteira e o veredito exige o `FAIL <assert>` NO LOG —
# vermelho em outro lugar é falha da falsificação, não aprovação.
SABOTAGENS="sem_advisory_lock:A23b sem_for_update:A24f unique_vira_check:A20 execute_para_anon:A21c
            gate_de_status:A07a nfe02_desligado:A14 so_cardinalidade:A03a origem_nao_gravada:A01d
            sem_compatibilidade:A05b"
seds_de() { # <nome> → expressões sed, uma por linha
  case "$1" in
    sem_advisory_lock)   echo '/pg_advisory_xact_lock(hashtext/d' ;;
    sem_for_update)      echo 's/ FOR UPDATE;/;/' ;;
    unique_vira_check)   echo 's/UNIQUE (nfe_recebimento_id, sequencia);/CHECK (true);/'; echo "s/AND contype = 'u' AND convalidated/AND convalidated/" ;;
    execute_para_anon)   echo 's/^REVOKE ALL ON FUNCTION public.importar_nfe_recebimento(jsonb, jsonb, text) FROM anon;/GRANT EXECUTE ON FUNCTION public.importar_nfe_recebimento(jsonb, jsonb, text) TO anon;/'; echo "s/OR has_function_privilege('anon', v_oid, 'EXECUTE')/OR false/" ;;
    gate_de_status)      echo "s/IF NOT (v_cab.status = 'pendente'/IF NOT (true/" ;;
    nfe02_desligado)     echo 's/IF v_repetidas > 0 THEN/IF false THEN/' ;;
    so_cardinalidade)    echo 's/IF v_existentes IS DISTINCT FROM v_n OR v_diferentes > 0 THEN/IF v_existentes IS DISTINCT FROM v_n THEN/' ;;
    origem_nao_gravada)  echo "s/c.omie_nfe_id, c.omie_id_receb, p_origem/c.omie_nfe_id, c.omie_id_receb, NULL/" ;;
    sem_compatibilidade) echo "s/IF (v_novo.warehouse_id IS NOT NULL AND v_novo.warehouse_id IS DISTINCT FROM v_cab.warehouse_id)/IF (false)/" ;;
    *) return 1 ;;
  esac
}
echo "═══ SABOTAGENS ═══"
for item in $SABOTAGENS; do
  sab="${item%%:*}"; esperado="${item#*:}"
  esp="$WORK/espelho.sql"; cp "$SQL_REAL" "$esp"
  seds_de "$sab" > "$WORK/seds.txt" || { echo "  INFRA $sab — sabotagem sem tradução"; FALHOU=$((FALHOU+1)); continue; }
  while IFS= read -r e; do sed "$e" "$esp" > "$esp.tmp" && mv "$esp.tmp" "$esp"; done < "$WORK/seds.txt"
  if cmp -s "$SQL_REAL" "$esp"; then echo "  INFRA $sab — o sed não mudou nada (âncora podre)"; FALHOU=$((FALHOU+1)); continue; fi
  if suite "$esp" "sabotagem: $sab" > "$WORK/$sab.log" 2>&1; then
    echo "  FALHA $sab — a suíte seguiu VERDE: o assert $esperado não tem dente"; FALHOU=$((FALHOU+1))
  elif grep -q "FAIL $esperado " "$WORK/$sab.log"; then
    echo "  VERMELHA $sab → $esperado ($(grep -o 'FAIL=[0-9]*' "$WORK/$sab.log"))"; VERMELHAS=$((VERMELHAS+1))
  else
    echo "  FALHA $sab — ficou vermelha, mas NÃO em $esperado: $(grep -o 'FAIL A[0-9a-z]*' "$WORK/$sab.log" | tr '\n' ' ')"; FALHOU=$((FALHOU+1))
  fi
done
echo "──────────────────────────────"
echo "SABOTAGENS: $VERMELHAS vermelhas / $FALHOU falhas"
if [ "$FALHOU" -eq 0 ]; then echo "FALSIFICACAO OK — todo verde tem vermelho alcancavel, e pelo motivo certo"; exit 0; fi
echo "❌ FALSIFICACAO FALHOU"; exit 1
