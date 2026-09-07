#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════════════════╗
# ║  `disparado_simulado` e um estado POS-DISPARO — prova em PG17 descartavel.                  ║
# ║                                                                                             ║
# ║  bash db/test-disparado-simulado-pos-disparo.sh   (NAO pipe pra tail — engole o exit≠0)      ║
# ║  2o locale:  HARNESS_LC=pt_BR.UTF-8 bash db/test-disparado-simulado-pos-disparo.sh           ║
# ║                                                                                             ║
# ║  GRUPOS                                                                                     ║
# ║   B  baseline   — ANTES da migration: o buraco EXISTE (tem de estar vermelho depois do fix) ║
# ║   C  o veto     — dry_run nao e mais cancelavel, por NENHUMA via de escrita                 ║
# ║   S  a saida    — corrigir_cancelamento_pos_disparo ACEITA o estado, com trilha             ║
# ║   A  ACL        — anon nao executa; e o eixo e falsificado (senao mede tabela, nao EXECUTE) ║
# ║   F  falsificacao — sabota UMA camada por vez e exige o vermelho CERTO, com CONTROLE verde  ║
# ║   Z  restore    — depois de todas as sabotagens, o corpo real ainda esta la                 ║
# ║                                                                                             ║
# ║  A TESTEMUNHA DO OMIE mora em `omie_testemunha`, escrita em transacao PROPRIA: "o PO existe" ║
# ║  tem de sobreviver ao rollback da transacao que o teste avalia.                              ║
# ╚════════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5478}"
SLUG="disparado-simulado"
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
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET TimeZone='UTC';"
# ── DOIS LOCALES (licao #1483: falsificar num ambiente so nao prova a asercao) ──────────────
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

AMOSTRA_MSG=$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA -c "SELECT 1/0;" 2>&1 | head -1) || true
echo "=== setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ==="
echo "=== controle do eixo de locale, mensagem do servidor: $AMOSTRA_MSG"

# ═══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRE-REQUISITOS (so o que as funcoes leem/escrevem; tipos da PROD via psql-ro 2026-09-07)
# ═══════════════════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.pedido_compra_sugerido (
  id                         bigserial PRIMARY KEY,
  empresa                    text NOT NULL,
  fornecedor_nome            text,
  status                     text NOT NULL DEFAULT 'pendente_aprovacao',
  status_envio_portal        text DEFAULT 'nao_aplicavel',
  portal_proximo_retry_em    timestamptz,
  cancelado_por              text,
  cancelado_em               timestamptz,
  justificativa_cancelamento text,
  horario_disparo_real       timestamptz,
  omie_pedido_compra_id      text,
  valor_total                numeric,
  atualizado_em              timestamptz DEFAULT now(),
  cancelamento_pos_disparo_motivo    text,
  cancelamento_pos_disparo_evidencia text,
  cancelamento_pos_disparo_por       text,
  cancelamento_pos_disparo_em        timestamptz
);

-- A testemunha do efeito EXTERNO (o PO no Omie). Escrita em transacao propria -- sobrevive ao
-- rollback da transacao que o teste avalia. Sem isso, "o PO existe" seria afirmado pela mesma
-- transacao sob julgamento.
CREATE TABLE public.omie_testemunha (
  pedido_id bigint PRIMARY KEY,
  po        text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- has_role/app_role: o gate de papel de corrigir_cancelamento_pos_disparo depende deles.
DO $t$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
  END IF;
END $t$;
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_uid uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_uid AND role=_role) $f$;
SQL

# ═══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — AS MIGRATIONS REAIS (Lei #1)
#   BASELINE = o corpo que roda em PRODUCAO HOJE. Conferido byte-a-byte via psql-ro/pg_get_functiondef
#   em 2026-09-07: trigger+audit da 152235, `cancelar_pedido_sugerido` da **170000** (NAO da 224959 —
#   a prod esta a frente daquele arquivo) e o gate canonico da 172718.
#   MIG = esta entrega, aplicada do arquivo REAL.
# ⚠️ O baseline nao e "um stub da logica": e o SQL commitado que hoje esta no ar. E o que faz o
#    grupo B medir o buraco de verdade em vez de uma caricatura dele.
# ═══════════════════════════════════════════════════════════════════════════════════════════
MIG_TRG="$REPO_ROOT/supabase/migrations/20260906152235_cancelamento_pos_disparo_trigger_e_rpc.sql"
MIG_SELO="$REPO_ROOT/supabase/migrations/20260906170000_reposicao_selo_aprovacao_m1_expandir.sql"
MIG_GATE="$REPO_ROOT/supabase/migrations/20260906172718_cancelamento_pos_disparo_gate_canonico.sql"
MIG="$REPO_ROOT/supabase/migrations/20260907095841_disparado_simulado_e_estado_pos_disparo.sql"
for f in "$MIG_TRG" "$MIG_SELO" "$MIG_GATE" "$MIG"; do
  [ -s "$f" ] || { echo "INFRA: migration ausente: $f"; exit 1; }
done

# Extrator de UM statement `CREATE OR REPLACE FUNCTION` de um .sql, resolvendo a tag de
# dollar-quote real do arquivo (as migrations usam $$, $trg$ e $function$ — sed fixo erraria).
extrai_funcao() {  # $1=arquivo  $2=nome da funcao
  python3 - "$1" "$2" <<'PY'
import re,sys,pathlib
t=pathlib.Path(sys.argv[1]).read_text()
i=t.find(f"CREATE OR REPLACE FUNCTION public.{sys.argv[2]}")
if i<0: sys.exit(f"nao achei {sys.argv[2]} em {sys.argv[1]}")
m=re.compile(r"AS \$(\w*)\$").search(t,i)
tag=m.group(1); end=t.find(f"${tag}$", m.end())
if end<0: sys.exit("dollar-quote nao fechou")
print(t[i:end+len(tag)+2].rstrip()+";")
PY
}

# O baseline do trigger + a tabela de trilha vem da migration INTEIRA (ela cria os dois).
P -q -f "$MIG_TRG"
# `cancelar_pedido_sugerido` canonico sai da 170000 (o resto daquela migration e de outro dominio).
extrai_funcao "$MIG_SELO" "cancelar_pedido_sugerido" > /tmp/base-cancelar-$$.sql
P -q -f /tmp/base-cancelar-$$.sql
P -q -f "$MIG_GATE"
# O ACL que a prod tem (medido: anon=false, authenticated=true, service_role=true).
P -q <<'SQL'
REVOKE ALL ON FUNCTION public.cancelar_pedido_sugerido(bigint,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancelar_pedido_sugerido(bigint,text,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.corrigir_cancelamento_pos_disparo(bigint,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.corrigir_cancelamento_pos_disparo(bigint,text,text,text,text) TO authenticated, service_role;
SQL
echo "=== baseline aplicado (o corpo que roda em prod HOJE) ==="

# ═══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + helpers
# ═══════════════════════════════════════════════════════════════════════════════════════════
UID_STAFF='11111111-1111-1111-1111-111111111111'
semear() {
  P -q <<SQL
TRUNCATE public.pedido_compra_sugerido RESTART IDENTITY CASCADE;
TRUNCATE public.omie_testemunha;
TRUNCATE public.reposicao_cancelamento_pos_disparo_audit RESTART IDENTITY;
TRUNCATE public.user_roles;
INSERT INTO public.user_roles (user_id, role) VALUES ('$UID_STAFF', 'employee');
INSERT INTO public.pedido_compra_sugerido
  (id, empresa, status, status_envio_portal, horario_disparo_real, omie_pedido_compra_id, valor_total) VALUES
  (1, 'COLACOR', 'pendente_aprovacao',          'nao_aplicavel', NULL,                                    NULL,          900),
  (2, 'COLACOR', 'aprovado_aguardando_disparo', 'nao_aplicavel', NULL,                                    NULL,          800),
  (4, 'OBEN',    'disparado',                   'enviado_portal', timestamptz '2026-09-01 10:00:00+00',   '12100000001', 700),
  (5, 'OBEN',    'concluido_recebido',          'enviado_portal', timestamptz '2026-08-20 09:00:00+00',   '12100000002', 600),
  -- 8 e o caso desta entrega: dry_run de empresa SEM linha em empresa_configuracao_custos.
  (8, 'COLACOR', 'disparado_simulado',          'nao_aplicavel',  timestamptz '2026-09-02 11:00:00+00',   '12100000008', 1234.56),
  (9, 'COLACOR', 'disparado_simulado',          'nao_aplicavel',  timestamptz '2026-09-02 11:05:00+00',   '12100000009', 55.40);
SQL
  # A TESTEMUNHA: transacao PROPRIA (cada `psql -c` e a sua). O PO existe no fornecedor
  # independentemente do que a transacao sob teste decidir.
  P -q -c "INSERT INTO public.omie_testemunha (pedido_id, po) VALUES (8,'12100000008'),(9,'12100000009');"
}
campo() { Pq -c "SELECT COALESCE(${2}::text,'<null>') FROM public.pedido_compra_sugerido WHERE id=$1;"; }
n_trilha() { Pq -c "SELECT count(*)::text FROM public.reposicao_cancelamento_pos_disparo_audit;"; }

# Normaliza os DOIS desfechos possiveis: o jsonb que a RPC devolve, ou `EXC:[SENTINELA]` quando o
# trigger aborta. As sentinelas sao ASCII de caixa fixa -> o assert nao depende do locale das
# mensagens do servidor. A sentinela do TESTE nunca contem o texto que o codigo emite alem do
# proprio marcador, entao um `grep` frouxo nao consegue casar consigo mesmo.
extrai_sentinela() { printf '%s' "$1" | grep -oE '\[[A-Z0-9-]+\]' | head -1; }
cancelar_x() {
  local out rc
  set +e; out="$(Pq -c "SELECT public.cancelar_pedido_sugerido($1, 'lucas', 'motivo do teste')::text;" 2>&1)"; rc=$?; set -e
  if [ $rc -ne 0 ]; then printf 'EXC:%s' "$(extrai_sentinela "$out")"; else printf '%s' "$out"; fi
}
# UPDATE cru: a via de escrita que NAO passa por RPC nenhuma. E o que so um trigger cobre.
update_cru() {
  local out rc
  set +e; out="$(Pq -c "UPDATE public.pedido_compra_sugerido SET status='cancelado_humano' WHERE id=$1;" 2>&1)"; rc=$?; set -e
  if [ $rc -ne 0 ]; then printf 'EXC:%s' "$(extrai_sentinela "$out")"; else printf 'PASSOU'; fi
}
corrigir() {  # $1=id $2=motivo $3=evidencia
  local out rc
  set +e
  out="$(Pq -c "SET test.uid='$UID_STAFF'; SELECT public.corrigir_cancelamento_pos_disparo($1,'lucas','$2','$3',NULL)::text;" 2>&1)"
  rc=$?; set -e
  if [ $rc -ne 0 ]; then printf 'EXC:%s' "$(extrai_sentinela "$out")"; else printf '%s' "$(printf '%s' "$out" | tail -1)"; fi
}

# ═══════════════════════════════════════════════════════════════════════════════════════════
# GRUPO B — BASELINE: o buraco EXISTE hoje. Estes asserts sao o CANARIO desta entrega:
#   depois de aplicar a migration eles TEM de mudar de resposta. Se um deles continuasse
#   valendo, a migration nao teria fechado nada.
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "-- grupo B: baseline (o corpo que roda em prod HOJE) --"
semear
eq "B1 BASELINE: hoje a RPC cancela um pedido em disparado_simulado (o buraco)" \
   "$(cancelar_x 8)" '{"status": "ok", "pedido_id": 8}'
eq "B1b BASELINE: e a linha fica carimbada cancelado_humano com o PO do Omie intacto" \
   "$(campo 8 status)/$(campo 8 omie_pedido_compra_id)" "cancelado_humano/12100000008"
eq "B1c BASELINE: sem trilha nenhuma (a tabela de auditoria segue vazia)" "$(n_trilha)" "0"
eq "B2 BASELINE: e o UPDATE cru tambem passa (o trigger nem olha o estado)" "$(update_cru 9)" "PASSOU"
eq "B3 BASELINE: a saida auditada RECUSA o estado -- o veto sozinho viraria armadilha" \
   "$(semear; corrigir 8 cancelado_junto_ao_fornecedor 'protocolo-123')" "EXC:[CANCEL-POS-DISPARO-ESTADO]"
# B4 e o CONTROLE do eixo: o guard JA funciona -- so era cego ao `disparado_simulado`. Sem ele,
# B1/B2 poderiam estar verdes por o trigger estar quebrado/desarmado, e nao por causa do estado.
# Tem de ser UPDATE CRU: pela RPC, um pedido `disparado` nem chega ao trigger (a denylist do
# UPDATE ja o exclui e a funcao devolve {"error": ...}).
eq "B4 CONTROLE: 'disparado' JA era barrado pelo trigger antes desta entrega" \
   "$(semear; update_cru 4)" "EXC:[CANCEL-POS-DISPARO-SEM-PORTAO]"
eq "B4b CONTROLE: e pela RPC ele e recusado com {error}, sem excecao" \
   "$(semear; cancelar_x 4 | grep -oE 'ja foi disparado|já foi disparado' | head -1)" "já foi disparado"

# ═══════════════════════════════════════════════════════════════════════════════════════════
# APLICA A MIGRATION SOB TESTE (o arquivo REAL, com a postcondicao embutida junto)
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "-- aplicando $(basename "$MIG") --"
P -q -f "$MIG" || { echo "INFRA: a migration nao aplicou"; exit 1; }
echo "-- migration aplicada (a postcondicao embutida passou, senao o -v ON_ERROR_STOP teria abortado) --"

# ═══════════════════════════════════════════════════════════════════════════════════════════
# GRUPO C — O VETO: `disparado_simulado` deixa de ser cancelavel por QUALQUER via de escrita
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "-- grupo C: o veto --"
semear
eq "C1 a RPC recusa o dry_run com {error} (porta educada, sem excecao)" \
   "$(cancelar_x 8 | grep -c 'dry-run')" "1"
eq "C1b a mensagem DIZ que o PO foi criado no Omie (o nome 'simulado' mente)" \
   "$(cancelar_x 8 | grep -c 'FOI criado no Omie')" "1"
eq "C1c e nomeia o PO real, para o operador achar no fornecedor" \
   "$(cancelar_x 8 | grep -c '12100000008')" "1"
eq "C1d a linha NAO foi carimbada"          "$(campo 8 status)" "disparado_simulado"
eq "C1e nem ganhou cancelado_em"            "$(campo 8 cancelado_em)" "<null>"
eq "C2 o UPDATE CRU aborta pelo trigger (a via que nenhuma RPC cobre)" \
   "$(update_cru 8)" "EXC:[CANCEL-POS-DISPARO-SEM-PORTAO]"
eq "C2b depois do UPDATE cru recusado, a linha segue intacta" "$(campo 8 status)" "disparado_simulado"
eq "C3 o PO no Omie continua existindo (testemunha em transacao propria)" \
   "$(Pq -c "SELECT count(*)::text FROM public.omie_testemunha WHERE pedido_id=8;")" "1"
# C4: PREFIXO, nao lista. Um vocabulario de cancelamento que nasca amanha ja nasce barrado.
eq "C4 o veto pega qualquer 'cancelad%', nao so cancelado_humano" \
   "$(Pq -c "UPDATE public.pedido_compra_sugerido SET status='cancelado_por_vocabulario_novo' WHERE id=8;" 2>&1 | grep -oE '\[[A-Z-]+\]' | head -1)" \
   "[CANCEL-POS-DISPARO-SEM-PORTAO]"
# C5: NAO barra transicao legitima -- o veto e cirurgico, nao um freeze da linha.
eq "C5 CONTROLE: sair de disparado_simulado para 'disparado' (conciliacao) continua permitido" \
   "$(Pq -c "UPDATE public.pedido_compra_sugerido SET status='disparado' WHERE id=9;" >/dev/null; campo 9 status)" "disparado"
eq "C6 CONTROLE: pedido que nunca disparou segue cancelavel normalmente" \
   "$(semear; cancelar_x 2)" '{"status": "ok", "pedido_id": 2}'

# ═══════════════════════════════════════════════════════════════════════════════════════════
# GRUPO S — A SAIDA AUDITADA: sem ela o veto vira armadilha
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "-- grupo S: a saida auditada --"
semear
S1="$(corrigir 8 cancelado_junto_ao_fornecedor 'protocolo-fornecedor-4471')"
eq "S1 corrigir_cancelamento_pos_disparo ACEITA disparado_simulado" \
   "$(printf '%s' "$S1" | grep -c '"status": "ok"')" "1"
eq "S1b e devolve o status ANTERIOR correto na resposta" \
   "$(printf '%s' "$S1" | grep -c 'disparado_simulado')" "1"
eq "S2 a linha foi cancelada"                  "$(campo 8 status)" "cancelado_humano"
eq "S2b com o motivo carimbado"                "$(campo 8 cancelamento_pos_disparo_motivo)" "cancelado_junto_ao_fornecedor"
eq "S2c com a evidencia carimbada"             "$(campo 8 cancelamento_pos_disparo_evidencia)" "protocolo-fornecedor-4471"
eq "S3 e DEIXOU TRILHA (a diferenca entre esta porta e o SQL na mao)" "$(n_trilha)" "1"
eq "S3b a trilha registra o estado anterior real" \
   "$(Pq -c "SELECT status_anterior FROM public.reposicao_cancelamento_pos_disparo_audit WHERE pedido_id=8;")" "disparado_simulado"
eq "S3c e o PO do Omie, que e o que torna a trilha acionavel" \
   "$(Pq -c "SELECT omie_pedido_compra_id FROM public.reposicao_cancelamento_pos_disparo_audit WHERE pedido_id=8;")" "12100000008"
# S4: a REDE de evidencia continua valendo para o estado novo -- a porta aberta nao basta.
eq "S4 evidencia curta e recusada tambem no estado novo" \
   "$(semear; corrigir 8 cancelado_junto_ao_fornecedor 'ab')" "EXC:[CANCEL-POS-DISPARO-EVIDENCIA]"
eq "S5 motivo invalido e recusado tambem no estado novo" \
   "$(semear; corrigir 8 motivo_inventado 'protocolo-4471')" "EXC:[CANCEL-POS-DISPARO-MOTIVO]"
eq "S6 CONTROLE: estado que NAO e pos-disparo continua fora desta porta" \
   "$(semear; corrigir 2 cancelado_junto_ao_fornecedor 'protocolo-4471')" "EXC:[CANCEL-POS-DISPARO-ESTADO]"
# S7: a PORTA e por PEDIDO. Autorizar o 8 nao autoriza o 9 na mesma transacao.
S7="$(P -tA 2>&1 <<'SQL' || true
BEGIN;
SET LOCAL test.uid='11111111-1111-1111-1111-111111111111';
SELECT set_config('app.correcao_cancelamento_pos_disparo','8',true);
UPDATE public.pedido_compra_sugerido
   SET status='cancelado_humano', cancelamento_pos_disparo_motivo='po_excluido_no_omie',
       cancelamento_pos_disparo_evidencia='evid-1234', cancelamento_pos_disparo_por='lucas',
       cancelamento_pos_disparo_em=now()
 WHERE id=9;
COMMIT;
SQL
)"
eq "S7 a porta aberta para o pedido 8 NAO libera o 9 na mesma transacao" \
   "$(printf '%s' "$S7" | grep -oE '\[[A-Z-]+\]' | head -1)" "[CANCEL-POS-DISPARO-SEM-PORTAO]"

# ═══════════════════════════════════════════════════════════════════════════════════════════
# GRUPO A — ACL: `CREATE OR REPLACE` preserva o ACL, mas isso e afirmacao a PROVAR, nao a supor
#   (`DROP`+`CREATE` o RESETARIA -- database.md §4). A1 mede EXECUTE de verdade, sob SET ROLE.
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "-- grupo A: ACL --"
# ⚠️ Casar a MENSAGEM do servidor seria fragil: em pt_BR ela vem acentuada ("permissão negada") e
# o assert mudaria de veredito conforme o lc_messages (licao #1483 — foi assim que este harness
# ficou verde em C e vermelho em pt_BR na primeira rodada). Casa-se a SQLSTATE, que e ASCII e
# estavel, mais a SENTINELA que o proprio RAISE do codigo emite (tambem ASCII, caixa fixa).
# O par importa: o gate de papel tambem levanta 42501, entao SQLSTATE sozinha nao distinguiria
# "negado no ACL" de "negado no gate" — e o A3 perderia todo o valor como falsificacao de eixo.
tenta_como() {  # $1=role  $2=chamada SQL  [$3=GUCs extras]  ->  "SQLSTATE|[SENTINELA]"
  local out
  out="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA -c \
    "SET ROLE $1; ${3:-} DO \$x\$ BEGIN PERFORM $2; RAISE NOTICE 'ZZ=00000'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'ZZ=%', SQLSTATE; RAISE NOTICE '%', SQLERRM; END \$x\$;" 2>&1)"
  printf '%s|%s' "$(printf '%s' "$out" | grep -oE 'ZZ=[0-9A-Za-z]{5}' | head -1 | cut -d= -f2)" "$(extrai_sentinela "$out")"
}
CHAMA_CORR="public.corrigir_cancelamento_pos_disparo(8,'x','po_excluido_no_omie','evid-1234',NULL)"
CHAMA_CANC="public.cancelar_pedido_sugerido(2,'x','y')"

eq "A1 anon NAO executa corrigir_cancelamento_pos_disparo (42501 no ACL, ANTES do gate)" \
   "$(tenta_como anon "$CHAMA_CORR")" "42501|"
eq "A2 anon NAO executa cancelar_pedido_sugerido (42501 no ACL)" \
   "$(tenta_como anon "$CHAMA_CANC")" "42501|"
# A3 FALSIFICA O EIXO: com EXECUTE concedido, a MESMA chamada tem de PASSAR do ACL e morrer no
# gate de papel -- mesma SQLSTATE, sentinela DIFERENTE. Sem isto, A1 poderia estar verde por a
# funcao nao existir, por erro de digitacao na chamada, ou por qualquer outro 42501.
P -q -c "GRANT EXECUTE ON FUNCTION public.corrigir_cancelamento_pos_disparo(bigint,text,text,text,text) TO anon;"
eq "A3 FALSIFICA O EIXO: com EXECUTE, anon passa do ACL e para no gate de papel" \
   "$(tenta_como anon "$CHAMA_CORR")" "42501|[CANCEL-POS-DISPARO-FORBIDDEN]"
P -q -c "REVOKE EXECUTE ON FUNCTION public.corrigir_cancelamento_pos_disparo(bigint,text,text,text,text) FROM anon;"
eq "A4 o REVOKE voltou: negado de novo no ACL, sem chegar ao gate" \
   "$(tenta_como anon "$CHAMA_CORR")" "42501|"
# A5 CONTROLE do proprio helper: um role COM permissao chega ao corpo da funcao (senao "42501|"
# poderia ser o helper sempre falhando, e A1/A2/A4 seriam sempre-verdes).
# (o gate le auth.role() do GUC de teste -- sem ele, service_role para no gate, nao no ACL)
eq "A5 CONTROLE: service_role executa e chega ao corpo (o helper nao e sempre-vermelho)" \
   "$(semear; tenta_como service_role "$CHAMA_CORR" "SET test.role='service_role';")" "00000|"

# ═══════════════════════════════════════════════════════════════════════════════════════════
# GRUPO F — FALSIFICACAO. Uma camada por vez, vermelho EXIGIDO, e um CONTROLE verde na MESMA
#   invocacao (uma sabotagem que derruba tudo aprova tudo: nao prova que o assert mede o eixo).
#   A sabotagem aqui e literalmente "volta ao corpo de ontem" -- o baseline que roda em prod.
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "-- grupo F: falsificacoes --"
restaurar() { P -q -f "$MIG"; }

# F1 — sabota SO o trigger (volta a lista sem disparado_simulado). C2 tem de perder o dente.
# So a FUNCAO, nao a migration inteira: a postcondicao da 152235 insere uma linha de teste com id
# fixo e colidiria na PK -- a sabotagem falharia por acidente e o F1 viraria teatro.
extrai_funcao "$MIG_TRG" "reposicao__valida_cancelamento_pos_disparo" > /tmp/sab-trg-$$.sql
P -q -f /tmp/sab-trg-$$.sql >/dev/null
semear
F1="$(update_cru 8)"
if [ "$F1" = "PASSOU" ]; then
  ok "F1 sabotando SO o trigger, o UPDATE cru volta a passar -- C2 mede o trigger"
else
  bad "F1 sabotagem nao mudou nada (veio [$F1]) -- C2 nao esta medindo o trigger"
fi
F1B="$(update_cru 4)"
if [ "$F1B" = "EXC:[CANCEL-POS-DISPARO-SEM-PORTAO]" ]; then
  ok "F1b CONTROLE: na MESMA sabotagem, 'disparado' ainda e barrado -- a sabotagem foi cirurgica"
else
  bad "F1b a sabotagem desligou o trigger inteiro, nao so o estado novo (veio [$F1B])"
fi
rm -f /tmp/sab-trg-$$.sql
restaurar

# F2 — sabota SO a denylist da RPC. O trigger continua de pe, entao a recusa muda de FORMA
#      ({error} -> excecao). E isso que prova que C1 mede a denylist, e nao o trigger.
extrai_funcao "$MIG_SELO" "cancelar_pedido_sugerido" > /tmp/sab-cancelar-$$.sql
P -q -f /tmp/sab-cancelar-$$.sql >/dev/null
semear
F2="$(cancelar_x 8)"
if [ "$F2" = "EXC:[CANCEL-POS-DISPARO-SEM-PORTAO]" ]; then
  ok "F2 sem a denylist, a RPC deixa de recusar e cai no trigger -- C1 mede a denylist"
else
  bad "F2 sabotagem nao mudou o desfecho (veio [$F2]) -- C1 nao mede a denylist"
fi
eq "F2b CONTROLE: na MESMA sabotagem a linha continua NAO cancelada (o trigger segurou)" \
   "$(campo 8 status)" "disparado_simulado"
F2C="$(cancelar_x 2)"
if [ "$F2C" = '{"status": "ok", "pedido_id": 2}' ]; then
  ok "F2c CONTROLE: na MESMA sabotagem o cancelamento legitimo ainda funciona"
else
  bad "F2c a sabotagem quebrou a RPC inteira (veio [$F2C])"
fi
rm -f /tmp/sab-cancelar-$$.sql
restaurar

# F3 — sabota SO a allowlist da saida auditada (volta ao gate canonico de ontem).
extrai_funcao "$MIG_GATE" "corrigir_cancelamento_pos_disparo" > /tmp/sab-gate-$$.sql
P -q -f /tmp/sab-gate-$$.sql >/dev/null
semear
F3="$(corrigir 8 cancelado_junto_ao_fornecedor 'protocolo-fornecedor-4471')"
if [ "$F3" = "EXC:[CANCEL-POS-DISPARO-ESTADO]" ]; then
  ok "F3 sem a allowlist, a saida volta a recusar o dry_run -- S1 mede a allowlist"
else
  bad "F3 sabotagem nao mudou nada (veio [$F3]) -- S1 nao mede a allowlist"
fi
F3B="$(semear; corrigir 4 cancelado_junto_ao_fornecedor 'protocolo-fornecedor-4471')"
if printf '%s' "$F3B" | grep -q '"status": "ok"'; then
  ok "F3b CONTROLE: na MESMA sabotagem, 'disparado' ainda sai pela porta -- sabotagem cirurgica"
else
  bad "F3b a sabotagem quebrou a porta inteira (veio [$F3B])"
fi
rm -f /tmp/sab-gate-$$.sql
restaurar

# F4 — a sabotagem MAIS FINA: mexe SO no `WHERE ... AND status IN (…)` do UPDATE sob lock,
#      deixando o `IF` de entrada aceitando o estado. E a prova de que a allowlist precisa
#      entrar nos TRES pontos: com so o IF, a funcao aceita na porta e morre no fim com
#      [ZERO-LINHAS] -- recusa correta, mas por acidente, e apos a porta GUC ter sido aberta.
extrai_funcao "$MIG" "corrigir_cancelamento_pos_disparo" > /tmp/sab-corr-$$.sql
ANTES_F4=$(grep -c "AND status IN ('disparado', 'disparado_simulado', 'concluido_recebido')" /tmp/sab-corr-$$.sql)
sed -i '' "s/AND status IN ('disparado', 'disparado_simulado', 'concluido_recebido')/AND status IN ('disparado', 'concluido_recebido')/" /tmp/sab-corr-$$.sql
DEPOIS_F4=$(grep -c "AND status IN ('disparado', 'disparado_simulado', 'concluido_recebido')" /tmp/sab-corr-$$.sql || true)
if [ "$ANTES_F4" = "1" ] && [ "$DEPOIS_F4" = "0" ]; then
  ok "F4-setup a sabotagem cirurgica pegou (o WHERE do UPDATE perdeu o estado novo, o IF manteve)"
else
  bad "F4-setup a sabotagem NAO alterou o alvo (antes=$ANTES_F4 depois=$DEPOIS_F4) -- F4 seria teatro"
fi
P -q -f /tmp/sab-corr-$$.sql >/dev/null
semear
F4="$(corrigir 8 cancelado_junto_ao_fornecedor 'protocolo-fornecedor-4471')"
if [ "$F4" = "EXC:[CANCEL-POS-DISPARO-ZERO-LINHAS]" ]; then
  ok "F4 so o IF nao basta: a funcao aceita e morre no UPDATE -- S1 mede os TRES pontos"
else
  bad "F4 esperado [CANCEL-POS-DISPARO-ZERO-LINHAS], veio [$F4] -- a allowlist do UPDATE nao esta medida"
fi
F4B="$(semear; corrigir 4 cancelado_junto_ao_fornecedor 'protocolo-fornecedor-4471')"
if printf '%s' "$F4B" | grep -q '"status": "ok"'; then
  ok "F4b CONTROLE: na MESMA sabotagem, 'disparado' ainda passa pelos tres pontos"
else
  bad "F4b a sabotagem quebrou a funcao inteira (veio [$F4B])"
fi
rm -f /tmp/sab-corr-$$.sql
restaurar

# F5 — falsifica a POSTCONDICAO da propria migration. Um `DO $post$` que nunca reprova e
#      decoracao: ele e a defesa contra "colei e nao pegou", e precisa ter dente proprio.
POSTBLOCO="$(mktemp /tmp/postbloco-simulado.XXXXXX)"
# shellcheck disable=SC2016  # `$post$` e a TAG de dollar-quote do SQL: tem de ficar literal.
sed -n '/^DO \$post\$/,/^\$post\$;/p' "$MIG" > "$POSTBLOCO"
[ -s "$POSTBLOCO" ] || { echo "INFRA: nao extrai o bloco de postcondicao do .sql"; exit 1; }
F5_OK="$(P -tA -f "$POSTBLOCO" 2>&1 && echo SEM_ERRO || echo COM_ERRO)"
eq "F5-controle a postcondicao PASSA com a migration aplicada de verdade" \
   "$(printf '%s' "$F5_OK" | tail -1)" "SEM_ERRO"
# Agora sabota o guard e exige que a postcondicao GRITE o motivo certo.
extrai_funcao "$MIG_TRG" "reposicao__valida_cancelamento_pos_disparo" > /tmp/sab-trg2-$$.sql
P -q -f /tmp/sab-trg2-$$.sql >/dev/null
F5="$(P -tA -f "$POSTBLOCO" 2>&1 || true)"
if printf '%s' "$F5" | grep -q 'GUARD-CEGO'; then
  ok "F5 com o guard sabotado, a postcondicao aborta com [GUARD-CEGO] -- ela tem dente"
else
  bad "F5 a postcondicao passou (ou gritou outra coisa) com o guard cego: $(printf '%s' "$F5" | head -c 160)"
fi
rm -f /tmp/sab-trg2-$$.sql
restaurar
# F6 — a postcondicao tambem tem de pegar a REGRESSAO do corpo errado (o risco REAL medido no
#      pre-voo: a prod esta a frente da 20260905224959, e partir daquele arquivo apagaria o guard
#      de `status_envio_portal`). A sabotagem tem de ISOLAR esse eixo: reaplicar a 224959 inteira
#      dispararia [DENYLIST-CEGA] primeiro (aquele corpo tambem nao conhece disparado_simulado) e
#      o F6 estaria medindo o alarme errado. Entao parte-se do corpo NOVO e retira-se SO o portal.
extrai_funcao "$MIG" "cancelar_pedido_sugerido" > /tmp/sab-velho-$$.sql
ANTES_F6=$(grep -c "aceito_portal_sem_protocolo" /tmp/sab-velho-$$.sql)
sed -i '' "s/'aceito_portal_sem_protocolo', //g" /tmp/sab-velho-$$.sql
DEPOIS_F6=$(grep -c "aceito_portal_sem_protocolo" /tmp/sab-velho-$$.sql || true)
if [ "$ANTES_F6" -ge 1 ] && [ "$DEPOIS_F6" = "0" ]; then
  ok "F6-setup a sabotagem do eixo do portal pegou (antes=$ANTES_F6 ocorrencias, depois=0)"
else
  bad "F6-setup a sabotagem NAO alterou o alvo (antes=$ANTES_F6 depois=$DEPOIS_F6) -- F6 seria teatro"
fi
P -q -f /tmp/sab-velho-$$.sql >/dev/null
F6="$(P -tA -f "$POSTBLOCO" 2>&1 || true)"
if printf '%s' "$F6" | grep -q 'REGRESSAO-PORTAL'; then
  ok "F6 a postcondicao pega o REPLACE partido do corpo errado -- [REGRESSAO-PORTAL]"
else
  bad "F6 a postcondicao nao viu a regressao do guard de portal: $(printf '%s' "$F6" | head -c 160)"
fi
# F6b CONTROLE na MESMA sabotagem: o alarme do OUTRO eixo NAO dispara -- prova que [REGRESSAO-PORTAL]
# foi o que mordeu, e nao um alarme qualquer que casaria com qualquer estrago.
if printf '%s' "$F6" | grep -q 'DENYLIST-CEGA'; then
  bad "F6b a sabotagem vazou para o outro eixo (DENYLIST-CEGA tambem disparou) -- F6 nao isola o portal"
else
  ok "F6b CONTROLE: na MESMA sabotagem [DENYLIST-CEGA] NAO dispara -- F6 isola o eixo do portal"
fi
rm -f /tmp/sab-velho-$$.sql "$POSTBLOCO"
restaurar

# F7 — A SABOTAGEM QUE PEGOU UM DEFEITO REAL NESTE HARNESS. Sabota SO a linha da condicao do
#      guard, deixando os COMENTARIOS (que citam `disparado_simulado` varias vezes) intactos.
#      A primeira versao da postcondicao testava `prosrc ~ 'disparado_simulado'` e ficava VERDE
#      aqui — `prosrc` inclui comentario. Um `DO $post$` que so encontra a PALAVRA nao prova nada
#      sobre a LOGICA; este assert e o que obriga o predicado a casar a ESTRUTURA da condicao.
POSTBLOCO2="$(mktemp /tmp/postbloco2-simulado.XXXXXX)"
# shellcheck disable=SC2016  # `$post$` e a TAG de dollar-quote do SQL: tem de ficar literal.
sed -n '/^DO \$post\$/,/^\$post\$;/p' "$MIG" > "$POSTBLOCO2"
extrai_funcao "$MIG" "reposicao__valida_cancelamento_pos_disparo" > /tmp/sab-cego-$$.sql
ANTES_F7=$(grep -c "IF OLD.status NOT IN ('disparado', 'disparado_simulado', 'concluido_recebido')" /tmp/sab-cego-$$.sql)
sed -i '' "s/IF OLD.status NOT IN ('disparado', 'disparado_simulado', 'concluido_recebido')/IF OLD.status NOT IN ('disparado', 'concluido_recebido')/" /tmp/sab-cego-$$.sql
RESTA_F7=$(grep -c "disparado_simulado" /tmp/sab-cego-$$.sql || true)
if [ "$ANTES_F7" = "1" ] && [ "$RESTA_F7" -ge 1 ]; then
  ok "F7-setup logica cega, comentarios intactos ($RESTA_F7 mencoes ao nome sobraram no corpo)"
else
  bad "F7-setup a sabotagem nao montou o caso (antes=$ANTES_F7 resta=$RESTA_F7) -- F7 seria teatro"
fi
P -q -f /tmp/sab-cego-$$.sql >/dev/null
F7="$(P -tA -f "$POSTBLOCO2" 2>&1 || true)"
if printf '%s' "$F7" | grep -q 'GUARD-CEGO'; then
  ok "F7 a postcondicao grita [GUARD-CEGO] mesmo com a palavra presente em comentario"
else
  bad "F7 a postcondicao passou com a logica cega -- ela mede a PALAVRA, nao a condicao: $(printf '%s' "$F7" | head -c 160)"
fi
semear
F7B="$(update_cru 8)"
if [ "$F7B" = "PASSOU" ]; then
  ok "F7b CONTROLE: e o buraco esta MESMO aberto nessa sabotagem (nao era falso alarme)"
else
  bad "F7b a sabotagem nao abriu o buraco (veio [$F7B]) -- F7 mediria um estado que nao existe"
fi
rm -f /tmp/sab-cego-$$.sql
restaurar

# F8 — o mesmo para a SAIDA: logica cega no WHERE do UPDATE, comentarios intactos.
extrai_funcao "$MIG" "corrigir_cancelamento_pos_disparo" > /tmp/sab-cego2-$$.sql
sed -i '' "s/AND status IN ('disparado', 'disparado_simulado', 'concluido_recebido')/AND status IN ('disparado', 'concluido_recebido')/" /tmp/sab-cego2-$$.sql
P -q -f /tmp/sab-cego2-$$.sql >/dev/null
F8="$(P -tA -f "$POSTBLOCO2" 2>&1 || true)"
if printf '%s' "$F8" | grep -q 'SAIDA-SEM-UPDATE'; then
  ok "F8 a postcondicao separa os tres pontos: grita [SAIDA-SEM-UPDATE] com o IF ainda intacto"
else
  bad "F8 a postcondicao nao distinguiu o WHERE do IF: $(printf '%s' "$F8" | head -c 160)"
fi
if printf '%s' "$F8" | grep -q 'SAIDA-SEM-IF'; then
  bad "F8b a sabotagem vazou para o outro ponto -- F8 nao isola o WHERE do UPDATE"
else
  ok "F8b CONTROLE: [SAIDA-SEM-IF] NAO dispara -- F8 isola o WHERE do UPDATE"
fi
rm -f /tmp/sab-cego2-$$.sql "$POSTBLOCO2"
restaurar

# ═══════════════════════════════════════════════════════════════════════════════════════════
# GRUPO Z — o CANARIO do restore: depois de TODAS as sabotagens, o corpo real esta de volta.
#   Sem isto, um assert que rodasse depois poderia estar medindo uma funcao sabotada.
# ═══════════════════════════════════════════════════════════════════════════════════════════
echo "-- grupo Z: restore --"
semear
eq "Z1 depois de todas as sabotagens, o veto real esta de volta (UPDATE cru)" \
   "$(update_cru 8)" "EXC:[CANCEL-POS-DISPARO-SEM-PORTAO]"
eq "Z2 e a saida auditada real tambem" \
   "$(semear; corrigir 8 cancelado_junto_ao_fornecedor 'protocolo-fornecedor-4471' | grep -c '\"status\": \"ok\"')" "1"
eq "Z3 e o guard de status_envio_portal da 20260906170000 NAO regrediu" \
   "$(Pq -c "SELECT (prosrc ~ 'aceito_portal_sem_protocolo')::text FROM pg_proc WHERE proname='cancelar_pedido_sugerido';")" "true"
eq "Z4 e o gate canonico da 20260906172718 NAO regrediu" \
   "$(Pq -c "SELECT (prosrc ~ 'IF NOT \(\s*COALESCE' AND prosrc ~ 'has_role')::text FROM pg_proc WHERE proname='corrigir_cancelamento_pos_disparo';")" "true"

echo ""
echo "PASS=$PASS FAIL=$FAIL   (lc_messages=$HARNESS_LC)"
[ "$FAIL" -eq 0 ] || exit 1
