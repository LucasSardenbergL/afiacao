#!/usr/bin/env bash
# roda-nucleo-ci.sh — executa o núcleo de provas SQL de `db/nucleo-ci.txt`.
# =====================================================================================
#   bash db/roda-nucleo-ci.sh                 # roda o núcleo
#   bash db/roda-nucleo-ci.sh --lista         # só imprime o que rodaria
#   NUCLEO_PARTE=i/N NUCLEO_RECIBO=arq bash db/roda-nucleo-ci.sh   # a parte i (0 ≤ i < N) e o recibo dela
#   bash db/roda-nucleo-ci.sh --uniao dir/    # confere os recibos parte-*.txt das N partes (sem Postgres)
#   PGH_MIN_VERSION_NUM=170006 bash db/...    # piso da versão do servidor
#
# ## Recibo e UNIÃO das partes (2026-10-01)
#
# Em N partes paralelas, a parte que NÃO roda não reprova nada: o step dela pulado (um `if:` novo,
# uma condição que mudou de tipo) sai verde, e a matriz agrega `success`. A partição está provada no
# harness, mas a EXECUÇÃO de cada run não estava. Com `NUCLEO_RECIBO`, a parte grava — só depois do
# próprio conjunto conferido — o sha256 do manifesto, `parte i/N` e cada unidade (arquivo, modo)
# concluída. O `--uniao` refaz a partição sobre o manifesto INTEIRO e exige: N recibos, as partes
# 0..N-1 uma vez cada, o mesmo manifesto em todos, e cada unidade concluída exatamente uma vez e na
# parte que a partição lhe dá. Unidade sem recibo reprova, como no serial; linha que o recibo não
# prevê também — nada é ignorado.
#
# ## O que este runner existe para impedir
#
# Um gate que executa SQL falha de um jeito específico: fica VERDE sem ter provado
# nada. As formas medidas/apontadas (parecer Codex, 2026-09-07):
#
#   · lista vazia ou glob sem correspondência — `set -euo pipefail` NÃO reprova um
#     laço que rodou zero vezes;
#   · PostgreSQL ausente virando skip silencioso — a assinatura de `ausente ≠ zero`
#     aplicada ao CI: banco que não existe aprovaria TUDO;
#   · prova esvaziada. O fechamento das provas é `[ "$FAIL" -eq 0 ]`, que **também
#     aceita PASS=0** — um script truncado sai 0. Por isso cada linha do manifesto
#     carrega o mínimo de asserts que aquela prova precisa ter EXECUTADO;
#   · filho paralelo que falha com o pai aprovando. Medido pelo Codex no bash:
#     `(exit 7) & wait` devolve **0**. Aqui o padrão é SERIAL, e o status de cada
#     prova é conferido na hora — sem `&` e sem `wait` sem argumento.
#
# Toda conferência é POSITIVA: nada é aprovado por ausência de sinal.
#
# ## Isolamento
#
# Cada prova sobe o seu próprio cluster (`initdb` + `pg_ctl`) — este runner só lhe
# entrega uma porta distinta via `PGPORT_TEST` e a executa. Serial é uma decisão:
# 70 das 289 provas trazem porta fixa sem override, e o isolamento por porta é
# frágil por desenho. Paralelizar exige antes migrar as provas para socket em
# diretório exclusivo por execução com `listen_addresses=''` — aí a porta deixa de
# ser recurso disputado. Enquanto isso não existe, o núcleo custa ~15s: serial paga.
#
# ## Falsificação no caminho obrigatório (3º campo do manifesto)
#
# Uma prova do núcleo pode ter modo `--falsificar` (sabota o alvo e EXIGE vermelho).
# Até 2026-09-10 nenhum rodava aqui: o runner só conhecia o modo normal, e as 17
# sabotagens da canária viviam fora do CI — ausência de dado, pelo critério do repo
# (docs/historico/falsificacao-da-canaria-no-caminho-obrigatorio.md). O 3º campo diz
# o que fazer com o modo, e é OBRIGATÓRIO quando ele existe:
#
#   falsificar=<n>           roda `--falsificar` aqui e exige o recibo
#                            `SABOTAGENS: <v> vermelhas / <f> falhas`, exatamente um,
#                            com f = 0 e v ≥ n (mesma lógica do mínimo de asserts:
#                            encolher reprova até alguém baixar o n no diff);
#   falsificar=fora-do-ci    exceção DECLARADA, com o motivo em comentário NA MESMA
#                            linha. Impressa em toda execução: fora do CI é ausência de
#                            dado, e o log diz isso em vez de calar.
#
# O recibo é exclusivo do modo: o normal nunca o emite. Sem isso, um `--falsificar`
# que a prova deixasse de reconhecer rodaria o modo NORMAL, sairia 0 e passaria.
#
# O detector de "tem modo" é TEXTO CRU (`--falsificar` em qualquer lugar do arquivo),
# e é ALARME, não prova: shell arbitrário escapa de qualquer leitura textual (flag
# montada por concatenação, delegação por `source`). Ele pega a forma CONVENCIONAL, e
# a declaração no manifesto é o cadastro. Cru e não "sem comentários" de propósito: o
# erro que ele comete é o falso positivo, que é barulhento e se resolve declarando.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFESTO="${MANIFESTO:-$REPO_ROOT/db/nucleo-ci.txt}"
PORTA_BASE="${PORTA_BASE:-5810}"
# Piso da versão do servidor. 170006 = 17.6, que é o que PRODUÇÃO roda (medido via
# psql-ro em 2026-09-07). Testar contra um servidor MAIS VELHO que prod provaria
# algo sobre um Postgres que ninguém usa.
PGH_MIN_VERSION_NUM="${PGH_MIN_VERSION_NUM:-170006}"

# Argumentos ESTRITOS: até 2026-10-01 só o 1º era lido e qualquer outro era ignorado — com o
# `--uniao` no mundo, um erro de digitação rodaria o núcleo inteiro no job que nem sobe banco.
uso() {
  echo "::error::$1"
  echo "  uso: bash db/roda-nucleo-ci.sh [--lista] | [--uniao <dir>]  (a parte vem de NUCLEO_PARTE/NUCLEO_RECIBO)"
  exit 1
}
so_lista=0; dir_uniao=""
while [ $# -gt 0 ]; do
  case "$1" in
    --lista) so_lista=1 ;;
    --uniao) [ $# -ge 2 ] || uso "--uniao sem diretório"; dir_uniao="$2"; shift ;;
    *) uso "argumento desconhecido '$1'" ;;
  esac
  shift
done
if [ -n "$dir_uniao" ] && { [ "$so_lista" -eq 1 ] || [ -n "${NUCLEO_PARTE:-}" ]; }; then
  uso "--uniao confere TODAS as partes: não se combina com --lista nem com NUCLEO_PARTE"
fi
if [ -n "${NUCLEO_RECIBO:-}" ] && [ -z "${NUCLEO_PARTE:-}" ]; then
  uso "NUCLEO_RECIBO só vale com NUCLEO_PARTE — o recibo é de uma parte, e a execução inteira não é parte nenhuma"
fi

# sha256 do manifesto: o recibo da parte leva o do manifesto que ELA leu, e a união exige o mesmo.
# Erro no stderr: aqui dentro o stdout é o valor capturado pelo chamador.
sha_manifesto() {
  local s
  if command -v sha256sum > /dev/null 2>&1; then s="$(sha256sum "$MANIFESTO")"; else s="$(shasum -a 256 "$MANIFESTO")"; fi
  s="${s%% *}"
  if ! printf '%s' "$s" | grep -qE '^[0-9a-f]{64}$'; then
    echo "::error::não consegui calcular o sha256 do manifesto (veio '$s')" >&2; exit 1
  fi
  printf '%s' "$s"
}

# ── 1. Manifesto ────────────────────────────────────────────────────────────────
[ -f "$MANIFESTO" ] || { echo "::error::manifesto ausente: $MANIFESTO"; exit 1; }

scripts=(); minimos=(); falsifs=(); motivos_fora=()
linha_n=0
while IFS= read -r linha || [ -n "$linha" ]; do
  linha_n=$((linha_n + 1))
  linha="$(printf '%s' "$linha" | tr -d '\r')"
  # O comentário da linha é lido ANTES de ser descartado: é nele que mora o motivo de uma
  # exceção `falsificar=fora-do-ci`, e o runner o imprime em toda execução.
  comentario=""
  case "$linha" in *'#'*) comentario="${linha#*#}" ;; esac
  linha="${linha%%#*}"                              # tira comentário de fim de linha
  # shellcheck disable=SC2001  # a substituição precisa de classe POSIX nas duas pontas
  linha="$(printf '%s' "$linha" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [ -z "$linha" ] && continue

  caminho="$(printf '%s' "$linha" | awk '{print $1}')"
  minimo="$(printf '%s' "$linha" | awk '{print $2}')"
  campo3="$(printf '%s' "$linha" | awk '{print $3}')"
  sobra="$(printf '%s' "$linha" | awk '{print $4}')"

  if ! printf '%s' "$minimo" | grep -qE '^[0-9]+$'; then
    echo "::error::$MANIFESTO:$linha_n — falta o mínimo de asserts (formato: <caminho> <n>): $linha"; exit 1
  fi
  if [ -n "$sobra" ]; then
    echo "::error::$MANIFESTO:$linha_n — campo a mais ('$sobra'). Formato: <caminho> <n> [falsificar=<n>|falsificar=fora-do-ci]"; exit 1
  fi
  # Parse ESTRITO: um erro de digitação (`falsifcar=17`, `falsificar=`, `falsificar=0`) não pode
  # DESLIGAR a falsificação em silêncio — que é o jeito de um gate morrer sem ninguém ver.
  case "$campo3" in
    '')                    falsif="" ;;
    falsificar=fora-do-ci) falsif="fora" ;;
    falsificar=[1-9]|falsificar=[1-9][0-9]|falsificar=[1-9][0-9][0-9]) falsif="${campo3#falsificar=}" ;;
    *) echo "::error::$MANIFESTO:$linha_n — 3º campo inválido '$campo3': esperado falsificar=<1..999> ou falsificar=fora-do-ci"; exit 1 ;;
  esac
  motivo_fora="$(printf '%s' "$comentario" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [ "$falsif" = "fora" ] && [ -z "$motivo_fora" ]; then
    echo "::error::$MANIFESTO:$linha_n — falsificar=fora-do-ci sem o MOTIVO em comentário na mesma linha: exceção sem porquê vira álibi"; exit 1
  fi
  if [ "$minimo" -lt 1 ]; then
    echo "::error::$MANIFESTO:$linha_n — mínimo de asserts precisa ser ≥1 (0 aprovaria uma prova vazia)"; exit 1
  fi
  if [ ! -f "$REPO_ROOT/$caminho" ]; then
    echo "::error::$MANIFESTO:$linha_n — arquivo não existe: $caminho (arquivo ausente ABORTA, nunca é filtrado)"; exit 1
  fi
  for ja in ${scripts[@]+"${scripts[@]}"}; do
    [ "$ja" = "$caminho" ] && { echo "::error::$MANIFESTO:$linha_n — duplicata: $caminho"; exit 1; }
  done

  # Construções BSD-only: o núcleo nasceu no macOS e roda no Ubuntu. `sed -i '' "expr" arq`
  # é o caso medido (2026-09-07, 1ª execução deste job): no GNU o `''` vira o SCRIPT e a
  # expressão vira NOME DE ARQUIVO — "sed: can't read s/...". A prova passa no laptop e
  # reprova no CI, e o round-trip para descobrir isso custa ~13min. Barrar aqui é barato.
  # A forma portável é `sed "expr" arq > arq.tmp && mv arq.tmp arq`.
  if grep -qE "sed -i ''" "$REPO_ROOT/$caminho"; then
    echo "::error::$caminho usa \`sed -i ''\` (BSD-only) — quebra no Linux do CI."
    echo "         portável: sed \"expr\" arq > arq.tmp && mv arq.tmp arq"
    exit 1
  fi

  # Cobertura do modo `--falsificar` (ver o cabeçalho): quem TEM o modo declara o que faz com ele,
  # e quem declara TEM o modo. A 2ª metade pega a exceção que apodreceu e a flag passada a uma
  # prova que a ignoraria. `grep` com 3 desfechos: 2 (não li) é erro, nunca "não tem modo".
  if grep -qF -e '--falsificar' "$REPO_ROOT/$caminho"; then
    tem_modo=1
  else
    rc_grep=$?
    [ "$rc_grep" -eq 1 ] || { echo "::error::$caminho — não consegui ler o arquivo para procurar o modo --falsificar (grep saiu $rc_grep)"; exit 1; }
    tem_modo=0
  fi
  if [ "$tem_modo" -eq 1 ] && [ -z "$falsif" ]; then
    echo "::error::$MANIFESTO:$linha_n — $caminho tem modo --falsificar e a linha não diz o que fazer com ele."
    echo "         declare falsificar=<n> (roda aqui, exige ≥n sabotagens vermelhas) ou"
    echo "         falsificar=fora-do-ci com o motivo em comentário na mesma linha."
    exit 1
  fi
  if [ "$tem_modo" -eq 0 ] && [ -n "$falsif" ]; then
    echo "::error::$MANIFESTO:$linha_n — declara '$campo3', mas $caminho não tem modo --falsificar: a flag seria ignorada e o modo NORMAL rodaria no lugar"
    exit 1
  fi
  scripts+=("$caminho"); minimos+=("$minimo"); falsifs+=("$falsif"); motivos_fora+=("$motivo_fora")
done < "$MANIFESTO"

esperados=${#scripts[@]}
# Guard do DENOMINADOR — sem ele um manifesto vazio (ou um parser quebrado) sairia
# 0 sem executar nada, e o gate aprovaria por AUSÊNCIA de dado.
if [ "$esperados" -lt 1 ]; then
  echo "::error::manifesto sem nenhuma prova — um gate que não executa nada não pode afirmar nada"; exit 1
fi

# ── 1a. A UNIÃO dos recibos das partes (sem Postgres; o manifesto INTEIRO) ─────────────────────
# O job que junta as partes não sobe banco: confere que o CONJUNTO das unidades concluídas é o do
# manifesto, pela mesma partição da 1b (prova de posição k → parte k mod N). Regras no cabeçalho
# (§Recibo e UNIÃO); cada uma tem caso no db/falsifica-nucleo-ci.sh.
if [ -n "$dir_uniao" ]; then
  [ -d "$dir_uniao" ] || { echo "::error::diretório de recibos não existe: $dir_uniao"; exit 1; }
  sha="$(sha_manifesto)"
  id_cam=(); id_modo=(); id_k=(); n_falsif_u=0; n_fora_u=0
  for k in "${!scripts[@]}"; do
    id_cam+=("${scripts[$k]}"); id_modo+=(normal); id_k+=("$k")
    case "${falsifs[$k]}" in
      '') ;;
      fora) n_fora_u=$((n_fora_u + 1)) ;;
      *) id_cam+=("${scripts[$k]}"); id_modo+=(falsificar); id_k+=("$k"); n_falsif_u=$((n_falsif_u + 1)) ;;
    esac
  done
  recibos=()
  while IFS= read -r f; do recibos+=("$f"); done < <(find "$dir_uniao" -maxdepth 1 -type f -name 'parte-*.txt' | LC_ALL=C sort)
  if [ ${#recibos[@]} -lt 1 ]; then
    echo "::error::nenhum recibo parte-*.txt em $dir_uniao — união vazia não prova nada"; exit 1
  fi

  # 1ª passada: o FORMATO de cada recibo e o N. Sem N não há partição contra a qual conferir.
  n_uniao=""; rec_parte=()
  for f in "${recibos[@]}"; do
    n_l=0; n_sha=0; n_par=0; n_fim=0; n_un=0; fim_n=""; ultima=""; r_i=""
    while IFS= read -r l || [ -n "$l" ]; do
      n_l=$((n_l + 1)); ultima="$l"
      if [ "$n_l" -eq 1 ]; then
        [ "$l" = NUCLEO_RECIBO_V1 ] || { echo "::error::$f: 1ª linha '$l', esperava NUCLEO_RECIBO_V1"; exit 1; }
        continue
      fi
      case "$l" in
        'manifesto_sha256 '*)
          n_sha=$((n_sha + 1))
          if [ "${l#manifesto_sha256 }" != "$sha" ]; then
            echo "::error::$f: recibo de OUTRO manifesto (${l#manifesto_sha256 }) — este é $sha"; exit 1
          fi ;;
        'parte '*)
          n_par=$((n_par + 1)); v="${l#parte }"
          printf '%s' "$v" | grep -qE '^(0|[1-9][0-9]?)/[1-9][0-9]?$' || { echo "::error::$f: linha de parte malformada: '$l'"; exit 1; }
          r_i="${v%/*}"; r_n="${v#*/}"
          if [ -z "$n_uniao" ]; then n_uniao="$r_n"; fi
          if [ "$r_n" -ne "$n_uniao" ]; then echo "::error::$f: parte $v, mas outro recibo diz N=$n_uniao — partes de partições diferentes"; exit 1; fi
          if [ "$r_i" -ge "$r_n" ]; then echo "::error::$f: parte $v não existe (i ≥ N)"; exit 1; fi ;;
        'unidade '*) n_un=$((n_un + 1)) ;;
        'fim '*) n_fim=$((n_fim + 1)); fim_n="${l#fim }" ;;
        *) echo "::error::$f: linha não reconhecida no recibo: '$l'"; exit 1 ;;
      esac
    done < "$f"
    if [ "$n_sha" -ne 1 ] || [ "$n_par" -ne 1 ] || [ "$n_fim" -ne 1 ]; then
      echo "::error::$f: recibo exige UMA linha de cada (manifesto_sha256=$n_sha parte=$n_par fim=$n_fim)"; exit 1
    fi
    if [ "$ultima" != "fim $fim_n" ] || [ "$fim_n" != "$n_un" ]; then
      echo "::error::$f: recibo TRUNCADO ou adulterado — 'fim $fim_n' com $n_un unidade(s), e o fim tem de ser a última linha"; exit 1
    fi
    rec_parte+=("$r_i")
  done

  # As partes 0..N-1, uma vez cada. Duas vezes a mesma = recibo copiado; faltando = parte que não rodou.
  for ((i = 0; i < n_uniao; i++)); do
    vezes=0
    for a in "${rec_parte[@]}"; do if [ "$a" -eq "$i" ]; then vezes=$((vezes + 1)); fi; done
    if [ "$vezes" -eq 0 ]; then echo "::error::falta o recibo da parte $i/$n_uniao — parte que não rodou não reprova nada"; exit 1; fi
    if [ "$vezes" -gt 1 ]; then echo "::error::a parte $i/$n_uniao apareceu $vezes vezes"; exit 1; fi
  done

  # 2ª passada: cada unidade do recibo existe no manifesto, cai NESTA parte pela partição e não foi
  # vista antes. Depois, toda unidade do manifesto tem de ter sido vista — o conjunto, não a contagem.
  visto=()
  for j in "${!id_cam[@]}"; do visto[j]=0; done
  idx=0
  for f in "${recibos[@]}"; do
    r_i="${rec_parte[$idx]}"; idx=$((idx + 1))
    while IFS= read -r l || [ -n "$l" ]; do
      case "$l" in 'unidade '*) ;; *) continue ;; esac
      read -r _ u_cam u_modo u_sobra <<< "$l"
      if [ -n "${u_sobra:-}" ] || [ -z "${u_modo:-}" ]; then echo "::error::$f: unidade malformada: '$l'"; exit 1; fi
      achou=""
      for j in "${!id_cam[@]}"; do
        if [ "${id_cam[$j]}" = "$u_cam" ] && [ "${id_modo[$j]}" = "$u_modo" ]; then achou="$j"; break; fi
      done
      if [ -z "$achou" ]; then echo "::error::$f: unidade fora do manifesto: $u_cam $u_modo"; exit 1; fi
      if [ "${visto[achou]}" -ne 0 ]; then echo "::error::$f: unidade concluída DUAS vezes: $u_cam $u_modo"; exit 1; fi
      if [ $(( id_k[achou] % n_uniao )) -ne "$r_i" ]; then
        echo "::error::$f: $u_cam $u_modo está no recibo da parte $r_i, mas a partição a põe na $(( id_k[achou] % n_uniao )) — a parte rodou OUTRO conjunto"; exit 1
      fi
      visto[achou]=1
    done < "$f"
  done
  faltando=()
  for j in "${!id_cam[@]}"; do
    if [ "${visto[j]}" -eq 0 ]; then faltando+=("${id_cam[$j]} ${id_modo[$j]} (parte $(( id_k[j] % n_uniao )))"); fi
  done
  if [ ${#faltando[@]} -ne 0 ]; then
    echo "=================================================="
    for u in "${faltando[@]}"; do echo "  ❌ sem recibo de conclusão: $u"; done
    echo "PROVAS-SQL REPROVADO — ${#faltando[@]} unidade(s) do manifesto sem conclusão em parte nenhuma"
    exit 1
  fi
  # A exceção fora-do-ci é impressa aqui, onde o veredito é sobre o núcleo INTEIRO — nunca calada.
  for k in "${!scripts[@]}"; do
    if [ "${falsifs[$k]}" = fora ]; then
      printf '  ⚠️  %-44s --falsificar FORA DO CI — ausência de dado, não aprovação: %s\n' \
        "$(basename "${scripts[$k]}" .sh)" "${motivos_fora[$k]}"
    fi
  done
  echo "=================================================="
  echo "SQL_PROOF_OK uniao=$n_uniao/$n_uniao provas=$esperados/$esperados falsificacoes=$n_falsif_u/$n_falsif_u fora_do_ci=$n_fora_u unidades=${#id_cam[@]} manifesto_sha256=$sha"
  exit 0
fi

# ── 1b. A PARTE deste runner (NUCLEO_PARTE="i/N", 0 ≤ i < N) ─────────────────────────────────
# O job `provas-sql` roda em N partes paralelas (matriz do ci.yml): serial, o núcleo passou do teto de
# 20 min quando o #2685 entrou (runs 36799444473 e 36802018807, `main` vermelha) — e o ci.yml já dizia
# que a próxima prova a estourar pedia PARALELIZAR, não subir o teto de novo.
#   · Partição round-robin sobre a ordem do manifesto: a prova de posição k vai para a parte k mod N.
#     Nenhuma prova em duas partes e nenhuma fora de todas, DESDE QUE as N partes rodem — e quem diz
#     i e N é o próprio GitHub (`strategy.job-index`/`job-total`), contados pela matriz real: mexer na
#     lista da matriz não abre buraco nem repete parte.
#   · O manifesto INTEIRO já foi validado acima, em toda parte: linha podre reprova as N.
#   · Malformada ou fora da faixa ABORTA. Rodar tudo estouraria o teto em silêncio; rodar nada seria o
#     verde vazio. Parte sem prova nenhuma (N maior que o manifesto) também aborta.
#   · Sem NUCLEO_PARTE, roda o manifesto inteiro — é como o laptop e o harness usam o runner.
parte=""
if [ -n "${NUCLEO_PARTE:-}" ]; then
  if ! printf '%s' "$NUCLEO_PARTE" | grep -qE '^[0-9]{1,2}/[0-9]{1,2}$'; then
    echo "::error::NUCLEO_PARTE inválida: '$NUCLEO_PARTE' (formato i/N, com 0 ≤ i < N)"; exit 1
  fi
  p_i=$((10#${NUCLEO_PARTE%/*})); p_n=$((10#${NUCLEO_PARTE#*/}))
  if [ "$p_n" -lt 1 ] || [ "$p_i" -ge "$p_n" ]; then
    echo "::error::NUCLEO_PARTE inválida: '$NUCLEO_PARTE' (formato i/N, com 0 ≤ i < N)"; exit 1
  fi
  sel_s=(); sel_m=(); sel_f=(); sel_mf=()
  for k in "${!scripts[@]}"; do
    if [ $((k % p_n)) -eq "$p_i" ]; then
      sel_s+=("${scripts[$k]}"); sel_m+=("${minimos[$k]}"); sel_f+=("${falsifs[$k]}"); sel_mf+=("${motivos_fora[$k]}")
    fi
  done
  if [ "${#sel_s[@]}" -lt 1 ]; then
    echo "::error::NUCLEO_PARTE $NUCLEO_PARTE: parte sem nenhuma prova ($esperados no manifesto) — reduza N"; exit 1
  fi
  parte="parte $((p_i + 1)) de $p_n: ${#sel_s[@]} de $esperados provas"
  scripts=("${sel_s[@]}"); minimos=("${sel_m[@]}"); falsifs=("${sel_f[@]}"); motivos_fora=("${sel_mf[@]}")
  esperados=${#scripts[@]}
fi
# O sha do manifesto que ESTA parte leu, tomado agora — não no fim, depois de minutos de provas.
sha_parte=""
if [ -n "${NUCLEO_RECIBO:-}" ]; then sha_parte="$(sha_manifesto)"; fi

# Identidades que o recibo final exige: toda prova no modo normal, e cada `falsificar=<n>` como
# identidade PRÓPRIA — a canária verde no modo normal não vale como falsificação concluída.
n_falsif=0; n_fora=0
for f in ${falsifs[@]+"${falsifs[@]}"}; do
  case "$f" in '') ;; fora) n_fora=$((n_fora + 1)) ;; *) n_falsif=$((n_falsif + 1)) ;; esac
done

if [ "$so_lista" -eq 1 ]; then
  printf '%s\n' "manifesto=$MANIFESTO provas=$esperados falsificacoes=$n_falsif fora_do_ci=$n_fora${parte:+ ($parte)}"
  for i in "${!scripts[@]}"; do
    case "${falsifs[$i]}" in
      '')   extra="" ;;
      fora) extra="  --falsificar FORA DO CI (${motivos_fora[$i]})" ;;
      *)    extra="  --falsificar (sabotagens≥${falsifs[$i]})" ;;
    esac
    printf '  %s  (asserts≥%s)%s\n' "${scripts[$i]}" "${minimos[$i]}" "$extra"
  done
  exit 0
fi

# ── 2. Sonda POSITIVA do ambiente ───────────────────────────────────────────────
# Antes de rodar prova nenhuma: sobe um cluster de mentira e PERGUNTA a versão ao
# servidor. Sem isto, "PG ausente" e "todas as provas passaram" produzem o mesmo
# verde. `initdb --version` não bastaria: prova o binário, não que ele SOBE.
echo "=== sonda do ambiente ==="
# LC_ALL=C não é detalhe: sem locale válido o postmaster do macOS morre no start com
# "became multithreaded during startup". Toda prova do acervo já exporta isto; a sonda
# precisa do mesmo ambiente, ou reprova por motivo que não é o do teste.
export LC_ALL=C LANG=C
# Sobrescrevível para exercitar o fail-closed do helper com uma major que não existe
# (é assim que db/falsifica-nucleo-ci.sh prova que "Postgres ausente" REPROVA).
export PGVER="${PGVER:-17}"   # lido pelo pg-harness.sh abaixo (via source), não por um filho
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

SONDA_DIR="$(mktemp -d "/tmp/pgsonda-nucleo.XXXXXX")"
sonda_cleanup() {
  "$PGBIN/pg_ctl" -D "$SONDA_DIR/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$SONDA_DIR"
}
trap sonda_cleanup EXIT

"$PGBIN/initdb" -D "$SONDA_DIR/data" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$SONDA_DIR/data" -o "-p $PORTA_BASE -k $SONDA_DIR" \
  -l "$SONDA_DIR/pg.log" -w start >/dev/null
versao_num="$("$PGBIN/psql" -X -p "$PORTA_BASE" -h "$SONDA_DIR" -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -tA -c 'SHOW server_version_num')"
versao_txt="$("$PGBIN/psql" -X -p "$PORTA_BASE" -h "$SONDA_DIR" -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -tA -c 'SHOW server_version')"
sonda_cleanup; trap - EXIT

if ! printf '%s' "$versao_num" | grep -qE '^[0-9]+$'; then
  echo "::error::sonda não obteve server_version_num do servidor (veio: '$versao_num')"; exit 1
fi
if [ "$versao_num" -lt "$PGH_MIN_VERSION_NUM" ]; then
  echo "::error::servidor $versao_txt ($versao_num) é mais VELHO que o piso $PGH_MIN_VERSION_NUM (produção)"; exit 1
fi
echo "  servidor SUBIU e respondeu: $versao_txt (server_version_num=$versao_num, piso=$PGH_MIN_VERSION_NUM)"
echo "  PGBIN=$PGBIN"

# ── 3. Execução ─────────────────────────────────────────────────────────────────
LOGS="$(mktemp -d "/tmp/pgnucleo-logs.XXXXXX")"
concluidas=(); falhas=()
porta=$((PORTA_BASE + 1))

# executa <caminho> <modo: normal|falsificar> <mínimo> — roda a prova UMA vez no modo pedido e
# valida o recibo DAQUELE modo. Só com tudo batendo acrescenta "<caminho> <modo>" a `concluidas`:
# a identidade do recibo é o PAR (arquivo, modo).
executa() {
  local caminho="$1" modo="$2" minimo="$3" nome rotulo log inicio dur rc
  nome="$(basename "$caminho" .sh)"
  rotulo="$nome"; [ "$modo" = falsificar ] && rotulo="$nome --falsificar"
  log="$LOGS/$nome.$modo.log"
  porta=$((porta + 1))

  inicio=$(date +%s)
  # rc capturado ANTES de qualquer recorte da saída: `| tail` devolveria o status
  # do tail e o veredito do trabalho se perderia.
  if [ "$modo" = falsificar ]; then
    PGPORT_TEST="$porta" bash "$REPO_ROOT/$caminho" --falsificar > "$log" 2>&1 && rc=0 || rc=$?
  else
    PGPORT_TEST="$porta" bash "$REPO_ROOT/$caminho" > "$log" 2>&1 && rc=0 || rc=$?
  fi
  dur=$(( $(date +%s) - inicio ))

  if [ "$rc" -ne 0 ]; then
    falhas+=("$rotulo: exit $rc")
    printf '  ❌ %-44s exit=%s (%ss)\n' "$rotulo" "$rc" "$dur"
    echo "     ── últimas linhas ──"
    tail -12 "$log" | sed 's/^/     /'
    return 0
  fi

  if [ "$modo" = falsificar ]; then
    # EXATAMENTE um recibo, e bem-formado. `tail -1` (o idioma do modo normal) aceitaria dois
    # recibos contraditórios lendo só o último; e uma linha `SABOTAGENS:` fora do formato é
    # prova de que o emissor mudou sem o runner saber — erro, não "sem recibo".
    local n_linhas n_validas recibo n_verm n_falh
    n_linhas="$(grep -c '^SABOTAGENS:' "$log" || true)"
    n_validas="$(grep -cE '^SABOTAGENS: [0-9]{1,4} vermelhas / [0-9]{1,4} falhas$' "$log" || true)"
    if [ "$n_linhas" != 1 ] || [ "$n_validas" != 1 ]; then
      falhas+=("$rotulo: exit 0 com $n_linhas linha(s) 'SABOTAGENS:' ($n_validas no formato) — o runner exige exatamente um recibo válido")
      printf '  ❌ %-44s exit=0, recibos=%s (válidos=%s) — sem UM recibo, a flag pode ter sido ignorada\n' "$rotulo" "$n_linhas" "$n_validas"
      return 0
    fi
    recibo="$(grep -E '^SABOTAGENS: [0-9]{1,4} vermelhas / [0-9]{1,4} falhas$' "$log")"
    n_verm="$(printf '%s' "$recibo" | grep -oE '[0-9]+' | sed -n 1p)"
    n_falh="$(printf '%s' "$recibo" | grep -oE '[0-9]+' | sed -n 2p)"
    if [ "$n_falh" -ne 0 ]; then
      falhas+=("$rotulo: $n_falh sabotagem(ns) sem o vermelho certo, com exit 0")
      printf '  ❌ %-44s falhas=%s com exit 0 — recibo e exit se contradizem\n' "$rotulo" "$n_falh"
      return 0
    fi
    if [ "$n_verm" -lt "$minimo" ]; then
      falhas+=("$rotulo: $n_verm sabotagens vermelhas, o manifesto exige ≥$minimo")
      printf '  ❌ %-44s sabotagens=%s < mínimo %s (a falsificação encolheu)\n' "$rotulo" "$n_verm" "$minimo"
      return 0
    fi
    concluidas+=("$caminho $modo")
    printf '  ✅ %-44s sabotagens=%-4s (≥%s) %ss\n' "$rotulo" "$n_verm" "$minimo" "$dur"
    return 0
  fi

  # Contagem de asserts. Três formatos vivem no acervo, todos com <pass> antes de
  # <fail>:  `PASS=27  FAIL=0` · `RESULTADO: 25 ok / 0 fail` · `19 OK / 0 FAIL`.
  # Não extrair é ERRO, nunca "assume que passou": é justamente o caso da prova
  # substituída por um `exit 0`.
  local contagem n_pass n_fail
  contagem="$(grep -ohE 'PASS=[0-9]+[[:space:]]+FAIL=[0-9]+|RESULTADO:[[:space:]]*[0-9]+[[:space:]]*[oO][kK][[:space:]]*[/,][[:space:]]*[0-9]+[[:space:]]*[fF][aA][iI][lL]|[0-9]+[[:space:]]*[oO][kK][[:space:]]*[/,][[:space:]]*[0-9]+[[:space:]]*[fF][aA][iI][lL]' "$log" | tail -1 || true)"
  if [ -z "$contagem" ]; then
    falhas+=("$rotulo: exit 0 mas SEM linha de contagem de asserts no log")
    printf '  ❌ %-44s exit=0 sem contagem — não dá para afirmar que asseriu algo\n' "$rotulo"
    return 0
  fi
  n_pass="$(printf '%s' "$contagem" | grep -oE '[0-9]+' | sed -n 1p)"
  n_fail="$(printf '%s' "$contagem" | grep -oE '[0-9]+' | sed -n 2p)"

  if [ "${n_fail:-1}" -ne 0 ]; then
    falhas+=("$rotulo: $n_fail assert(s) vermelhos com exit 0"); printf '  ❌ %-44s FAIL=%s\n' "$rotulo" "$n_fail"; return 0
  fi
  if [ "${n_pass:-0}" -lt "$minimo" ]; then
    falhas+=("$rotulo: executou $n_pass asserts, o manifesto exige ≥$minimo")
    printf '  ❌ %-44s asserts=%s < mínimo %s (prova encolheu)\n' "$rotulo" "$n_pass" "$minimo"
    return 0
  fi

  concluidas+=("$caminho $modo")
  printf '  ✅ %-44s asserts=%-4s (≥%s) %ss\n' "$rotulo" "$n_pass" "$minimo" "$dur"
}

echo
echo "=== núcleo: $esperados prova(s) + $n_falsif falsificação(ões), serial${parte:+ — $parte} ==="
for i in "${!scripts[@]}"; do
  executa "${scripts[$i]}" normal "${minimos[$i]}"
  case "${falsifs[$i]}" in
    '')   ;;
    fora) printf '  ⚠️  %-44s --falsificar FORA DO CI — ausência de dado, não aprovação: %s\n' \
            "$(basename "${scripts[$i]}" .sh)" "${motivos_fora[$i]}" ;;
    *)    executa "${scripts[$i]}" falsificar "${falsifs[$i]}" ;;
  esac
done

# ── 4. Recibo — CONJUNTO, não contagem ──────────────────────────────────────────
# "Cinco de cinco" não prova que foram ESTAS cinco: uma prova rodada duas vezes e
# outra pulada dariam o mesmo total. A conferência é sobre as identidades — o par
# (arquivo, modo), de modo que falsificação omitida não se esconde atrás do normal.
echo
faltando=()
for i in "${!scripts[@]}"; do
  identidades=("${scripts[$i]} normal")
  case "${falsifs[$i]}" in ''|fora) ;; *) identidades+=("${scripts[$i]} falsificar") ;; esac
  for esperado in "${identidades[@]}"; do
    achou=0
    for feito in ${concluidas[@]+"${concluidas[@]}"}; do [ "$feito" = "$esperado" ] && achou=1 && break; done
    [ "$achou" -eq 0 ] && faltando+=("$esperado")
  done
done

if [ ${#falhas[@]} -ne 0 ] || [ ${#faltando[@]} -ne 0 ]; then
  echo "=================================================="
  for f in ${falhas[@]+"${falhas[@]}"};     do echo "  ❌ $f"; done
  for f in ${faltando[@]+"${faltando[@]}"}; do echo "  ❌ sem recibo de conclusão: $f"; done
  echo "PROVAS-SQL REPROVADO — logs em $LOGS"
  exit 1
fi

echo "=================================================="
ok_normal=0; ok_falsif=0
for feito in "${concluidas[@]}"; do
  case "$feito" in *' normal') ok_normal=$((ok_normal + 1)) ;; *' falsificar') ok_falsif=$((ok_falsif + 1)) ;; esac
done
echo "SQL_PROOF_OK provas=$ok_normal/$esperados falsificacoes=$ok_falsif/$n_falsif fora_do_ci=$n_fora server_version_num=$versao_num pgbin=$PGBIN${parte:+ parte=$NUCLEO_PARTE}"
# O recibo só nasce aqui, DEPOIS do conjunto da parte conferido: parte vermelha não deixa recibo, e a
# união reprova pela falta dele mesmo que ninguém olhe o job vermelho. A parte vai normalizada (p_i/p_n
# da 1b), que é como a união a lê.
if [ -n "${NUCLEO_RECIBO:-}" ]; then
  mkdir -p "$(dirname "$NUCLEO_RECIBO")"
  { echo NUCLEO_RECIBO_V1
    echo "manifesto_sha256 $sha_parte"
    echo "parte $p_i/$p_n"
    for feito in "${concluidas[@]}"; do echo "unidade $feito"; done
    echo "fim ${#concluidas[@]}"
  } > "$NUCLEO_RECIBO.tmp"
  mv "$NUCLEO_RECIBO.tmp" "$NUCLEO_RECIBO"
  echo "RECIBO_DA_PARTE $p_i/$p_n unidades=${#concluidas[@]} arquivo=$NUCLEO_RECIBO"
fi
rm -rf "$LOGS"
