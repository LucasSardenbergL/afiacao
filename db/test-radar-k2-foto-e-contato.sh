#!/usr/bin/env bash
# Prova PG17 da migration 20261111132000_radar_foto_do_card_e_contato_avaliado (pacote K2 do Radar), aplicada sobre
# os corpos de PRODUÇÃO de 2026-11-09 (db/fixtures/radar-k2-predecessora-prod-20261109.sql):
#   F  card/e-mail cruzando a publicação em passos (private.radar_leads_do_vendedor): durante a publicação de um mês
#      novo, a empresa já reetiquetada (ultimo_lote = P, lote_anterior = V) SEGUE no card — nos 3 ramos (território,
#      atribuído pelo gestor, acompanhamento órfão); a empresa nova (só em P) NÃO entra antes da virada; depois da
#      virada a foto é P inteira; sem lote completo a empresa só de P fica de fora. F0 = o predecessor de PROD
#      perdia a reetiquetada (o teste distingue).
#   C  contato contábil (private.radar_contato_contabil_avaliar): contato da linha LIDA pelo cálculo e sem marca →
#      "não é" (false); linha escrita DEPOIS do cálculo (carga trocou o telefone) → "não sei" (NULL), nunca false;
#      marca positiva segue true; correção manual prevalece; nunca calculado → NULL; empresa ausente → NULL.
#      C0 = o predecessor de PROD dizia false para o número novo.
#   G  PRE recusa corpo estranho e dependência ausente; PÓS: corpo, atributos e ACL; re-aplicar = no-op; a cópia
#      sem envelope de db/ é a migration byte a byte menos BEGIN;/COMMIT;.
#   bash db/test-radar-k2-foto-e-contato.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-k2-foto-e-contato.sh     # o 2º locale (asserts em ASCII, caixa fixa)
#   SABOTAGEM=<nome> bash db/test-radar-k2-foto-e-contato.sh             # tem de ficar VERMELHA
#   bash db/test-radar-k2-foto-e-contato.sh --falsificar                 # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261111132000_radar_foto_do_card_e_contato_avaliado.sql"
MIG_DB="$REPO_ROOT/db/2026-11-09-radar-foto-do-card-e-contato-avaliado.sql"
FIX="$REPO_ROOT/db/fixtures/radar-k2-predecessora-prod-20261109.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>. `POST!P3_FALHOU` = a postcondição aborta o apply com a marca exata.
  SABOTAGENS="sem_anterior:F1 atribuido_sem_anterior:F2 orfao_sem_anterior:F3 nova_entra:F4 sem_lote_nova_entra:F6
    sem_versao:C2 versao_mata_marca:C3 acl_aberta:POST!P3_FALHOU pre_cega:G2"
  falsificar_em() { # $1 = locale
    local loc="$1" logdir falhas=0 n_sab=0 s a marca
    logdir="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-k2.XXXXXX")"
    echo "== CONTROLE ($loc) =="
    if ! LOCALE_TESTE="$loc" SABOTAGEM="" bash "$0" > "$logdir/controle.log" 2>&1; then
      echo "controle VERMELHO em $loc — falsificacao abortada (log: $logdir/controle.log)"; tail -15 "$logdir/controle.log"; return 1
    fi
    if ! grep -q "^PASS=[1-9][0-9]* FAIL=0$" "$logdir/controle.log"; then
      echo "controle sem recibo PASS=n FAIL=0 em $loc — a suite nao rodou"; return 1
    fi
    echo "controle verde em $loc ($(grep '^PASS=' "$logdir/controle.log"))"
    for s in $SABOTAGENS; do
      n_sab=$((n_sab+1)); a="${s#*:}"; s="${s%%:*}"
      if LOCALE_TESTE="$loc" SABOTAGEM="$s" bash "$0" > "$logdir/$s.log" 2>&1; then
        echo "SABOTAGEM $s ficou VERDE em $loc"; falhas=$((falhas+1)); continue
      fi
      case "$a" in
        POST!*) marca="${a#POST!}"; marca="${marca//_/ }"
                if grep -qF "${marca// /_}" "$logdir/$s.log"; then echo "ok $s -> postcondicao ${a#POST!}"
                else echo "SABOTAGEM $s vermelha SEM a marca ${a#POST!}"; falhas=$((falhas+1)); fi ;;
        *)      if grep -q "^FAIL $a " "$logdir/$s.log"; then echo "ok $s -> $a"
                else echo "SABOTAGEM $s vermelha mas NAO no assert $a"; grep "^FAIL\|ERROR" "$logdir/$s.log" | head -3; falhas=$((falhas+1)); fi ;;
      esac
    done
    echo "$loc: $n_sab sabotagens, $falhas falha(s)"
    N_TOT=$((N_TOT + n_sab)); F_TOT=$((F_TOT + falhas)); [ "$falhas" -eq 0 ]
  }
  N_TOT=0; F_TOT=0; total=0
  falsificar_em C || total=1
  falsificar_em pt_BR.UTF-8 || total=1
  [ "$total" -eq 0 ] || [ "$F_TOT" -gt 0 ] || F_TOT=1   # controle vermelho conta como falha
  echo "SABOTAGENS: $((N_TOT - F_TOT)) vermelhas / $F_TOT falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$total" -eq 0 ]; exit $?
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5523}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-k2.XXXXXX")/data"
export LC_ALL="${LOCALE_TESTE:-C}" LANG="${LOCALE_TESTE:-C}"
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrências) — na migration desta entrega
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
# Sabotagem de CORPO: a PÓS barraria pelo md5 no apply; cegada, a suíte tem de pegar sozinha.
cegar_pos() { sabotar "    IF r.oid IS NULL OR r.vivo IS DISTINCT FROM r.este THEN" "    IF r.oid IS NULL THEN"; }
case "${SABOTAGEM:-}" in
  "") ;;
  sem_anterior)        cegar_pos; sabotar "AND (re.ultimo_lote = par.lote OR re.lote_anterior = par.lote) END)" "AND re.ultimo_lote = par.lote END)" ;;
  atribuido_sem_anterior) cegar_pos; python3 -I - "$MIG_USADA" <<'PY'
import sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
novo = "                      AND (re.ultimo_lote = par.lote OR re.lote_anterior = par.lote) END)\n"
velho = "                      AND (re.ultimo_lote = par.lote) END)\n"
i = s.index(novo); j = s.index(novo, i + 1)
s = s[:j] + s[j:].replace(novo, velho, 1)   # o 1º (território) fica certo; o 2º (atribuído) perde o lote_anterior
open(p, "w", encoding="utf-8").write(s)
PY
  ;;
  orfao_sem_anterior)  cegar_pos; python3 -I - "$MIG_USADA" <<'PY'
import sys
p = sys.argv[1]; s = open(p, encoding="utf-8").read()
novo = "                      AND (re.ultimo_lote = par.lote OR re.lote_anterior = par.lote) END)\n"
velho = "                      AND (re.ultimo_lote = par.lote) END)\n"
i = s.rindex(novo)
s = s[:i] + s[i:].replace(novo, velho, 1)   # só o 3º (acompanhamento órfão) perde o lote_anterior
open(p, "w", encoding="utf-8").write(s)
PY
  ;;
  nova_entra)          cegar_pos; sabotar "                 ELSE re.ultimo_lote = ANY (ARRAY[par.lote, par.pub])
                      AND (re.ultimo_lote = par.lote OR re.lote_anterior = par.lote) END)" "                 ELSE re.ultimo_lote = ANY (ARRAY[par.lote, par.pub]) END)" ;;
  sem_lote_nova_entra) cegar_pos; sabotar "THEN par.pub IS NULL OR NOT (re.ultimo_lote IS NOT DISTINCT FROM par.pub AND re.lote_anterior IS NULL)" "THEN true" ;;
  sem_versao)          cegar_pos; sabotar "                    AND (SELECT e.updated_at FROM public.radar_empresas e WHERE e.cnpj = p_cnpj) <= s.calculado_em," "," ;;
  versao_mata_marca)   cegar_pos; sabotar "  SELECT c.campo, c.tipo, c.valor,
         CASE WHEN a.cnpj IS NOT NULL THEN true WHEN est.calculado THEN false END," "  SELECT c.campo, c.tipo, c.valor,
         CASE WHEN NOT est.calculado THEN NULL WHEN a.cnpj IS NOT NULL THEN true ELSE false END," ;;
  acl_aberta)          sabotar "-- PÓS: os corpos vivos" "GRANT EXECUTE ON FUNCTION private.radar_leads_do_vendedor(uuid, integer, timestamptz) TO authenticated;

-- PÓS: os corpos vivos" ;;
  pre_cega)            sabotar "    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN" "    IF false THEN" ;;
  *) echo "SABOTAGEM desconhecida: ${SABOTAGEM}"; exit 2 ;;
esac

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="${LOCALE_TESTE:-C}" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -tA -q "$@"; }

# ── Esquema mínimo: as colunas que os 5 corpos leem, com os tipos de PROD (psql-ro, 2026-11-09) ──────────────
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA private;
CREATE TABLE public.radar_ingest_state (mes_referencia text PRIMARY KEY, status text NOT NULL, carga_fase text,
  carga_publicacao_iniciada_em timestamptz);
CREATE TABLE public.radar_empresas (cnpj text PRIMARY KEY, razao_social text, nome_fantasia text, municipio_codigo text,
  municipio_nome text, uf text, score smallint, score_motivos text[], ja_cliente boolean NOT NULL DEFAULT false,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar', rfb_situacao text, ultimo_lote text, lote_anterior text,
  telefone1 text, telefone2 text, email text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_atendimentos (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, cnpj text NOT NULL,
  dono_user_id uuid NOT NULL, atribuido_por uuid, encerrado_em timestamptz, assumido_em timestamptz DEFAULT now(),
  renovado_em timestamptz);
CREATE TABLE public.fornecedor_alerta (id bigint PRIMARY KEY, status text);
CREATE TABLE public.radar_email_vendedor_envios (id uuid PRIMARY KEY, vendedor_user_id uuid, semana date,
  eh_teste boolean NOT NULL DEFAULT false, alerta_id bigint, criado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_email_vendedor_leads (envio_id uuid, posicao smallint, cnpj text);
CREATE TABLE public.radar_contato_contabil (cnpj text, tipo text, valor text, motivos text[], grupos integer,
  corroborado boolean, versao_regra smallint, calculado_em timestamptz, PRIMARY KEY (cnpj, tipo, valor));
CREATE TABLE public.radar_contato_contabil_estado (id boolean PRIMARY KEY, impressao text, versao_regra smallint,
  calculado_em timestamptz, contatos integer, duracao_ms integer, detalhes jsonb);
CREATE TABLE public.radar_contato_contabil_correcoes (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  cnpj text, tipo text, valor text, campo text, veredito boolean, automatico boolean, substitui_id bigint,
  autor_user_id uuid, criado_em timestamptz DEFAULT now());
-- Dependências fora do recorte (stubs com as assinaturas de PROD): território = 1 município (M1); acompanhamento
-- órfão = o CNPJ que a tabela de controle aponta; posse ativa sempre; todo dono com acesso.
CREATE TABLE public._acomp (cnpj text, responsavel uuid, retorno_em date);
CREATE FUNCTION private.radar_territorio_do_vendedor(p_vendedor uuid, p_n integer)
  RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, clientes integer, compartilhado boolean)
  LANGUAGE sql STABLE AS $$ SELECT 'M1'::text, 'Cidade'::text, 'SC'::text, 3, false $$;
CREATE FUNCTION private.radar_acompanhamentos(p_agora timestamptz)
  RETURNS TABLE(cnpj text, raiz text, retorno_tipo text, contato_id uuid, autor uuid, responsavel uuid, retorno_em date,
                retorno_origem text, nota text, contato_em timestamptz)
  LANGUAGE sql STABLE AS $$ SELECT a.cnpj, left(a.cnpj, 8), 'retorno', NULL::uuid, NULL::uuid, a.responsavel,
                                   a.retorno_em, 'manual', NULL, NULL::timestamptz FROM public._acomp a $$;
CREATE FUNCTION private.radar_atendimento_expira_em(text, uuid, timestamptz, timestamptz) RETURNS timestamptz
  LANGUAGE sql STABLE AS $$ SELECT now() + interval '10 days' $$;
CREATE FUNCTION private.cap_radar_prospectar(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
SQL
P -q -f "$FIX"

eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
PASS=0; FAIL=0
V1=00000000-0000-0000-0000-0000000000a1
G1=00000000-0000-0000-0000-0000000000b2
leads() { Pq -c "SELECT COALESCE(string_agg(left(cnpj, 3), ',' ORDER BY cnpj), '-') FROM private.radar_leads_do_vendedor('$V1', 5, now())"; }

# Cenário-base: V = 2026-10 completo, P = 2026-11 validado com a publicação em passos COMEÇADA (meio do caminho).
# Raízes distintas (o card mostra 1 por raiz); todas com score, contato e no território M1, menos as do atribuído.
#   AAA  rótulo V intocado                           → na foto de V
#   BBB  reetiquetada: P vindo de V                  → na foto de V (o bug: sumia)
#   CCC  nova: só em P (lote_anterior NULL)          → fora até a virada
#   DDD  saiu da foto (rótulo antigo)                → fora
#   EEE  atribuída pelo gestor, reetiquetada, fora do território → na foto de V (ramo atribuído)
#   FFF  acompanhamento órfão vencido, reetiquetada  → na foto de V (ramo órfão)
P -q <<SQL
INSERT INTO public.radar_ingest_state VALUES ('2026-09', 'complete', NULL, NULL), ('2026-10', 'complete', 'publicada', NULL),
  ('2026-11', 'running', 'validada', now() - interval '20 minutes');
INSERT INTO public.radar_empresas (cnpj, municipio_codigo, score, ultimo_lote, lote_anterior, telefone1, prospeccao_status) VALUES
  ('AAA00001000101', 'M1', 80, '2026-10', NULL,      '4733330001', 'a_contatar'),
  ('BBB00001000101', 'M1', 79, '2026-11', '2026-10', '4733330002', 'a_contatar'),
  ('CCC00001000101', 'M1', 78, '2026-11', NULL,      '4733330003', 'a_contatar'),
  ('DDD00001000101', 'M1', 77, '2026-09', NULL,      '4733330004', 'a_contatar'),
  ('EEE00001000101', 'M9', 76, '2026-11', '2026-10', '4733330005', 'a_contatar'),
  ('FFF00001000101', 'M1', 75, '2026-11', '2026-10', '4733330006', 'em_conversa');
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, atribuido_por) VALUES ('EEE00001000101', '$V1', '$G1');
INSERT INTO public._acomp VALUES ('FFF00001000101', NULL, current_date - 1);
SQL

eq "F0 predecessor de PROD: durante a publicacao a reetiquetada (BBB, EEE, FFF) sumia do card" "$(leads)" "AAA"

# Contato: estado calculado há 1 h; XXX lido pelo cálculo (updated_at antes), YYY marcada como contabilidade,
# ZZZ com correção manual "não é" — as duas últimas e o WWW escritos pela carga DEPOIS do cálculo.
P -q <<'SQL'
INSERT INTO public.radar_contato_contabil_estado (id, impressao, versao_regra, calculado_em) VALUES (true, 'x', 1, now() - interval '1 hour');
INSERT INTO public.radar_empresas (cnpj, telefone1, updated_at) VALUES
  ('XXX00001000101', '4733339001', now() - interval '2 hours'),
  ('YYY00001000101', '4733339002', now()),
  ('ZZZ00001000101', '4733339003', now()),
  ('WWW00001000101', '4733339004', now());
INSERT INTO public.radar_contato_contabil (cnpj, tipo, valor, motivos, grupos) VALUES
  ('YYY00001000101', 'telefone', '4733339002', ARRAY['telefone_compartilhado'], 5);
INSERT INTO public.radar_contato_contabil_correcoes (cnpj, tipo, valor, campo, veredito, automatico) VALUES
  ('ZZZ00001000101', 'telefone', '4733339003', 'telefone1', false, NULL);
SQL
aval() { Pq -c "SELECT coalesce(string_agg(coalesce(automatico::text, 'null') || '/' || coalesce(efetivo::text, 'null'), ','), '-')
                  FROM public.radar_empresas e CROSS JOIN LATERAL private.radar_contato_contabil_avaliar(e.cnpj, e.telefone1, e.telefone2, e.email)
                 WHERE e.cnpj = '$1'"; }
eq "C0 predecessor de PROD: numero escrito DEPOIS do calculo saia como 'nao e' (false)" "$(aval WWW00001000101)" "false/false"

# ── Aplica a migration (com o envelope dela, como no SQL Editor) ─────────────────────────────────────────────
APPLY_LOG="$(dirname "$DATA")/apply.log"
if ! P -q -f "$MIG_USADA" > "$APPLY_LOG" 2>&1; then
  echo "APPLY FALHOU:"; cat "$APPLY_LOG"; echo "PASS=$PASS FAIL=$((FAIL+1))"; exit 1
fi

# ── F: a foto do card cruzando a publicação ─────────────────────────────────────────────────────────────────
L="$(leads)"
case ",$L," in *,BBB,*) f1=ok ;; *) f1="sem BBB: $L" ;; esac
eq "F1 durante a publicacao a reetiquetada do territorio (BBB) segue no card" "$f1" "ok"
case ",$L," in *,EEE,*) f2=ok ;; *) f2="sem EEE: $L" ;; esac
eq "F2 durante a publicacao a reetiquetada atribuida pelo gestor (EEE) segue no card" "$f2" "ok"
case ",$L," in *,FFF,*) f3=ok ;; *) f3="sem FFF: $L" ;; esac
eq "F3 durante a publicacao o acompanhamento orfao reetiquetado (FFF) segue no card" "$f3" "ok"
eq "F4 durante a publicacao: exatamente a foto de V (nova CCC e antiga DDD fora)" "$L" "AAA,BBB,EEE,FFF"
P -q -c "UPDATE public.radar_ingest_state SET status = 'complete', carga_fase = 'publicada' WHERE mes_referencia = '2026-11';"
eq "F5 depois da virada a foto e P inteira (AAA com rotulo V sai; CCC nova entra)" "$(leads)" "BBB,CCC,EEE,FFF"
P -q -c "DELETE FROM public.radar_ingest_state WHERE mes_referencia <> '2026-11';
         UPDATE public.radar_ingest_state SET status = 'running', carga_fase = 'validada' WHERE mes_referencia = '2026-11';"
eq "F6 sem lote completo e com publicacao em curso: a empresa so de P (CCC) fica de fora" "$(leads)" "AAA,BBB,DDD,EEE,FFF"
P -q -c "DELETE FROM public.radar_ingest_state;"
# 6 elegíveis e o card capa em 5: sai a de menor score (FFF).
eq "F7 sem lote nenhum: nao recorta (null e 'nao sei', nunca zero)" "$(leads)" "AAA,BBB,CCC,DDD,EEE"

# ── C: contato contábil amarrado à versão dos dados ─────────────────────────────────────────────────────────
eq "C1 contato lido pelo calculo e sem marca: 'nao e' (false)" "$(aval XXX00001000101)" "false/false"
eq "C2 numero escrito DEPOIS do calculo: 'nao sei' (null), nunca false" "$(aval WWW00001000101)" "null/null"
eq "C3 marca positiva segue valendo com a linha reescrita" "$(aval YYY00001000101)" "true/true"
eq "C4 correcao manual prevalece sobre o 'nao sei'" "$(aval ZZZ00001000101)" "null/false"
P -q -c "UPDATE public.radar_contato_contabil_estado SET calculado_em = now() + interval '1 minute';"
eq "C5 recalculo posterior a escrita devolve o 'nao e'" "$(aval WWW00001000101)" "false/false"
eq "C6 empresa ausente: 'nao sei'" "$(Pq -c "SELECT coalesce(automatico::text, 'null') FROM private.radar_contato_contabil_avaliar('QQQ00001000101', '4733330009', NULL, NULL)")" "null"
P -q -c "DELETE FROM public.radar_contato_contabil_estado;"
eq "C7 nunca calculado: 'nao sei'" "$(aval XXX00001000101)" "null/null"

# ── G: guardas da migration ─────────────────────────────────────────────────────────────────────────────────
eq "G1 re-aplicar sobre ela mesma passa (PRE aceita o corpo 'este')" "$(P -q -f "$MIG_USADA" >/dev/null 2>&1 && echo ok || echo falhou)" "ok"
P -q -c "CREATE OR REPLACE FUNCTION private.radar_contato_contabil_avaliar(p_cnpj text, p_tel1 text, p_tel2 text, p_email text)
  RETURNS TABLE(campo text, tipo text, valor text, automatico boolean, motivos text[], grupos integer, corroborado boolean,
                correcao_id bigint, veredito boolean, efetivo boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS \$f\$ SELECT NULL::text, NULL::text, NULL::text, NULL::boolean,
  NULL::text[], NULL::integer, NULL::boolean, NULL::bigint, NULL::boolean, NULL::boolean WHERE false \$f\$;"
g2="$(P -q -f "$MIG_USADA" 2>&1 | grep -o "PRE FALHOU: radar_contato_contabil_avaliar vivo" || true)"
eq "G2 anti-deriva: corpo vivo estranho (outra sessao) aborta a aplicacao" "$g2" "PRE FALHOU: radar_contato_contabil_avaliar vivo"
eq "G2b ...e nao apaga o corpo da outra sessao" "$(Pq -c "SELECT count(*) FROM private.radar_contato_contabil_avaliar('X', '4733330001', NULL, NULL)")" "0"
eq "G3 a interna segue fechada a PUBLIC/anon/authenticated" \
   "$(Pq -c "SELECT has_function_privilege('authenticated', 'private.radar_leads_do_vendedor(uuid,integer,timestamptz)', 'EXECUTE')::text || has_function_privilege('anon', 'private.radar_contato_contabil_avaliar(text,text,text,text)', 'EXECUTE')::text")" \
   "falsefalse"
g4="$(python3 -I - "$MIG" "$MIG_DB" <<'PY'
import sys
m = open(sys.argv[1], encoding="utf-8").read().split("\n")
d = open(sys.argv[2], encoding="utf-8").read().split("\n")
corpo_m = [l for l in m if l not in ("BEGIN;", "COMMIT;")]
i = d.index("-- =============================================================================")
print("igual" if d[i:] == corpo_m else "diverge")
PY
)"
eq "G4 a copia sem envelope de db/ e a migration menos BEGIN;/COMMIT;" "$g4" "igual"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
