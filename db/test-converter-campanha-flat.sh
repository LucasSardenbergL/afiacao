#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════╗
# ║  REGRESSÃO — converter_sugestao_em_campanha_flat nas colunas REAIS do item      ║
# ║  (20261001083000_converter_campanha_flat_colunas_reais.sql · issue #2668)      ║
# ║                                                                                ║
# ║  H  o predecessor da fixture é o corpo de prod (md5) e o último CREATE do repo  ║
# ║  P0 o predecessor EXECUTADO falha com 42703 — o defeito de prod, reproduzido   ║
# ║  X  caminhos da migration: deriva aborta a PRE; a função nasce com o fecho      ║
# ║     PORTA_GATE (sem e com o default ACL do Supabase); re-aplicar é seguro       ║
# ║  O1/A1  a assinatura antiga saiu; anon e PUBLIC fechados, staff aberto         ║
# ║  P  a conversão grava a campanha, o item (código Sayerlack aparado, SKU bigint, ║
# ║     manual_confirmado, confirmado) e fecha a sugestão                          ║
# ║  N  os portões: staff, código vazio, data fim no passado, SKU não numérico,     ║
# ║     sugestão já convertida, sugestão inexistente — e nada gravado (NZ)         ║
# ║  B  a borda do dia de SP (D = 28/02/2025), 4 instantes — 20:59:59 · 21:00:00 ·  ║
# ║     23:59:59 BRT de D · 00:00:00 BRT de D+1 — sob `TimeZone=UTC` E             ║
# ║     `America/Sao_Paulo`, convertendo com data fim = hoje de SP: a data de       ║
# ║     início e a da oferta são o dia de SP, e a campanha nasce no último dia     ║
# ║  W  a função com o search_path de prod, chamada como authenticated, no relógio ║
# ║     real                                                                       ║
# ║  ⏰ Relógio CONTROLADO (`test.agora`): `public.now()` é TRIPWIRE (Z9T01) e só  ║
# ║    o converter ganha `pg_catalog` DEPOIS de `public`. R0 prova o pin; o        ║
# ║    `current_date` literal (que o relógio não alcança) é pego pelo bloco B e    ║
# ║    pelo P1, que leem o dia do relógio controlado.                              ║
# ║  Diário: docs/historico/converter-campanha-flat-colunas-reais.md               ║
# ║                                                                                ║
# ║  rode: bash db/test-converter-campanha-flat.sh > log 2>&1; echo "exit=$?"       ║
# ║        bash db/test-converter-campanha-flat.sh --falsificar > log 2>&1         ║
# ║  matriz: TZ=UTC (servidor UTC, como o CI) e sem TZ · HARNESS_LC=C|pt_BR.UTF-8  ║
# ╚════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5730}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="converter-campanha-flat"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C

MIG_NOVA="$REPO_ROOT/supabase/migrations/20261001083000_converter_campanha_flat_colunas_reais.sql"
FIXTURE="$REPO_ROOT/db/fixtures/converter-campanha-flat-predecessora-prod-20261001.sql"
# o gatilho de campanha roda DENTRO da transação do converter: entra com o corpo vivo de prod
MIG_GATILHO="$REPO_ROOT/supabase/migrations/20260929001651_hoje_sp_sessao_utc_sete_funcoes.sql"
# Denominador: quantos asserts a suíte EXECUTA (H1-H2 · P0 · X1 X3 X3s X2 · O1 A1 · R0 · P1-P3 ·
# N1-N7 NZ · B0 BU BS · W). Asserts a menos — um bloco que não rodou — é vermelho.
TOTAL_ESPERADO=25

# ══════════════════════════════════════════════════════════════════════════════
# MODO --falsificar: prova que os asserts têm DENTE (o contrato de
# db/test-hoje-sp-sete-funcoes.sh). O controle roda PRIMEIRO, na mesma invocação; cada sabotagem
# declara os asserts que TÊM de ficar vermelhos por RESULTADO e os que TÊM de continuar verdes; o
# filho tem de chegar ao fim com todos os asserts; todo ERRO_DE_EXECUCAO tem de estar declarado
# (`ID!MARCA`); a marca da sabotagem tem de aparecer.
# Formato: <sabotagem>:<vermelhos,separados>[:<verdes,separados>]
# ══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="current_date_de_volta:BU:BS,P1,P2,P3,R0
              current_date_literal:BU,BS,P1:R0
              hoje_em_utc:BU,BS:P1,P2,P3,R0
              relogio_desligado:R0
              codigo_cru:P2,N3:P1,P3
              qualidade_errada:P2:P1,P3
              item_sem_sku:P2:P1,P3
              nao_confirmado:P2:P1,P3
              sem_guard_reconversao:N6:N1,N2,N3,N4,N5,N7
              gate_staff_aberto:N1,N2:N3,N4,N5,N6,N7
              sem_guard_codigo:N3!sku_codigo_fornecedor:N1,N2,N4,N5,N6,N7
              sem_guard_data_fim:N4!ck_periodo_coerente:N1,N2,N3,N5,N6,N7
              sugestao_nao_fechada:P3:P1,P2
              corte_um_mes:P1:P2,P3
              acl_anon_aberta:A1:O1
              pre_cega:X1:X2,X3,X3s
              pre_sem_reaplicacao:X2:X1,X3,X3s
              sem_grant_authenticated:X3:X3s,X1,X2
              revoke_sem_anon:X3s:X3,X1,X2"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT

  # o filho rodou até o fim, com TODOS os asserts? (senão o vermelho pode ser de um aborto)
  completo() {
    local l ok_n fail_n
    l="$(grep -E '^RESULTADO: [0-9]+ ok / [0-9]+ fail$' "$1" | tail -1 || true)"
    [ -n "$l" ] || return 1
    ok_n="$(printf '%s' "$l" | awk '{print $2}')"; fail_n="$(printf '%s' "$l" | awk '{print $5}')"
    [ $((ok_n + fail_n)) -eq "$TOTAL_ESPERADO" ]
  }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE, com os $TOTAL_ESPERADO asserts ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1 && completo "$LOGDIR/controle.log"; then
    echo "  ✅ controle VERDE ($(grep -c ' OK — ' "$LOGDIR/controle.log" || true) asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO ou incompleto — abortando ANTES de sabotar (uma suíte que já falha aprovaria tudo)"
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; resto="${item#*:}"; verm="${resto%%:*}"; verdes=""
    [ "$resto" != "$verm" ] && verdes="${resto#*:}"
    porta=$((porta+1))
    log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ativa: $sab\$" "$log"; then
      echo "  ❌ $sab — vermelha, mas a sabotagem NÃO chegou a aplicar: quebrou outra coisa"
      grep -E 'FALHOU|ERRO|ERROR|APLICAVEL|INFRA' "$log" | head -3 | sed 's/^/       /'
      falhas=$((falhas+1)); continue
    fi
    if ! completo "$log"; then
      echo "  ❌ $sab — o filho NÃO chegou ao fim com os $TOTAL_ESPERADO asserts: o vermelho pode ser de um aborto"
      tail -5 "$log" | sed 's/^/       /'
      falhas=$((falhas+1)); continue
    fi
    faltou=""; sobrou=""; nao_declarado=""
    for x in ${verm//,/ }; do
      case "$x" in
        *!*) id="${x%%!*}"; marca="${x#*!}"
             grep -Eq "(^|[^A-Za-z0-9])${id} ERRO_DE_EXECUCAO .*${marca}" "$log" || faltou="$faltou $x" ;;
        *)   grep -Eq "(^|[^A-Za-z0-9])${x} FALHOU" "$log" || faltou="$faltou $x" ;;
      esac
    done
    for id in ${verdes//,/ }; do
      if ! grep -Eq "(^|[^A-Za-z0-9])${id} OK" "$log" || grep -Eq "(^|[^A-Za-z0-9])${id} (FALHOU|ERRO_DE_EXECUCAO)" "$log"; then
        sobrou="$sobrou $id"
      fi
    done
    while IFS= read -r id_err; do
      [ -n "$id_err" ] || continue
      case ",${verm}," in *",${id_err}!"*) ;; *) nao_declarado="$nao_declarado $id_err" ;; esac
    done < <(grep -oE '[A-Za-z0-9]+ ERRO_DE_EXECUCAO' "$log" | awk '{print $1}' || true)
    if [ -z "$faltou" ] && [ -z "$sobrou" ] && [ -z "$nao_declarado" ]; then
      echo "  ✅ $sab — vermelha em [${verm}]${verdes:+, verde em [${verdes}]}"
    else
      [ -n "$faltou" ] && echo "  ❌ $sab — devia ficar vermelha (por resultado) em:${faltou}"
      [ -n "$sobrou" ] && echo "  ❌ $sab — devia continuar verde (rodando) em:${sobrou}"
      [ -n "$nao_declarado" ] && { echo "  ❌ $sab — ERRO DE EXECUÇÃO não declarado em:${nao_declarado} (vermelho que não é do assert não mata mutante)"
                                   grep 'ERRO_DE_EXECUCAO' "$log" | head -2 | sed 's/^/       /'; }
      falhas=$((falhas+1))
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert certo ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem dente (logs em $LOGDIR) ═══"
  exit 1
fi
SABOTAGEM="${SABOTAGEM:-}"

# PGBIN: resolvido por plataforma (macOS Homebrew / Linux PGDG) com conferência POSITIVA da major.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -q -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()       { PASS=$((PASS+1)); echo "  ✅ $1 OK — $2"; }
bad()      { FAIL=$((FAIL+1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec(){ FAIL=$((FAIL+1)); echo "  ❌ $1 ERRO_DE_EXECUCAO — $2"; }
# Um VALOR que é erro (psql, tripwire) ou vazio não é resultado: vira ERRO_DE_EXECUCAO, que o laço
# de falsificação não aceita como dente. Só um resultado válido que contraria o esperado é FALHOU.
eq() {
  case "$3" in
    ""|*ERROR:*|*ERRO:*|*FATAL:*|*TRIPWIRE*|*psql:*)
      erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 300)]" ;;
    *) if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi ;;
  esac
}

echo "═══ setup pronto (PG17 :$PORT, servidor TimeZone=$(Pq -c 'SHOW TimeZone'), lc_messages=$HARNESS_LC) ═══"

# ── helpers de arquivo (python, contagem EXATA de cada padrão: troca que não pegou é erro) ──
extrair() {   # <arquivo> <marcador de início> <saída> — o bloco CREATE … $function$; VERBATIM
  python3 - "$1" "$2" "$3" <<'PY'
import sys
s = open(sys.argv[1], encoding='utf-8').read(); marca = sys.argv[2]
ini = s.find(marca); fim = s.find('$function$;', ini) if ini >= 0 else -1
if ini < 0 or fim < 0 or s.count(marca) != 1:
    sys.exit('marcador ausente ou ambiguo em %s: %r' % (sys.argv[1], marca))
open(sys.argv[3], 'w', encoding='utf-8').write(s[ini:fim + len('$function$;')] + '\n')
PY
}
trocar() {    # <entrada> <saída> <de> <para> <n> [<de> <para> <n> ...]
  local src="$1" dst="$2"; shift 2
  python3 - "$src" "$dst" "$@" <<'PY'
import sys
src, dst, trocas = sys.argv[1], sys.argv[2], sys.argv[3:]
s = open(src, encoding='utf-8').read()
for i in range(0, len(trocas), 3):
    de, para, n = trocas[i], trocas[i + 1], int(trocas[i + 2])
    if s.count(de) != n:
        sys.exit('padrao ocorre %dx, esperado %d: %r' % (s.count(de), n, de))
    s = s.replace(de, para)
open(dst, 'w', encoding='utf-8').write(s)
PY
}

SIG_ANTIGA="public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text)"
SIG_NOVA="public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text,text)"
STAFF='a0000000-0000-4000-8000-000000000001'     # employee
CLIENTE='c0000000-0000-4000-8000-000000000002'   # customer
ESTE='557f962e0355b034097be8cf88c27a1a'           # md5 do corpo novo (as constantes da PRE e da POS)

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS com as colunas, os tipos, os NOT NULL, os DEFAULTs e os CHECKs da prod
# (pg_attribute/pg_constraint via psql-ro, 2026-10-01 — o information_schema esconde do claude_ro
# a coluna sem privilégio). As tabelas nascem ANTES do relógio controlado: o `DEFAULT now()` delas
# amarra o pg_catalog.now() no CREATE e nunca toca o tripwire. Os gatilhos são os de prod
# (pg_get_triggerdef): o de alerta de campanha roda dentro da transação do converter.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

CREATE TABLE public.promocao_campanha (
  id bigserial PRIMARY KEY, empresa text NOT NULL, fornecedor_nome text NOT NULL, nome text NOT NULL,
  tipo_origem text NOT NULL, data_inicio date NOT NULL, data_fim date NOT NULL, estado text NOT NULL DEFAULT 'rascunho',
  origem_arquivo_url text, origem_arquivo_tipo text, origem_email_assunto text, origem_email_remetente text,
  origem_email_data timestamptz, extracao_confianca numeric, extracao_observacoes text, extraido_em timestamptz,
  observacoes text, criado_em timestamptz DEFAULT now(), criado_por text, atualizado_em timestamptz DEFAULT now(),
  atualizado_por text, data_corte_pedido date, data_corte_faturamento date, permite_pedido_oportunidade boolean DEFAULT true,
  responsavel_oferta_nome text, responsavel_oferta_email text, canal_oferta text, data_oferta date,
  volume_minimo_condicional numeric, volume_minimo_unidade text, status_aceite text DEFAULT 'pendente', observacoes_negociacao text,
  CONSTRAINT ck_periodo_coerente CHECK (data_fim >= data_inicio),
  CONSTRAINT promocao_campanha_canal_oferta_check CHECK (canal_oferta IS NULL OR canal_oferta = ANY (ARRAY['email','whatsapp','ligacao','visita_presencial','outro'])),
  CONSTRAINT promocao_campanha_estado_check CHECK (estado = ANY (ARRAY['rascunho','negociando','ativa','encerrada','cancelada'])),
  CONSTRAINT promocao_campanha_status_aceite_check CHECK (status_aceite = ANY (ARRAY['pendente','aceita','recusada','cumprida','expirada'])),
  CONSTRAINT promocao_campanha_tipo_origem_check CHECK (tipo_origem = ANY (ARRAY['fornecedor_impoe','oficial_mensal','negociacao_cliente','desconto_flat_condicional','outro'])),
  CONSTRAINT promocao_campanha_volume_minimo_unidade_check CHECK (volume_minimo_unidade IS NULL OR volume_minimo_unidade = ANY (ARRAY['unidades','reais','kg','litros'])));
CREATE TABLE public.promocao_item (
  id bigserial PRIMARY KEY, campanha_id bigint NOT NULL REFERENCES public.promocao_campanha(id) ON DELETE CASCADE,
  sku_codigo_fornecedor text NOT NULL, descricao_produto_fornecedor text, sku_codigo_omie bigint,
  mapeamento_qualidade text, mapeamento_candidatos jsonb, desconto_perc numeric NOT NULL, volume_minimo numeric,
  confirmado boolean NOT NULL DEFAULT false, ativo boolean NOT NULL DEFAULT true, observacoes text,
  criado_em timestamptz DEFAULT now(), atualizado_em timestamptz DEFAULT now(), desconto_extra_perc numeric,
  desconto_extra_observacoes text, desconto_extra_negociado_por text, desconto_extra_negociado_em timestamptz,
  desconto_extra_email_referencia text,
  CONSTRAINT promocao_item_desconto_extra_perc_check CHECK (desconto_extra_perc IS NULL OR (desconto_extra_perc > 0 AND desconto_extra_perc <= 50)),
  CONSTRAINT promocao_item_desconto_perc_check CHECK (desconto_perc > 0 AND desconto_perc <= 100),
  CONSTRAINT promocao_item_mapeamento_qualidade_check CHECK (mapeamento_qualidade = ANY (ARRAY['unico','unico_por_similaridade','ambiguo','nao_encontrado','manual_confirmado','expandido_automatico','expandido_por_similaridade','expandido_origem',NULL::text])),
  CONSTRAINT uq_item_na_campanha UNIQUE (campanha_id, sku_codigo_fornecedor, volume_minimo));
CREATE TABLE public.sugestao_negociacao_paralela (
  id bigserial PRIMARY KEY, empresa text NOT NULL, sku_codigo_omie text NOT NULL, sku_descricao text, motivo text NOT NULL,
  motivo_detalhes jsonb, score_final numeric, volume_financeiro_12m numeric, preco_medio_unitario numeric,
  promocoes_12m integer, perc_meses_com_promo numeric, status text NOT NULL DEFAULT 'nova',
  campanha_id_gerada bigint REFERENCES public.promocao_campanha(id), data_acao timestamptz, observacoes text,
  data_geracao date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'))::date,
  valido_ate date NOT NULL DEFAULT (((now() AT TIME ZONE 'America/Sao_Paulo'))::date + '14 days'::interval),
  criado_em timestamptz DEFAULT now(), atualizado_em timestamptz DEFAULT now(),
  CONSTRAINT sugestao_negociacao_paralela_motivo_check CHECK (motivo = ANY (ARRAY['candidato_forte_sem_promo_recente','consumo_abaixo_tipico_fim_de_mes','score_alto_ciclo_semanal','combinacao_heuristica'])),
  CONSTRAINT sugestao_negociacao_paralela_status_check CHECK (status = ANY (ARRAY['nova','visualizada','acao_tomada','fechada_desconto','fechada_sem_acordo','ignorada'])));
CREATE TABLE public.fornecedor_alerta (id bigserial PRIMARY KEY, empresa text NOT NULL, fornecedor_nome text, tipo text NOT NULL,
  severidade text NOT NULL DEFAULT 'info', titulo text NOT NULL, mensagem text, campanha_id bigint);

CREATE FUNCTION public.touch_promocao() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$ BEGIN NEW.atualizado_em := now(); RETURN NEW; END; $function$;
CREATE FUNCTION public.touch_sugestao_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$ BEGIN NEW.atualizado_em := now(); RETURN NEW; END; $function$;
CREATE TRIGGER trg_touch_promocao_campanha BEFORE UPDATE ON public.promocao_campanha FOR EACH ROW EXECUTE FUNCTION touch_promocao();
CREATE TRIGGER trg_touch_promocao_item BEFORE UPDATE ON public.promocao_item FOR EACH ROW EXECUTE FUNCTION touch_promocao();
CREATE TRIGGER trg_touch_sugestao BEFORE UPDATE ON public.sugestao_negociacao_paralela FOR EACH ROW EXECUTE FUNCTION touch_sugestao_updated_at();

-- Instrumentos da prova (não existem em prod). Cada um devolve um TOKEN: o resultado esperado, ou
-- a recusa ESPERADA (SQLSTATE e marca); qualquer outro erro é relançado (não vira verde).
CREATE FUNCTION public.t_pred(p_sug bigint) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_catalog.set_config('test.uid', 'a0000000-0000-4000-8000-000000000001', true);
  PERFORM public.converter_sugestao_em_campanha_flat(p_sug, 8, 10, 'unidades', DATE '2999-12-31', NULL, 'ligacao', NULL);
  RETURN 'PASSOU';
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = '42703' THEN RETURN 'DEFEITO:42703'; END IF;
  RAISE;
END $f$;
CREATE FUNCTION public.t_conv(p_uid uuid, p_sug bigint, p_desc numeric, p_vol numeric, p_unid text, p_fim date,
                              p_cod text, p_resp text, p_canal text, p_obs text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_catalog.set_config('test.uid', p_uid::text, true);
  RETURN public.converter_sugestao_em_campanha_flat(p_sug, p_desc, p_vol, p_unid, p_fim, p_cod, p_resp, p_canal, p_obs)::text;
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE IN ('22023', '23514', 'P0001') THEN RETURN 'RECUSADA:' || SQLSTATE; END IF;
  RAISE;
END $f$;
CREATE FUNCTION public.t_tenta(p_uid uuid, p_sug bigint, p_fim date, p_cod text, p_estado text, p_marca text)
RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_catalog.set_config('test.uid', coalesce(p_uid::text, ''), true);
  PERFORM public.converter_sugestao_em_campanha_flat(p_sug, 8, 10, 'unidades', p_fim, p_cod);
  RETURN 'PASSOU';
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = p_estado AND position(p_marca IN SQLERRM) > 0 THEN RETURN 'BARRADO'; END IF;
  RAISE;
END $f$;
CREATE FUNCTION public.t_borda(p_sug bigint, p_fim date) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_id bigint; v text;
BEGIN
  PERFORM pg_catalog.set_config('test.uid', 'a0000000-0000-4000-8000-000000000001', true);
  v_id := public.converter_sugestao_em_campanha_flat(p_sug, 8, 10, 'unidades', p_fim, 'FO5.6717.00GL');
  SELECT c.data_inicio::text || '/' || c.data_oferta::text INTO v FROM public.promocao_campanha c WHERE c.id = v_id;
  RETURN v;
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE IN ('22023', '23514') THEN RETURN 'RECUSADA'; END IF;
  RAISE;
END $f$;
CREATE FUNCTION public.t_r0(p_sug bigint) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_catalog.set_config('test.uid', 'a0000000-0000-4000-8000-000000000001', true);
  PERFORM pg_catalog.set_config('test.agora', '', true);
  PERFORM public.converter_sugestao_em_campanha_flat(p_sug, 8, 10, 'unidades', DATE '2999-12-31', 'FO5.6717.00GL');
  RETURN 'RETORNOU';
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = 'Z9T01' THEN RETURN 'RELOGIO_CONTROLADO'; END IF;
  RAISE;
END $f$;
SQL

# o gatilho de alerta de campanha, com o corpo VIVO de prod (o da 20260929001651, aplicada)
extrair "$MIG_GATILHO" "CREATE OR REPLACE FUNCTION public.trg_campanha_gera_alerta()" "$TMPD/gatilho.sql"
P -q -f "$TMPD/gatilho.sql"
P -q -c "CREATE TRIGGER trg_campanha_alerta AFTER INSERT OR UPDATE OF estado ON public.promocao_campanha
           FOR EACH ROW EXECUTE FUNCTION trg_campanha_gera_alerta();"

# SEED: o staff, o cliente e uma sugestão por cenário (SKU e descrição reais de prod, fila v2).
P -q <<SQL
INSERT INTO public.user_roles VALUES ('$STAFF', 'employee'), ('$CLIENTE', 'customer');
INSERT INTO public.sugestao_negociacao_paralela (id, empresa, sku_codigo_omie, sku_descricao, motivo, status)
SELECT i, 'OBEN', CASE WHEN i = 25 THEN 'SKU-SEM-NUMERO' ELSE '8689723039' END, 'VERNIZ PU FOSCO FO5.6717.00GL',
       'combinacao_heuristica', 'acao_tomada'
  FROM unnest(ARRAY[1, 10, 21, 22, 23, 24, 25, 26, 30, 41, 42, 43, 44, 51, 52, 53, 54, 60]) AS i;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — O PREDECESSOR, da fixture VERBATIM da prod (Lei #1: nada de stub da lógica), com o ACL
# de prod (PUBLIC/anon fechados; authenticated/service_role abertos).
#   H1: o md5 EXATO do predecessor instalado é o medido na prod — a constante da PRE.
#   H2: a fixture é o último CREATE do repo (20260512101121) módulo comentário e espaço.
#   P0: EXECUTADO, o predecessor falha com 42703 (coluna inexistente) — o defeito de prod.
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$FIXTURE"
P -q -c "REVOKE ALL ON FUNCTION $SIG_ANTIGA FROM PUBLIC; GRANT EXECUTE ON FUNCTION $SIG_ANTIGA TO authenticated, service_role;"
V_H1=$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('$SIG_ANTIGA');" 2>&1 || true)
eq H1 "o predecessor da fixture = o corpo de prod (md5 exato, psql-ro 2026-10-01)" "$V_H1" "513a87a6e1785991e8aee9a8be9dc090"
V_H2=$(python3 - "$REPO_ROOT" "$FIXTURE" <<'PY' 2>&1 || true
import re, sys
raiz, fixture = sys.argv[1], sys.argv[2]
def corpo(txt, nome):
    ini = [m.start() for m in re.finditer(r'CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?' + nome + r'\s*\(', txt, re.I)][-1]
    m = re.search(r'\bAS\s+(\$[A-Za-z_]*\$)', txt[ini:], re.I)
    a = ini + m.end(); return txt[a:txt.index(m.group(1), a)]
sem = lambda s: re.sub(r'\s+', ' ', re.sub(r'--[^\n]*', '', s)).strip()
repo = open(f'{raiz}/supabase/migrations/20260512101121_a96fa007-f688-4c3a-8cd9-43f9d88e5505.sql', encoding='utf-8').read()
fx = open(fixture, encoding='utf-8').read()
n = 'converter_sugestao_em_campanha_flat'
print(f'{int(sem(corpo(repo, n)) == sem(corpo(fx, n)))}/1')
PY
)
eq H2 "a fixture é o último CREATE do repo módulo comentário" "$V_H2" "1/1"
eq P0 "o predecessor EXECUTADO como staff falha por coluna inexistente (o defeito de prod)" \
  "$(Pq -c "SELECT public.t_pred(1);" 2>&1 || true)" "DEFEITO:42703"

# ── sabotagens de ARQUIVO: cópias da migration nova usadas SÓ nas provas de caminho (X1-X3) ──
MIG_X1="$MIG_NOVA"; MIG_X2="$MIG_NOVA"; MIG_X3="$MIG_NOVA"
sabotar_arquivo() {   # <destino> <de> <para> <n> [...] — cópia de MIG_NOVA com as trocas
  local dst="$1"; shift
  trocar "$MIG_NOVA" "$dst" "$@" || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
  echo "→ SABOTAGEM ativa: $SABOTAGEM"
}
case "$SABOTAGEM" in
  # a PRE que não aborta nunca: uma deriva concorrente do corpo antigo seria apagada em silêncio
  pre_cega) MIG_X1="$TMPD/mig_x1.sql"
    sabotar_arquivo "$MIG_X1" "IF v_antigo IS NOT NULL AND v_antigo <>" "IF false AND v_antigo IS NOT NULL AND v_antigo <>" 1 ;;
  # a PRE que não reconhece o próprio corpo: re-aplicar (idempotência do envelope) abortaria
  pre_sem_reaplicacao) MIG_X2="$TMPD/mig_x2.sql"
    sabotar_arquivo "$MIG_X2" "v_novo <> '$ESTE'" "v_novo <> 'sabotado'" 1 ;;
  # sem o GRANT: onde a função NASCE sem default ACL, authenticated (o staff pelo PostgREST) ficaria
  # sem EXECUTE — vermelha no X3; no X3s o default do Supabase já dá a porta
  sem_grant_authenticated) MIG_X3="$TMPD/mig_x3.sql"
    sabotar_arquivo "$MIG_X3" " TO authenticated, service_role;" " TO service_role;" 1 ;;
  # o REVOKE só de PUBLIC: com o default ACL do Supabase o DROP + CREATE dá EXECUTE DIRETO a anon,
  # que um REVOKE de PUBLIC não tira — vermelha no X3s
  revoke_sem_anon) MIG_X3="$TMPD/mig_x3.sql"
    sabotar_arquivo "$MIG_X3" " FROM PUBLIC, anon;" " FROM PUBLIC;" 1 ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# X — OS CAMINHOS DECLARADOS DA MIGRATION. X1/X3/X3s rodam numa transação que volta atrás; o apply
# de verdade e a re-aplicação (X2) usam `psql -1` — a transação única do executor (db:aplicar).
# ══════════════════════════════════════════════════════════════════════════════
echo "── caminhos da migration ──"
trocar "$FIXTURE" "$TMPD/deriva.sql" "  v_campanha_id bigint;" "  v_campanha_id bigint; -- deriva concorrente" 1
{ echo "BEGIN;"; cat "$TMPD/deriva.sql"; cat "$MIG_X1"; echo "ROLLBACK;"; } > "$TMPD/x1.sql"
rc=0; out="$(P -q -f "$TMPD/x1.sql" 2>&1)" || rc=$?
if [[ $out == *"PRE FALHOU: o corpo vivo de $SIG_ANTIGA"* ]]; then V_X1="ABORTOU"
elif [ "$rc" -eq 0 ]; then V_X1="APLICOU"
else V_X1="OUTRO: $(printf '%s' "$out" | grep -m1 -E 'ERRO|ERROR' || true)"; fi
eq X1 "deriva no corpo antigo: a PRE aborta (nada apagado em silêncio)" "$V_X1" "ABORTOU"

nascimento() {   # <id> <descrição> <sql antes da migration>
  local id="$1" descr="$2" antes="$3" rc=0 out v
  { echo "BEGIN;"; echo "DROP FUNCTION $SIG_ANTIGA;"; printf '%s\n' "$antes"; cat "$MIG_X3"
    echo "SELECT 'auth=' || has_function_privilege('authenticated', '$SIG_NOVA', 'EXECUTE')::text || ' anon=' || has_function_privilege('anon', '$SIG_NOVA', 'EXECUTE')::text;"
    echo "ROLLBACK;"; } > "$TMPD/$id.sql"
  out="$(P -q -tA -f "$TMPD/$id.sql" 2>&1)" || rc=$?
  if [[ $out == *"POS6 FALHOU"* ]]; then v="ABORTOU:POS6"
  elif [ "$rc" -eq 0 ]; then v="$(printf '%s\n' "$out" | grep -m1 '^auth=' || true)"
  else v="OUTRO: $(printf '%s' "$out" | grep -m1 -E 'ERRO|ERROR' || true)"; fi
  eq "$id" "$descr" "$v" "auth=true anon=false"
}
nascimento X3 "função ausente nasce com a porta PORTA_GATE (sem default ACL)" ""
nascimento X3s "função ausente nasce com a porta PORTA_GATE (com o default ACL do Supabase)" \
  "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;"

# O APPLY de verdade: a migration inteira, numa transação, como o db:aplicar.
rc=0; out="$(P -1 -q -f "$MIG_NOVA" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ] || [[ $out != *"POS OK: converter na assinatura nova"* ]]; then
  echo "❌ INFRA: a migration real não aplicou com POS OK"; printf '%s\n' "$out" | tail -5; exit 1
fi
echo "→ migration aplicada (POS OK)"
rc=0; out="$(P -1 -q -f "$MIG_X2" 2>&1)" || rc=$?
if [ "$rc" -eq 0 ] && [[ $out == *"POS OK"* ]]; then V_X2="OK"
elif [[ $out == *"PRE FALHOU"* ]]; then V_X2="ABORTOU"
else V_X2="OUTRO: $(printf '%s' "$out" | grep -m1 -E 'ERRO|ERROR' || true)"; fi
eq X2 "re-aplicar a migration sobre ela mesma é seguro" "$V_X2" "OK"

# ── SABOTAGEM de CORPO (só no modo --falsificar) — no BANCO, recriando a função a partir do bloco
# da migration com UMA troca de contagem exata; o ACL fica (CREATE OR REPLACE o preserva) ──
extrair "$MIG_NOVA" "CREATE OR REPLACE FUNCTION public.converter_sugestao_em_campanha_flat(" "$TMPD/bloco.sql"
sabotar_corpo() {   # <de> <para> <n> [...]
  trocar "$TMPD/bloco.sql" "$TMPD/sab.sql" "$@" || { echo "❌ SABOTAGEM NAO APLICAVEL ($SABOTAGEM)"; exit 9; }
  P -q -f "$TMPD/sab.sql"
  echo "→ SABOTAGEM ativa: $SABOTAGEM"
}
HOJE="(now() AT TIME ZONE 'America/Sao_Paulo')::date"
case "$SABOTAGEM" in
  current_date_de_volta) sabotar_corpo "$HOJE" "now()::date" 1 ;;   # a DEFINIÇÃO de current_date, pelo relógio
  current_date_literal)  sabotar_corpo "$HOJE" "CURRENT_DATE" 1 ;;
  hoje_em_utc)           sabotar_corpo "$HOJE" "(now() AT TIME ZONE 'UTC')::date" 1 ;;
  codigo_cru)            sabotar_corpo "nullif(btrim(p_sku_codigo_fornecedor), '')" "nullif(p_sku_codigo_fornecedor, '')" 1 ;;
  qualidade_errada)      sabotar_corpo "'manual_confirmado', p_desconto_perc" "'unico', p_desconto_perc" 1 ;;
  item_sem_sku)          sabotar_corpo "v_sugestao.sku_codigo_omie::bigint," "NULL::bigint," 1 ;;
  nao_confirmado)        sabotar_corpo "p_desconto_perc, true, true," "p_desconto_perc, false, true," 1 ;;
  sem_guard_reconversao) sabotar_corpo "IF v_sugestao.campanha_id_gerada IS NOT NULL THEN" "IF false THEN" 1 ;;
  gate_staff_aberto)     sabotar_corpo "RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';" "NULL;" 1 ;;
  sem_guard_codigo)      sabotar_corpo "IF v_codigo IS NULL THEN" "IF false THEN" 1 ;;
  sem_guard_data_fim)    sabotar_corpo "IF p_data_fim IS NULL OR p_data_fim < v_hoje THEN" "IF false THEN" 1 ;;
  sugestao_nao_fechada)  sabotar_corpo "SET status = 'fechada_desconto'" "SET status = 'acao_tomada'" 1 ;;
  corte_um_mes)          sabotar_corpo "interval '2 months - 1 day'" "interval '1 month - 1 day'" 1 ;;
  acl_anon_aberta)       P -q -c "GRANT EXECUTE ON FUNCTION $SIG_NOVA TO anon;"; echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;
  relogio_desligado)     echo "→ SABOTAGEM ativa: $SABOTAGEM" ;;   # aplicada adiante: o pin não é feito
  ''|pre_cega|pre_sem_reaplicacao|sem_grant_authenticated|revoke_sem_anon) ;;
  *) echo "❌ SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac

eq O1 "a assinatura antiga (quebrada) saiu, a nova está no ar" \
  "$(Pq -c "SELECT 'antiga=' || (to_regprocedure('$SIG_ANTIGA') IS NOT NULL)::text || ' nova=' || (to_regprocedure('$SIG_NOVA') IS NOT NULL)::text;" 2>&1 || true)" \
  "antiga=false nova=true"
eq A1 "porta: anon e PUBLIC fechados, authenticated e service_role abertos" \
  "$(Pq -c "SELECT 'anon=' || has_function_privilege('anon', '$SIG_NOVA', 'EXECUTE')::text || ' public=' || has_function_privilege('public', '$SIG_NOVA', 'EXECUTE')::text
              || ' authenticated=' || has_function_privilege('authenticated', '$SIG_NOVA', 'EXECUTE')::text || ' service_role=' || has_function_privilege('service_role', '$SIG_NOVA', 'EXECUTE')::text;" 2>&1 || true)" \
  "anon=false public=false authenticated=true service_role=true"

# ══════════════════════════════════════════════════════════════════════════════
# RELÓGIO CONTROLADO — `public.now()` lê a GUC `test.agora` e é um TRIPWIRE: sem ela, levanta
# exceção com SQLSTATE PRÓPRIO (Z9T01). SÓ o converter ganha `pg_catalog` DEPOIS de `public` no
# search_path. Toda conexão nova nasce em 10/03/2025 15:00Z (12:00 BRT: a data é a mesma nos dois
# fusos); o bloco B troca o instante na própria sessão.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE plpgsql STABLE AS $f$
DECLARE v text := nullif(pg_catalog.current_setting('test.agora', true), '');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'TRIPWIRE: now() lido sem test.agora — a prova escapou do relógio controlado'
      USING ERRCODE = 'Z9T01';
  END IF;
  RETURN v::timestamptz;
END $f$;
SQL
if [ "$SABOTAGEM" != relogio_desligado ]; then
  P -q -c "ALTER FUNCTION $SIG_NOVA SET search_path = public, pg_catalog, pg_temp;"
fi
P -q -c "ALTER DATABASE prove SET test.agora = '2025-03-10 15:00:00+00';"
# `public` antes de `pg_catalog` não troca só o now(): TODA função de `public` com a MESMA assinatura
# de um embutido passaria a vencê-lo. A guarda exige que o ÚNICO nome de `public` que sombreia
# `pg_catalog` seja o nosso now(). Controle POSITIVO: se não vê nem esse, está cega e aborta.
sombra="$(Pq -c "SELECT COALESCE(string_agg(s.proname, ',') FILTER (WHERE s.proname = 'now'), '') || '|' ||
    COALESCE(string_agg(s.proname, ',' ORDER BY s.proname) FILTER (WHERE s.proname <> 'now'), '')
  FROM (SELECT DISTINCT p.proname FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND EXISTS (SELECT 1 FROM pg_proc c WHERE c.pronamespace = 'pg_catalog'::regnamespace
                        AND c.proname = p.proname AND c.proargtypes = p.proargtypes)) s;")"
case "$sombra" in
  'now|') echo "guarda de sombra: só now() sombreia pg_catalog (controle positivo visto)" ;;
  now\|*) echo "❌ o relógio controlado mudaria mais que o now(): public sombreia [${sombra#*|}]"; exit 1 ;;
  *) echo "❌ guarda cega: não enxergou nem o public.now() que acabou de ser criado [$sombra]"; exit 1 ;;
esac

# o token do acerto não diz TRIPWIRE: o eq() lê essa palavra como vazamento do relógio (ERRO_DE_EXECUCAO)
eq R0 "sem test.agora o converter bate no tripwire (Z9T01): o dia vem do relógio controlado" \
  "$(Pq -c "SELECT public.t_r0(30);" 2>&1 || true)" "RELOGIO_CONTROLADO"

# ══════════════════════════════════════════════════════════════════════════════
# P — A CONVERSÃO, em 10/03/2025 12:00 BRT, com o código digitado com espaços nas pontas.
# ══════════════════════════════════════════════════════════════════════════════
echo "── conversão ──"
ID_P="$(Pq -c "SELECT public.t_conv('$STAFF', 10, 8.5, 20, 'unidades', '2025-03-31', '  FO5.6717.00GL  ', 'Andre', 'whatsapp', 'obs P');" 2>&1 || true)"
case "$ID_P" in
  ''|*[!0-9]*) V_P1="$ID_P"; V_P2="SEM_ITEM"; ID_SQL="NULL" ;;
  *) ID_SQL="$ID_P"
     V_P1="$(Pq -c "SELECT concat_ws('|', tipo_origem, estado, fornecedor_nome, nome, status_aceite, permite_pedido_oportunidade::text,
                      volume_minimo_condicional::text, volume_minimo_unidade, data_inicio::text, data_fim::text, data_corte_pedido::text,
                      data_corte_faturamento::text, data_oferta::text, responsavel_oferta_nome, canal_oferta, observacoes_negociacao)
                    FROM promocao_campanha WHERE id = $ID_P;" 2>&1 || true)"
     V_P2="$(Pq -c "SELECT (SELECT count(*) FROM promocao_item WHERE campanha_id = $ID_P)::text || '|' || coalesce((
                      SELECT concat_ws('|', sku_codigo_fornecedor, descricao_produto_fornecedor, sku_codigo_omie::text, mapeamento_qualidade,
                             desconto_perc::text, confirmado::text, ativo::text, coalesce(volume_minimo::text, '-'),
                             (observacoes LIKE 'Convertido da sugest%paralela #10')::text)
                        FROM promocao_item WHERE campanha_id = $ID_P LIMIT 1), 'SEM_ITEM');" 2>&1 || true)" ;;
esac
eq P1 "a campanha flat: tipo, estado, fornecedor, aceite, datas do dia de SP, corte de faturamento, oferta" "$V_P1" \
  "desconto_flat_condicional|negociando|RENNER SAYERLACK S/A|Desconto Flat Condicional - 8689723039|aceita|false|20|unidades|2025-03-10|2025-03-31|2025-03-31|2025-04-30|2025-03-10|Andre|whatsapp|obs P"
# A descrição do SKU no item é o que ESTA migration (20261001083000) gravava — histórico, não o
# desejado: a 20261010224755 passa a gravar NULL (prova: db/test-promocao-descricao-fornecedor.sh).
eq P2 "o item: código aparado, descrição, SKU bigint, manual_confirmado, desconto, confirmado, sem volume" "$V_P2" \
  "1|FO5.6717.00GL|VERNIZ PU FOSCO FO5.6717.00GL|8689723039|manual_confirmado|8.5|true|true|-|true"
eq P3 "a sugestão fechada: status, link para a campanha, instante da ação, observação" \
  "$(Pq -c "SELECT concat_ws('|', status, (campanha_id_gerada IS NOT DISTINCT FROM $ID_SQL AND campanha_id_gerada IS NOT NULL)::text,
                   (data_acao = '2025-03-10 15:00:00+00'::timestamptz)::text, observacoes)
              FROM sugestao_negociacao_paralela WHERE id = 10;" 2>&1 || true)" \
  "fechada_desconto|true|true|obs P"

# ══════════════════════════════════════════════════════════════════════════════
# N — OS PORTÕES. Data fim longe (2999) para que só o N4 dependa do dia; cada recusa tem a
# SQLSTATE e a marca esperadas (o resto relança). NZ: nada gravado além da 1ª conversão do N6.
# ══════════════════════════════════════════════════════════════════════════════
echo "── portões ──"
MAX_ANTES_N="$(Pq -c "SELECT coalesce(max(id), 0) FROM promocao_campanha;")"
tenta() { Pq -c "SELECT public.t_tenta($1, $2, DATE '$3', '$4', '$5', '$6');" 2>&1 || true; }   # <uid> <sug> <fim> <cod> <sqlstate> <marca>
eq N1 "cliente (não staff) é barrado" "$(tenta "'$CLIENTE'" 21 2999-12-31 FO5.6717.00GL 42501 'requer perfil staff')" "BARRADO"
eq N2 "anônimo é barrado" "$(tenta NULL 22 2999-12-31 FO5.6717.00GL 42501 'requer perfil staff')" "BARRADO"
eq N3 "código Sayerlack em branco é recusado" "$(tenta "'$STAFF'" 23 2999-12-31 '   ' 22023 'Sayerlack do produto')" "BARRADO"
eq N4 "data fim no passado (ontem, no dia de SP) é recusada" "$(tenta "'$STAFF'" 24 2025-03-09 FO5.6717.00GL 22023 'anterior a hoje')" "BARRADO"
eq N5 "SKU da sugestão não numérico é recusado" "$(tenta "'$STAFF'" 25 2999-12-31 FO5.6717.00GL 22023 'Omie num')" "BARRADO"
tenta "'$STAFF'" 26 2999-12-31 FO5.6717.00GL XXXXX '-' >/dev/null   # a 1ª conversão do N6 (vale)
eq N6 "a mesma sugestão não converte duas vezes" "$(tenta "'$STAFF'" 26 2999-12-31 FO5.6717.00GL P0001 'foi convertida')" "BARRADO"
eq N7 "sugestão inexistente é recusada" "$(tenta "'$STAFF'" 999 2999-12-31 FO5.6717.00GL P0001 'encontrada')" "BARRADO"
eq NZ "os portões não gravaram campanha (só a 1ª conversão do N6)" \
  "$(Pq -c "SELECT count(*) FROM promocao_campanha WHERE id > $MAX_ANTES_N;" 2>&1 || true)" "1"

# ══════════════════════════════════════════════════════════════════════════════
# BLOCO B — A BORDA DO DIA DE SP, cruzada de propósito, uma conexão por sessão: D = 28/02/2025.
# Em cada instante, converte com data fim = o hoje de SP (o "último dia" que o CURRENT_DATE da
# sessão UTC recusava das 21h às 24h BRT). B0 é o controle do próprio relógio.
# ══════════════════════════════════════════════════════════════════════════════
echo "── borda do dia de SP ──"
INST=("2025-02-28 23:59:59+00" "2025-03-01 00:00:00+00" "2025-03-01 02:59:59+00" "2025-03-01 03:00:00+00")
DIAS=("2025-02-28" "2025-02-28" "2025-02-28" "2025-03-01")
ESPERADO_B="2025-02-28/2025-02-28;2025-02-28/2025-02-28;2025-02-28/2025-02-28;2025-03-01/2025-03-01"
b0_sql=""; for i in 0 1 2 3; do b0_sql+="SET test.agora = '${INST[$i]}'; SELECT (public.now() AT TIME ZONE 'America/Sao_Paulo')::date;"$'\n'; done
eq B0 "controle do relógio: os 4 instantes caem em D, D, D e D+1 em SP" \
  "$(Pq <<<"$b0_sql" 2>&1 | paste -sd ';' - || true)" "2025-02-28;2025-02-28;2025-02-28;2025-03-01"
borda() {   # <TimeZone da sessão> <base dos ids de sugestão>
  local sql="SET TimeZone = '$1';"$'\n' i
  for i in 0 1 2 3; do sql+="SET test.agora = '${INST[$i]}'; SELECT public.t_borda($(( $2 + i + 1 )), '${DIAS[$i]}');"$'\n'; done
  Pq <<<"$sql" 2>&1 | paste -sd ';' - || true
}
eq BU "sessão UTC (a da prod): datas do dia de SP, e a data fim = hoje converte até 23:59 BRT" "$(borda UTC 40)" "$ESPERADO_B"
eq BS "sessão America/Sao_Paulo: o mesmo" "$(borda America/Sao_Paulo 50)" "$ESPERADO_B"

# ══════════════════════════════════════════════════════════════════════════════
# W — o converter com o search_path de PROD (sem o relógio controlado), chamado como authenticated
# (a porta do PostgREST), no relógio de verdade: converte, e a data de início é o dia de SP.
# ══════════════════════════════════════════════════════════════════════════════
P -q -c "ALTER FUNCTION $SIG_NOVA SET search_path = public;"
[ "$(Pq -c "SELECT array_to_string(proconfig, ';') FROM pg_proc WHERE oid = to_regprocedure('$SIG_NOVA');")" = "search_path=public" ] \
  || { echo "❌ INFRA: o proconfig não voltou ao de prod — o W mediria outra função"; exit 1; }
V_W="$(Pq 2>&1 <<SQL || true
SET test.uid = '$STAFF'; SET ROLE authenticated;
SELECT public.converter_sugestao_em_campanha_flat(60, 8, 10, 'unidades', (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date + 30, 'FO5.6717.00GL') AS id \gset
RESET ROLE;
SELECT CASE WHEN data_inicio = (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date THEN 'OK' ELSE 'DIA:' || data_inicio END
  FROM promocao_campanha WHERE id = :id;
SQL
)"
eq W "como authenticated, no relógio real e com o search_path de prod: converte no dia de SP" "$V_W" "OK"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
if [ $((PASS + FAIL)) -ne "$TOTAL_ESPERADO" ]; then
  echo "❌ HARNESS INCOMPLETO: rodaram $((PASS + FAIL)) asserts, esperado $TOTAL_ESPERADO"
  exit 1
fi
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
