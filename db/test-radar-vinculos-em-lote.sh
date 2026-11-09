#!/usr/bin/env bash
# Prova PG17 do selo de vínculo em LOTE (migration 20261106083754): as regras do "possível vínculo / sucessor de
# cliente" passam a viver SÓ em `private.radar_vinculos_nucleo`; a ficha (`radar_possiveis_vinculos`) e a lista
# (`radar_vinculos_por_cnpjs`) são invólucros dele.
#   F*  a ficha continua com o mesmo comportamento da 20261104201756 (os cenários dela, agora sobre o núcleo).
#   L*  a lista devolve, por lead, EXATAMENTE o resumo do que a ficha mostra (mesma força do 1º, mesma contagem,
#       mesmos nomes e situações na mesma ordem), para o gestor E para o vendedor; gate, teto de 200, núcleo fechado.
# Aplica as migrations REAIS (a predecessora e esta) sobre um esquema mínimo, sob SET ROLE authenticated + GUC de JWT.
#
#   bash db/test-radar-vinculos-em-lote.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-vinculos-em-lote.sh   # tem de ficar VERMELHA
#   bash db/test-radar-vinculos-em-lote.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_ANTES="$REPO_ROOT/supabase/migrations/20261104201756_radar_possiveis_vinculos.sql"
MIG="$REPO_ROOT/supabase/migrations/20261106083754_radar_vinculos_em_lote.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la> — `post:A3` = a POSTCONDIÇÃO da migration aborta; `pre` = a PRE aborta.
  SABOTAGENS="tel_nao_exclusivo:F5 sem_contador:F6 sozinho_aparece:F4 pessoa_outro_mun:F8 perfil_sem_carteira:F10 mesma_raiz:F11 lote_sem_gate:L1 lote_sem_teto:L2 lote_forca_ultima:L4 lote_carteira_sempre:L5 nucleo_aberto:post:A3 lote_anon:post:A2 corpo_divergente:post:A1 deriva:pre"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-vinculos-lote.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  if ! grep -q "RADAR_VINCULOS_LOTE_PROVA_OK" "$LOGDIR/controle.log"; then
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
DATA="$(mktemp -d "/tmp/pgtest-radar-vinculos-lote.XXXXXX")/data"
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
# Sabotagem de COMPORTAMENTO muda o corpo; sem cegar a postcondição de md5, ela abortaria antes do assert.
cegar_md5() { sabotar "    IF r.vivo IS DISTINCT FROM r.esperado THEN" "    IF false AND r.vivo IS DISTINCT FROM r.esperado THEN"; }
case "${SABOTAGEM:-}" in
  "") ;;
  tel_nao_exclusivo)    cegar_md5; sabotar "GROUP BY lead, k HAVING count(DISTINCT left(doc, 8)) <= 2)" "GROUP BY lead, k HAVING count(DISTINCT left(doc, 8)) <= 9)" ;;
  sem_contador)         cegar_md5; sabotar "SELECT '@[^@]*(cont|assessor|escritorio|fiscal|mei|partner)'::text AS cont" "SELECT 'NUNCA_CASA'::text AS cont" ;;
  sozinho_aparece)      cegar_md5; sabotar "     WHERE 'pessoa' = ANY (v.s) OR cardinality(v.s) >= 2 OR v.s = ARRAY['endereco']" "     WHERE cardinality(v.s) >= 1" ;;
  pessoa_outro_mun)     cegar_md5; sabotar "     WHERE h.cliente AND h.mun = l.municipio_codigo" "     WHERE h.cliente" ;;
  perfil_sem_carteira)  cegar_md5; sabotar "     WHERE c.nome_radar IS NOT NULL OR p_carteira" "     WHERE true" ;;
  mesma_raiz)           cegar_md5; sabotar "     WHERE left(s.doc, 8) <> left(s.lead, 8)" "     WHERE true" ;;
  lote_sem_gate)        cegar_md5; python3 -I - "$MIG_USADA" <<'PY'
import sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
i = s.index("CREATE OR REPLACE FUNCTION public.radar_vinculos_por_cnpjs")
g = "  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN"
j = s.index(g, i)
open(p, "w", encoding="utf-8").write(s[:j] + "  IF false THEN" + s[j + len(g):])
PY
    ;;
  lote_sem_teto)        cegar_md5; sabotar "  IF COALESCE(cardinality(p_cnpjs), 0) > 200 THEN" "  IF COALESCE(cardinality(p_cnpjs), 0) > 9999 THEN" ;;
  lote_forca_ultima)    cegar_md5; sabotar "         (array_agg(n.forca ORDER BY n.ordem))[1]," "         (array_agg(n.forca ORDER BY n.ordem DESC))[1]," ;;
  lote_carteira_sempre) cegar_md5; sabotar "    FROM private.radar_vinculos_nucleo(p_cnpjs, COALESCE(private.cap_carteira_ler((SELECT auth.uid())), false)) n" "    FROM private.radar_vinculos_nucleo(p_cnpjs, true) n" ;;
  nucleo_aberto)        sabotar "REVOKE ALL ON FUNCTION private.radar_vinculos_nucleo(text[], boolean) FROM PUBLIC, anon, authenticated;" "GRANT EXECUTE ON FUNCTION private.radar_vinculos_nucleo(text[], boolean) TO authenticated;" ;;
  lote_anon)            sabotar "REVOKE ALL ON FUNCTION public.radar_vinculos_por_cnpjs(text[]) FROM PUBLIC, anon;" "REVOKE ALL ON FUNCTION public.radar_vinculos_por_cnpjs(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.radar_vinculos_por_cnpjs(text[]) TO anon;" ;;
  corpo_divergente)     sabotar "   WHERE o.ordem <= 10" "   WHERE o.ordem <=  10" ;;
  deriva)               ;;  # outra sessão mudou a ficha viva depois do pré-voo: a PRE tem de abortar o apply
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
GRANT USAGE ON SCHEMA private TO authenticated;   -- como em prod: o que fecha o núcleo é o REVOKE da função
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

P -q -f "$MIG_ANTES" >/dev/null   # o estado de prod antes desta migration (md5 797fdff… da ficha)
if [ "${SABOTAGEM:-}" = "deriva" ]; then
  # Outra sessão recriou a ficha com outro corpo depois do pré-voo desta.
  P -q -c "CREATE OR REPLACE FUNCTION public.radar_possiveis_vinculos(p_cnpj text)
 RETURNS TABLE(cliente_cnpj text, cliente_nome text, cliente_situacao text, forca text, sinais text[])
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS \$f\$ BEGIN RETURN; END; \$f\$;"
fi
P -q -f "$MIG_USADA" >/dev/null
P -q -f "$MIG_USADA" >/dev/null   # idempotente (a PRE aceita o corpo que este arquivo já deixou)

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
  ('19999999000202','C9 FILIAL',true,'(37) 99990009','nove@gmail.com',NULL,NULL,NULL,NULL,'M1',NULL,'02'),
  -- 10: DOIS clientes — um pela pessoa (FORTE, ativo) e outro pelo endereço (MÉDIA, baixado): a ordem da ficha põe
  --     o forte primeiro; a lista tem de dizer 'forte', 2 clientes e as situações nessa ordem (o 08 dá o 'sucessor')
  ('10101010000101','L10 LTDA',false,NULL,NULL,'RUA DO PORTO','10',NULL,'35500222','M1','ANA LUIZA ROCHA','02'),
  ('20101010000101','C10A LTDA',true,NULL,NULL,'RUA DO PORTO','10',NULL,'35500222','M1',NULL,'08'),
  ('30101010000101','C10B LTDA',true,NULL,NULL,NULL,NULL,NULL,NULL,'M1','ANA LUIZA ROCHA','02');
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
sql_como() { # $1 = claims, $2 = SQL → a última linha (ou a mensagem de erro: quem julga é o assert)
  P -qAt <<SQL 2>&1 || true
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '$1', false) IS NULL;
$2
SQL
}
ficha_crua() { # a saída inteira (a recusa vem com CONTEXT depois do ERROR) — para os asserts de gate
  sql_como "$1" "SELECT count(*) FROM public.radar_possiveis_vinculos('$2');"
}
ficha() { # "cnpj/forca/sinais/situacao/nome" por cliente, ou "-"
  sql_como "$1" "SELECT coalesce(string_agg(cliente_cnpj||'/'||forca||'/'||array_to_string(sinais,'+')||'/'||coalesce(cliente_situacao,'-')||'/'||coalesce(cliente_nome,'-'), ' '), '-')
  FROM public.radar_possiveis_vinculos('$2');" | tail -1
}
lote_crua() { sql_como "$1" "SELECT count(*) FROM public.radar_vinculos_por_cnpjs($2);"; }
lote() { # $2 = literal de array → "cnpj/forca/n/nomes/situacoes" por lead, ou "-"
  sql_como "$1" "SELECT coalesce(string_agg(cnpj||'/'||forca||'/'||clientes||'/'||array_to_string(clientes_nomes,'+','-')||'/'||array_to_string(clientes_situacoes,'+','-'), ' ' ORDER BY cnpj), '-')
  FROM public.radar_vinculos_por_cnpjs($2);" | tail -1
}
# O lote comparado com a ficha, lead a lead, em TODOS os leads da base: "<leads com vínculo>|<divergentes>".
equivalencia() {
  local todos; todos="$(Pq -c "SELECT array_agg(cnpj ORDER BY cnpj)::text FROM public.radar_empresas;")"   # o JWT não lê a tabela
  sql_como "$1" "WITH leads AS (SELECT '$todos'::text[] AS a),
f AS (SELECT c AS cnpj, (array_agg(v.forca ORDER BY v.o))[1] AS forca, count(*)::int AS n,
             array_agg(v.cliente_nome ORDER BY v.o) AS nomes, array_agg(v.cliente_situacao ORDER BY v.o) AS sits
        FROM leads, unnest(leads.a) AS c
       CROSS JOIN LATERAL public.radar_possiveis_vinculos(c) WITH ORDINALITY AS v(cc, cliente_nome, cliente_situacao, forca, sinais, o)
       GROUP BY c),
b AS (SELECT * FROM public.radar_vinculos_por_cnpjs((SELECT a FROM leads)))
SELECT (SELECT count(*) FROM f)::text || '|' || count(*)::text
  FROM f FULL JOIN b USING (cnpj)
 WHERE ROW(f.forca, f.n, f.nomes, f.sits) IS DISTINCT FROM ROW(b.forca, b.clientes, b.clientes_nomes, b.clientes_situacoes);" | tail -1
}

# ── F: a ficha, agora sobre o núcleo, com o comportamento da 20261104201756 ──
case "$(ficha_crua "$SEM" 11111111000101)" in *"forbidden: radar_prospectar"*) r="negado";; *) r="LIBEROU";; esac
eq "F1 ficha sem cap_radar_prospectar → 42501" "$r" "negado"
case "$(ficha_crua "$GESTOR" "abc")" in *"cnpj inválido"*) r="recusou";; *) r="ACEITOU";; esac
eq "F2 ficha com CNPJ fora do formato → 22023" "$r" "recusou"
eq "F3 endereço completo sozinho, grafia diferente → MÉDIA" \
   "$(ficha "$GESTOR" 13333333000101)" "23333333000101/media/endereco/02/C3 LTDA"
eq "F4 telefone sozinho não aparece" "$(ficha "$GESTOR" 12222222000101)" "-"
eq "F5 telefone em 4 raízes não é exclusivo → só sobra o e-mail → nada" "$(ficha "$GESTOR" 15555555000101)" "-"
eq "F6 e-mail de contabilidade derruba telefone e e-mail" "$(ficha "$GESTOR" 14444444000101)" "-"
eq "F7 telefone + e-mail exclusivos → FORTE, situação da foto mais nova (08)" \
   "$(ficha "$VENDEDOR" 11111111000101)" "21111111000101/forte/email+telefone/08/C1 ANTIGA LTDA"
eq "F8 mesmo sócio em OUTRO município não conta" "$(ficha "$GESTOR" 17777777000101)" "-"
eq "F9 MEI novo da mesma pessoa de um MEI inapto → FORTE por pessoa, nome SEM o CPF" \
   "$(ficha "$VENDEDOR" 16666666000101)" "26666666000101/forte/pessoa/04/JOAO PEREIRA LIMA"
eq "F10 cliente só-profiles: o vendedor (sem carteira) não o vê" "$(ficha "$VENDEDOR" 18888888000101)" "-"
eq "F11 cliente da MESMA raiz (filial) fica de fora" "$(ficha "$GESTOR" 19999999000101)" "-"
eq "F12 cliente só-profiles: o gestor vê, por telefone (9º dígito cortado) + endereço do cadastro" \
   "$(ficha "$GESTOR" 18888888000101)" "28888888000101/forte/endereco+telefone/-/C8 PERFIL ME"
eq "F13 dois clientes: o forte (pessoa) antes do médio (endereço)" \
   "$(ficha "$GESTOR" 10101010000101)" "30101010000101/forte/pessoa/02/C10B LTDA 20101010000101/media/endereco/08/C10A LTDA"

# ── L: a lista ──
case "$(lote_crua "$SEM" "ARRAY['11111111000101']")" in *"forbidden: radar_prospectar"*) r="negado";; *) r="LIBEROU";; esac
eq "L1 lista sem cap_radar_prospectar → 42501" "$r" "negado"
case "$(lote_crua "$GESTOR" "(SELECT array_agg(lpad(g::text, 14, '0')) FROM generate_series(1, 201) g)")" in
  *"no máximo 200"*) r="recusou";; *) r="ACEITOU";; esac
eq "L2 lista com 201 CNPJs → 22023 (teto de 200, como radar_irmaos_por_raiz)" "$r" "recusou"
eq "L3 lista com exatamente 200 CNPJs passa" \
   "$(lote "$GESTOR" "(SELECT array_agg(lpad(g::text, 14, '0')) || ARRAY['11111111000101'] FROM generate_series(1, 199) g)")" \
   "11111111000101/forte/1/C1 ANTIGA LTDA/08"
eq "L4 gestor: lista = resumo da ficha em todos os leads (5 com vínculo: L1 L3 L6 L8 L10; 0 divergentes)" "$(equivalencia "$GESTOR")" "5|0"
eq "L5 vendedor: lista = resumo da ficha (4 com vínculo — sem o só-profiles L8 —, 0 divergentes)" "$(equivalencia "$VENDEDOR")" "4|0"
eq "L6 dois clientes: força do mais forte, 2 clientes, nomes e situações na ordem da ficha" \
   "$(lote "$GESTOR" "ARRAY['10101010000101']")" "10101010000101/forte/2/C10B LTDA+C10A LTDA/02+08"
eq "L7 CNPJ repetido, fora do formato, sem vínculo ou já cliente: uma linha só para quem tem vínculo" \
   "$(lote "$GESTOR" "ARRAY['13333333000101','13333333000101','abc',NULL,'12222222000101','21111111000101']")" \
   "13333333000101/media/1/C3 LTDA/02"
eq "L8 lista vazia ou nula → nenhuma linha, sem erro" \
   "$(lote "$GESTOR" "ARRAY[]::text[]")$(lote "$GESTOR" "NULL")" "--"
case "$(sql_como "$GESTOR" "SELECT count(*) FROM private.radar_vinculos_nucleo(ARRAY['11111111000101'], true);")" in
  *"permission denied for function radar_vinculos_nucleo"*) r="negado";; *) r="EXECUTOU";; esac
eq "L9 o núcleo (sem gate) não é chamável pelo JWT, nem pelo gestor" "$r" "negado"
eq "L10 anon NÃO executa a lista; authenticated e service_role executam" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.radar_vinculos_por_cnpjs(text[])','EXECUTE')::text||' '||has_function_privilege('authenticated','public.radar_vinculos_por_cnpjs(text[])','EXECUTE')::text||' '||has_function_privilege('service_role','public.radar_vinculos_por_cnpjs(text[])','EXECUTE')::text;")" \
   "false true true"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_VINCULOS_LOTE_PROVA_OK"
[ "$FAIL" -eq 0 ]
