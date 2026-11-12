#!/usr/bin/env bash
# Prova PG17 do "possível vínculo / sucessor de cliente" na ficha do Radar (migration 20261104201756):
# `radar_possiveis_vinculos(p_cnpj)` devolve os clientes com vínculo EXCLUSIVO (≤ 2 raízes) ao lead, com força e
# sinais — telefone/e-mail sozinhos não aparecem, contador derruba telefone/e-mail, pessoa só no mesmo município,
# cliente só-profiles só para quem lê a carteira, mesma raiz fica de fora (é filial). Gate 42501/22023, ACL sem
# anon, helpers fechados, e os 4 índices casam com as expressões que a RPC usa (o planner os escolhe).
# Aplica a migration REAL sobre um esquema mínimo, sob SET ROLE authenticated + GUC de JWT, como o PostgREST.
#
#   bash db/test-radar-possiveis-vinculos.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-possiveis-vinculos.sh   # tem de ficar VERMELHA
#   bash db/test-radar-possiveis-vinculos.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261104201756_radar_possiveis_vinculos.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la> — `post:A3` = a POSTCONDIÇÃO da migration aborta o apply.
  SABOTAGENS="sem_gate:A1 tel_nao_exclusivo:A5 sem_contador:A6 sozinho_aparece:A4 pessoa_outro_mun:A8 perfil_sem_carteira:A10 mesma_raiz:A11 endereco_cru:A3 indice_email_errado:A14 anon_executa:post:A3 helper_aberto:post:A4 corpo_divergente:post:A2"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-vinculos.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  if ! grep -q "RADAR_VINCULOS_PROVA_OK" "$LOGDIR/controle.log"; then
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
DATA="$(mktemp -d "/tmp/pgtest-radar-vinculos.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
cegar_md5() { sabotar "  IF v_md5 IS DISTINCT FROM '" "  IF false AND v_md5 IS DISTINCT FROM '"; }
case "${SABOTAGEM:-}" in
  "") ;;
  sem_gate)            cegar_md5; sabotar "  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN" "  IF false THEN" ;;
  tel_nao_exclusivo)   cegar_md5; sabotar "GROUP BY k HAVING count(DISTINCT left(doc, 8)) <= 2)" "GROUP BY k HAVING count(DISTINCT left(doc, 8)) <= 9)" ;;
  sem_contador)        cegar_md5; sabotar "v_cont     constant text := '@[^@]*(cont|assessor|escritorio|fiscal|mei|partner)';" "v_cont     constant text := 'NUNCA_CASA';" ;;
  sozinho_aparece)     cegar_md5; sabotar "   WHERE 'pessoa' = ANY (v.s) OR cardinality(v.s) >= 2 OR v.s = ARRAY['endereco']" "   WHERE cardinality(v.s) >= 1" ;;
  pessoa_outro_mun)    cegar_md5; sabotar "     WHERE h.cliente AND h.mun = v_lead.municipio_codigo" "     WHERE h.cliente" ;;
  perfil_sem_carteira) cegar_md5; sabotar "     WHERE c.nome_radar IS NOT NULL OR v_carteira" "     WHERE true" ;;
  mesma_raiz)          cegar_md5; sabotar "     WHERE left(s.doc, 8) <> left(p_cnpj, 8)" "     WHERE true" ;;
  endereco_cru)        sabotar "'^ (RUA|R|AVENIDA|AV|RODOVIA|ROD|TRAVESSA|TV|PRACA|PC|ALAMEDA|AL|ESTRADA|EST|LARGO|VIA|BECO) '" "'^ (NUNCA_CASA) '" ;;
  indice_email_errado) sabotar "ON public.radar_empresas (lower(btrim(email))) WHERE email IS NOT NULL;" "ON public.radar_empresas (lower(email)) WHERE email IS NOT NULL;" ;;
  anon_executa)        sabotar "REVOKE ALL ON FUNCTION public.radar_possiveis_vinculos(text) FROM PUBLIC, anon;" "REVOKE ALL ON FUNCTION public.radar_possiveis_vinculos(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.radar_possiveis_vinculos(text) TO anon;" ;;
  helper_aberto)       sabotar "REVOKE ALL ON FUNCTION private.radar_tel_chave(text) FROM PUBLIC, anon, authenticated;" "GRANT EXECUTE ON FUNCTION private.radar_tel_chave(text) TO authenticated;" ;;
  corpo_divergente)    sabotar "   LIMIT 10;" "   LIMIT  10;" ;;
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
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE SCHEMA private;
-- 'aaaa…' = gestor (prospecta e lê a carteira) · 'bbbb…' = vendedor (só prospecta) · 'cccc…' = sem acesso.
CREATE FUNCTION private.cap_radar_prospectar(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT p IN ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid) $$;
CREATE FUNCTION private.cap_carteira_ler(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT p = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid $$;
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
SQL

P -q -f "$MIG_USADA" >/dev/null
P -q -f "$MIG_USADA" >/dev/null   # idempotente

# Cada lead Ln casa (ou não) com o cliente Cn. M1 = município do lead; M2 = outro município.
Pq -c "INSERT INTO public.radar_empresas
  (cnpj, razao_social, ja_cliente, telefone1, email, logradouro, numero, complemento, cep, municipio_codigo, socios_nomes, rfb_situacao) VALUES
  -- 1: telefone + e-mail exclusivos → FORTE; o cliente está baixado na RFB (a foto mais nova é a de situação)
  ('11111111000101','L1 NOVA LTDA',false,'(37) 99990001','dono@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('21111111000101','C1 ANTIGA LTDA',true,'(37) 99990001','DONO@gmail.com ',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  -- 2: só telefone → não aparece
  ('12222222000101','L2 LTDA',false,'(37) 99990002',NULL,NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('22222222000101','C2 LTDA',true,'(37) 99990002',NULL,NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  -- 3: endereço completo sozinho, grafias diferentes → MÉDIA
  ('13333333000101','L3 LTDA',false,NULL,NULL,'R. DAS FLORES','0200','Sala 01','35500000','M1',NULL,'02'),
  ('23333333000101','C3 LTDA',true,NULL,NULL,'RUA DAS FLORES','200','SALA 1','35500000','M1',NULL,'02'),
  -- 4: telefone + e-mail, mas o e-mail é de contabilidade → nada
  ('14444444000101','L4 LTDA',false,'(37) 99990004','fiscal@contabilidadeabc.com.br',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('24444444000101','C4 LTDA',true,'(37) 99990004','fiscal@contabilidadeabc.com.br',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  -- 5: e-mail exclusivo + telefone em 4 raízes (não exclusivo) → só e-mail → nada
  ('15555555000101','L5 LTDA',false,'(37) 99990005','cinco@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('25555555000101','C5 LTDA',true,'(37) 99990005','cinco@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('35555555000101','X5A LTDA',false,'(37) 99990005',NULL,NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('45555555000101','X5B LTDA',false,'(37) 99990005',NULL,NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  -- 6: MEI novo (prefixo da raiz) da MESMA pessoa de um MEI cliente inapto (CPF no fim), mesmo município → FORTE
  ('16666666000101','66.666.666 JOAO PEREIRA LIMA',false,NULL,NULL,NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('26666666000101','JOAO PEREIRA LIMA 12345678901',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1',NULL,'04'),
  -- 7: mesmo sócio, mas em OUTRO município → nada (homônimo)
  ('17777777000101','L7 LTDA',false,NULL,NULL,NULL,NULL,NULL,NULL,'M1','MARIA SOUZA COSTA','02'),
  ('27777777000101','C7 LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M2','MARIA SOUZA COSTA; OUTRO NOME AQUI','02'),
  -- 8: cliente só em profiles (fora do Radar): telefone + endereço → FORTE, só para quem lê a carteira
  ('18888888000101','L8 LTDA',false,'(37) 99990008',NULL,'AVENIDA BRASIL','50',NULL,'35500111','M1',NULL,'02'),
  -- 9: cliente da MESMA raiz do lead (filial) → fora (é o selo de filial)
  ('19999999000101','L9 LTDA',false,'(37) 99990009','nove@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  ('19999999000202','C9 FILIAL',true,'(37) 99990009','nove@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02');
INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao) VALUES
  ('21111111000101','2026-09','02'), ('21111111000101','2026-10','08');
INSERT INTO public.profiles (user_id, document, razao_social, name, phone, email) VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','28.888.888/0001-01','C8 PERFIL ME',NULL,'(37) 9 9999-0008','oito@gmail.com');
INSERT INTO public.addresses (user_id, street, number, complement, zip_code) VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','Av. Brasil','50','','35500-111');" >/dev/null

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
GESTOR='{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}'
VENDEDOR='{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}'
SEM='{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}'
como() { # $1 = claims, $2 = cnpj → "cnpj/forca/sinais/situacao/nome" por cliente, ou "-" se vazio
  P -qAt <<SQL 2>&1 || true   # a recusa (42501/22023) é esperada em A1/A2: quem julga é o assert
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '$1', false) IS NULL;
SELECT coalesce(string_agg(cliente_cnpj||'/'||forca||'/'||array_to_string(sinais,'+')||'/'||coalesce(cliente_situacao,'-')||'/'||coalesce(cliente_nome,'-'), ' '), '-')
  FROM public.radar_possiveis_vinculos('$2');
SQL
}
res() { como "$1" "$2" | tail -1; }

case "$(como "$SEM" 11111111000101)" in *"forbidden: radar_prospectar"*) r="negado";; *) r="LIBEROU";; esac
eq "A1 sem cap_radar_prospectar → 42501" "$r" "negado"
case "$(como "$GESTOR" "abc")" in *"cnpj inválido"*) r="recusou";; *) r="ACEITOU";; esac
eq "A2 CNPJ fora do formato → 22023" "$r" "recusou"

eq "A3 endereço completo sozinho, grafia diferente (R./RUA, 0200/200, Sala 01/SALA 1) → MÉDIA" \
   "$(res "$GESTOR" 13333333000101)" "23333333000101/media/endereco/02/C3 LTDA"
eq "A4 telefone sozinho não aparece" "$(res "$GESTOR" 12222222000101)" "-"
eq "A5 telefone em 4 raízes não é exclusivo → só sobra o e-mail → nada" "$(res "$GESTOR" 15555555000101)" "-"
eq "A6 e-mail de contabilidade derruba telefone e e-mail" "$(res "$GESTOR" 14444444000101)" "-"
eq "A7 telefone + e-mail exclusivos → FORTE, situação da foto mais nova (08), e-mail casa sem caixa/espaço" \
   "$(res "$VENDEDOR" 11111111000101)" "21111111000101/forte/email+telefone/08/C1 ANTIGA LTDA"
eq "A8 mesmo sócio em OUTRO município não conta" "$(res "$GESTOR" 17777777000101)" "-"
eq "A9 MEI novo da mesma pessoa de um MEI inapto, mesmo município → FORTE por pessoa, nome SEM o CPF" \
   "$(res "$VENDEDOR" 16666666000101)" "26666666000101/forte/pessoa/04/JOAO PEREIRA LIMA"
eq "A10 cliente só-profiles: o vendedor (sem carteira) não o vê" "$(res "$VENDEDOR" 18888888000101)" "-"
eq "A11 cliente da MESMA raiz (filial) fica de fora" "$(res "$GESTOR" 19999999000101)" "-"
eq "A12 cliente só-profiles: o gestor vê, por telefone (9º dígito cortado) + endereço do cadastro" \
   "$(res "$GESTOR" 18888888000101)" "28888888000101/forte/endereco+telefone/-/C8 PERFIL ME"
eq "A13 lead que já é cliente não devolve nada" "$(res "$GESTOR" 21111111000101)" "-"

# O índice tem de ser usado pela CONDIÇÃO (Index Cond), não varrido inteiro só porque o seqscan está desligado
# (a sabotagem indice_email_errado mostrou isso: a expressão errada ainda aparecia no plano, com Filter).
expl() {
  local plano; plano="$(Pq -c "SET enable_seqscan = off; EXPLAIN $1")"
  if grep -q "$2" <<<"$plano" && grep -q "Index Cond" <<<"$plano"; then echo 1; else echo 0; fi
}
eq "A14 índice de e-mail casa com a expressão da RPC" \
   "$(expl "SELECT 1 FROM public.radar_empresas e WHERE e.email IS NOT NULL AND lower(btrim(e.email)) = 'x@y.z';" idx_radar_empresas_email_norm)" "1"
eq "A15 índice de CEP casa com o join da RPC" \
   "$(expl "SELECT 1 FROM public.radar_empresas e WHERE e.cep = '35500000';" idx_radar_empresas_cep)" "1"
eq "A16 GIN dos sócios casa com o @> da RPC" \
   "$(expl "SELECT 1 FROM public.radar_empresas e WHERE e.socios_nomes IS NOT NULL AND string_to_array(e.socios_nomes, '; ') @> ARRAY['A B C'];" idx_radar_empresas_socios_arr)" "1"
eq "A17 índice do titular de MEI casa com a expressão da RPC" \
   "$(expl "SELECT 1 FROM public.radar_empresas e WHERE (e.razao_social ~ ' [0-9]{11}\$' OR e.razao_social ~ '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ') AND btrim(regexp_replace(regexp_replace(e.razao_social, '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ', ''), ' [0-9]{11}\$', '')) = 'A B C';" idx_radar_empresas_titular_mei)" "1"

eq "A18 anon NÃO executa a RPC; authenticated e service_role executam" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.radar_possiveis_vinculos(text)','EXECUTE')::text||' '||has_function_privilege('authenticated','public.radar_possiveis_vinculos(text)','EXECUTE')::text||' '||has_function_privilege('service_role','public.radar_possiveis_vinculos(text)','EXECUTE')::text;")" \
   "false true true"
eq "A19 a carga (service_role) continua gravando com os índices novos" \
   "$(Pq -c "GRANT SELECT, INSERT, UPDATE ON public.radar_empresas TO service_role; SET ROLE service_role; INSERT INTO public.radar_empresas (cnpj, razao_social, email, cep, socios_nomes) VALUES ('99999999000199','ZE DA SILVA SANTOS 11122233344','A@B.C','35500000','X Y Z') RETURNING cnpj;")" \
   "99999999000199"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_VINCULOS_PROVA_OK"
[ "$FAIL" -eq 0 ]
