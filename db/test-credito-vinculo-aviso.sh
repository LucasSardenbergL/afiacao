#!/usr/bin/env bash
# Prova PG17 do AVISO de crédito por vínculo com cliente que tem título vencido (migration 20261106205557).
#   E*  equivalência: o núcleo da ficha/lista (agora invólucro de private.radar_vinculos_base) devolve, lead a lead e
#       para gestor E vendedor (p_carteira true/false), EXATAMENTE o que devolvia antes da migration.
#   C*  credito_vinculo_aviso: já-cliente incluído, sem o corte de 10, carteira inteira avaliada (só-profiles), código
#       Omie só com PROVA documental (evidência = documento do vinculado, titular único), a regra do vencido é a de
#       venda_prazo_aviso (A VENCER já passado conta), colacor_sc entra como credora, vínculo em dia some, avaliação
#       incompleta (sem prova, título ambíguo) vira INDETERMINADO, fora da base diz 'fora_da_base', e a projeção é a
#       da ficha (cliente só-cadastro sem nome/CNPJ para quem não lê a carteira).
#   G*  gate staff (inclusive no 'fora_da_base'), CNPJ inválido, ACL, base/núcleo fechados ao JWT.
#   S*  o sensor credito_vinculo_aviso_registrar: staff, só aviso VIGENTE, 'servido' 1/dia com os pares, todo voto
#       de 'conferido' grava, com o CNPJ real do vinculado mesmo quando a tela o oculta.
# Aplica as migrations REAIS (cadeia do vínculo + corpos vivos de venda_prazo_aviso e normalizar_documento + esta).
#
#   bash db/test-credito-vinculo-aviso.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-credito-vinculo-aviso.sh   # tem de ficar VERMELHA
#   bash db/test-credito-vinculo-aviso.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGS="$REPO_ROOT/supabase/migrations"
MIG_V1="$MIGS/20261104201756_radar_possiveis_vinculos.sql"
MIG_V2="$MIGS/20261106083754_radar_vinculos_em_lote.sql"
MIG_PRAZO="$MIGS/20261031200000_venda_prazo_decisao.sql"       # corpo de venda_prazo_aviso (= prod)
MIG_DOC="$MIGS/20261019140000_omie_identidade_cnpj_alfanumerico.sql"  # normalizar_documento (= prod)
MIG="$MIGS/20261106205557_credito_aviso_vinculo_vencido.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la> — `post:A3` = a POSTCONDIÇÃO da migration aborta; `pre` = a PRE aborta.
  SABOTAGENS="aviso_sem_clientes:C2 aviso_corta_10:C3 aviso_sem_carteira:C5 prova_ignorada:C4 titular_duplo:C7 evidencia_nula:C13 sem_frescor:C1 parcial_falso:C1 ref_por_posicao:S10 regra_inline:C5 sem_vencido_aparece:C11 incompleto_ignorado:C6 vendedor_ve_tudo:C10 fora_vira_vazio:C8 aviso_sem_gate:G1b registrar_sem_gate:S5 registrar_sem_vigencia:S6 voto_deduplicado:S3 nucleo_corta_11:E1 nucleo_mostra_cliente:E1 aviso_anon:post:A3 base_aberta:post:A2 deriva:pre"
  LOGDIR="$(mktemp -d "/tmp/falsifica-credito-vinculo.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  if ! grep -q "CREDITO_VINCULO_AVISO_PROVA_OK" "$LOGDIR/controle.log"; then
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
PORT="${PGPORT_TEST:-5497}"
DATA="$(mktemp -d "/tmp/pgtest-credito-vinculo.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; tem de existir no arquivo)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if s.count(de) != 1:
    sys.exit("padrao deve ocorrer 1 vez, ocorre %d: %s" % (s.count(de), de))
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
# Sabotagem de COMPORTAMENTO muda o corpo; sem cegar as checagens de md5 (PRE do re-apply e PÓS), elas abortariam
# antes do assert que a sabotagem deve acender.
cegar_md5() {
  sabotar "    IF r.vivo IS DISTINCT FROM r.esperado THEN" "    IF false AND r.vivo IS DISTINCT FROM r.esperado THEN"
  sabotar "  IF v_bs IS NOT NULL AND v_bs <>" "  IF false AND v_bs <>"
  sabotar "  IF v_av IS NOT NULL AND v_av <>" "  IF false AND v_av <>"
  sabotar "  IF v_pa IS NOT NULL AND v_pa <>" "  IF false AND v_pa <>"
  sabotar "  IF v_nuc IS NULL OR v_nuc NOT IN" "  IF false AND v_nuc NOT IN"
  sabotar "  IF v_rg IS NOT NULL AND v_rg <>" "  IF false AND v_rg <>"
}
# A chamada da base DENTRO do aviso (o sensor tem outra, com WHERE b.ordem = p_ref): contexto que só ela tem.
BASE_DO_AVISO="      FROM private.radar_vinculos_base(ARRAY[p_cnpj], true, true) b
  ),"
case "${SABOTAGEM:-}" in
  "") ;;
  aviso_sem_clientes)   cegar_md5; sabotar "$BASE_DO_AVISO" "      FROM private.radar_vinculos_base(ARRAY[p_cnpj], true, false) b
  )," ;;
  aviso_corta_10)       cegar_md5; sabotar "$BASE_DO_AVISO" "      FROM private.radar_vinculos_base(ARRAY[p_cnpj], true, true) b WHERE b.ordem <= 10
  )," ;;
  aviso_sem_carteira)   cegar_md5; sabotar "$BASE_DO_AVISO" "      FROM private.radar_vinculos_base(ARRAY[p_cnpj], false, true) b
  )," ;;
  prova_ignorada)       cegar_md5; sabotar "            AND m.evidence_document_normalized = t.cliente_cnpj" "            AND true" ;;
  titular_duplo)        cegar_md5; sabotar "COALESCE(t.n_titulares = 1" "COALESCE(true" ;;
  evidencia_nula)       cegar_md5; sabotar "AND m.updated_at >= now() - interval '7 days', false) AS provado" "AND m.updated_at >= now() - interval '7 days') AS provado" ;;
  sem_frescor)          cegar_md5; sabotar "AND m.updated_at >= now() - interval '7 days', false) AS provado" "AND true, false) AS provado" ;;
  parcial_falso)        cegar_md5; sabotar "'parcial', (pv.n_sem_prova > 0 OR pv.incompleto)," "'parcial', false," ;;
  ref_por_posicao)      cegar_md5; sabotar "'ref', left(md5(p_cnpj || '|' || pv.cliente_cnpj), 16)," "'ref', lpad(pv.ordem::text, 16, '0')," ;;
  incompleto_ignorado)  cegar_md5; sabotar "AND (pv.n_provados = 0 OR pv.n_sem_prova > 0 OR pv.incompleto))" "AND (pv.n_provados = 0))" ;;
  vendedor_ve_tudo)     cegar_md5; sabotar "'cliente_cnpj', CASE WHEN pv.no_radar OR p_ver_carteira THEN pv.cliente_cnpj END," "'cliente_cnpj', pv.cliente_cnpj," ;;
  registrar_sem_gate)   cegar_md5; python3 -I - "$MIG_USADA" <<'PY2'
import sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
i = s.index("CREATE OR REPLACE FUNCTION public.credito_vinculo_aviso_registrar")
g = "  IF v_uid IS NULL OR NOT EXISTS ("
j = s.index(g, i)
k = s.index("THEN", j) + len("THEN")
open(p, "w", encoding="utf-8").write(s[:j] + "  IF false THEN" + s[k:])
PY2
    ;;
  registrar_sem_vigencia) cegar_md5; sabotar "  IF v_aviso ->> 'estado' IS DISTINCT FROM 'avaliado' OR jsonb_array_length(v_aviso -> 'vinculos') = 0 THEN" "  IF false THEN" ;;
  voto_deduplicado)     cegar_md5; sabotar "               || ':' || to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS');" "               || ':' || v_dia;" ;;
  regra_inline)         cegar_md5; sabotar "public.venda_prazo_aviso(q.company, q.codigo) AS a" "(SELECT jsonb_build_object('disponivel', true, 'vencido', coalesce(sum(r.saldo), 0), 'n_titulos', count(*), 'qualidade', 'ok') FROM public.fin_contas_receber r WHERE r.company = q.company AND r.omie_codigo_cliente = q.codigo AND r.status_titulo = 'ATRASADO' AND r.saldo > 0) AS a" ;;
  sem_vencido_aparece)  cegar_md5; sabotar "FROM credora c WHERE c.cliente_cnpj = v.cliente_cnpj AND c.vencido > 0" "FROM credora c WHERE c.cliente_cnpj = v.cliente_cnpj" ;;
  fora_vira_vazio)      cegar_md5; sabotar "RETURN jsonb_build_object('estado', 'fora_da_base', 'regra_versao', 1);" "RETURN jsonb_build_object('estado', 'avaliado', 'regra_versao', 1, 'n_vinculos', 0, 'n_indeterminados', 0, 'vinculos', '[]'::jsonb);" ;;
  aviso_sem_gate)       cegar_md5; sabotar "  IF v_uid IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = v_uid AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'credito_vinculo_aviso: exige staff'" "  IF false THEN
    RAISE EXCEPTION 'credito_vinculo_aviso: exige staff'" ;;
  nucleo_corta_11)      cegar_md5; sabotar "   WHERE b.ordem <= 10
\$function\$;" "   WHERE b.ordem <= 11
\$function\$;" ;;
  nucleo_mostra_cliente) cegar_md5; sabotar "FROM private.radar_vinculos_base(p_cnpjs, p_carteira, false) b" "FROM private.radar_vinculos_base(p_cnpjs, p_carteira, true) b" ;;
  aviso_anon)           sabotar "REVOKE ALL ON FUNCTION public.credito_vinculo_aviso(text) FROM PUBLIC, anon;" "REVOKE ALL ON FUNCTION public.credito_vinculo_aviso(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.credito_vinculo_aviso(text) TO anon;" ;;
  base_aberta)          sabotar "REVOKE ALL ON FUNCTION private.radar_vinculos_base(text[], boolean, boolean) FROM PUBLIC, anon, authenticated;" "GRANT EXECUTE ON FUNCTION private.radar_vinculos_base(text[], boolean, boolean) TO authenticated;" ;;
  deriva)               ;;  # outra sessão mudou o núcleo vivo depois do pré-voo: a PRE tem de abortar o apply
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
-- Default privileges do Supabase: função nova em public NASCE aberta (é o REVOKE da migration que fecha).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE SCHEMA private;
GRANT USAGE ON SCHEMA private TO authenticated;   -- como em prod: o que fecha a base é o REVOKE da função
-- 'aaaa…' = gestor (staff, prospecta, lê a carteira) · 'bbbb…' = vendedor (staff, só prospecta) · 'cccc…' = sem papel
-- 'ffff…' = customer.
CREATE FUNCTION private.cap_radar_prospectar(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT p IN ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid) $$;
CREATE FUNCTION private.cap_carteira_ler(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT p = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid $$;
CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
INSERT INTO public.user_roles VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'master'), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'employee'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'customer');
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  razao_social text, ja_cliente boolean NOT NULL DEFAULT false,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  telefone1 text, telefone2 text, email text,
  logradouro text, numero text, complemento text, cep text, municipio_codigo text,
  socios_nomes text, rfb_situacao text);
CREATE TABLE public.profiles (user_id uuid, document text, razao_social text, name text, phone text, email text);
CREATE TABLE public.addresses (user_id uuid, street text, number text, complement text, zip_code text);
CREATE TABLE public.radar_situacao_cadastral (cnpj text, lote text, situacao text, PRIMARY KEY (cnpj, lote));
CREATE TABLE public.fin_contas_receber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text, omie_codigo_cliente bigint,
  status_titulo text, saldo numeric, valor_documento numeric, data_emissao date, data_vencimento date);
CREATE TABLE public.fin_sync_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text, companies text[],
  status text, completed_at timestamptz);
CREATE TABLE public.omie_customer_account_map (user_id uuid, account text, omie_codigo_cliente bigint,
  source text NOT NULL DEFAULT 'document', evidence_document_normalized text, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (omie_codigo_cliente, account));   -- a constraint real: um código por conta tem UM titular
CREATE TABLE public.analytics_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  evento text NOT NULL, distinct_id text, user_id uuid, props jsonb NOT NULL DEFAULT '{}',
  chave_dedup text UNIQUE, ocorrido_em timestamptz NOT NULL DEFAULT now());
SQL

extrair() { # $1 = arquivo, $2 = início literal, $3 = fim literal
  python3 -I - "$1" "$2" "$3" <<'PY'
import sys
p, ini, fim = sys.argv[1:]
s = open(p, encoding="utf-8").read()
a = s.index(ini); b = s.index(fim, a) + len(fim)
print(s[a:b])
PY
}
# O estado de PROD antes desta migration: cadeia do vínculo + os corpos vivos que ela lê/recria.
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
eq_pre() { [ "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('$1')")" = "$2" ] || { echo "FAIL X0 harness: $1 não é o corpo de prod"; exit 1; }; }
eq_pre 'public.venda_prazo_aviso(text,bigint)' d2dda7d32d8a6acd34e24aa1cc1f4c96
eq_pre 'public.normalizar_documento(text)' b7659502c90df3ff483c576cf56d559d
eq_pre 'private.radar_vinculos_nucleo(text[],boolean)' bc00b310f4347fde61fee3a6c3b28a30

# ── Fixture ──
# Do teste do lote (cenários 1–10) + K (sujeito JÁ CLIENTE) + M (lead com 11 vínculos; o 11º é o devedor).
Pq -c "INSERT INTO public.radar_empresas
  (cnpj, razao_social, ja_cliente, telefone1, email, logradouro, numero, complemento, cep, municipio_codigo, socios_nomes, rfb_situacao) VALUES
  ('11111111000101','L1 NOVA LTDA',false,'(37) 99990001','dono@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('21111111000101','C1 ANTIGA LTDA',true,'(37) 99990001','DONO@gmail.com ',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('12222222000101','L2 LTDA',false,'(37) 99990002',NULL,NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('22222222000101','C2 LTDA',true,'(37) 99990002',NULL,NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('13333333000101','L3 LTDA',false,NULL,NULL,'R. DAS FLORES','0200','Sala 01','35500000','M1',NULL,'02'),
  ('23333333000101','C3 LTDA',true,NULL,NULL,'RUA DAS FLORES','200','SALA 1','35500000','M1',NULL,'02'),
  ('14444444000101','L4 LTDA',false,'(37) 99990004','fiscal@contabilidadeabc.com.br',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('24444444000101','C4 LTDA',true,'(37) 99990004','fiscal@contabilidadeabc.com.br',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('15555555000101','L5 LTDA',false,'(37) 99990005','cinco@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('25555555000101','C5 LTDA',true,'(37) 99990005','cinco@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('35555555000101','X5A LTDA',false,'(37) 99990005',NULL,NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('45555555000101','X5B LTDA',false,'(37) 99990005',NULL,NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('16666666000101','66.666.666 JOAO PEREIRA LIMA',false,NULL,NULL,NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('26666666000101','JOAO PEREIRA LIMA 12345678901',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1',NULL,'04'),
  ('17777777000101','L7 LTDA',false,NULL,NULL,NULL,NULL,NULL,NULL,'M1','MARIA SOUZA COSTA','02'),
  ('27777777000101','C7 LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M2','MARIA SOUZA COSTA; OUTRO NOME AQUI','02'),
  ('18888888000101','L8 LTDA',false,'(37) 99990008',NULL,'AVENIDA BRASIL','50',NULL,'35500111','M1',NULL,'02'),
  ('19999999000101','L9 LTDA',false,'(37) 99990009','nove@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('19999999000202','C9 FILIAL',true,'(37) 99990009','nove@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('10101010000101','L10 LTDA',false,NULL,NULL,'RUA DO PORTO','10',NULL,'35500222','M1','ANA LUIZA ROCHA','02'),
  ('20101010000101','C10A LTDA',true,NULL,NULL,'RUA DO PORTO','10',NULL,'35500222','M1',NULL,'08'),
  ('30101010000101','C10B LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1','ANA LUIZA ROCHA','02'),
  -- K: o SUJEITO já é cliente (o núcleo da prospecção o exclui) e tem telefone + e-mail exclusivos com D, devedor.
  ('41000000000101','K CLIENTE LTDA',true,'(31) 98880041','k@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('42000000000101','D DEVEDOR LTDA',true,'(31) 98880041','k@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'08'),
  -- M: lead com 11 sócios, cada um sócio de UM cliente no mesmo município → 11 vínculos fortes; o 11º (maior CNPJ)
  -- é o único devedor. A ficha corta em 10; o crédito não pode.
  ('51000000000101','M MUITOS LTDA',false,NULL,NULL,NULL,NULL,NULL,NULL,'M1',
   'ANA ALFA SOUZA; ANA BETA SOUZA; ANA GAMA SOUZA; ANA DELTA SOUZA; ANA ZETA SOUZA; ANA ETA SOUZA; ANA TETA SOUZA; ANA IOTA SOUZA; ANA CAPA SOUZA; ANA LAMBDA SOUZA; ANA OMEGA SOUZA','02'),
  ('52000001000101','P01 LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1','ANA ALFA SOUZA','02'),
  ('52000002000101','P02 LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1','ANA BETA SOUZA','02'),
  ('52000003000101','P03 LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1','ANA GAMA SOUZA','02'),
  ('52000004000101','P04 LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1','ANA DELTA SOUZA','02'),
  ('52000005000101','P05 LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1','ANA ZETA SOUZA','02'),
  ('52000006000101','P06 LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1','ANA ETA SOUZA','02'),
  ('52000007000101','P07 LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1','ANA TETA SOUZA','02'),
  ('52000008000101','P08 LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1','ANA IOTA SOUZA','02'),
  ('52000009000101','P09 LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1','ANA CAPA SOUZA','02'),
  ('52000010000101','P10 LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1','ANA LAMBDA SOUZA','02'),
  ('52000011000101','P11 LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1','ANA OMEGA SOUZA','02'),
  -- Q: lead com telefone + e-mail exclusivos de um cliente EM DIA, com código provado → avaliação completa, sem aviso.
  ('61000000000101','Q1 LTDA',false,'(31) 98880061','q@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('62000000000101','Q2 LTDA',true,'(31) 98880061','q@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  -- N: Oben PROVADA e em dia + Colacor com evidência NULA → indeterminado (nunca silêncio) — achado Codex P1.
  ('63000000000101','N1 LTDA',false,'(31) 98880063','n@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('64000000000101','N2 LTDA',true,'(31) 98880063','n@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02');
INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao) VALUES
  ('21111111000101','2026-09','02'), ('21111111000101','2026-10','08');
-- Titulares: u1=C1 · u3=C3 · u6=C6 (o mapa aponta OUTRO documento) · d…=C8 só-profiles · u42=D · u511=P11 ·
-- u10b/u10c = DOIS titulares com o documento de C10B · u62=Q2
INSERT INTO public.profiles (user_id, document, razao_social, name, phone, email) VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','28.888.888/0001-01','C8 PERFIL ME',NULL,'(37) 9 9999-0008','oito@gmail.com'),
  ('10000000-0000-0000-0000-000000000001','21.111.111/0001-01','C1 ANTIGA LTDA',NULL,NULL,NULL),
  ('10000000-0000-0000-0000-000000000003','23333333000101','C3 LTDA',NULL,NULL,NULL),
  ('10000000-0000-0000-0000-000000000006','26666666000101','JOAO',NULL,NULL,NULL),
  ('10000000-0000-0000-0000-000000000042','42000000000101','D DEVEDOR LTDA',NULL,NULL,NULL),
  ('10000000-0000-0000-0000-000000000511','52000011000101','P11 LTDA',NULL,NULL,NULL),
  ('10000000-0000-0000-0000-00000000010b','30101010000101','C10B LTDA',NULL,NULL,NULL),
  ('10000000-0000-0000-0000-00000000010c','30.101.010/0001-01','C10B DUPLICADO',NULL,NULL,NULL),
  ('10000000-0000-0000-0000-000000000062','62000000000101','Q2 LTDA',NULL,NULL,NULL),
  ('10000000-0000-0000-0000-000000000064','64000000000101','N2 LTDA',NULL,NULL,NULL);
INSERT INTO public.addresses (user_id, street, number, complement, zip_code) VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','Av. Brasil','50','','35500-111');
INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, evidence_document_normalized) VALUES
  ('10000000-0000-0000-0000-000000000001','oben',101,'21111111000101'), ('10000000-0000-0000-0000-000000000001','colacor',201,'21111111000101'),
  ('10000000-0000-0000-0000-000000000003','oben',103,'23333333000101'),
  ('10000000-0000-0000-0000-000000000006','oben',106,'99999999000191'),   -- mapa único, documento DIVERGENTE
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','colacor_sc',801,'28888888000101'),
  ('10000000-0000-0000-0000-000000000042','oben',142,'42000000000101'),
  ('10000000-0000-0000-0000-000000000511','colacor',511,'52000011000101'),
  ('10000000-0000-0000-0000-00000000010b','oben',110,'30101010000101'),
  ('10000000-0000-0000-0000-00000000010c','colacor',110,'30101010000101'),
  ('10000000-0000-0000-0000-000000000062','oben',162,'62000000000101'),
  ('10000000-0000-0000-0000-000000000064','oben',164,'64000000000101'),
  ('10000000-0000-0000-0000-000000000064','colacor',964,NULL);   -- evidência NULA
-- C1/Colacor: mapa de 8 dias (fora da janela de 7) → sem prova → o aviso de C1 vale, mas é PARCIAL.
UPDATE public.omie_customer_account_map SET updated_at = now() - interval '8 days' WHERE account = 'colacor' AND omie_codigo_cliente = 201;
-- Títulos. 'passado' = 30 dias atrás, 'futuro' = +30.
INSERT INTO public.fin_contas_receber (company, omie_codigo_cliente, status_titulo, saldo, valor_documento, data_emissao, data_vencimento) VALUES
  ('oben',101,'ATRASADO',500,500,current_date - 60,current_date - 30),     -- C1: vencido na Oben
  ('colacor',201,'A VENCER',300,300,current_date - 10,current_date + 30),  -- C1: Colacor em dia → não é credora
  ('oben',103,'A VENCER',90,90,current_date - 10,current_date + 30),       -- C3: em dia, MAS…
  ('oben',103,'ABERTO',50,50,current_date - 60,current_date - 30),         -- …um título de status incerto → indeterminado
  ('oben',106,'ATRASADO',700,700,current_date - 60,current_date - 30),     -- C6: sem prova → nunca avaliado
  ('colacor_sc',801,'A VENCER',80,80,current_date - 60,current_date - 30), -- C8: A VENCER já passado (lag) = vencido
  ('oben',142,'ATRASADO',1000,1000,current_date - 90,current_date - 45),   -- D: devedor do sujeito já-cliente K
  ('colacor',511,'ATRASADO',77,77,current_date - 60,current_date - 20),    -- P11: o 11º vínculo de M
  ('oben',110,'ATRASADO',400,400,current_date - 60,current_date - 30),     -- C10B: documento de 2 titulares → nunca
  ('colacor',110,'ATRASADO',400,400,current_date - 60,current_date - 30),
  ('oben',162,'A VENCER',60,60,current_date - 10,current_date + 30),       -- Q2: em dia, avaliação completa
  ('oben',164,'A VENCER',60,60,current_date - 10,current_date + 30);       -- N2: Oben em dia (a Colacor não tem prova)
INSERT INTO public.fin_sync_log (action, companies, status, completed_at) VALUES
  ('sync_all', ARRAY['oben','colacor'], 'complete', now() - interval '1 hour');   -- colacor_sc sem sync → 'sem_sync'
" >/dev/null

# Foto do núcleo ANTES (superusuário chama o private): todo lead, com e sem carteira.
foto_nucleo() {
  Pq -c "SELECT coalesce(string_agg(x, E'\n' ORDER BY x), '-') FROM (
    SELECT c::text || '|' || n.lead_cnpj || '|' || n.ordem || '|' || n.cliente_cnpj || '|' || coalesce(n.cliente_nome,'-') || '|'
           || coalesce(n.cliente_situacao,'-') || '|' || n.forca || '|' || array_to_string(n.sinais, '+') AS x
      FROM (VALUES (true), (false)) v(c),
           private.radar_vinculos_nucleo((SELECT array_agg(cnpj) FROM public.radar_empresas), v.c) n) t;"
}
foto_nucleo > "$(dirname "$DATA")/nucleo-antes.txt"

if [ "${SABOTAGEM:-}" = "deriva" ]; then
  # Outra sessão recriou o núcleo com outro corpo depois do pré-voo desta.
  P -q -c "CREATE OR REPLACE FUNCTION private.radar_vinculos_nucleo(p_cnpjs text[], p_carteira boolean)
 RETURNS TABLE(lead_cnpj text, ordem integer, cliente_cnpj text, cliente_nome text, cliente_situacao text, forca text, sinais text[])
 LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS \$f\$ SELECT NULL::text, 1, NULL::text, NULL::text, NULL::text, 'forte', ARRAY['email'] WHERE false \$f\$;"
fi
P -q --single-transaction -f "$MIG_USADA" >/dev/null   # o db:aplicar fornece a transação
P -q --single-transaction -f "$MIG_USADA" >/dev/null   # idempotente (a PRE aceita os corpos que este arquivo já deixou)

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
GESTOR='{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}'
VENDEDOR='{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}'
SEM='{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}'
CLIENTE='{"sub":"ffffffff-ffff-ffff-ffff-ffffffffffff","role":"authenticated"}'
sql_como() { # $1 = claims, $2 = SQL → a saída (ou a mensagem de erro: quem julga é o assert)
  P -qAt <<SQL 2>&1 || true
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '$1', false) IS NULL;
$2
SQL
}
# Resumo ASCII do aviso: "estado|n_vinculos|n_indet|cliente/forca/sinais/company:vencido:n:qualidade+…;…"
aviso() {
  sql_como "$1" "WITH a AS (SELECT public.credito_vinculo_aviso('$2') AS j)
SELECT (j->>'estado') || '|' || coalesce(j->>'n_vinculos','-') || '|' || coalesce(j->>'n_indeterminados','-') || '|' ||
       coalesce((SELECT string_agg(coalesce(v->>'cliente_cnpj', 'oculto') || '/' || (v->>'forca') || '/' ||
                   (SELECT string_agg(s, '+' ORDER BY s) FROM jsonb_array_elements_text(v->'sinais') s) || '/' ||
                   CASE WHEN (v->>'parcial')::boolean THEN 'parcial' ELSE 'completo' END || '/' ||
                   (SELECT string_agg((c->>'company') || ':' || (c->>'vencido') || ':' || (c->>'n_titulos') || ':' || (c->>'qualidade'), '+')
                      FROM jsonb_array_elements(v->'credoras') c), ';')
                   FROM jsonb_array_elements(j->'vinculos') v), '-')
  FROM a;" | tail -1
}
aviso_cru() { sql_como "$1" "SELECT public.credito_vinculo_aviso('$2') IS NOT NULL;"; }

# ── E: o núcleo da ficha/lista não mudou ──
foto_nucleo > "$(dirname "$DATA")/nucleo-depois.txt"
if diff -q "$(dirname "$DATA")/nucleo-antes.txt" "$(dirname "$DATA")/nucleo-depois.txt" >/dev/null; then r="igual"; else r="MUDOU"; diff "$(dirname "$DATA")/nucleo-antes.txt" "$(dirname "$DATA")/nucleo-depois.txt" | head -10 || true; fi
eq "E1 núcleo (todos os leads, com e sem carteira) idêntico antes e depois da migration" "$r" "igual"
eq "E2 a foto tem conteúdo (não é igualdade de vazios): linhas com vínculo" \
   "$(grep -c . "$(dirname "$DATA")/nucleo-antes.txt")" "35"
eq "E3 a ficha do lead M segue cortada em 10 e sem o já-cliente K" \
   "$(sql_como "$GESTOR" "SELECT (SELECT count(*) FROM public.radar_possiveis_vinculos('51000000000101'))::text || '/' || (SELECT count(*) FROM public.radar_possiveis_vinculos('41000000000101'))::text;" | tail -1)" "10/0"

# ── C: o aviso ──
eq "C1 lead → cliente com vencido na Oben; a Colacor (mapa de 8 dias, sem prova) não é credora e torna o aviso PARCIAL" \
   "$(aviso "$VENDEDOR" 11111111000101)" "avaliado|1|0|21111111000101/forte/email+telefone/parcial/oben:500:1:ok"
eq "C2 sujeito JÁ CLIENTE (fora da prospecção) com vínculo a devedor → avisa" \
   "$(aviso "$VENDEDOR" 41000000000101)" "avaliado|1|0|42000000000101/forte/email+telefone/completo/oben:1000:1:ok"
eq "C3 o 11º vínculo (além do corte de 10 da ficha) é o devedor → avisa; os 10 sem cadastro ficam indeterminados" \
   "$(aviso "$VENDEDOR" 51000000000101)" "avaliado|11|10|52000011000101/forte/pessoa/completo/colacor:77:1:ok"
eq "C4 mapa com documento DIVERGENTE do vinculado não prova a dívida → indeterminado, sem aviso" \
   "$(aviso "$VENDEDOR" 16666666000101)" "avaliado|1|1|-"
eq "C5 cliente só-profiles AVALIADO para o vendedor (sem nome/CNPJ); A VENCER já passado conta; colacor_sc sem sync" \
   "$(aviso "$VENDEDOR" 18888888000101)" "avaliado|1|0|oculto/forte/endereco+telefone/parcial/colacor_sc:80:1:sem_sync"
eq "C6 vínculo em dia MAS com título de status incerto → indeterminado (nunca 'sem pendência')" \
   "$(aviso "$VENDEDOR" 13333333000101)" "avaliado|1|1|-"
eq "C7 sem cadastro (C10A) e documento de 2 titulares (C10B) → os 2 indeterminados, sem aviso" \
   "$(aviso "$VENDEDOR" 10101010000101)" "avaliado|2|2|-"
eq "C8 CNPJ fora da base RFB do Radar → 'fora_da_base' (nunca 'sem vínculo')" \
   "$(aviso "$VENDEDOR" 99999999000199)" "fora_da_base|-|-|-"
eq "C9 lead sem vínculo nenhum → avaliado, 0" "$(aviso "$VENDEDOR" 12222222000101)" "avaliado|0|0|-"
eq "C10 o gestor (lê a carteira) vê o CNPJ do cliente só-cadastro; o vendedor não (projeção da ficha)" \
   "$(aviso "$GESTOR" 18888888000101) $(aviso "$VENDEDOR" 18888888000101 | cut -d'|' -f4 | cut -d/ -f1)" \
   "avaliado|1|0|28888888000101/forte/endereco+telefone/parcial/colacor_sc:80:1:sem_sync oculto"
eq "C11 vínculo em dia com avaliação completa → avaliado, sem aviso e sem indeterminado" \
   "$(aviso "$VENDEDOR" 61000000000101)" "avaliado|1|0|-"
eq "C13 Oben provada e em dia + Colacor com evidência NULA → indeterminado, nunca silêncio" \
   "$(aviso "$VENDEDOR" 63000000000101)" "avaliado|1|1|-"
eq "C14 o CNPJ real do par nunca sai pela API (_cliente_cnpj_real)" \
   "$(sql_como "$GESTOR" "SELECT count(*) FROM jsonb_array_elements(public.credito_vinculo_aviso('18888888000101')->'vinculos') v WHERE v ? '_cliente_cnpj_real';" | tail -1)" "0"
eq "C12 o vencido do aviso = venda_prazo_aviso do par (a mesma regra)" \
   "$(sql_como "$VENDEDOR" "SELECT (public.venda_prazo_aviso('colacor_sc', 801)->>'vencido');" | tail -1)" "80"

# ── G: gate e ACL ──
case "$(aviso_cru "$CLIENTE" 11111111000101)" in *"exige staff"*) r="negado";; *) r="LIBEROU";; esac
eq "G1 customer não lê o aviso com devedor → 42501" "$r" "negado"
case "$(aviso_cru "$CLIENTE" 99999999000199)$(aviso_cru "$CLIENTE" 12222222000101)" in *"exige staff"*"exige staff"*) r="negado";; *) r="LIBEROU";; esac
eq "G1b customer não lê nem o 'fora_da_base' nem o 'sem vínculo' (o gate vem antes de qualquer retorno)" "$r" "negado"
case "$(aviso_cru "$SEM" 11111111000101)" in *"exige staff"*) r="negado";; *) r="LIBEROU";; esac
eq "G2 sem papel não lê o aviso → 42501" "$r" "negado"
case "$(aviso_cru "$VENDEDOR" "abc")" in *"cnpj inválido"*) r="recusou";; *) r="ACEITOU";; esac
eq "G3 CNPJ fora do formato → 22023" "$r" "recusou"
case "$(sql_como "$GESTOR" "SELECT count(*) FROM private.radar_vinculos_base(ARRAY['11111111000101'], true, true);")" in
  *"permission denied for function radar_vinculos_base"*) r="negado";; *) r="EXECUTOU";; esac
eq "G4 a base das regras (sem gate) não é chamável pelo JWT" "$r" "negado"
eq "G5 anon NÃO executa aviso nem sensor; authenticated executa os 2" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.credito_vinculo_aviso(text)','EXECUTE')::text||' '||has_function_privilege('anon','public.credito_vinculo_aviso_registrar(text,text,text,text,text)','EXECUTE')::text||' '||has_function_privilege('authenticated','public.credito_vinculo_aviso(text)','EXECUTE')::text||' '||has_function_privilege('authenticated','public.credito_vinculo_aviso_registrar(text,text,text,text,text)','EXECUTE')::text||' '||has_function_privilege('authenticated','private.credito_vinculo_avaliar(text,boolean)','EXECUTE')::text;")" \
   "false false true true false"

# ── S: o sensor ──
reg() { sql_como "$1" "SELECT public.credito_vinculo_aviso_registrar($2)->>'registrado';" | tail -1; }
REF8="$(sql_como "$VENDEDOR" "SELECT public.credito_vinculo_aviso('18888888000101')->'vinculos'->0->>'ref';" | tail -1)"
eq "S1 'servido' grava para staff com aviso vigente" "$(reg "$VENDEDOR" "'servido', 'pedido', '18888888000101'")" "true"
eq "S2 'servido' repetido no mesmo dia é deduplicado" "$(reg "$VENDEDOR" "'servido', 'pedido', '18888888000101'")" "false"
reg "$VENDEDOR" "'conferido', 'pedido', '18888888000101', '$REF8', 'mesmo_grupo'" >/dev/null
reg "$VENDEDOR" "'conferido', 'pedido', '18888888000101', '$REF8', 'sem_relacao'" >/dev/null
reg "$VENDEDOR" "'conferido', 'pedido', '18888888000101', '$REF8', 'mesmo_grupo'" >/dev/null
eq "S3 todo voto de 'conferido' grava (o último por ocorrido_em é a resposta vigente)" \
   "$(Pq -c "SELECT string_agg(props->>'veredito', ',' ORDER BY id) FROM public.analytics_outbox WHERE evento = 'credito.vinculo_aviso_conferido';")" \
   "mesmo_grupo,sem_relacao,mesmo_grupo"
case "$(sql_como "$VENDEDOR" "SELECT public.credito_vinculo_aviso_registrar('conferido', 'pedido', '18888888000101', 'ffffffffffffffff', 'mesmo_grupo');")" in
  *"não é um vínculo vigente"*) r="recusou";; *) r="ACEITOU";; esac
eq "S4 'conferido' com ref que não é vínculo vigente → 22023" "$r" "recusou"
case "$(sql_como "$CLIENTE" "SELECT public.credito_vinculo_aviso_registrar('servido', 'pedido', '18888888000101');")" in
  *"credito_vinculo_aviso_registrar: exige staff"*) r="negado";; *) r="LIBEROU";; esac
eq "S5 customer não emite o sensor → 42501 (do próprio escritor)" "$r" "negado"
case "$(sql_como "$VENDEDOR" "SELECT public.credito_vinculo_aviso_registrar('servido', 'ficha_radar', '13333333000101');")" in
  *"não há aviso vigente"*) r="recusou";; *) r="ACEITOU";; esac
eq "S6 'servido' para CNPJ sem aviso vigente → 22023 (não se registra o que a tela não podia mostrar)" "$r" "recusou"
eq "S7 as props levam o CNPJ REAL do vinculado (oculto na tela do vendedor), a força e a versão da regra" \
   "$(Pq -c "SELECT (props->>'cliente_cnpj')||'/'||(props->>'forca')||'/'||(props->>'regra_versao')||'/'||(props->>'superficie')||'/'||(props->>'ref') FROM public.analytics_outbox WHERE evento = 'credito.vinculo_aviso_conferido' ORDER BY id LIMIT 1;")" \
   "28888888000101/forte/1/pedido/$REF8"
eq "S8 'servido' guarda os pares exibidos (ref e credoras)" \
   "$(Pq -c "SELECT (props->'pares'->0->>'ref')||'/'||(props->'pares'->0->>'cliente_cnpj')||'/'||(props->'pares'->0->'credoras'->>0) FROM public.analytics_outbox WHERE evento = 'credito.vinculo_aviso_servido';")" \
   "$REF8/28888888000101/colacor_sc"
case "$(sql_como "$VENDEDOR" "SELECT public.credito_vinculo_aviso_registrar('conferido', 'pedido', '18888888000101', '$REF8', 'talvez');")" in
  *"veredito válido"*) r="recusou";; *) r="ACEITOU";; esac
eq "S9 veredito fora do vocabulário → 22023" "$r" "recusou"

# S10: um vínculo NOVO e mais forte (B) entra na FRENTE de C8 depois de a tela mostrar o aviso. O voto com o ref
# de C8 continua sendo de C8 — por posição, iria para B (achado Codex P1 do código).
Pq -c "UPDATE public.radar_empresas SET email = 'bb@gmail.com', socios_nomes = 'BRUNO TESTE SILVA' WHERE cnpj = '18888888000101';
INSERT INTO public.radar_empresas (cnpj, razao_social, ja_cliente, email, municipio_codigo, socios_nomes, rfb_situacao)
  VALUES ('10000000000191','B NOVO LTDA',true,'bb@gmail.com','M1','BRUNO TESTE SILVA','02');
INSERT INTO public.profiles (user_id, document, razao_social) VALUES ('10000000-0000-0000-0000-0000000000b1','10000000000191','B NOVO LTDA');
INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, evidence_document_normalized)
  VALUES ('10000000-0000-0000-0000-0000000000b1','oben',191,'10000000000191');
INSERT INTO public.fin_contas_receber (company, omie_codigo_cliente, status_titulo, saldo, valor_documento, data_emissao, data_vencimento)
  VALUES ('oben',191,'ATRASADO',33,33,current_date - 60,current_date - 30);" >/dev/null
eq "S10a B entrou na frente de C8 (pré-condição do cenário)" \
   "$(sql_como "$GESTOR" "SELECT (public.credito_vinculo_aviso('18888888000101')->'vinculos'->0->>'cliente_cnpj');" | tail -1)" "10000000000191"
reg "$VENDEDOR" "'conferido', 'pedido', '18888888000101', '$REF8', 'sem_relacao'" >/dev/null
eq "S10 o voto com o ref de C8 segue gravando C8, mesmo com B na frente" \
   "$(Pq -c "SELECT props->>'cliente_cnpj' FROM public.analytics_outbox WHERE evento = 'credito.vinculo_aviso_conferido' ORDER BY id DESC LIMIT 1;")" \
   "28888888000101"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "CREDITO_VINCULO_AVISO_PROVA_OK"
[ "$FAIL" -eq 0 ]
