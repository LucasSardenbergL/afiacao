#!/usr/bin/env bash
# Prova PG17 do passo 3 do "Radar sucessor": mesmo sócio pelo CPF MASCARADO (migration 20261107040000).
#   E*  sem lote vigente, a base (e por ela núcleo, ficha, lista e aviso de crédito) devolve EXATAMENTE o que devolvia
#       antes, para todo sujeito, com e sem carteira, com e sem cliente — salvo o nome de perfil-MEI, agora sem o CPF.
#   S*  o sinal 'socio_cpf': outro município, cliente fora do recorte (só gestor vê), ≤3 empresas no país, ≤2 raízes no
#       universo, qualificação de dono (mista não conta), máscara do MEI = dígitos 4 a 9, guarda de máscara conflitante
#       na regra antiga por nome, lote 'carregando' não conta; RPCs públicas (ficha, lista, crédito) herdam.
#   P*  protocolo da carga: manifesto imutável, chunk só em lote carregando, linha inválida contada e descartada,
#       reconciliação na publicação, troca de ponteiro (vigente → anterior → descartado), republicação idempotente,
#       limpeza em fatias.
#   G*  ACL: tabelas e RPCs fechadas ao JWT (SQLSTATE 42501 sob SET ROLE).
# Aplica as migrations REAIS da cadeia do vínculo (20261104201756 → 20261106083754 → 20261106205557) e depois esta.
#
#   bash db/test-radar-socios-cpf.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-socios-cpf.sh   # tem de ficar VERMELHA
#   bash db/test-radar-socios-cpf.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGS="$REPO_ROOT/supabase/migrations"
MIG_V1="$MIGS/20261104201756_radar_possiveis_vinculos.sql"
MIG_V2="$MIGS/20261106083754_radar_vinculos_em_lote.sql"
MIG_P2="$MIGS/20261106205557_credito_aviso_vinculo_vencido.sql"
MIG_PRAZO="$MIGS/20261031200000_venda_prazo_decisao.sql"
MIG_DOC="$MIGS/20261019140000_omie_identidade_cnpj_alfanumerico.sql"
MIG="$MIGS/20261107040000_radar_socios_cpf_mascarado.sql"
# O schema mínimo (papéis, caps, tabelas) é o MESMO da prova do passo 2 — lido de lá para não divergir.
PROVA_P2="$REPO_ROOT/db/test-credito-vinculo-aviso.sh"

if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_filtro_pais:S3 sem_universo:S4 sem_dono:S5 mascara_3a8:S6 sem_guarda:S7 guarda_sem_lote:E1 carregando_conta:S10 nome_perfil_cru:E2 regra_versao_1:C2 reconciliacao_frouxa:P4 manifesto_mutavel:P2 receber_em_vigente:P6 republica:P7 limpa_tudo:P9 tabela_aberta:post:A2 rpc_aberta:post:A3 deriva:pre mei_sem_norm:S11 receber_sem_lock:P10"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-socios.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  if ! grep -q "RADAR_SOCIOS_CPF_PROVA_OK" "$LOGDIR/controle.log"; then
    echo "❌ controle sem marcador de fim — falsificação abortada"; exit 1
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
    case "$a" in
      post:*) padrao="${a#post:} FALHOU" ;;
      pre)    padrao="PRE FALHOU" ;;
      *)      padrao="^FAIL $a " ;;
    esac
    if grep -q "$padrao" "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho"
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
PORT="${PGPORT_TEST:-5498}"
DATA="$(mktemp -d "/tmp/pgtest-radar-socios.XXXXXX")/data"
MIG_USADA="$(dirname "$DATA")/mig.sql"
# Locale HERDADO (a falsificação roda em LC_ALL=C e em pt_BR.UTF-8); vazio vira C — o postmaster exige um válido.
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; tem de ocorrer UMA vez no arquivo)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if s.count(de) != 1:
    sys.exit("padrao deve ocorrer 1 vez, ocorre %d: %s" % (s.count(de), de))
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
# Sabotagem de COMPORTAMENTO muda o corpo: sem cegar o md5 da PÓS e o da PRE (que o 2º apply roda), elas abortariam
# antes do assert que a sabotagem deve acender. A deriva (PRE) e as de ACL/protocolo não cegam.
cegar_md5() {
  sabotar "    IF r.vivo IS DISTINCT FROM r.esperado THEN" "    IF false AND r.vivo IS DISTINCT FROM r.esperado THEN"
  sabotar "  IF v_bs IS NULL OR v_bs NOT IN" "  IF false AND v_bs NOT IN"
  sabotar "  IF v_pa IS NULL OR v_pa NOT IN" "  IF false AND v_pa NOT IN"
}
case "${SABOTAGEM:-}" in
  "") ;;
  sem_filtro_pais)    cegar_md5; sabotar "AND coalesce(max(o.n_pais), 0) <= 3" "AND coalesce(max(o.n_pais), 0) <= 99" ;;
  sem_universo)       cegar_md5; sabotar "HAVING count(DISTINCT o.raiz) <= 2 AND" "HAVING count(DISTINCT o.raiz) <= 99 AND" ;;
  sem_dono)           cegar_md5; sabotar "bool_and(o.qualif IS NULL OR o.qualif IN ('05', '22', '49', '65')) AS dono" "true AS dono" ;;
  mascara_3a8)        cegar_md5; sabotar "'***' || substr(p, 4, 6) || '**'" "'***' || substr(p, 3, 6) || '**'" ;;
  sem_guarda)         cegar_md5; sabotar "       AND NOT private.radar_mascaras_conflitam(left(h.lead, 8), left(h.doc, 8), h.n)
" "" ;;
  guarda_sem_lote)    cegar_md5; sabotar "  SELECT EXISTS (SELECT 1 FROM vig)
     AND EXISTS (SELECT 1 FROM m WHERE m.raiz = p_raiz_a)" "  SELECT EXISTS (SELECT 1 FROM m WHERE m.raiz = p_raiz_a)" ;;
  carregando_conta)   cegar_md5; sabotar "    SELECT sl.lote FROM public.radar_socios_lote sl WHERE sl.status = 'vigente'
  )," "    SELECT sl.lote FROM public.radar_socios_lote sl WHERE sl.status IN ('vigente', 'carregando') ORDER BY sl.status DESC LIMIT 1
  )," ;;
  nome_perfil_cru)    cegar_md5; sabotar "regexp_replace(COALESCE(v.nome_radar, v.nome_perfil), ' [0-9]{11}\$', '') AS nome," "COALESCE(regexp_replace(v.nome_radar, ' [0-9]{11}\$', ''), v.nome_perfil) AS nome," ;;
  regra_versao_1)     cegar_md5; sabotar "RETURN jsonb_build_object('estado', 'fora_da_base', 'regra_versao', 2);" "RETURN jsonb_build_object('estado', 'fora_da_base', 'regra_versao', 1);" ;;
  reconciliacao_frouxa) sabotar "IF v_linhas <> r.linhas_declaradas OR v_raizes <> r.raizes_declaradas THEN" "IF false THEN" ;;
  manifesto_mutavel)  sabotar "      RAISE EXCEPTION 'RSOC_MANIFESTO_DIVERGENTE';" "      NULL;" ;;
  receber_em_vigente) sabotar "IF v_status <> 'carregando' THEN RAISE EXCEPTION 'RSOC_LOTE_FECHADO'; END IF;" "" ;;
  republica)          sabotar "  IF r.status IN ('vigente', 'anterior') THEN" "  IF false THEN" ;;
  limpa_tudo)         sabotar "WHERE x.lote IN (SELECT l.lote FROM public.radar_socios_lote l WHERE l.status = 'descartado')" "WHERE true" ;;
  tabela_aberta)      sabotar "REVOKE ALL ON TABLE public.radar_socios FROM PUBLIC, anon, authenticated;" "GRANT SELECT ON TABLE public.radar_socios TO authenticated;" ;;
  rpc_aberta)         sabotar "GRANT EXECUTE ON FUNCTION public.radar_socios_publicar(text) TO service_role;" "GRANT EXECUTE ON FUNCTION public.radar_socios_publicar(text) TO service_role, authenticated;" ;;
  mei_sem_norm)       cegar_md5; python3 -I - "$MIG_USADA" <<'PY2'
import re, sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
# volta ao nome CRU no ramo MEI de `ocorr` (o defeito que o Codex achou): só o 1º `AND btrim(...) = c.nome`
i = s.index("       AND btrim(regexp_replace(upper(translate(regexp_replace(e.razao_social")
j = s.index("= c.nome", i)
s = s[:i] + "       AND btrim(regexp_replace(e.razao_social, ' [0-9]{11}$', '')) " + s[j:]
open(p, "w", encoding="utf-8").write(s)
PY2
    ;;
  receber_sem_lock)   sabotar "  PERFORM pg_advisory_xact_lock(hashtext('radar_socios'));
  SELECT status INTO v_status FROM public.radar_socios_lote WHERE lote = p_lote FOR UPDATE;" "  SELECT status INTO v_status FROM public.radar_socios_lote WHERE lote = p_lote;" ;;
  deriva)             ;;  # outra sessão mudou a base viva depois do pré-voo: a PRE tem de abortar o apply
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

extrair() { # $1 = arquivo, $2 = início literal, $3 = fim literal
  python3 -I - "$1" "$2" "$3" <<'PY'
import sys
p, ini, fim = sys.argv[1:]
s = open(p, encoding="utf-8").read()
a = s.index(ini); b = s.index(fim, a) + len(fim)
print(s[a:b])
PY
}
# Schema mínimo: o heredoc de setup da prova do passo 2 (papéis, auth.uid, caps, tabelas).
extrair "$PROVA_P2" "CREATE ROLE anon NOLOGIN;" "chave_dedup text UNIQUE, ocorrido_em timestamptz NOT NULL DEFAULT now());" > "$(dirname "$DATA")/setup.sql"
P -q -f "$(dirname "$DATA")/setup.sql" >/dev/null
# Default privileges de TABELA do Supabase: tabela nova em public nasce aberta ao JWT (é o REVOKE que fecha).
P -q -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;" >/dev/null
P -q -f "$MIG_V1" >/dev/null
P -q -f "$MIG_V2" >/dev/null
{
  extrair "$MIG_PRAZO" "CREATE OR REPLACE FUNCTION public.venda_prazo_aviso(" "\$fn\$;"
  echo "REVOKE ALL ON FUNCTION public.venda_prazo_aviso(text, bigint) FROM PUBLIC, anon;"
  echo "GRANT EXECUTE ON FUNCTION public.venda_prazo_aviso(text, bigint) TO authenticated, service_role;"
  extrair "$MIG_DOC" "CREATE OR REPLACE FUNCTION public.cnpj_alfanumerico_valido(" "\$\$;"
  extrair "$MIG_DOC" "CREATE OR REPLACE FUNCTION public.normalizar_documento(" "\$\$;"
} > "$(dirname "$DATA")/vivos.sql"
P -q -f "$(dirname "$DATA")/vivos.sql" >/dev/null
P -q -f "$MIG_P2" >/dev/null
eq_pre() { [ "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('$1')")" = "$2" ] || { echo "FAIL X0 harness: $1 não é o corpo de prod"; exit 1; }; }
eq_pre 'private.radar_vinculos_base(text[],boolean,boolean)' 91dc715bb76efc00b85c4b86964d50db
eq_pre 'private.credito_vinculo_avaliar(text,boolean)' afbc83bfdbe959be21486d19c818d051
P -q -c "GRANT USAGE ON SCHEMA public TO service_role;" >/dev/null

# ── Fixture ── (M1/M2 = municípios; 3xxxxxxx = leads, 4xxxxxxx = clientes no Radar, 5xxxxxxx = clientes só no cadastro)
Pq -c "INSERT INTO public.radar_empresas (cnpj, razao_social, ja_cliente, telefone1, municipio_codigo, socios_nomes, rfb_situacao) VALUES
  ('31000001000101','A1 NOVA LTDA',false,NULL,'M1','MARIA SOUZA LIMA','02'),
  ('41000001000101','CA1 VELHA LTDA',true,NULL,'M2','MARIA SOUZA LIMA','08'),
  ('31000002000101','A2 LTDA',false,NULL,'M1','JOSE CARLOS NUNES','02'),
  ('31000003000101','A3 LTDA',false,NULL,'M1',NULL,'02'),
  ('41000003000101','CA3 LTDA',true,NULL,'M2',NULL,'02'),
  ('31000004000101','A4 LTDA',false,NULL,'M1',NULL,'02'),
  ('41000004000101','CA4 LTDA',true,NULL,'M2',NULL,'02'),
  ('39000004000101','X4 LTDA',false,NULL,'M2',NULL,'02'),
  ('31000005000101','A5 LTDA',false,NULL,'M1',NULL,'02'),
  ('41000005000101','CA5 LTDA',true,NULL,'M2',NULL,'02'),
  ('31000015000101','A5B LTDA',false,NULL,'M1',NULL,'02'),
  ('41000015000101','CA5B SA',true,NULL,'M2',NULL,'02'),
  ('31000006000101','PEDRO ALVES COSTA 12345678901',false,NULL,'M1',NULL,'02'),
  ('41000006000101','CA6 LTDA',true,NULL,'M2',NULL,'02'),
  ('31000016000101','RITA MELO DIAS 11122233344',false,NULL,'M1',NULL,'02'),
  ('41000016000101','CA6X LTDA',true,NULL,'M2',NULL,'02'),
  ('31000007000101','A7 LTDA',false,NULL,'M1','ANA PAULA REIS','02'),
  ('41000007000101','CA7 LTDA',true,NULL,'M1','ANA PAULA REIS','02'),
  ('31000017000101','A7B LTDA',false,NULL,'M1','BETO LUIZ MOTA','02'),
  ('41000017000101','CA7B LTDA',true,NULL,'M1','BETO LUIZ MOTA','02'),
  ('31000013000101','LUIZ GOMES PRADO 11111111111',false,NULL,'M1',NULL,'02'),
  ('41000013000101','LUIZ GOMES PRADO 22222222222',true,NULL,'M1',NULL,'04'),
  ('31000012000101','A12 LTDA',false,'(37) 99990012','M1',NULL,'02'),
  ('31000009000101','A9 LTDA',false,NULL,'M1',NULL,'02'),
  ('31000011000101','A11 LTDA',false,NULL,'M1',NULL,'02'),
  ('41000011000101','CA11 LTDA',true,NULL,'M2',NULL,'02'),
  ('39000011000101','JOÃO DA SILVA 99945678901',false,NULL,'M2',NULL,'02');
UPDATE public.radar_empresas SET email = 'ze.mei@gmail.com' WHERE cnpj = '31000012000101';
INSERT INTO public.profiles (user_id, document, razao_social, name, phone, email) VALUES
  ('00000000-0000-0000-0000-000000000001','41.000.001/0001-01','CA1 VELHA LTDA',NULL,NULL,NULL),
  ('00000000-0000-0000-0000-000000000002','51000002000101','FORA LTDA',NULL,NULL,NULL),
  ('00000000-0000-0000-0000-000000000012','51000012000101','ZE MEI SILVA 12345678909',NULL,'(37) 99990012','ze.mei@gmail.com'),
  ('00000000-0000-0000-0000-000000000009','51000009000101','FORA DEVEDORA LTDA',NULL,NULL,NULL);
INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, evidence_document_normalized) VALUES
  ('00000000-0000-0000-0000-000000000001','oben',101,'41000001000101'),
  ('00000000-0000-0000-0000-000000000009','oben',109,'51000009000101');
INSERT INTO public.fin_contas_receber (company, omie_codigo_cliente, status_titulo, saldo, valor_documento, data_emissao, data_vencimento) VALUES
  ('oben',101,'ATRASADO',500,500,current_date - 60,current_date - 30),
  ('oben',109,'ATRASADO',70,70,current_date - 60,current_date - 30);
INSERT INTO public.fin_sync_log (action, companies, status, completed_at) VALUES
  ('sync_all', ARRAY['oben','colacor'], 'complete', now() - interval '1 hour');" >/dev/null

GESTOR='{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}'
VENDEDOR='{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}'
sql_como() { # $1 = claims, $2 = SQL → a saída (ou a mensagem de erro: quem julga é o assert)
  P -qAt -v VERBOSITY=verbose <<SQL 2>&1 || true
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '$1', false) IS NULL;
$2
SQL
}
foto_base() { # todo sujeito × carteira × incluir clientes → linhas ordenadas
  Pq -c "SELECT coalesce(string_agg(x, E'\n' ORDER BY x), '-') FROM (
    SELECT c::text || '|' || i::text || '|' || b.lead_cnpj || '|' || b.ordem || '|' || b.cliente_cnpj || '|'
           || coalesce(b.cliente_nome,'-') || '|' || coalesce(b.cliente_situacao,'-') || '|' || b.forca || '|'
           || array_to_string(b.sinais, '+') AS x
      FROM (VALUES (true), (false)) v(c), (VALUES (true), (false)) w(i),
           private.radar_vinculos_base((SELECT array_agg(cnpj) FROM public.radar_empresas), v.c, w.i) b) t;"
}
foto_aviso() { # o aviso de crédito de todo sujeito, como gestor, sem a versão da regra
  for c in $(Pq -c "SELECT cnpj FROM public.radar_empresas ORDER BY cnpj"); do
    echo "$c $(sql_como "$GESTOR" "SELECT (public.credito_vinculo_aviso('$c') - 'regra_versao')::text;" | tail -1)"
  done
}
foto_base > "$(dirname "$DATA")/base-antes.txt"
foto_aviso > "$(dirname "$DATA")/aviso-antes.txt"

if [ "${SABOTAGEM:-}" = "deriva" ]; then
  P -q -c "CREATE OR REPLACE FUNCTION private.radar_vinculos_base(p_cnpjs text[], p_carteira boolean, p_incluir_clientes boolean)
           RETURNS TABLE(lead_cnpj text, ordem integer, cliente_cnpj text, cliente_nome text, cliente_situacao text, forca text, sinais text[])
           LANGUAGE sql STABLE AS \$f\$ SELECT NULL::text, 1, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text[] WHERE false \$f\$;" >/dev/null
fi

# ── Apply ── (a PÓS roda dentro; o 2º apply prova idempotência)
P -q -f "$MIG_USADA" > "$(dirname "$DATA")/apply.log" 2>&1 || { cat "$(dirname "$DATA")/apply.log"; exit 1; }
P -q -f "$MIG_USADA" > "$(dirname "$DATA")/apply2.log" 2>&1 || { echo "FAIL X1 re-apply"; cat "$(dirname "$DATA")/apply2.log"; exit 1; }

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
tem() { if printf '%s' "$2" | grep -qF -- "$3"; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — [$3] ausente em [$2]"; FAIL=$((FAIL+1)); fi; }

# E1: sem lote vigente, a base é a de antes (exceto o nome de perfil-MEI saneado, que E2 cobre).
foto_base > "$(dirname "$DATA")/base-depois.txt"
sed -E 's/ZE MEI SILVA 12345678909/ZE MEI SILVA/' "$(dirname "$DATA")/base-antes.txt" > "$(dirname "$DATA")/base-antes-saneada.txt"
eq E1 "$(diff "$(dirname "$DATA")/base-antes-saneada.txt" "$(dirname "$DATA")/base-depois.txt" > /dev/null && echo igual || echo diferente)" igual
# E2: o CPF do MEI do PERFIL não sai mais no nome do cliente (antes saía) — gestor, lead A12 (mesmo telefone).
eq E2 "$(grep -c '12345678909' "$(dirname "$DATA")/base-depois.txt" || true)|$(grep -c 'ZE MEI SILVA 12345678909' "$(dirname "$DATA")/base-antes.txt" || true)" "0|2"
foto_aviso > "$(dirname "$DATA")/aviso-depois.txt"
sed -E 's/ZE MEI SILVA 12345678909/ZE MEI SILVA/g' "$(dirname "$DATA")/aviso-antes.txt" > "$(dirname "$DATA")/aviso-antes-saneado.txt"
eq E3 "$(diff "$(dirname "$DATA")/aviso-antes-saneado.txt" "$(dirname "$DATA")/aviso-depois.txt" > /dev/null && echo igual || echo diferente)" igual

# ── Carga de um lote pelas RPCs (como service_role) ──
SR() { P -qAt -v VERBOSITY=verbose -c "SET ROLE service_role; $1" 2>&1 | grep -v '^SET$' || true; }
DIG1=$(printf '1%.0s' $(seq 64))
LINHAS='[
 {"raiz":"31000001","nome_normalizado":"MARIA SOUZA LIMA","cpf_mascarado":"***111111**","qualificacao":"49","data_entrada":"2026-01-10","n_raizes_pais":2},
 {"raiz":"41000001","nome_normalizado":"MARIA SOUZA LIMA","cpf_mascarado":"***111111**","qualificacao":"22","data_entrada":"2015-03-01","n_raizes_pais":2},
 {"raiz":"31000002","nome_normalizado":"JOSE CARLOS NUNES","cpf_mascarado":"***222222**","qualificacao":"49","data_entrada":null,"n_raizes_pais":2},
 {"raiz":"51000002","nome_normalizado":"JOSE CARLOS NUNES","cpf_mascarado":"***222222**","qualificacao":"49","data_entrada":null,"n_raizes_pais":2},
 {"raiz":"31000003","nome_normalizado":"CARLA DIAS ROCHA","cpf_mascarado":"***333333**","qualificacao":"49","data_entrada":null,"n_raizes_pais":4},
 {"raiz":"41000003","nome_normalizado":"CARLA DIAS ROCHA","cpf_mascarado":"***333333**","qualificacao":"49","data_entrada":null,"n_raizes_pais":4},
 {"raiz":"31000004","nome_normalizado":"DIEGO REIS LOPES","cpf_mascarado":"***444444**","qualificacao":"49","data_entrada":null,"n_raizes_pais":3},
 {"raiz":"41000004","nome_normalizado":"DIEGO REIS LOPES","cpf_mascarado":"***444444**","qualificacao":"49","data_entrada":null,"n_raizes_pais":3},
 {"raiz":"39000004","nome_normalizado":"DIEGO REIS LOPES","cpf_mascarado":"***444444**","qualificacao":"49","data_entrada":null,"n_raizes_pais":3},
 {"raiz":"31000005","nome_normalizado":"EVA LIMA PORTO","cpf_mascarado":"***555555**","qualificacao":"49","data_entrada":null,"n_raizes_pais":2},
 {"raiz":"31000005","nome_normalizado":"EVA LIMA PORTO","cpf_mascarado":"***555555**","qualificacao":"10","data_entrada":null,"n_raizes_pais":2},
 {"raiz":"41000005","nome_normalizado":"EVA LIMA PORTO","cpf_mascarado":"***555555**","qualificacao":"49","data_entrada":null,"n_raizes_pais":2},
 {"raiz":"31000015","nome_normalizado":"FABIO NETO VAZ","cpf_mascarado":"***515151**","qualificacao":"49","data_entrada":null,"n_raizes_pais":2},
 {"raiz":"41000015","nome_normalizado":"FABIO NETO VAZ","cpf_mascarado":"***515151**","qualificacao":"10","data_entrada":null,"n_raizes_pais":2},
 {"raiz":"41000006","nome_normalizado":"PEDRO ALVES COSTA","cpf_mascarado":"***456789**","qualificacao":"49","data_entrada":null,"n_raizes_pais":1},
 {"raiz":"41000016","nome_normalizado":"RITA MELO DIAS","cpf_mascarado":"***999999**","qualificacao":"49","data_entrada":null,"n_raizes_pais":1},
 {"raiz":"31000007","nome_normalizado":"ANA PAULA REIS","cpf_mascarado":"***777777**","qualificacao":"49","data_entrada":null,"n_raizes_pais":1},
 {"raiz":"41000007","nome_normalizado":"ANA PAULA REIS","cpf_mascarado":"***777700**","qualificacao":"49","data_entrada":null,"n_raizes_pais":1},
 {"raiz":"31000017","nome_normalizado":"BETO LUIZ MOTA","cpf_mascarado":"***171717**","qualificacao":"49","data_entrada":null,"n_raizes_pais":1},
 {"raiz":"31000009","nome_normalizado":"GIL ROSA PINTO","cpf_mascarado":"***909090**","qualificacao":"49","data_entrada":null,"n_raizes_pais":2},
 {"raiz":"51000009","nome_normalizado":"GIL ROSA PINTO","cpf_mascarado":"***909090**","qualificacao":"22","data_entrada":null,"n_raizes_pais":2},
 {"raiz":"31000011","nome_normalizado":"JOAO DA SILVA","cpf_mascarado":"***456789**","qualificacao":"49","data_entrada":null,"n_raizes_pais":2},
 {"raiz":"41000011","nome_normalizado":"JOAO DA SILVA","cpf_mascarado":"***456789**","qualificacao":"49","data_entrada":null,"n_raizes_pais":2}
]'
N_LINHAS=23; N_RAIZES=22
# P1: manifesto criado em 'carregando'; o mesmo manifesto de novo é retomada (idempotente).
INI=$(SR "SELECT public.radar_socios_iniciar('2026-10', '$DIG1', 'v1', $N_LINHAS, $N_RAIZES, 40) ->> 'status';")
INI2=$(SR "SELECT public.radar_socios_iniciar('2026-10', '$DIG1', 'v1', $N_LINHAS, $N_RAIZES, 40) ->> 'lote';")
eq P1 "$INI|$INI2" "carregando|2026-10-11111111"
# P2: manifesto IMUTÁVEL — mesmo lote com contagem declarada menor é recusado.
tem P2 "$(SR "SELECT public.radar_socios_iniciar('2026-10', '$DIG1', 'v1', 3, 2, 40);")" "RSOC_MANIFESTO_DIVERGENTE"
# P3: chunk com 1 linha inválida (máscara fora do formato, CPF completo) → contada e descartada, sem eco do valor.
R3=$(SR "SELECT public.radar_socios_receber('2026-10-11111111', '[{\"raiz\":\"31000001\",\"nome_normalizado\":\"X Y\",\"cpf_mascarado\":\"12345678901\",\"qualificacao\":\"49\",\"data_entrada\":null,\"n_raizes_pais\":1}]'::jsonb)::text;")
eq P3 "$R3" '{"inseridas": 0, "invalidas": 1, "recebidas": 1}'
# Carga parcial (só as 10 primeiras) → P4: a publicação recusa (reconciliação).
P -qAt -c "SET ROLE service_role; SELECT public.radar_socios_receber('2026-10-11111111', (SELECT jsonb_agg(e) FROM (SELECT e FROM jsonb_array_elements('$LINHAS'::jsonb) WITH ORDINALITY t(e, i) WHERE i <= 10) x));" >/dev/null
tem P4 "$(SR "SELECT public.radar_socios_publicar('2026-10-11111111');")" "RSOC_RECONCILIACAO"
# O resto (o chunk inteiro de novo: retentativa não duplica).
R5=$(SR "SELECT public.radar_socios_receber('2026-10-11111111', '$LINHAS'::jsonb) ->> 'inseridas';")
eq P5 "$R5" "13"
# S10: lote ainda 'carregando' não contribui.
eq S10 "$(Pq -c "SELECT count(*) FROM private.radar_vinculos_base(ARRAY['31000001000101'], true, true) WHERE 'socio_cpf' = ANY (sinais);")" "0"
PUB=$(SR "SELECT public.radar_socios_publicar('2026-10-11111111') ->> 'status';")
eq P5b "$PUB" "vigente"
# P6: chunk em lote já vigente é recusado.
tem P6 "$(SR "SELECT public.radar_socios_receber('2026-10-11111111', '$LINHAS'::jsonb);")" "RSOC_LOTE_FECHADO"
# P7: republicar (resposta perdida) responde sucesso sem promover de novo.
eq P7 "$(SR "SELECT public.radar_socios_publicar('2026-10-11111111') ->> 'ja_publicado';")" "true"

v() { # sujeito, carteira, incluir → "cliente:forca:sinais" ordenados
  Pq -c "SELECT coalesce(string_agg(cliente_cnpj || ':' || forca || ':' || array_to_string(sinais, '+'), ',' ORDER BY cliente_cnpj), '-')
           FROM private.radar_vinculos_base(ARRAY['$1'], $2, $3);"
}
# S1: mesmo sócio em OUTRO município (a regra antiga não pegava) → socio_cpf, forte.
eq S1 "$(v 31000001000101 false false)" "41000001000101:forte:socio_cpf"
# S2: cliente FORA do recorte (só no cadastro): o gestor vê; o vendedor (sem carteira) não.
eq S2 "$(v 31000002000101 true false)|$(v 31000002000101 false false)" "51000002000101:forte:socio_cpf|-"
# S3: a chave aparece em 4 empresas no país → não.
eq S3 "$(v 31000003000101 true false)" "-"
# S4: 3 raízes no universo → não.
eq S4 "$(v 31000004000101 true false)" "-"
# S5: qualificação mista no sujeito (sócio-adm E diretor) → não; S5b: o cliente só tem diretor → não.
eq S5 "$(v 31000005000101 true false)|$(v 31000015000101 true false)" "-|-"
# S6: titular de MEI (CPF na razão → ***456789**) casa o QSA do cliente; máscara diferente não casa.
eq S6 "$(v 31000006000101 true false)|$(v 31000016000101 true false)" "41000006000101:forte:socio_cpf|-"
# S7: regra antiga por nome no mesmo município: máscaras dos 2 lados e diferentes → não casa; cliente sem máscara
#     para esse nome → a regra antiga segue; MEI × MEI com CPFs diferentes → não casa.
eq S7 "$(v 31000007000101 true false)|$(v 31000017000101 true false)|$(v 31000013000101 true false)" "-|41000017000101:forte:pessoa|-"
# S11: o titular de MEI com ACENTO ('JOÃO DA SILVA', mesma máscara) é a 3ª raiz da chave → não é exclusiva → não.
eq S11 "$(v 31000011000101 true false)" "-"
# S8: as RPCs públicas herdam — ficha (radar_possiveis_vinculos) do gestor traz o socio_cpf.
tem S8 "$(sql_como "$GESTOR" "SELECT public.radar_possiveis_vinculos('31000001000101')::text;" | tail -1)" "socio_cpf"
# S9: a lista em lote também (o selo forte dos 2 leads que só o CPF parcial liga).
eq S9 "$(sql_como "$GESTOR" "SELECT string_agg(cnpj || ':' || forca, ',' ORDER BY cnpj) FROM public.radar_vinculos_por_cnpjs(ARRAY['31000001000101','31000002000101']);" | tail -1)" "31000001000101:forte,31000002000101:forte"
# C1: o AVISO de crédito vê o devedor ligado só pelo CPF parcial (outro município; e o fora do recorte).
C1=$(sql_como "$GESTOR" "SELECT (SELECT string_agg(v ->> 'cliente_cnpj', ',' ORDER BY v ->> 'cliente_cnpj') FROM jsonb_array_elements(public.credito_vinculo_aviso(c) -> 'vinculos') v)
                            FROM unnest(ARRAY['31000001000101','31000009000101']) c;" | tail -2 | tr '\n' ' ')
eq C1 "$C1" "41000001000101 51000009000101 "
# C2: versão da regra 2 (inclusive no 'fora_da_base').
eq C2 "$(sql_como "$GESTOR" "SELECT public.credito_vinculo_aviso('31000001000101') ->> 'regra_versao', public.credito_vinculo_aviso('99999999000191') ->> 'regra_versao';" | tail -1)" "2|2"

# P8: 2º e 3º lotes: o vigente vira anterior; o anterior, descartado.
DIG2=$(printf '2%.0s' $(seq 64)); DIG3=$(printf '3%.0s' $(seq 64))
UM='[{"raiz":"31000001","nome_normalizado":"MARIA SOUZA LIMA","cpf_mascarado":"***111111**","qualificacao":"49","data_entrada":null,"n_raizes_pais":2}]'
for d in "$DIG2" "$DIG3"; do
  SR "SELECT public.radar_socios_iniciar('2026-11', '$d', 'v1', 1, 1, 40); SELECT public.radar_socios_receber('2026-11-${d:0:8}', '$UM'::jsonb); SELECT public.radar_socios_publicar('2026-11-${d:0:8}');" >/dev/null
done
eq P8 "$(Pq -c "SELECT string_agg(lote || '=' || status, ',' ORDER BY lote) FROM public.radar_socios_lote;")" "2026-10-11111111=descartado,2026-11-22222222=anterior,2026-11-33333333=vigente"
# P9: a limpeza apaga em fatias SÓ o descartado; vigente e anterior ficam.
SR "SELECT public.radar_socios_limpar(5);" >/dev/null
eq P9a "$(Pq -c "SELECT count(*) FROM public.radar_socios WHERE lote = '2026-10-11111111';")|$(Pq -c "SELECT count(*) FROM public.radar_socios WHERE lote <> '2026-10-11111111';")" "18|2"
for _ in 1 2 3 4; do SR "SELECT public.radar_socios_limpar(5);" >/dev/null; done
eq P9 "$(Pq -c "SELECT string_agg(lote || '=' || status, ',' ORDER BY lote) FROM public.radar_socios_lote;")|$(Pq -c "SELECT count(*) FROM public.radar_socios;")" "2026-11-22222222=anterior,2026-11-33333333=vigente|2"

# P10: concorrência — um chunk em transação aberta (sessão A) e a publicação (sessão B) ao mesmo tempo: B ESPERA o
#      commit de A e reconcilia com as linhas dele (sem o lock, B leria o lote incompleto e reprovaria).
DIG4=$(printf '4%.0s' $(seq 64))
DOIS='[{"raiz":"31000001","nome_normalizado":"MARIA SOUZA LIMA","cpf_mascarado":"***111111**","qualificacao":"49","data_entrada":null,"n_raizes_pais":2},{"raiz":"41000001","nome_normalizado":"MARIA SOUZA LIMA","cpf_mascarado":"***111111**","qualificacao":"22","data_entrada":null,"n_raizes_pais":2}]'
SR "SELECT public.radar_socios_iniciar('2026-12', '$DIG4', 'v1', 2, 2, 40);" >/dev/null
P -qAt -c "BEGIN; SET LOCAL ROLE service_role; SELECT public.radar_socios_receber('2026-12-44444444', '$DOIS'::jsonb); SELECT pg_sleep(2); COMMIT;" > /dev/null 2>&1 &
PID_A=$!
sleep 0.7
P10=$(SR "SELECT public.radar_socios_publicar('2026-12-44444444') ->> 'status';")
wait "$PID_A" || true
eq P10 "$P10" "vigente"

# G1-G3: o JWT não lê as tabelas nem chama as RPCs da carga (42501).
tem G1 "$(sql_como "$GESTOR" "SELECT count(*) FROM public.radar_socios;")" "42501"
tem G2 "$(sql_como "$GESTOR" "SELECT count(*) FROM public.radar_socios_lote;")" "42501"
tem G3 "$(sql_como "$GESTOR" "SELECT public.radar_socios_publicar('2026-11-33333333');")" "42501"
tem G4 "$(sql_como "$VENDEDOR" "SELECT private.radar_vinculos_base(ARRAY['31000001000101'], true, true);")" "42501"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_SOCIOS_CPF_PROVA_OK"
[ "$FAIL" -eq 0 ]
