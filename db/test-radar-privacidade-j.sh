#!/usr/bin/env bash
# Prova PG17 do pacote J do Radar (privacidade/LGPD), migration 20261111130000:
#   E*  o vínculo e o aviso de crédito decidem EXATAMENTE o mesmo com a razão crua (antes), com a migration sobre a
#       razão crua (durante) e depois do backfill da máscara — o CPF completo nunca foi insumo, só a máscara.
#   M*  a razão de MEI é GRAVADA mascarada por qualquer escritor (INSERT, upsert da publicação com EXCLUDED, UPDATE),
#       a contagem da publicação não muda, nenhuma linha de radar_empresas fica com o CPF, o cru só existe no
#       private e só o cadastro Omie o lê; buscar pelos 11 dígitos não acha mais o MEI.
#   X*  exclusão de titular: registro (gate, escopo que só amplia), efeito imediato, resiste à recarga (upsert cru de
#       novo, lote novo de sócios com a raiz) e o vínculo ignora a raiz antes mesmo do expurgo.
#   R*  retenção: nota livre de lead descartado há > 12 meses sai; a nota automática da RFB e a recente ficam.
#   G*  ACL: nada novo aberto ao JWT além do previsto.
# Aplica as migrations REAIS da cadeia do vínculo (20261104201756 → 20261106083754 → 20261106205557 → 20261107040000)
# e depois esta.
#
#   bash db/test-radar-privacidade-j.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-privacidade-j.sh   # tem de ficar VERMELHA
#   bash db/test-radar-privacidade-j.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGS="$REPO_ROOT/supabase/migrations"
MIG_V1="$MIGS/20261104201756_radar_possiveis_vinculos.sql"
MIG_V2="$MIGS/20261106083754_radar_vinculos_em_lote.sql"
MIG_P2="$MIGS/20261106205557_credito_aviso_vinculo_vencido.sql"
MIG_PRAZO="$MIGS/20261031200000_venda_prazo_decisao.sql"
MIG_DOC="$MIGS/20261019140000_omie_identidade_cnpj_alfanumerico.sql"
MIG_SOC="$MIGS/20261107040000_radar_socios_cpf_mascarado.sql"
MIG="$MIGS/20261111130000_radar_privacidade_titular_mei.sql"
PROVA_P2="$REPO_ROOT/db/test-credito-vinculo-aviso.sh"

if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_trigger:M1 mascara_errada:E2 regra_so_crua:E2 sem_filtro_exclusao:X3 exclusao_sem_ingestao:X4 reter_tudo:R1 apaga_rfb:R2 cadastro_aberto:G3 escopo_regride:X6 deriva:pre"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-privacidade.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  if ! grep -q "RADAR_PRIVACIDADE_J_PROVA_OK" "$LOGDIR/controle.log"; then
    echo "❌ controle sem marcador de fim — falsificação abortada"; exit 1
  fi
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; alvo="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: ficou VERDE (o assert $alvo não morde)"; falhas=$((falhas+1)); continue
    fi
    if [ "$alvo" = "pre" ]; then
      if grep -q "PRE FALHOU" "$LOGDIR/$s.log"; then echo "✅ $s: vermelha na PRE"; else echo "❌ $s: vermelha, mas não na PRE"; falhas=$((falhas+1)); fi
    elif grep -q "^FAIL $alvo\b" "$LOGDIR/$s.log"; then
      echo "✅ $s: vermelha em $alvo"
    else
      echo "❌ $s: vermelha, mas não em $alvo (log: $LOGDIR/$s.log)"; grep -E "^FAIL|ERRO|ERROR" "$LOGDIR/$s.log" | head -3; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5497}"
DATA="$(mktemp -d "/tmp/pgtest-radar-privacidade.XXXXXX")/data"
DIR="$(dirname "$DATA")"
MIG_USADA="$DIR/mig.sql"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$DIR"; }
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
# Sabotagem que muda o corpo das regras: cega o md5 da PÓS (a PRE do 2º apply aceita o corpo novo pelo md5 dele).
cegar_md5() {
  sabotar "  IF v_bs IS DISTINCT FROM" "  IF false AND v_bs IS DISTINCT FROM"
  sabotar "  IF v_bs IS NULL OR v_bs NOT IN" "  IF false AND v_bs NOT IN"
  sabotar "  IF v_mc IS NULL OR v_mc NOT IN" "  IF false AND v_mc NOT IN"
}
case "${SABOTAGEM:-}" in
  "") ;;
  sem_trigger)          sabotar "  FOR EACH ROW EXECUTE FUNCTION private.radar_empresas_privacidade();" "  FOR EACH ROW WHEN (false) EXECUTE FUNCTION private.radar_empresas_privacidade();" ;;
  mascara_errada)       sabotar "SELECT regexp_replace(p, ' [0-9]{3}([0-9]{6})[0-9]{2}\$', ' ***\\1**')" "SELECT regexp_replace(p, ' [0-9]{2}([0-9]{6})[0-9]{3}\$', ' ***\\1**')"
                        sabotar "  IF private.radar_razao_mascarada('FULANO DE TAL 12345678901') IS DISTINCT FROM 'FULANO DE TAL ***456789**'
     OR" "  IF" ;;
  # As regras voltam a só reconhecer o CPF cru no ramo do titular de MEI (o ramo socio_cpf do sujeito).
  regra_so_crua)        cegar_md5; sabotar "    SELECT l.cnpj, private.radar_nome_norm(regexp_replace(l.razao_social, ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)\$', '')),
           private.radar_titular_mascara(substring(l.razao_social FROM ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)\$'))
      FROM lead l
     WHERE l.razao_social ~ ' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)\$'" "    SELECT l.cnpj, private.radar_nome_norm(regexp_replace(l.razao_social, ' [0-9]{11}\$', '')),
           private.radar_mascara_cpf(substring(l.razao_social FROM ' ([0-9]{11})\$'))
      FROM lead l
     WHERE l.razao_social ~ ' [0-9]{11}\$'" ;;
  sem_filtro_exclusao)  cegar_md5; sabotar "
       AND NOT EXISTS (SELECT 1 FROM public.radar_exclusoes_titular xt WHERE xt.raiz = s.raiz)" "" ;;
  exclusao_sem_ingestao) sabotar "  SELECT x.escopo INTO v_escopo FROM public.radar_exclusoes_titular x WHERE x.raiz = left(NEW.cnpj, 8);" "  v_escopo := NULL;" ;;
  reter_tudo)           sabotar "     AND e.prospeccao_atualizado_em < now() - make_interval(months => p_meses)" "     AND false" ;;
  apaga_rfb)            sabotar "     AND c.nota !~ '^RFB: [A-Z]+ em [0-9]{2}/[0-9]{2}/[0-9]{4}';" "     ;" ;;
  cadastro_aberto)      sabotar "  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT COALESCE(r.razao_social" "  RETURN (SELECT COALESCE(r.razao_social" ;;
  escopo_regride)       sabotar "SET escopo = CASE WHEN x.escopo = 'contato' THEN 'contato' ELSE EXCLUDED.escopo END," "SET escopo = EXCLUDED.escopo," ;;
  deriva)               ;;  # outra sessão mudou a base viva depois do pré-voo: a PRE tem de abortar o apply
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DIR/pg.log" -w start >/dev/null
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
# Schema mínimo: o MESMO da prova do passo 2 (papéis, auth.uid, caps, tabelas) + o que esta migration toca.
extrair "$PROVA_P2" "CREATE ROLE anon NOLOGIN;" "chave_dedup text UNIQUE, ocorrido_em timestamptz NOT NULL DEFAULT now());" > "$DIR/setup.sql"
P -q -f "$DIR/setup.sql" >/dev/null
P -q -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;" >/dev/null
P -q -f "$MIG_V1" >/dev/null
P -q -f "$MIG_V2" >/dev/null
{
  extrair "$MIG_PRAZO" "CREATE OR REPLACE FUNCTION public.venda_prazo_aviso(" "\$fn\$;"
  echo "REVOKE ALL ON FUNCTION public.venda_prazo_aviso(text, bigint) FROM PUBLIC, anon;"
  echo "GRANT EXECUTE ON FUNCTION public.venda_prazo_aviso(text, bigint) TO authenticated, service_role;"
  extrair "$MIG_DOC" "CREATE OR REPLACE FUNCTION public.cnpj_alfanumerico_valido(" "\$\$;"
  extrair "$MIG_DOC" "CREATE OR REPLACE FUNCTION public.normalizar_documento(" "\$\$;"
} > "$DIR/vivos.sql"
P -q -f "$DIR/vivos.sql" >/dev/null
P -q -f "$MIG_P2" >/dev/null
P -q -c "GRANT USAGE ON SCHEMA public TO service_role;" >/dev/null
P -q -f "$MIG_SOC" >/dev/null
eq_pre() { [ "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('$1')")" = "$2" ] || { echo "FAIL X0 harness: $1 não é o corpo de prod"; exit 1; }; }
eq_pre 'private.radar_vinculos_base(text[],boolean,boolean)' 568af84dec25450e8970bd3d6918e4bb
eq_pre 'private.radar_mascaras_conflitam(text,text,text)' b2c9922a1d5d0fb767e9050c872822cf
# O que a migration toca e a prova do passo 2 não tinha (colunas reais de prod; cron e ledger como em prod).
P -q <<'SQL' >/dev/null
ALTER TABLE public.radar_empresas ADD COLUMN nome_fantasia text, ADD COLUMN prospeccao_atualizado_em timestamptz,
  ADD COLUMN descarte_motivo text, ADD COLUMN ultimo_lote text;
CREATE TABLE public.radar_contatos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj text NOT NULL REFERENCES public.radar_empresas (cnpj) ON DELETE CASCADE, acao text NOT NULL, nota text,
  criado_por uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.acoes_execucoes (id bigserial PRIMARY KEY, acao text NOT NULL,
  origem text NOT NULL CHECK (origem IN ('manual', 'automatica')), iniciado_em timestamptz, finalizado_em timestamptz,
  status text NOT NULL CHECK (status IN ('executando', 'sucesso', 'erro')), detalhes jsonb);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS
  $$ INSERT INTO cron.job VALUES ((SELECT COALESCE(max(jobid), 0) + 1 FROM cron.job), p_jobname, p_schedule, p_command, true) RETURNING jobid $$;
CREATE FUNCTION cron.unschedule(p_jobname text) RETURNS boolean LANGUAGE sql AS
  $$ DELETE FROM cron.job WHERE jobname = p_jobname RETURNING true $$;
SQL
# master do registro: o gestor 'aaaa…' (caps do setup); o vendedor 'bbbb…' não é master.
P -q -c "INSERT INTO public.user_roles (user_id, role) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'master');" >/dev/null

# ── Fixture ── (a MESMA da prova do passo 3: 3xxxxxxx = leads, 4xxxxxxx = clientes no Radar, 5xxxxxxx = só cadastro)
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
  ('39000011000101','JOÃO DA SILVA 99945678901',false,NULL,'M2',NULL,'02'),
  ('41000021000101','TITULAR CLIENTE MEI 55566677788',true,NULL,'M1','OUTRO SOCIO NOME','02');
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

# Lote vigente de sócios pelas RPCs da carga (as 23 linhas da prova do passo 3).
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
SR "SELECT public.radar_socios_iniciar('2026-10', '$DIG1', 'v1', 23, 22, 40);
    SELECT public.radar_socios_receber('2026-10-11111111', '$LINHAS'::jsonb);
    SELECT public.radar_socios_publicar('2026-10-11111111');" >/dev/null
[ "$(Pq -c "SELECT status FROM public.radar_socios_lote WHERE lote = '2026-10-11111111'")" = "vigente" ] || { echo "FAIL X0 harness: lote de sócios não ficou vigente"; exit 1; }

GESTOR='{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}'
VENDEDOR='{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}'
CUSTOMER='{"sub":"ffffffff-ffff-ffff-ffff-ffffffffffff","role":"authenticated"}'
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
foto_aviso() { # o aviso de crédito de todo sujeito, como gestor
  for c in $(Pq -c "SELECT cnpj FROM public.radar_empresas ORDER BY cnpj"); do
    echo "$c $(sql_como "$GESTOR" "SELECT public.credito_vinculo_aviso('$c')::text;" | tail -1)"
  done
}
foto_conflito() { # a guarda da regra por nome, para todo par de raízes × nome de titular/sócio
  Pq -c "SELECT string_agg(a || '|' || b || '|' || n || '|' || private.radar_mascaras_conflitam(a, b, n)::text, E'\n' ORDER BY a, b, n)
           FROM (SELECT DISTINCT left(cnpj, 8) a FROM public.radar_empresas) x, (SELECT DISTINCT left(cnpj, 8) b FROM public.radar_empresas) y,
                (VALUES ('PEDRO ALVES COSTA'), ('LUIZ GOMES PRADO'), ('ANA PAULA REIS'), ('JOAO DA SILVA'), ('RITA MELO DIAS')) z(n);"
}
foto_base > "$DIR/base-antes.txt"; foto_aviso > "$DIR/aviso-antes.txt"; foto_conflito > "$DIR/conf-antes.txt"
[ "$(grep -c socio_cpf "$DIR/base-antes.txt")" -gt 0 ] || { echo "FAIL X0 harness: a foto de antes não tem socio_cpf (fixture morta)"; exit 1; }

if [ "${SABOTAGEM:-}" = "deriva" ]; then
  P -q -c "CREATE OR REPLACE FUNCTION private.radar_mascaras_conflitam(p_raiz_a text, p_raiz_b text, p_nome text)
           RETURNS boolean LANGUAGE sql STABLE AS \$f\$ SELECT false \$f\$;" >/dev/null
fi

# ── Apply ── (a PÓS roda dentro; o 2º apply prova idempotência). O executor dá a transação: aqui, -1.
P -q -1 -f "$MIG_USADA" > "$DIR/apply.log" 2>&1 || { cat "$DIR/apply.log"; exit 1; }
P -q -1 -f "$MIG_USADA" > "$DIR/apply2.log" 2>&1 || { echo "FAIL X1 re-apply"; cat "$DIR/apply2.log"; exit 1; }

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
tem() { if printf '%s' "$2" | grep -qF -- "$3"; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — [$3] ausente em [$2]"; FAIL=$((FAIL+1)); fi; }
igual() { diff "$1" "$2" > /dev/null && echo igual || { diff "$1" "$2" | head -6 >&2; echo diferente; }; }

# E1: migration aplicada, razão ainda CRUA (o backfill não correu): vínculo, aviso e guarda idênticos.
foto_base > "$DIR/base-durante.txt"; foto_aviso > "$DIR/aviso-durante.txt"; foto_conflito > "$DIR/conf-durante.txt"
eq E1 "$(igual "$DIR/base-antes.txt" "$DIR/base-durante.txt")|$(igual "$DIR/aviso-antes.txt" "$DIR/aviso-durante.txt")|$(igual "$DIR/conf-antes.txt" "$DIR/conf-durante.txt")" "igual|igual|igual"

# Backfill pelo job (como o cron: sem JWT), em fatias de 3 para exercitar a retomada.
for _ in 1 2 3 4 5; do Pq -c "SELECT public.radar_privacidade_expurgo(3, 12);" >/dev/null; done
# M1: nenhuma razão com o CPF em radar_empresas; o titular ficou com a máscara da RFB.
eq M1 "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE razao_social ~ '[0-9]{11}'")|$(Pq -c "SELECT razao_social FROM public.radar_empresas WHERE cnpj = '31000006000101'")" "0|PEDRO ALVES COSTA ***456789**"
# E2: depois do backfill, a MESMA foto (vínculo de todo sujeito, aviso de crédito, guarda de homônimo).
foto_base > "$DIR/base-depois.txt"; foto_aviso > "$DIR/aviso-depois.txt"; foto_conflito > "$DIR/conf-depois.txt"
eq E2 "$(igual "$DIR/base-antes.txt" "$DIR/base-depois.txt")|$(igual "$DIR/aviso-antes.txt" "$DIR/aviso-depois.txt")|$(igual "$DIR/conf-antes.txt" "$DIR/conf-depois.txt")" "igual|igual|igual"
# E3: o titular de MEI (S6 da prova do passo 3) segue casando o QSA do cliente pelo CPF parcial.
eq E3 "$(Pq -c "SELECT string_agg(cliente_cnpj || ':' || array_to_string(sinais, '+'), ',') FROM private.radar_vinculos_base(ARRAY['31000006000101'], true, false)")" "41000006000101:socio_cpf"
# M2: o cru está no private (só ele) e o job registrou no ledger.
eq M2 "$(Pq -c "SELECT razao_social FROM private.radar_razao_receita WHERE cnpj = '31000006000101'")|$(Pq -c "SELECT count(*) FROM public.acoes_execucoes WHERE acao = 'radar.privacidade_expurgo' AND status = 'sucesso'")" "PEDRO ALVES COSTA 12345678901|5"
# M3: o upsert da PUBLICAÇÃO (EXCLUDED do ON CONFLICT, conta exata) grava mascarado — linha nova e linha existente.
M3=$(Pq <<'SQL'
WITH c(cnpj, razao_social) AS (VALUES ('31000006000101', 'PEDRO ALVES COSTA 12345678901'), ('32000001000101', 'NOVA MEI SILVA 98765432100'))
, ins AS (
  INSERT INTO public.radar_empresas AS e (cnpj, razao_social) SELECT cnpj, razao_social FROM c
  ON CONFLICT (cnpj) DO UPDATE SET razao_social = EXCLUDED.razao_social RETURNING 1)
SELECT count(*) FROM ins;
SQL
)
eq M3 "$M3|$(Pq -c "SELECT string_agg(razao_social, ',' ORDER BY cnpj) FROM public.radar_empresas WHERE cnpj IN ('31000006000101', '32000001000101')")|$(Pq -c "SELECT razao_social FROM private.radar_razao_receita WHERE cnpj = '32000001000101'")" \
  "2|PEDRO ALVES COSTA ***456789**,NOVA MEI SILVA ***654321**|NOVA MEI SILVA 98765432100"
# M4: buscar pelos 11 dígitos não acha mais o MEI; pelo nome acha (a busca da lista é ILIKE na razão).
eq M4 "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE razao_social ILIKE '%12345678901%'")|$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE razao_social ILIKE '%PEDRO ALVES%'")" "0|1"
# M5: a razão FISCAL para o cadastro no Omie: o vendedor do Radar recebe o cru (só por aqui); não-MEI vem como está.
eq M5 "$(sql_como "$VENDEDOR" "SELECT public.radar_razao_social_para_cadastro('31000006000101');" | tail -1)|$(sql_como "$VENDEDOR" "SELECT public.radar_razao_social_para_cadastro('31000001000101');" | tail -1)" \
  "PEDRO ALVES COSTA 12345678901|A1 NOVA LTDA"
# M6: nenhuma função que o JWT executa lê o cru, salvo a do cadastro (varredura de catálogo).
eq M6 "$(Pq -c "SELECT coalesce(string_agg(p.oid::regprocedure::text, ','), '-') FROM pg_proc p
                 WHERE p.prosrc LIKE '%radar_razao_receita%' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')")" \
  "radar_razao_social_para_cadastro(text)"

# ── Exclusão de titular ──
# X1: só o master registra; escopo e finalidade validados.
tem X1 "$(sql_como "$VENDEDOR" "SELECT public.radar_exclusao_registrar('31000001', 'qsa', 'pedido de oposição do titular');")|$(sql_como "$GESTOR" "SELECT public.radar_exclusao_registrar('31000001', 'tudo', 'pedido de oposição do titular');")" "42501"
tem X1b "$(sql_como "$GESTOR" "SELECT public.radar_exclusao_registrar('31000001', 'tudo', 'pedido de oposição do titular');")" "22023"
# X2: sócio de A1 (S1: mesmo sócio por CPF parcial) pede oposição → o vínculo some, o QSA e os nomes da raiz saem.
eq X2pre "$(Pq -c "SELECT string_agg(cliente_cnpj, ',') FROM private.radar_vinculos_base(ARRAY['31000001000101'], false, false) WHERE 'socio_cpf' = ANY (sinais)")" "41000001000101"
sql_como "$GESTOR" "SELECT public.radar_exclusao_registrar('31000001', 'qsa', 'oposição art. 18 §2º — protocolo de teste', 'T-1');" >/dev/null
eq X2 "$(Pq -c "SELECT count(*) FROM private.radar_vinculos_base(ARRAY['31000001000101'], true, true) WHERE 'socio_cpf' = ANY (sinais)")|$(Pq -c "SELECT count(*) FROM public.radar_socios WHERE raiz = '31000001'")|$(Pq -c "SELECT coalesce(socios_nomes, 'NULL') FROM public.radar_empresas WHERE cnpj = '31000001000101'")" "0|0|NULL"
# X3: um lote NOVO de sócios traz a raiz de volta (a carga não sabe da exclusão): o vínculo ignora antes do expurgo.
DIG2=$(printf '2%.0s' $(seq 64))
SR "SELECT public.radar_socios_iniciar('2026-11', '$DIG2', 'v1', 23, 22, 40);
    SELECT public.radar_socios_receber('2026-11-22222222', '$LINHAS'::jsonb);
    SELECT public.radar_socios_publicar('2026-11-22222222');" >/dev/null
eq X3 "$(Pq -c "SELECT count(*) FROM public.radar_socios s JOIN public.radar_socios_lote l USING (lote) WHERE l.status = 'vigente' AND s.raiz = '31000001'")|$(Pq -c "SELECT count(*) FROM private.radar_vinculos_base(ARRAY['31000001000101','41000001000101'], true, true) WHERE 'socio_cpf' = ANY (sinais)")" "1|0"
# X4: a recarga de radar_empresas (upsert cru, como a publicação) não devolve os nomes dos sócios da raiz.
Pq -c "INSERT INTO public.radar_empresas AS e (cnpj, razao_social, socios_nomes) VALUES ('31000001000101', 'A1 NOVA LTDA', 'MARIA SOUZA LIMA')
       ON CONFLICT (cnpj) DO UPDATE SET razao_social = EXCLUDED.razao_social, socios_nomes = EXCLUDED.socios_nomes;" >/dev/null
eq X4 "$(Pq -c "SELECT coalesce(socios_nomes, 'NULL') FROM public.radar_empresas WHERE cnpj = '31000001000101'")" "NULL"
# X5: o expurgo apaga o que o lote novo trouxe; os outros seguem.
Pq -c "SELECT public.radar_privacidade_expurgo();" >/dev/null
eq X5 "$(Pq -c "SELECT count(*) FROM public.radar_socios WHERE raiz = '31000001'")|$(Pq -c "SELECT count(*) > 0 FROM public.radar_socios WHERE raiz = '41000001'")" "0|t"
# X6: titular de MEI (PEDRO) se opõe ao CONTATO: some do vínculo, a razão perde até a máscara, o cru sai, o contato
#     zera, o lead é descartado com o motivo LGPD e a nota livre sai já. Um 2º pedido 'qsa' não regride o escopo.
Pq -c "INSERT INTO public.radar_contatos (cnpj, acao, nota) VALUES ('31000006000101', 'em_conversa', 'falei com o Pedro, filha estuda fora');
       UPDATE public.radar_empresas SET telefone1 = '(37) 91234567', email = 'pedro@gmail.com' WHERE cnpj = '31000006000101';" >/dev/null
sql_como "$GESTOR" "SELECT public.radar_exclusao_registrar('31000006', 'contato', 'oposição à prospecção — protocolo de teste');" >/dev/null
sql_como "$GESTOR" "SELECT public.radar_exclusao_registrar('31000006', 'qsa', 'segundo pedido, só do QSA');" >/dev/null
eq X6 "$(Pq -c "SELECT razao_social || '|' || coalesce(email, 'NULL') || '|' || coalesce(telefone1, 'NULL') || '|' || prospeccao_status || '|' || descarte_motivo FROM public.radar_empresas WHERE cnpj = '31000006000101'")|$(Pq -c "SELECT count(*) FROM private.radar_razao_receita WHERE cnpj = '31000006000101'")|$(Pq -c "SELECT count(*) FROM private.radar_vinculos_base(ARRAY['31000006000101'], true, true)")|$(Pq -c "SELECT count(nota) FROM public.radar_contatos WHERE cnpj = '31000006000101'")|$(Pq -c "SELECT escopo FROM public.radar_exclusoes_titular WHERE raiz = '31000006'")" \
  "PEDRO ALVES COSTA|NULL|NULL|descartado|lgpd_oposicao|0|0|0|contato"
# X7: e a recarga crua do mês seguinte não traz o CPF, o contato nem o cru de volta.
Pq -c "INSERT INTO public.radar_empresas AS e (cnpj, razao_social, email, telefone1) VALUES ('31000006000101', 'PEDRO ALVES COSTA 12345678901', 'pedro@gmail.com', '(37) 91234567')
       ON CONFLICT (cnpj) DO UPDATE SET razao_social = EXCLUDED.razao_social, email = EXCLUDED.email, telefone1 = EXCLUDED.telefone1;" >/dev/null
eq X7 "$(Pq -c "SELECT razao_social || '|' || coalesce(email, 'NULL') || '|' || coalesce(telefone1, 'NULL') FROM public.radar_empresas WHERE cnpj = '31000006000101'")|$(Pq -c "SELECT count(*) FROM private.radar_razao_receita WHERE cnpj = '31000006000101'")" \
  "PEDRO ALVES COSTA|NULL|NULL|0"

# ── Retenção das notas ──
Pq <<'SQL' >/dev/null
UPDATE public.radar_empresas SET prospeccao_status = 'descartado', prospeccao_atualizado_em = now() - interval '13 months' WHERE cnpj = '31000003000101';
UPDATE public.radar_empresas SET prospeccao_status = 'descartado', prospeccao_atualizado_em = now() - interval '2 months' WHERE cnpj = '31000004000101';
UPDATE public.radar_empresas SET prospeccao_atualizado_em = now() - interval '13 months' WHERE cnpj = '31000005000101';
INSERT INTO public.radar_contatos (cnpj, acao, nota, created_at) VALUES
  ('31000003000101', 'em_conversa', 'dono separado, ligar depois das 18h', now() - interval '14 months'),
  ('31000003000101', 'descartado', 'RFB: INAPTA em 15/05/2025 (63 — OMISSAO DE DECLARACOES)', now() - interval '13 months'),
  ('31000004000101', 'descartado', 'não quis, disse que compra do concorrente', now() - interval '2 months'),
  ('31000005000101', 'em_conversa', 'ativo, conversa boa', now() - interval '13 months');
SQL
Pq -c "SELECT public.radar_privacidade_expurgo();" >/dev/null
# R1: a nota livre do lead descartado há 13 meses sai (o evento fica).
eq R1 "$(Pq -c "SELECT count(*) || '/' || count(nota) FILTER (WHERE nota NOT LIKE 'RFB:%') FROM public.radar_contatos WHERE cnpj = '31000003000101'")" "2/0"
# R2: a nota automática da RFB fica; o descartado recente e o lead ativo antigo ficam intactos.
eq R2 "$(Pq -c "SELECT count(*) FROM public.radar_contatos WHERE nota LIKE 'RFB: INAPTA%'")|$(Pq -c "SELECT count(nota) FROM public.radar_contatos WHERE cnpj IN ('31000004000101', '31000005000101')")" "1|2"

# ── ACL ──
tem G1 "$(sql_como "$GESTOR" "SELECT count(*) FROM public.radar_exclusoes_titular;")|$(sql_como "$GESTOR" "SELECT count(*) FROM private.radar_razao_receita;")" "42501"
tem G2 "$(sql_como "$GESTOR" "SELECT public.radar_privacidade_expurgo();")" "42501"
tem G3 "$(sql_como "$CUSTOMER" "SELECT public.radar_razao_social_para_cadastro('32000001000101');")" "42501"
eq G4 "$(Pq -c "SELECT has_function_privilege('anon', 'public.radar_razao_social_para_cadastro(text)', 'EXECUTE')::text || has_function_privilege('anon', 'public.radar_exclusao_registrar(text,text,text,text)', 'EXECUTE')::text")" "falsefalse"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_PRIVACIDADE_J_PROVA_OK"
[ "$FAIL" -eq 0 ]
