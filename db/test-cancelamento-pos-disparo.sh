#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — cancelamento PÓS-DISPARO: o guard vira TRIGGER e a correção tem porta    ║
# ║  Migration: 20260906152235_cancelamento_pos_disparo_trigger_e_rpc.sql             ║
# ║                                                                                   ║
# ║      bash db/test-cancelamento-pos-disparo.sh > /tmp/t.log 2>&1; echo $?          ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                           ║
# ║                                                                                   ║
# ║  Grupos:                                                                          ║
# ║   T  a VIA CRUA é barrada — o invariante inteiro desta fatia                       ║
# ║   P  positivos  — a RPC COM evidência corrige, carimba e deixa trilha              ║
# ║   N  negativos  — sem evidência / motivo inválido / fora da allowlist ⇒ SQLSTATE   ║
# ║   X  NÃO-REGRESSÃO — as transições legítimas medidas na PROD seguem passando       ║
# ║   A  ACL/RLS    — anon não executa; a trilha não é forjável                        ║
# ║   R  CORRIDA    — R1 é o BASELINE DO BUG (sem trigger a via crua VENCE o disparo)  ║
# ║   F  falsificação — sabota UMA camada por vez e exige o vermelho certo             ║
# ║   V  a query de validação do handoff, nos DOIS sentidos                            ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5479}"
SLUG="cancel-pos-disparo"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

# shellcheck disable=SC2329  # invocada pelo `trap ... EXIT` logo abaixo.
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET TimeZone='UTC';"

# DOIS LOCALES (lição #1483): o eixo a variar é a LÍNGUA DAS MENSAGENS do servidor, GUC do banco.
#   HARNESS_LC=pt_BR.UTF-8 bash db/test-cancelamento-pos-disparo.sh
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
contem() { if case "$2" in *"$3"*) true;; *) false;; esac; then ok "$1"; else bad "$1 -- [$2] nao contem [$3]"; fi; }

AMOSTRA_MSG=$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA -c "SELECT 1/0;" 2>&1 | head -1) || true
echo "=== setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ==="
echo "=== controle do eixo de locale, mensagem do servidor: $AMOSTRA_MSG"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (tipos copiados da PROD via information_schema, 2026-09-06)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;

CREATE TABLE public.pedido_compra_sugerido (
  id                         bigserial PRIMARY KEY,
  empresa                    text,
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
  atualizado_em              timestamptz DEFAULT now()
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — AS MIGRATIONS REAIS (Lei #1). A do guard atômico entra junto para que o
#          grupo X prove que as duas CONVIVEM (a RPC normal segue recusando).
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260906152235_cancelamento_pos_disparo_trigger_e_rpc.sql"
MIG_GUARD="$REPO_ROOT/supabase/migrations/20260905224959_cancelar_pedido_guard_atomico.sql"
P -q -f "$MIG_GUARD"
P -q -f "$MIG"
echo "migrations aplicadas: $(basename "$MIG_GUARD") + $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + helpers
# ══════════════════════════════════════════════════════════════════════════════
UID_STAFF='11111111-1111-1111-1111-111111111111'
UID_CLIENTE='22222222-2222-2222-2222-222222222222'
P -q -c "INSERT INTO public.user_roles VALUES ('$UID_STAFF','employee'), ('$UID_CLIENTE','customer');"

# `t_tentar` devolve o CARIMBO DO RAMO ('SQLSTATE|mensagem'), nunca um veredito.
# ⚠️ Isto NÃO é o anti-padrão `WHEN OTHERS THEN 'OK'`: aquele ENGOLE o erro e pinta verde. Aqui
# o erro é DEVOLVIDO inteiro e cada assert exige a SQLSTATE **e** a sentinela do ramo esperado —
# um erro diferente (inclusive um typo no próprio SQL do teste) reprova mostrando qual veio.
P -q <<'SQL'
CREATE FUNCTION public.t_tentar(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  RETURN 'PASSOU';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || '|' || SQLERRM;
END $f$;
-- Irmã de `t_tentar` para SELECTs: devolve o RESULTADO (t_tentar devolveria só 'PASSOU').
CREATE FUNCTION public.t_chamar(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || '|' || SQLERRM;
END $f$;
SQL

semear() {
  P -q <<'SQL'
TRUNCATE public.pedido_compra_sugerido RESTART IDENTITY;
TRUNCATE public.reposicao_cancelamento_pos_disparo_audit RESTART IDENTITY;
INSERT INTO public.pedido_compra_sugerido
  (id, empresa, fornecedor_nome, status, status_envio_portal, horario_disparo_real, omie_pedido_compra_id, valor_total) VALUES
  (1, 'OBEN', 'Renner Sayerlack', 'disparado',                   'sucesso_portal',        timestamptz '2026-05-27 01:35:00+00', 'PO-12098721294', 4200.50),
  (2, 'OBEN', 'Acre Caxias',      'disparado',                   'enviado_portal',        timestamptz '2026-04-20 21:38:00+00', 'PO-12076996056', 1899.00),
  (3, 'OBEN', 'Renner Sayerlack', 'concluido_recebido',          'enviado_portal',        timestamptz '2026-03-01 09:00:00+00', 'PO-CONCLUIDO',   999.99),
  (4, 'OBEN', 'Acre Caxias',      'pendente_aprovacao',          'nao_aplicavel',         NULL, NULL, 150.00),
  (5, 'OBEN', 'Renner Sayerlack', 'aprovado_aguardando_disparo', 'pendente_envio_portal', NULL, NULL, 777.00),
  (6, 'OBEN', 'Acre Caxias',      'bloqueado_guardrail',         'nao_aplicavel',         NULL, NULL,  10.00),
  (7, 'OBEN', 'Renner Sayerlack', 'aprovado_aguardando_disparo', 'nao_aplicavel',         NULL, NULL, 555.00),
  (8, 'OBEN', 'Acre Caxias',      'disparado',                   'enviado_portal',        timestamptz '2026-06-01 08:00:00+00', 'PO-PARA-CORRIDA', 320.00);
SELECT setval('public.pedido_compra_sugerido_id_seq', 100);
SQL
  ator "$UID_STAFF" authenticated
}
# ⚠️ `ALTER DATABASE ... SET` e nao `set_config(...,false)`: cada `psql -c` abre uma conexao NOVA,
# entao um GUC de SESSAO morreria antes do proximo assert e o gate da RPC leria uid NULL — o teste
# mediria "gate fechado" em todo lugar e o grupo P ficaria vermelho por motivo errado.
ator() { P -q -c "ALTER DATABASE prove SET test.uid='$1'; ALTER DATABASE prove SET test.role='$2';" >/dev/null; }
campo()   { Pq -c "SELECT COALESCE($2::text,'<null>') FROM public.pedido_compra_sugerido WHERE id=$1;"; }
tentar()  { Pq -c "SELECT public.t_tentar(\$sql\$$1\$sql\$);"; }
# A via CRUA — exatamente o UPDATE que o SQL Editor / um cliente PostgREST antigo emitiria.
via_crua() { tentar "UPDATE public.pedido_compra_sugerido SET status='$2', cancelado_por='sql-na-mao', cancelado_em=now() WHERE id=$1"; }
chamar()   { Pq -c "SELECT public.t_chamar(\$sql\$$1\$sql\$);"; }
corrigir() { chamar "SELECT public.corrigir_cancelamento_pos_disparo($1, 'lucas@afiacao', '$2', '$3', 'justificativa do teste')::text"; }
n_trilha() { Pq -c "SELECT count(*) FROM public.reposicao_cancelamento_pos_disparo_audit WHERE pedido_id=$1;"; }

# Re-executa a postcondição da migration sob demanda (agora COM linhas semeadas, para que a
# sonda de execução do trigger — eixo (g) — de fato exercite o caminho, o que não acontece no
# apply contra a tabela vazia).
# ⚠️ X no FIM do template. O mktemp do BSD (macOS) NAO substitui X seguidos de sufixo: com
# `.XXXXXX.sql` ele cria o nome LITERAL, e a 2a execucao do harness morre com "File exists".
# Um teste que so passa UMA vez nao serve de regressao. (Mesmo padrao em trg-/fn- abaixo.)
POSTBLOCO="$(mktemp /tmp/post-cpd-XXXXXX)"
# shellcheck disable=SC2016  # `$post$` é a TAG de dollar-quote do SQL: tem de ficar literal.
sed -n '/^DO \$post\$/,/^\$post\$;/p' "$MIG" > "$POSTBLOCO"
[ -s "$POSTBLOCO" ] || { echo "INFRA: nao extrai o bloco de postcondicao do .sql"; exit 1; }
rodar_post() { if P -q -f "$POSTBLOCO" >/dev/null 2>&1; then echo "VERDE"; else echo "VERMELHO"; fi; }

semear

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "-- grupo T: a VIA CRUA e barrada (o invariante inteiro desta fatia) --"
R=$(via_crua 1 'cancelado_humano')
contem "T1 UPDATE cru disparado->cancelado_humano e BARRADO" "$R" "[CANCEL-POS-DISPARO-SEM-PORTAO]"
contem "T1b ... com a SQLSTATE P0001 (nao um erro qualquer)" "$R" "P0001|"
eq  "T1c ... e a linha NAO foi tocada" "$(campo 1 status)" "disparado"
eq  "T1d ... nem o carimbo de cancelamento" "$(campo 1 cancelado_por)" "<null>"

# Os DOIS vocabulários. Cobrir só `cancelado_humano` deixaria de fora as linhas 409/1046 da PROD,
# cuja via está PROVADA (status legado + `status_envio_portal` preservado = nao passou pela RPC).
R=$(via_crua 2 'cancelado')
contem "T2 UPDATE cru disparado->cancelado (vocabulario LEGADO) e BARRADO" "$R" "[CANCEL-POS-DISPARO-SEM-PORTAO]"
eq  "T2b ... linha intacta" "$(campo 2 status)" "disparado"

R=$(via_crua 3 'cancelado_humano')
contem "T3 UPDATE cru concluido_recebido->cancelado_humano e BARRADO" "$R" "[CANCEL-POS-DISPARO-SEM-PORTAO]"

# CONTROLE INÓCUO: sem isto, um trigger que RECUSA SEMPRE passaria por fix.
R=$(via_crua 4 'cancelado_humano')
eq  "T4 CONTROLE: via crua em pedido pendente_aprovacao PASSA (o trigger nao e um 'nega tudo')" "$R" "PASSOU"
eq  "T4b ... e a linha realmente mudou" "$(campo 4 status)" "cancelado_humano"

# O portão é do PEDIDO, não da sessão: abrir para o 8 não pode liberar o 1 na mesma transação.
R=$(tentar "SELECT set_config('app.correcao_cancelamento_pos_disparo','8',true); UPDATE public.pedido_compra_sugerido SET status='cancelado_humano' WHERE id=1")
contem "T5 portao aberto para OUTRO pedido nao libera este" "$R" "[CANCEL-POS-DISPARO-SEM-PORTAO]"

# Portão certo, mas sem os carimbos ⇒ a REDE morde (é assim que a 'segunda via' do #2231 nasceu).
R=$(tentar "SELECT set_config('app.correcao_cancelamento_pos_disparo','1',true); UPDATE public.pedido_compra_sugerido SET status='cancelado_humano' WHERE id=1")
contem "T6 portao certo mas SEM evidencia na linha: a rede morde" "$R" "[CANCEL-POS-DISPARO-SEM-EVIDENCIA]"
eq  "T6b ... linha intacta" "$(campo 1 status)" "disparado"

echo "-- grupo P: a RPC COM evidencia corrige, carimba e deixa trilha --"
semear
R=$(corrigir 1 'cancelado_junto_ao_fornecedor' 'protocolo 2097501')
contem "P1 a RPC devolve ok"                       "$R" '"status": "ok"'
contem "P1b ... com o status ANTERIOR na resposta" "$R" '"status_anterior": "disparado"'
eq "P2 status virou cancelado_humano"              "$(campo 1 status)" "cancelado_humano"
eq "P3 motivo carimbado"        "$(campo 1 cancelamento_pos_disparo_motivo)"    "cancelado_junto_ao_fornecedor"
eq "P4 evidencia carimbada"     "$(campo 1 cancelamento_pos_disparo_evidencia)" "protocolo 2097501"
eq "P5 autor carimbado"         "$(campo 1 cancelamento_pos_disparo_por)"       "lucas@afiacao"
eq "P6 higiene do portal aplicada (igual a RPC normal)" "$(campo 1 status_envio_portal)" "nao_aplicavel"
eq "P7 o PO do Omie e PRESERVADO (a compra existe: apagar seria mentir)" "$(campo 1 omie_pedido_compra_id)" "PO-12098721294"
eq "P8 a trilha ganhou 1 linha" "$(n_trilha 1)" "1"
eq "P9 a trilha guarda o valor em risco" \
   "$(Pq -c "SELECT valor_total::text||'|'||omie_pedido_compra_id||'|'||status_anterior FROM public.reposicao_cancelamento_pos_disparo_audit WHERE pedido_id=1;")" \
   "4200.50|PO-12098721294|disparado"
R=$(corrigir 3 'po_excluido_no_omie' 'PO 12101983534 excluido no ERP')
contem "P10 concluido_recebido tambem tem porta" "$R" '"status": "ok"'
eq    "P10b ... e a trilha registra o status anterior certo" \
      "$(Pq -c "SELECT status_anterior FROM public.reposicao_cancelamento_pos_disparo_audit WHERE pedido_id=3;")" "concluido_recebido"

echo "-- grupo N: negativos (SQLSTATE + sentinela do RAMO, nunca 'lancou algo') --"
semear
R=$(corrigir 1 'cancelado_junto_ao_fornecedor' 'ab')
contem "N1 evidencia curta e RECUSADA"          "$R" "[CANCEL-POS-DISPARO-EVIDENCIA]"
eq     "N1b ... e a linha nao foi tocada"       "$(campo 1 status)" "disparado"
eq     "N1c ... e a trilha continua vazia"      "$(n_trilha 1)" "0"
R=$(corrigir 1 'cancelado_junto_ao_fornecedor' '   ')
contem "N2 evidencia so de espacos e RECUSADA (btrim, nao length cru)" "$R" "[CANCEL-POS-DISPARO-EVIDENCIA]"
R=$(corrigir 1 'porque_sim' 'protocolo 123456')
contem "N3 motivo fora do enum e RECUSADO"      "$R" "[CANCEL-POS-DISPARO-MOTIVO]"
R=$(chamar "SELECT public.corrigir_cancelamento_pos_disparo(1,'lucas@afiacao',NULL,'protocolo 123456',NULL)::text")
contem "N4 motivo NULL e RECUSADO (nao vira string vazia)" "$R" "[CANCEL-POS-DISPARO-MOTIVO]"
R=$(corrigir 4 'cancelado_junto_ao_fornecedor' 'protocolo 123456')
contem "N5 ALLOWLIST: pendente_aprovacao nao usa esta porta" "$R" "[CANCEL-POS-DISPARO-ESTADO]"
eq     "N5b ... a linha segue pendente_aprovacao"            "$(campo 4 status)" "pendente_aprovacao"
R=$(corrigir 5 'cancelado_junto_ao_fornecedor' 'protocolo 123456')
contem "N6 ALLOWLIST: aprovado_aguardando_disparo tambem nao (o estado que o disparador pega)" "$R" "[CANCEL-POS-DISPARO-ESTADO]"
R=$(corrigir 999 'cancelado_junto_ao_fornecedor' 'protocolo 123456')
contem "N7 pedido inexistente e RECUSADO"       "$R" "[CANCEL-POS-DISPARO-AUSENTE]"

echo "-- grupo A: ACL / autorizacao --"
ator "$UID_CLIENTE" authenticated
R=$(corrigir 1 'cancelado_junto_ao_fornecedor' 'protocolo 123456')
contem "A1 customer NAO corrige (gate na fronteira: DEFINER bypassa RLS)" "$R" "[CANCEL-POS-DISPARO-FORBIDDEN]"
contem "A1b ... com SQLSTATE 42501"                                        "$R" "42501|"
eq     "A1c ... e a linha nao foi tocada"                                  "$(campo 1 status)" "disparado"
# A1d falsifica A1: promove o MESMO uid a employee e exige que a chamada PASSE. Sem isto, A1
# poderia estar verde por qualquer outro motivo (uid nulo, funcao ausente) e nao mediria o gate.
P -q -c "INSERT INTO public.user_roles VALUES ('$UID_CLIENTE','employee');"
R=$(corrigir 1 'cancelado_junto_ao_fornecedor' 'protocolo 123456')
contem "A1d FALSIFICA A1: promovido a employee, a MESMA chamada passa" "$R" '"status": "ok"'
P -q -c "DELETE FROM public.user_roles WHERE user_id='$UID_CLIENTE' AND role='employee';"
ator "$UID_STAFF" authenticated
semear
eq "A2 anon NAO tem EXECUTE na RPC de correcao" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.corrigir_cancelamento_pos_disparo(bigint,text,text,text,text)','EXECUTE')::text;")" "false"
eq "A3 authenticated TEM EXECUTE (senao a tela nao corrige)" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','public.corrigir_cancelamento_pos_disparo(bigint,text,text,text,text)','EXECUTE')::text;")" "true"
eq "A4 a trilha NAO e escrivel por authenticated (ACL)" \
   "$(Pq -c "SELECT has_table_privilege('authenticated','public.reposicao_cancelamento_pos_disparo_audit','INSERT')::text;")" "false"
eq "A5 ... nem UPDATE/DELETE (append-only)" \
   "$(Pq -c "SELECT (has_table_privilege('authenticated','public.reposicao_cancelamento_pos_disparo_audit','UPDATE') OR has_table_privilege('authenticated','public.reposicao_cancelamento_pos_disparo_audit','DELETE'))::text;")" "false"
eq "A6 ... mas LE (o staff precisa auditar)" \
   "$(Pq -c "SELECT has_table_privilege('authenticated','public.reposicao_cancelamento_pos_disparo_audit','SELECT')::text;")" "true"

echo "-- grupo X: NAO-REGRESSAO (as transicoes medidas na PROD seguem passando) --"
semear
eq "X1 UPDATE que NAO mexe em status passa (recalculo de valor)" \
   "$(tentar "UPDATE public.pedido_compra_sugerido SET valor_total=9999 WHERE id=1")" "PASSOU"
eq "X2 edge: aprovado_aguardando_disparo -> disparado passa" \
   "$(tentar "UPDATE public.pedido_compra_sugerido SET status='disparado', omie_pedido_compra_id='PO-NOVO' WHERE id=5")" "PASSOU"
eq "X3 edge: disparado -> falha_envio passa (nao e cancelamento)" \
   "$(tentar "UPDATE public.pedido_compra_sugerido SET status='falha_envio' WHERE id=2")" "PASSOU"
eq "X4 edge: aprovado -> expirado_sem_aprovacao passa" \
   "$(tentar "UPDATE public.pedido_compra_sugerido SET status='expirado_sem_aprovacao' WHERE id=7")" "PASSOU"
eq "X5 split: -> split_em_filhos passa" \
   "$(tentar "UPDATE public.pedido_compra_sugerido SET status='split_em_filhos' WHERE id=4")" "PASSOU"
semear
# A RPC NORMAL continua com o comportamento provado em 20260905224959 — as duas migrations convivem.
eq "X6 cancelar_pedido_sugerido segue RECUSANDO disparado (guard da 20260905224959 intacto)" \
   "$(Pq -c "SELECT public.cancelar_pedido_sugerido(1,'lucas','x')->>'error' IS NOT NULL;")" "t"
eq "X7 cancelar_pedido_sugerido segue CANCELANDO pendente_aprovacao" \
   "$(Pq -c "SELECT public.cancelar_pedido_sugerido(4,'lucas','x')->>'status';")" "ok"
eq "X7b ... e o trigger NAO exigiu evidencia dessa via (nao era pos-disparo)" "$(campo 4 status)" "cancelado_humano"
# As 5 linhas historicas da PROD ja estao em status cancelado: um UPDATE futuro nelas NAO pode
# travar (OLD.status nao e disparado/concluido). Sem este assert, a migration poderia congelar
# linhas legitimas e ninguem saberia ate alguem tentar editar uma.
eq "X8 linha JA cancelada aceita UPDATE posterior (as 5 historicas nao congelam)" \
   "$(tentar "UPDATE public.pedido_compra_sugerido SET atualizado_em=now(), status='cancelado' WHERE id=4")" "PASSOU"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4b — A CORRIDA, com BARREIRA OBSERVADA (nunca `sleep`)
#
# A pergunta que só a corrida responde: o trigger vê o OLD **re-avaliado**?
# A `20260905224959` precisou pôr o predicado no `WHERE` para que o EvalPlanQual re-avaliasse a
# linha. A via CRUA (`WHERE id = …`, sem predicado) NÃO tem esse WHERE — ela grava mesmo assim.
# A aposta do desenho é que o trigger BEFORE, disparando DEPOIS do lock, recebe em `OLD` a versão
# NOVA da linha (a que o disparador acabou de commitar) e barra. Isso é AFIRMAÇÃO sobre o motor,
# e por isso está MEDIDO aqui em vez de deduzido.
# ══════════════════════════════════════════════════════════════════════════════
P -q -c "CREATE TABLE IF NOT EXISTS public.barreira (nome text PRIMARY KEY);" >/dev/null

lancar_bloqueador() {   # $1 = id que A trava e leva a 'disparado' (a compra REAL no Omie)
  P -q >/dev/null <<SQL &
BEGIN;
DO \$u\$
BEGIN
  UPDATE public.pedido_compra_sugerido
     SET status = 'disparado', omie_pedido_compra_id = 'PO-REAL-NO-OMIE',
         horario_disparo_real = timestamptz '2026-09-06 12:00:00+00'
   WHERE id = $1 AND status = 'aprovado_aguardando_disparo';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BLOQUEADOR: o UPDATE do disparador nao pegou a linha % -- a corrida nao mediria nada', $1;
  END IF;
  PERFORM pg_advisory_xact_lock(918273646);
END
\$u\$;
DO \$w\$
BEGIN
  FOR i IN 1..2000 LOOP
    PERFORM pg_sleep(0.05);
    IF EXISTS (SELECT 1 FROM public.barreira WHERE nome = 'liberar') THEN RETURN; END IF;
  END LOOP;
  RAISE EXCEPTION 'BARREIRA: o orquestrador nunca liberou o bloqueador';
END
\$w\$;
COMMIT;
SQL
  BLOQ_PID=$!
}
esperar_A_travar() {
  local n
  for _ in $(seq 1 300); do
    n=$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted AND pid <> pg_backend_pid();" | tail -1)
    if [ "${n:-0}" -ge 1 ]; then echo "sim"; return; fi
    sleep 0.05
  done
  echo "nao"
}
esperar_bloqueio() {
  local n
  for _ in $(seq 1 "${1:-300}"); do
    n=$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND cardinality(pg_blocking_pids(pid)) > 0 AND query ILIKE '%sonda_corrida_b%';" | tail -1)
    if [ "${n:-0}" -ge 1 ]; then echo "sim"; return; fi
    sleep 0.05
  done
  echo "nao"
}
liberar_A() { P -q -c "INSERT INTO public.barreira VALUES ('liberar') ON CONFLICT DO NOTHING;" >/dev/null; }

# ecoa "<retorno da via crua>~~<status final>~~<omie id final>~~<bloqueio observado>"
corrida() {
  local id="$1" out bpid visto
  out="$(mktemp /tmp/corrida-cpd-XXXXXX)"
  P -q -c "DELETE FROM public.barreira;" >/dev/null
  lancar_bloqueador "$id"
  if [ "$(esperar_A_travar)" != "sim" ]; then
    liberar_A; wait "$BLOQ_PID" || true; rm -f "$out"
    echo "A-NAO-TRAVOU~~A-NAO-TRAVOU~~A-NAO-TRAVOU~~A-NAO-TRAVOU"; return
  fi
  Pq -c "SELECT public.t_tentar(\$sql\$UPDATE public.pedido_compra_sugerido /* sonda_corrida_b */ SET status='cancelado_humano', cancelado_por='sql-na-mao' WHERE id=$id\$sql\$);" > "$out" 2>&1 &
  bpid=$!
  visto="$(esperar_bloqueio)"
  liberar_A
  wait "$bpid" || true
  if ! wait "$BLOQ_PID"; then rm -f "$out"; echo "BLOQUEADOR-FALHOU~~BLOQUEADOR-FALHOU~~BLOQUEADOR-FALHOU~~BLOQUEADOR-FALHOU"; return; fi
  # ⚠️ separador `~~`, nao `|`: o retorno de `t_tentar` e "SQLSTATE|SQLERRM" e um `cut -d'|'`
  # cortaria DENTRO da mensagem de erro -- os campos sairiam deslocados e os asserts mediriam
  # a coluna errada (foi o que aconteceu na 1a execucao deste harness).
  echo "$(tail -1 "$out")~~$(campo "$id" status)~~$(campo "$id" omie_pedido_compra_id)~~$visto"
  rm -f "$out"
}

# Sabotagem/restauração CIRÚRGICAS do trigger. A restauração usa o TEXTO REAL da migration
# (extraído por sed), não uma cópia neste arquivo que poderia divergir dela em silêncio.
TRGBLOCO="$(mktemp /tmp/trg-cpd-XXXXXX)"
sed -n '/^DROP TRIGGER IF EXISTS trg_valida_cancelamento_pos_disparo/,/^  EXECUTE FUNCTION public.reposicao__valida_cancelamento_pos_disparo();/p' "$MIG" > "$TRGBLOCO"
[ -s "$TRGBLOCO" ] || { echo "INFRA: nao extrai o bloco do CREATE TRIGGER do .sql"; exit 1; }
tirar_trigger()  { P -q -c "DROP TRIGGER IF EXISTS trg_valida_cancelamento_pos_disparo ON public.pedido_compra_sugerido;" >/dev/null; }
por_trigger()    { P -q -f "$TRGBLOCO" >/dev/null; }

echo "-- grupo R: a corrida (2 conexoes, barreira OBSERVADA) --"
# R1 = BASELINE DO BUG. Sem este VERMELHO, o verde de R2 nao provaria nada: poderia significar
# apenas que a corrida nunca aconteceu.
semear; tirar_trigger
R1="$(corrida 5)"
eq     "R1a BASELINE: a corrida REALMENTE aconteceu (bloqueio observado)" "$(echo "$R1" | awk -F'~~' '{print $4}')" "sim"
eq     "R1b BASELINE sem trigger: a via crua VENCE a compra real"         "$(echo "$R1" | awk -F'~~' '{print $2}')" "cancelado_humano"
eq     "R1c BASELINE: e deixa o PO do Omie ORFAO sob status cancelado"    "$(echo "$R1" | awk -F'~~' '{print $3}')" "PO-REAL-NO-OMIE"

semear; por_trigger
R2="$(corrida 5)"
eq     "R2a a corrida aconteceu tambem no caminho com trigger"            "$(echo "$R2" | awk -F'~~' '{print $4}')" "sim"
contem "R2b COM trigger: a via crua e BARRADA mesmo vencendo a escrita"   "$R2" "[CANCEL-POS-DISPARO-SEM-PORTAO]"
eq     "R2c ... o pedido continua disparado"                              "$(echo "$R2" | awk -F'~~' '{print $2}')" "disparado"
eq     "R2d ... e o PO do Omie segue sob um status verdadeiro"            "$(echo "$R2" | awk -F'~~' '{print $3}')" "PO-REAL-NO-OMIE"

# R3 = CONTROLE INOCUO: um disparo em OUTRA linha nao pode barrar esta via crua. Sem R3, um
# trigger que recusasse sob QUALQUER concorrencia passaria por fix.
semear; por_trigger
P -q -c "DELETE FROM public.barreira;" >/dev/null
lancar_bloqueador 7 >/dev/null
if [ "$(esperar_A_travar)" = "sim" ]; then
  R3="$(tentar "UPDATE public.pedido_compra_sugerido /* outra_linha */ SET status='cancelado_humano' WHERE id=4")"
else
  R3="A-NAO-TRAVOU"
fi
liberar_A; wait "$BLOQ_PID" || true
eq "R3 CONTROLE: disparo concorrente em OUTRA linha nao barra esta via" "$R3" "PASSOU"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3). Uma camada por vez: a que ficar VERDE sob sabotagem é
# redundante ou inalcançada. O CONTROLE de cada F é o assert homônimo do grupo T/N/A, que
# rodou VERDE nesta MESMA invocação, acima — sem isso, uma sabotagem sempre-vermelha aprovaria
# tudo (docs/historico/falsificacao-sem-linha-de-base.md).
# ══════════════════════════════════════════════════════════════════════════════
FNBLOCO="$(mktemp /tmp/fn-cpd-XXXXXX)"
# shellcheck disable=SC2016  # `$trg$` e a TAG de dollar-quote do SQL.
sed -n '/^CREATE OR REPLACE FUNCTION public.reposicao__valida_cancelamento_pos_disparo/,/^\$trg\$;/p' "$MIG" > "$FNBLOCO"
[ -s "$FNBLOCO" ] || { echo "INFRA: nao extrai o corpo da funcao do trigger"; exit 1; }
restaurar_fn() { P -q -f "$FNBLOCO" >/dev/null; }

echo "-- grupo F: falsificacao --"
semear; tirar_trigger
eq "F1 SEM o trigger, a via crua volta a PASSAR (controle: T1 verde acima)" \
   "$(via_crua 1 'cancelado_humano')" "PASSOU"
eq "F1b ... carimbando cancelado sobre o PO real -- e exatamente o bug" "$(campo 1 status)" "cancelado_humano"
por_trigger; semear

# F2 — tira a REDE (a exigência de evidência), mantendo o portão. T6 tem de virar PASSOU.
P -q >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION public.reposicao__valida_cancelamento_pos_disparo()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $trg$
DECLARE v_portao text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF OLD.status NOT IN ('disparado','concluido_recebido') THEN RETURN NEW; END IF;
  IF NEW.status NOT LIKE 'cancelad%' THEN RETURN NEW; END IF;
  v_portao := nullif(current_setting('app.correcao_cancelamento_pos_disparo', true), '');
  IF v_portao IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-SEM-PORTAO] sabotagem F2' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;   -- SABOTADO: sem a exigencia de evidencia
END; $trg$;
SQL
eq "F2 sem a REDE, portao aberto sem carimbo PASSA (controle: T6 verde acima)" \
   "$(tentar "SELECT set_config('app.correcao_cancelamento_pos_disparo','1',true); UPDATE public.pedido_compra_sugerido SET status='cancelado_humano' WHERE id=1")" \
   "PASSOU"
restaurar_fn; semear

# F3 — portão BOOLEANO em vez de amarrado ao id. T5 tem de virar PASSOU (a autorização vaza).
P -q >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION public.reposicao__valida_cancelamento_pos_disparo()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $trg$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF OLD.status NOT IN ('disparado','concluido_recebido') THEN RETURN NEW; END IF;
  IF NEW.status NOT LIKE 'cancelad%' THEN RETURN NEW; END IF;
  IF nullif(current_setting('app.correcao_cancelamento_pos_disparo', true),'') IS NULL THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-SEM-PORTAO] sabotagem F3' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;   -- SABOTADO: portao booleano, nao amarrado ao id
END; $trg$;
SQL
eq "F3 portao BOOLEANO deixa a autorizacao vazar para outro pedido (controle: T5 verde acima)" \
   "$(tentar "SELECT set_config('app.correcao_cancelamento_pos_disparo','8',true); UPDATE public.pedido_compra_sugerido SET status='cancelado_humano' WHERE id=1")" \
   "PASSOU"
restaurar_fn; semear

# F4 — lista FECHADA em vez de prefixo. O vocabulário legado `cancelado` escapa: é exatamente o
# que deixaria de fora as linhas 409/1046 da PROD, cuja via está provada.
P -q >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION public.reposicao__valida_cancelamento_pos_disparo()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $trg$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF OLD.status NOT IN ('disparado','concluido_recebido') THEN RETURN NEW; END IF;
  IF NEW.status <> 'cancelado_humano' THEN RETURN NEW; END IF;   -- SABOTADO: so um vocabulario
  IF nullif(current_setting('app.correcao_cancelamento_pos_disparo', true),'') IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-SEM-PORTAO] sabotagem F4' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END; $trg$;
SQL
eq "F4 lista FECHADA deixa o vocabulario legado 'cancelado' escapar (controle: T2 verde acima)" \
   "$(via_crua 2 'cancelado')" "PASSOU"
restaurar_fn; semear

# F5 — a RPC sem a validação de evidência. N1 (evidência curta) tem de virar ok... e, com a REDE
# do trigger DE PÉ, ela na verdade morre no trigger: F5 prova que as DUAS camadas são distintas.
P -q >/dev/null <<'SQL'
CREATE OR REPLACE FUNCTION public.corrigir_cancelamento_pos_disparo(
  p_pedido_id bigint, p_usuario text, p_motivo text, p_evidencia text, p_justificativa text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_ant text;
BEGIN
  SELECT status INTO v_ant FROM public.pedido_compra_sugerido WHERE id=p_pedido_id FOR NO KEY UPDATE;
  PERFORM set_config('app.correcao_cancelamento_pos_disparo', p_pedido_id::text, true);
  UPDATE public.pedido_compra_sugerido
     SET status='cancelado_humano', cancelamento_pos_disparo_motivo=p_motivo,
         cancelamento_pos_disparo_evidencia=btrim(COALESCE(p_evidencia,'')),
         cancelamento_pos_disparo_por=p_usuario, cancelamento_pos_disparo_em=now()
   WHERE id=p_pedido_id AND status IN ('disparado','concluido_recebido');
  RETURN jsonb_build_object('status','ok');   -- SABOTADO: sem gate e sem validacao de evidencia
END; $$;
SQL
R=$(corrigir 1 'cancelado_junto_ao_fornecedor' 'ab')
contem "F5 RPC sem validacao: a REDE do trigger ainda segura a evidencia curta (controle: N1 verde acima)" \
   "$R" "[CANCEL-POS-DISPARO-SEM-EVIDENCIA]"
ator "$UID_CLIENTE" authenticated
R=$(corrigir 1 'cancelado_junto_ao_fornecedor' 'protocolo 2097501')
eq "F5b RPC sem GATE: o customer passa a corrigir (controle: A1 verde acima)" \
   "$(echo "$R" | grep -c 'CANCEL-POS-DISPARO-FORBIDDEN' || true)" "0"
ator "$UID_STAFF" authenticated
P -q -f "$MIG" >/dev/null   # restaura a RPC REAL (a migration inteira, idempotente)
semear

# F6 — falsifica a PRÓPRIA BARREIRA: com A travando OUTRA linha, o observador tem de dizer "nao".
# Sem isto, `esperar_bloqueio` poderia estar sempre devolvendo "sim" e R1a/R2a nao provariam nada.
P -q -c "DELETE FROM public.barreira;" >/dev/null
lancar_bloqueador 7 >/dev/null
if [ "$(esperar_A_travar)" = "sim" ]; then VISTO="$(esperar_bloqueio 20)"; else VISTO="A-NAO-TRAVOU"; fi
liberar_A; wait "$BLOQ_PID" || true
eq "F6 FALSIFICA a barreira: travando outra linha, nenhum bloqueio e observado" "$VISTO" "nao"

# F7 — a POSTCONDIÇÃO da migration tem dente? Controle verde primeiro, na mesma invocação.
semear
eq "F7a CONTROLE: postcondicao VERDE com o objeto real e linha 'disparado' semeada" "$(rodar_post)" "VERDE"
tirar_trigger
eq "F7b sem o trigger, a postcondicao fica VERMELHA"  "$(rodar_post)" "VERMELHO"
por_trigger
P -q -c "ALTER TABLE public.pedido_compra_sugerido DISABLE TRIGGER trg_valida_cancelamento_pos_disparo;" >/dev/null
eq "F7c trigger DESABILITADO (existe mas inerte) tambem fica VERMELHA" "$(rodar_post)" "VERMELHO"
P -q -c "ALTER TABLE public.pedido_compra_sugerido ENABLE TRIGGER trg_valida_cancelamento_pos_disparo;" >/dev/null
P -q -c "ALTER VIEW public.vw_cancelamento_pos_disparo_sem_evidencia SET (security_invoker = off);" >/dev/null
eq "F7d view sem security_invoker (falha ABERTA de RLS) fica VERMELHA" "$(rodar_post)" "VERMELHO"
P -q -c "ALTER VIEW public.vw_cancelamento_pos_disparo_sem_evidencia SET (security_invoker = on);" >/dev/null
eq "F7e restaurado: postcondicao VERDE de novo" "$(rodar_post)" "VERDE"

echo "-- grupo V: a query de validacao do handoff, nos DOIS sentidos --"
# Uma validacao que nunca soube dizer "nao aplicada" nao valida nada.
VAL="$REPO_ROOT/db/valida-cancelamento-pos-disparo.sql"
semear
contem "V1 com a migration aplicada, a query diz APLICADA" "$(Pq -f "$VAL" | tail -1)" "[APLICADA]"
tirar_trigger
contem "V2 sem o trigger, a MESMA query diz NAO APLICADA"  "$(Pq -f "$VAL" | tail -1)" "[NAO-APLICADA]"
contem "V2b ... e NOMEIA o eixo que falta"                 "$(Pq -f "$VAL" | tail -1)" "trigger ausente"
por_trigger
P -q -c "ALTER TABLE public.pedido_compra_sugerido DROP COLUMN cancelamento_pos_disparo_evidencia CASCADE;" >/dev/null
contem "V3 faltando UMA coluna de evidencia, a query conta e reprova" "$(Pq -f "$VAL" | tail -1)" "3/4"
P -q -f "$MIG" >/dev/null   # restaura tudo (a migration e idempotente)
contem "V4 reaplicando a migration, volta a APLICADA (idempotencia provada)" "$(Pq -f "$VAL" | tail -1)" "[APLICADA]"

# ══════════════════════════════════════════════════════════════════════════════
echo
echo "════════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL   (lc_messages=$HARNESS_LC)"
echo "════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
