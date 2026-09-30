#!/usr/bin/env bun
/**
 * falsificar-exige-assert-gate.ts — fiscal TEXTUAL do veredito de falsificação: o vermelho que conta
 * como DENTE tem de ser do assert que a sabotagem declara, nunca "a rodada sabotada saiu ≠0". Não
 * executa shell nenhum.
 *
 *   bun scripts/falsificar-exige-assert-gate.ts          # corpo do repo (com pisos e o núcleo)
 *   bun scripts/falsificar-exige-assert-gate.ts <dir…>   # corpo arbitrário (sem piso nem núcleo — é fixture)
 *
 * exit 0 = limpo · 1 = violação · 2 = o fiscal não conseguiu medir (nenhum arquivo lido, piso de
 * denominador furado, manifesto do núcleo ilegível, stripper desabando). 2 NUNCA é "passou". Roda no
 * CI pelo vitest (`falsificar-exige-assert-gate.test.ts`); as mutações que provam o dente de cada
 * camada estão em `scripts/mutcheck.d/falsificar-exige-assert.mut`.
 *
 * ## A classe (docs/historico/falsificacao-exit-nao-e-dente.md)
 *
 * Até 2026-09-27 o `--falsificar` de `db/test-data-health-sync-reprocess.sh` contava como "✅ vermelha
 * como devia" QUALQUER rodada sabotada que saísse ≠0 — inclusive o `exit 9` de uma sabotagem NÃO
 * APLICÁVEL, cuja própria linha "❌ SABOTAGEM NÃO APLICÁVEL" ainda entrava na contagem de asserts
 * quebrados. O recibo saía `SABOTAGENS: 1 vermelhas / 0 falhas`, exit 0 — e o runner do núcleo, que
 * só lê o recibo, aprovaria. A varredura achou a mesma classe em mais 3 juízes do núcleo, cada um no
 * seu idioma: "≠ verde" (que aceitava o SQLSTATE de um ERRO), "ABORTOU" (qualquer exit≠0 do apply)
 * e "rc≠0" (qualquer erro no lugar da recusa).
 *
 * ## As regras
 *
 * R1 · toda lista `SABOTAGENS="…"` (ou `=(…)`) declara, em CADA entrada, o(s) assert(s) que TÊM de
 *      acusá-la: `nome:VERMELHOS`, com `:VERDES` opcional (os que têm de continuar verdes); IDs
 *      alfanuméricos unidos por `,` (E) ou `|` (OU), e `ID!MARCA` quando o vermelho DECLARADO é um erro
 *      de execução com aquela marca (o idioma do #2606). Entrada nua é o defeito; curinga de regex
 *      (`.*`) é o defeito disfarçado — casa qualquer vermelho. Lista vazia não prova nada.
 * R2 · o laço `for X in $SABOTAGENS` extrai a declaração (`${X#*:}`) e ela CHEGA a um `grep` — direto
 *      ou pela cadeia de derivação (`verm="${resto%%:*}"`, `for x in ${verm//,/ }`). Declarar e
 *      descartar é a entrada nua com outra cara.
 * R3 · cada linha `falsificar=<n>` de `db/nucleo-ci.txt` — o recibo que o CI confia sem saber o que é
 *      sabotagem — usa o idioma acima LIMPO (R1/R2 sem violação no arquivo) OU tem um JUIZ registrado
 *      em `JUIZES`: POR QUE o vermelho é do assert, e as âncoras de código sem as quais ele volta a
 *      aceitar qualquer vermelho. Juiz de arquivo não lido reprova. E todo juiz registrado (2026-09-30)
 *      prende a MEDIÇÃO: cada variável julgada (`mede`) só é escrita, DENTRO do juízo, por linha presa
 *      inteira, e alguma âncora a lê — ou o juiz diz por que não dá (`semLigacao`). O juízo compacto é
 *      um BLOCO de linhas consecutivas (ramo inserido ou trocado rompe); a âncora casa na forma normal,
 *      com `"…"` de curinga para a prosa; e o JUIZES é FECHADO (`REGISTRO_FECHADO`): apagar um juiz,
 *      voluntário ou não, é mudança explícita, não um bloco a menos.
 * R4 · o análogo do R3 para o `test:falsificacao` do package.json (o step que o CI roda no `validate`):
 *      cada arquivo que o roteiro EXECUTA — os slugs do laço, expandidos pelo MESMO parser do
 *      `test:hooks` (`scripts/lib/lacos-test-hooks.ts`), e os comandos fora dele — usa o idioma limpo
 *      OU tem juiz registrado. R1/R2 só enxergam quem USA a lista: sem o R4, um teste novo com juiz
 *      "exit≠0" entraria no CI sem ninguém acusar. Forma do roteiro que o fiscal não sabe expandir
 *      (`bun run` aninhado, outro interpretador) é INDETERMINADO, nunca "sem alvos".
 *
 * ## O que o texto NÃO alcança, e por quê
 *
 * Fora do núcleo, os laços de falsificação são dezenas, cada um no seu idioma (sentinela, SQLSTATE,
 * conjunto exato de IDs, valor ≠ verde…): uma regra textual única ou os reprovaria em massa ou
 * aprenderia um idioma por arquivo. A varredura de 2026-09-27, site a site, está no diário, e as fases
 * seguintes são tarefa com dono. Na 2ª leva (2026-09-27), os 10 laços de `scripts/` que tinham lista de
 * sabotagens migraram para o idioma e caem sob R1/R2; os de sabotagem única usam valor/marca exata. Âncora também não prova SEMÂNTICA — só torna vermelha a remoção da
 * linha que sustenta o juiz; quem prova o juiz é a meta-falsificação registrada no diário. A ligação
 * com a medição também é textual: `eval`, nameref, `printf -v "$1"` indireto e a escrita por helper num
 * arquivo de caminho literal ficam fora — e o juiz-helper chamado em N pontos declara `semLigacao`.
 */

import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { maiorBlocoDescartado, removerComentarios } from '@/lib/gates/limpeza-fonte';
import { diagnosticarShell, mascaraContexto, removerComentariosShell } from '@/lib/gates/limpeza-shell';
import { TETO_BLOCO_DESCARTADO } from './gate-sonda-autentica';
import { arquivosExecutados } from './lib/lacos-test-hooks';
import { PISOS as PISOS_DO_VIZINHO, RAIZES_PADRAO, alarmesDoStripper, enumerar } from './shell-variavel-colada-gate';

/** `import.meta.dir` é do Bun e não existe sob o vitest — por isso preguiçosa, como nos irmãos. */
const raizDoRepo = () => resolve(import.meta.dir, '..');

export const MANIFESTO_NUCLEO = 'db/nucleo-ci.txt';
export const PACOTE = 'package.json';
/** O roteiro que o CI roda no `validate` ("Falsificação — sabota o alvo e EXIGE vermelho"). */
export const ROTEIRO = 'test:falsificacao';

/**
 * PISOS — o denominador, medido em 2026-09-27. O universo de arquivos é o do vizinho (importado, não
 * copiado: dois números para a mesma calibração divergem). Piso é alarme de fumaça: folgado abaixo do
 * medido, SOBE quando o repo cresce, nunca desce para caber.
 */
export const PISOS = {
  arquivosPorRaiz: PISOS_DO_VIZINHO.arquivosPorRaiz,
  // medidos de novo em 2026-09-27, pós-merge do #2630/#2631/#2636 (o gate imprime o denominador:
  // `bun scripts/falsificar-exige-assert-gate.ts`) — 20 listas: 9 de db/, o
  // test-idioma-errexit-leitura (#2631) e as 10 de scripts/ que migraram na 2ª leva: onde-parei,
  // orfaos-custosos, read-contexto-nudge, ocupacao-por-arquivo, ocupacao-por-comando,
  // fecho-edges-pendentes, psql-ro-error-stop, eval-diagnostico-cegueira, falsificar-implementado,
  // bash-contexto-nudge
  listas: 15,
  entradas: 170, // medido: 239 (112 de db/ + 125 da 2ª leva + 2 do #2631; a positivação foi de 14 a 26 com o universo canônico, #2630)
  lacos: 15, // medido: 20
  linhasFalsificarNucleo: 6, // medido: 11 (eram 7: 4 da varredura + transporte-nuvem #2601, tint #2605, positivacao #2606)
  alvosFalsificacao: 20, // medido em 2026-09-29: 27 (26 slugs do laço + sonda-cron-prova.ts)
} as const;

/**
 * Uma âncora: um TRECHO de uma linha de código, ou um BLOCO — linhas CONSECUTIVAS de código, cada uma
 * casada INTEIRA (o juízo da medição ao veredito: nada inserido no meio, nenhum ramo trocado). As duas
 * formas casam sobre a FORMA NORMAL (sem recuo, espaço colapsado), e `"…"`/`'…'` é o curinga de PROSA:
 * uma string entre aspas de conteúdo qualquer, sem aspa dentro — a mensagem do diagnóstico pode mudar,
 * o código em volta dela não.
 */
export type Ancora = string | readonly string[];

export interface Juiz {
  /** POR QUE o vermelho que este arquivo conta é do assert — o idioma dele, em uma frase. */
  motivo: string;
  /** O código (sobrevive ao stripper) sem o qual o juiz volta a aceitar qualquer vermelho. */
  ancoras: readonly Ancora[];
  /**
   * As variáveis que o veredito JULGA — o que a medição escreve: o valor (`DSAB=$(…)`) ou o arquivo que
   * o veredito lê (`> "$log"`). TODA escrita delas no arquivo tem de estar numa linha presa INTEIRA por
   * uma âncora: a medição fica presa, e nenhuma escrita a mais (`DSAB=720` logo depois da leitura) passa
   * sem o gate ver. E alguma âncora tem de LÊ-las — medição presa sem veredito ligado a ela é decoração.
   */
  mede: readonly string[];
  /**
   * Obrigatório quando `mede` é vazio: POR QUE a ligação medição→veredito não é textual (a medição mora
   * nos N pontos de chamada de um helper, e o que liga é o argumento posicional). É a detecção MANUAL
   * documentada — explícita no diff, nunca a omissão calada que o `mede` existe para impedir.
   */
  semLigacao?: string;
  /**
   * O arquivo que DESPACHA para este juiz (o slug do `test:falsificacao` que roda um `lab-*`): a
   * âncora que some daqui reprova com a regra do despachante — o juiz de verdade mora aqui.
   */
  delegadoPor?: string;
}

/** O idioma da camada 4 nova, comum aos laços que a usam (docs/historico/falsificacao-exit-nao-e-dente.md). */
const MOTIVO_CAMADA4 =
  'o idioma SABOTAGENS (R1/R2) com as quatro camadas — a 4ª por LINHA, sobre o stderr INTEIRO do alvo que o EMBRULHO recolhe na rodada sabotada, contra o do controle';

/**
 * Os juízes do núcleo. Obrigatório para toda linha `falsificar=<n>` do manifesto; voluntário para os
 * que fazem a falsificação DENTRO da suíte normal — mas, uma vez aqui, preso pelo REGISTRO_FECHADO:
 * apagar a entrada é mudança explícita, não um bloco a menos. Cada juiz prende a MEDIÇÃO (`mede`) ou
 * diz por que não dá (`semLigacao`).
 */
export const JUIZES: Readonly<Record<string, Juiz>> = {
  'db/test-data-health-sync-reprocess.sh': {
    motivo:
      'SABOTAGENS nome:A<n> (R1/R2), e a rodada só conta se a sabotagem APLICOU, a suíte rodou INTEIRA e o assert declarado virou de verde para vermelho',
    mede: ['log', 'erros_sql', 'faltam'],
    ancoras: [
      'if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then',
      `erros_sql="$(grep -c 'ERROR:  ' "$log" || true)"`,
      [
        'faltam=""',
        'for exigido in ${exigidos//,/ }; do',
        'if ! grep -Eq "^  ✅ ($exigido) " "$LOGDIR/controle.log" || ! grep -Eq "^  ❌ ($exigido) " "$log"; then',
        'faltam="$faltam $exigido"',
        'fi',
        'done',
      ],
      `if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then`,
      `elif [ "$(executados "$log")" != "$asserts_controle" ]; then`,
      `elif [ "$erros_sql" != "$erros_controle" ]; then`,
      `elif [ -n "$faltam" ]; then`,
    ],
  },
  'db/test-canaria-veredito.sh': {
    motivo:
      'sabota <id> <desc> <marca>: CERTO só com a marca da asserção nos 2 locales; SQL inválido e morte do shell recusados; padrão que não casa invalida',
    mede: ['log', 'm'],
    ancoras: [
      [
        'log="$LOGS_F/$id.$loc.log"',
        'if roda_suite "$alvo" "$loc" "$log"; then motivo="…"; continue; fi',
        'm="$(julga_log "$log" "$marca")"',
        '[ "$m" = CERTO ] || motivo="…"',
      ],
      `if tem_marca "$1" "$2"; then printf 'CERTO'; else printf "…" "$2"; fi`,
      'if cmp -s "$GERADO" "$copia"; then invalida "$id" "$desc" "…"; return 0; fi',
    ],
  },
  'db/test-db-aplicar.sh': {
    motivo: 'confere <rc> <rc-esperado> <log> <marca>…: CERTO só com o rc EXATO e TODAS as marcas; o rc sozinho é recusado',
    mede: [],
    semLigacao:
      'a medição mora nos ~15 pontos de chamada (`r="$(rc_de …)"; confere "$r" <rc> "$OUT" <marca>…`) e liga pelo argumento posicional, que o texto não segue — presos aqui o juízo (`confere`) inteiro e a primitiva que mede (`rc_de`)',
    ancoras: [
      'rc_de() { local r=0; aplicar "$@" > "$OUT" 2>&1 || r=$?; echo "$r"; }',
      [
        'confere() {',
        'local veio="$1" esperado="$2" log="$3" marca="" faltam=""',
        'shift 3',
        `[ "$#" -ge 1 ] || { printf '…'; return 0; }`,
        'if [ "$veio" != "$esperado" ]; then printf "…" "$veio" "$esperado"; return 0; fi',
        `[ -s "$log" ] || { printf '…' "$veio"; return 0; }`,
        'for marca in "$@"; do',
        `grep -qF -- "$marca" "$log" || faltam="$faltam '$marca'"`,
        'done',
        `if [ -n "$faltam" ]; then printf '…' "$veio" "$faltam"; return 0; fi`,
        `printf 'CERTO'`,
        '}',
      ],
    ],
  },
  'db/test-pedido-total-liquido-acervo.sh': {
    motivo:
      'vermelha <rótulo> <valor> <verde> <declarado>: conta só o valor que a sabotagem DECLARA; vermelha_por exige a assinatura do ramo; texto inalterado é falha',
    mede: [],
    semLigacao:
      'medição INLINE nas 14 chamadas (`vermelha <rótulo> "$(medida)" <verde> <declarado>`): o valor julgado é argumento posicional, que o texto não liga — presos aqui os juízes (`vermelha`, `vermelha_por`, `postcondicao_de`) e o no-op do `sabotar`',
    ancoras: [
      [
        'vermelha() {',
        'if [ "$2" = "$3" ]; then sab_falha "…"',
        'elif [ "$2" = "$4" ]; then sab_verm "…"',
        'else sab_falha "…"; fi',
        '}',
      ],
      'vermelha_por() { if [ "$2" = "$3" ]; then sab_verm "…"; else sab_falha "…"; fi; }',
      ['perl -0pe "$3" "$2" > "$TMPM"', 'if cmp -s "$2" "$TMPM"; then', 'sab_falha "…"', 'return 1', 'fi'],
      [
        'if P -q -f "$TMPM" >"$TMPD/post.out" 2>&1; then echo aplicou',
        `elif grep -q 'ERROR:  POSTCONDICAO FALHOU' "$TMPD/post.out"; then echo postcondicao`,
        'else echo outro_erro; fi',
      ],
      '"$(estado_c)" "23514:pedido_venda_coerencia"',
    ],
  },
  'db/test-transporte-nuvem.sh': {
    motivo:
      'sabota <id> <marca>: vermelho só com a marca do assert (`FALHA [T<n>]`) no log, sobre um controle `0 fail` da MESMA invocação; sabotagem que não aplica é falha',
    mede: ['log'],
    ancoras: [
      `grep -qE '^RESULTADO: [0-9]+ ok / 0 fail$' "$TMP/controle.log"`,
      'local id="$1" marca="$2" expr="$3" log="$TMP/sab-$1.log"',
      [
        'if git -C "$WT_SABOTADO" diff --quiet -- scripts/lib/transporte-nuvem.ts; then',
        'echo "…"; SAB_FALHAS=$((SAB_FALHAS + 1)); return',
        'fi',
        'if entrada_normal "$log"; then',
        'echo "…"; SAB_FALHAS=$((SAB_FALHAS + 1)); return',
        'fi',
        'if grep -qF -- "$marca" "$log"; then',
        'echo "…"; SAB_VERMELHAS=$((SAB_VERMELHAS + 1))',
        'else',
        'echo "…"; tail -c 800 "$log"',
        'SAB_FALHAS=$((SAB_FALHAS + 1))',
        'fi',
      ],
    ],
  },
  // Pré-registrado para o #2605, que o põe no núcleo com `falsificar=12` (o registro de arquivo lido e
  // ancorado vale mesmo antes da linha do manifesto existir).
  'db/test-tint-promocao-assincrona.sh': {
    motivo:
      'fals <nome> <esperado>: vermelho só com o CONJUNTO EXATO de asserts caídos (falhas_de); sabotagem no-op aborta (cmp na migration, RAISE no corpo do promote)',
    mede: ['got'],
    ancoras: [
      [
        'local nome=$1 esperado=$2 mig=$3 sab=$4 got',
        'got="$(suite "$mig" "$sab" | falhas_de)"',
        'if [ "$got" = "$esperado" ]; then',
        'echo "…"',
        'VERM=$((VERM + 1))',
        'else',
        'echo "…"',
        'FALSOS=$((FALSOS + 1))',
        'fi',
      ],
      'if cmp -s "$MIG" "$1"; then echo "…"; exit 1; fi',
    ],
  },
  'db/test-authz-revoke-anon-rpc.sh': {
    motivo: 'falsificação na suíte normal: ABORTOU só com a marca da postcondição na saída do apply; outro erro vira "ERRO ALHEIO"',
    mede: ['F1', 'F2', 'F3'],
    ancoras: [
      [
        'if P -q -f "$alvo" >"$alvo.out" 2>&1; then echo "APLICOU"',
        `elif grep -q 'ERROR:  POSTCONDICAO FALHOU' "$alvo.out"; then echo "ABORTOU"`,
        `else echo "ERRO ALHEIO a postcondicao: $(grep -m1 'ERROR' "$alvo.out" | cut -c1-120)"; fi`,
      ],
      [`F1="$(sabotar '…' '…')"`, `eq "…" "$F1" 'ABORTOU'`],
      [`F2="$(sabotar '…' '…')"`, `eq "…" "$F2" 'ABORTOU'`],
      [`F3="$(sabotar "…" '…')"`, `eq "…" "$F3" 'APLICOU'`],
    ],
  },
  // O juízo inteiro, da LEITURA ao `esac`: as 4 âncoras soltas de antes deixavam passar a leitura
  // trocada por `DSAB=720`, o ramo `0|""` liberado e o registro apagado (Codex, fase 4).
  'db/test-tint-promote.sh': {
    motivo:
      'falsificação na suíte normal: a divergência EXATA que cada sabotagem declara (F1 720, F2 1928) — "qualquer ≠ 0" aceitava divergência de outra causa',
    mede: ['DSAB', 'DSAB2'],
    ancoras: [
      [
        'DSAB=$(P -tA -c "SELECT _dif_count();")',
        'case "$DSAB" in',
        '720) ok "…" ;;',
        '0|"") echo "…"; exit 1 ;;',
        '*) echo "…"; exit 1 ;;',
        'esac',
      ],
      [
        'DSAB2=$(P -tA -c "SELECT _dif_count();")',
        'case "$DSAB2" in',
        '1928) ok "…" ;;',
        '0|"") echo "…"; exit 1 ;;',
        '*) echo "…"; exit 1 ;;',
        'esac',
      ],
    ],
  },
  'db/test-pedido-edicao-atomica.sh': {
    motivo:
      'falsificação na suíte normal: rc≠0 só conta com a marca do que a sabotagem DECLARA vir no lugar da recusa (default: a chamada completa)',
    mede: ['out', 'rc'],
    ancoras: [
      'local f out rc no_lugar="${5:-ASSERT_NAO_LANCOU}"',
      [
        'out="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d sab -v ON_ERROR_STOP=1 -q -c \\',
        String.raw`"DO \$a\$ BEGIN PERFORM $4; RAISE EXCEPTION 'ASSERT_NAO_LANCOU'; EXCEPTION WHEN sqlstate '$3' THEN NULL; WHEN OTHERS THEN RAISE; END \$a\$;" 2>&1)"`,
        'rc=$?',
        'set -e',
        'rm -f "$f"',
        'local erro=""',
        'case "$out" in *"ERROR:  "*) erro="${out#*ERROR:  }"; erro="${erro%%$\'\\n\'*}" ;; esac',
        'case "$rc:$erro" in',
        '0:*) bad "…" ;;',
        '*:*"$no_lugar"*) ok "…" ;;',
        '*) bad "…" ;;',
        'esac',
      ],
    ],
  },

  // ── R4: os alvos do `test:falsificacao` fora do idioma SABOTAGENS (2026-09-29). Cada um RELIDO: a
  // varredura de 2026-09-27 os chamava de "já-corretos", e três não eram (setup-contrato,
  // medir-footprint, sonda-cron-prova — consertados junto; docs/historico/falsificacao-exit-nao-e-dente.md).
  // Residual comum aos de `FAIL [<id>]`: sem camada de crash — o assert declarado que inclui o rc
  // também cai se o alvo MORRER no ramo dele (pendência com dono no diário).
  'scripts/test-codex-async.sh': {
    motivo:
      'sabotar <id> <marca> <python>: sobre controle VERDE nos 2 locales (aborta sem ele), troca 1× + `bash -n`, e só conta com `FAIL [<marca>]` — o assert que a declara',
    mede: ['saida_suite', 'rc_suite'],
    ancoras: [
      'saida_suite="$(LC_ALL="$2" CODEX_ASYNC_ALVO="$1" bash "$0" 2>&1)"; rc_suite=$?',
      `bash -n "$alvo" 2>/dev/null || { printf '…' "$id"; falhas=1; return; }`,
      '[ "$falhas" -eq 0 ] || { echo "…"; exit 1; }',
      [
        'suite "$alvo" "$loc"',
        'if [ "$rc_suite" -eq 0 ]; then',
        `printf '…' "$id" "$loc"; falhas=1`,
        `elif printf '%s' "$saida_suite" | grep -qF "FAIL [$marca]"; then`,
        `printf '…' "$id" "$marca" "$loc"`,
        'else',
        `printf '…' "$id" "$loc" "$marca"`,
        String.raw`printf '%s\n' "$saida_suite" | grep -m3 'FAIL' | sed 's/^/        /'`,
        'falhas=1',
        'fi',
      ],
    ],

  },
  'scripts/test-codex-async-nuvem.sh': {
    motivo: 'o molde do codex-async: troca LITERAL que casa exatamente 1×, `bash -n`, controle verde nos 2 locales, e `FAIL [<marca>]` do assert declarado',
    mede: ['saida_suite', 'rc_suite'],
    ancoras: [
      'saida_suite="$(LC_ALL="$2" CODEX_ASYNC_ALVO="$1" bash "$0" 2>&1)"; rc_suite=$?',
      'if s.count(de)!=1: sys.exit(1)',
      '[ "$falhas" -eq 0 ] || { echo "…"; exit 1; }',
      [
        'suite "$alvo" "$loc"',
        'if [ "$rc_suite" -eq 0 ]; then',
        `printf '…' "$id" "$loc"; falhas=1`,
        'elif grep -qF "FAIL [$marca]" <<< "$saida_suite"; then',
        `printf '…' "$id" "$marca" "$loc"`,
        'else',
        `printf '…' "$id" "$loc" "$marca"`,
        `grep -m3 'FAIL' <<< "$saida_suite" | sed 's/^/        /'`,
        'falhas=1',
        'fi',
      ],
    ],

  },
  'scripts/test-gate-senha-bootstrap.sh': {
    motivo:
      'sabota a ENTRADA (planta o defeito na raiz-fixture) com controle antes de cada uma: rc EXATO + o marcador do ramo + a senha falsa ausente; sabotagem que não muda a raiz aborta',
    mede: ['rc'],
    ancoras: [
      `rodar() { "$GATE" --raiz "$RAIZ" > "$TMP/saida" 2>&1; printf '%s' "$?"; }`,
      [
        'local rc; rc="$(rodar)"',
        `if [ "$rc" -ne 0 ] || ! grep -q 'BOOTSTRAP-SENHA-OK' "$TMP/saida"; then`,
        `printf '…' "$rc"`,
        'cut -c1-300 "$TMP/saida"',
        'exit 1',
        'fi',
      ],
      [
        'antes="$(hash_raiz)"',
        '( cd "$RAIZ" && eval "$cmd" ) >/dev/null 2>&1',
        'depois="$(hash_raiz)"',
        'if [ "$antes" = "$depois" ]; then',
        `printf '…' "$desc"`,
        'exit 1',
        'fi',
        'rc="$(rodar)"',
        'if [ "$rc" -ne "$rc_esp" ]; then falhou "…"; return; fi',
        'if ! grep -q "$marca" "$TMP/saida"; then falhou "…"; return; fi',
        'if grep -q "$FALSA" "$TMP/saida"; then falhou "…"; return; fi',
        'ok "…"',
      ],
    ],

  },
  'scripts/test-codex-prompt-paginacao.sh': {
    motivo: 'o VALOR devolvido pela definição sabotada: G1/G2 = o SHA do citador, G3/G4 vazios, e exatamente 2 vermelhos — o defeito exato, não um erro que esvazia a resposta',
    mede: ['got_1856', 'got_1889', 'got_9999', 'got_185', 'falhas'],
    ancoras: [
      ['rodar_assercoes() {', 'falhas=0', 'unset -f sha_de', 'eval "$1"'],
      'got="$(sha_de 1856)"; got_1856="$got"',
      'got="$(sha_de 1889)"; got_1889="$got"',
      'got="$(sha_de 9999)"; got_9999="$got"',
      'got="$(sha_de 185)"; got_185="$got"',
      [
        'log="$tmp/sabotada.log"',
        'rodar_assercoes "$defn_sabotado" > "$log" 2>&1',
        'cat "$log"',
        'echo',
        'faltam=""',
        '[ "$got_1856" = "$sha_citador" ] || faltam="…"',
        '[ "$got_1889" = "$sha_citador_1889" ] || faltam="…"',
        '[ -z "$got_9999" ] || faltam="…"',
        '[ -z "$got_185" ] || faltam="…"',
        'if [ "$falhas" -eq 0 ]; then',
        'echo "…"',
        'exit 1',
        'fi',
        'if [ -n "$faltam" ] || [ "$falhas" -ne 2 ]; then',
        'echo "…"',
        'echo "…"',
        'exit 1',
        'fi',
      ],
    ],

  },
  'scripts/test-guard-noop-sabotagem.sh': {
    motivo: 'rc 1 E a LINHA exata (`grep -qxF`) da resposta do guard frágil com o alvo presente; `bash -n` antes — o bash cita a linha do erro de sintaxe',
    mede: ['veredito', 'rc_v'],
    ancoras: [
      [
        'if ! bash -n "$TMP/sabotado.sh" 2>/dev/null; then',
        `printf '…' "$base"`,
        'cegas=$((cegas + 1)); continue',
        'fi',
        'veredito=$(verificar_guard "$TMP/sabotado.sh"); rc_v=$?',
        "marca_exata='     com o alvo PRESENTE o guard respondeu:   [XX ] sabotagem NO-OP (alvo sumiu)'",
        'LC_ALL=C grep -qxF -- "$marca_exata" <<<"$veredito" && rc_v="$rc_v+marca"',
        'case "$rc_v:$veredito" in',
        '0:*)',
        `printf '…' "$base"`,
        'cegas=$((cegas + 1)) ;;',
        '1+marca:*)',
        `printf '…' "$base" ;;`,
        '*)',
        `printf '…' "$base" "$rc_v"`,
        String.raw`printf '%s\n' "$veredito" | sed 's/^/       /' | head -4`,
        'cegas=$((cegas + 1)) ;;',
        'esac',
      ],
    ],

  },
  'scripts/test-eval-via-morta.sh': {
    motivo: 'S1: exit EXATO 1 + o baseline do caso-alvo vermelho + o recibo do laço completo (12); S2: nenhuma pegada, com o recibo — erro alheio e laço abortado são recusados',
    mede: ['r_rc', 'r_out'],
    ancoras: [
      `local out; out=$(bash "$sc" "$@" 2>&1); printf '%s|%s' "$?" "$out"`,
      [
        'r=$(roda "$EVALDIR/eval.sh" --falsify); r_rc="${r%%|*}"; r_out="${r#*|}"',
        'case "$r_rc:$r_out" in',
        '2:*"$MARCA"*) ruim "…" ;;',
        `1:*'o caso-alvo "velho_com_controle"'*'cegueira(s) em 12 sabotagem(ns)'*)`,
        'ok "…" ;;',
        `1:*'o caso-alvo "velho_com_controle"'*)`,
        'ruim "…" ;;',
        '0:*) ruim "…" ;;',
        '*) ruim "…"',
        String.raw`printf '%s\n' "$r_out" | sed 's/^/     /' | tail -4 ;;`,
        'esac',
      ],
      '  *"cegueira(s) em 12 sabotagem(ns)"*)',
    ],

  },
  'scripts/test-gates-frescura.sh': {
    motivo: 'sabota a ENTRADA (a raiz-fixture) com controle remontado antes de cada uma: rc EXATO + o marcador do ramo (ORFAO, CENSO-OBSOLETO, …)',
    mede: ['saida', 'rc'],
    ancoras: [
      'rodar() { (cd "$RAIZ_REPO" && LC_ALL="$LOCALE_ATUAL" bun "$GATE" --raiz "$TMP/raiz" 2>&1); }',
      [
        'set +e; saida="$(rodar)"; rc=$?; set -e',
        `if [ "$rc" -ne 0 ] || ! printf '%s' "$saida" | grep -q 'FRESCURA-OK'; then`,
        `printf '…' "\${LOCALE_ATUAL:-default}" "$rc"`,
        String.raw`printf '%s\n' "$saida"`,
        'exit 1',
        'fi',
      ],
      [
        'set +e; saida="$(rodar)"; rc=$?; set -e',
        'if [ "$rc" -ne "$rc_esp" ]; then',
        'falhou "…"',
        'return',
        'fi',
        `if ! printf '%s' "$saida" | grep -q "$marca"; then`,
        'falhou "…"',
        'return',
        'fi',
        'ok "…"',
      ],
    ],

  },
  'scripts/test-vigia-gstack.sh': {
    motivo: 'controle verde por locale (aborta sem ele); cópia que difere; exit EXATO 1 + `FAIL [<caso>]` do caso-alvo',
    mede: ['saida', 'rc'],
    ancoras: [
      [
        'saida="$(LC_ALL="$1" VIGIA_GSTACK_HOOK="$HOOK" bash "$0" 2>&1)"; rc=$?',
        'if [ "$rc" -ne 0 ]; then',
        `printf '…' "$1" "$rc" "$saida"`,
        'exit 1',
        'fi',
      ],
      [
        'if cmp -s "$HOOK" "$copia"; then',
        `printf '…' "$id"`,
        'falhas=$((falhas + 1)); return',
        'fi',
        'saida="$(LC_ALL="$LOC" VIGIA_GSTACK_HOOK="$copia" bash "$0" 2>&1)"; rc=$?',
        String.raw`if [ "$rc" -eq 1 ] && printf '%s\n' "$saida" | grep -F "FAIL [$alvo]" >/dev/null; then`,
        `printf '…' "$id" "$desc" "$alvo" "$LOC"`,
        'else',
        `printf '…' "$id" "$desc" "$alvo" "$rc" "$saida"`,
        'falhas=$((falhas + 1))',
        'fi',
      ],
    ],

  },
  'scripts/test-vigia-nuvem.sh': {
    motivo: 'o molde do vigia-gstack: controle verde por locale, sabotagem que muda o arquivo, exit EXATO 1 + `FAIL [<caso>]`',
    mede: ['saida', 'rc'],
    ancoras: [
      [
        'saida="$(LC_ALL="$LOC" VIGIA_NUVEM_HOOK="$tmp/$1/hook.sh" VIGIA_NUVEM_SETTINGS="$tmp/$1/settings.json" \\',
        'bash "$0" 2>&1)"; rc=$?',
      ],
      [
        `preparar "controle-$LOC" nada ''`,
        'rodar_suite "controle-$LOC"',
        'if [ "$rc" -ne 0 ]; then',
        `printf '…' \\`,
        '"$LOC" "$rc" "$saida"',
        'exit 1',
        'fi',
      ],
      [
        'if ! preparar "$1-$LOC" "$4" "$5"; then',
        `printf '…' "$1"`,
        'falhas=$((falhas + 1)); return',
        'fi',
        'rodar_suite "$1-$LOC"',
        String.raw`if [ "$rc" -eq 1 ] && printf '%s\n' "$saida" | grep -F "FAIL [$2]" >/dev/null; then`,
        `printf '…' "$1" "$3" "$2" "$LOC"`,
        'else',
        `printf '…' "$1" "$3" "$2" "$rc" "$saida"`,
        'falhas=$((falhas + 1))',
        'fi',
      ],
    ],

  },
  // Entrou no roteiro com o #2655 DURANTE este PR — e o R4 o acusou no rebase, antes de registrado:
  // exatamente o caso que o R4 existe para pegar. Relido: o molde do vigia-gstack, recortado ao caso.
  'scripts/test-gstack-auto-upgrade.sh': {
    motivo:
      'o molde do vigia-gstack: controle verde por locale (aborta sem ele), cópia que difere, e a rodada RECORTADA ao caso-alvo (SO_CASO) tem de sair exit EXATO 1 com `FAIL [<caso>]`',
    mede: ['saida', 'rc'],
    ancoras: [
      [
        'saida="$(env -u SO_CASO LC_ALL="$1" GSTACK_AUTO_UPGRADE_SCRIPT="$ALVO" bash "$0" 2>&1)"; rc=$?',
        'if [ "$rc" -ne 0 ]; then',
        `printf '…' "$1" "$rc" "$saida"`,
        'exit 1',
        'fi',
      ],
      [
        'if cmp -s "$ALVO" "$copia"; then',
        `printf '…' "$id"`,
        'falhas=$((falhas + 1)); return',
        'fi',
        'saida="$(LC_ALL="$LOC" SO_CASO="$caso" GSTACK_AUTO_UPGRADE_SCRIPT="$copia" bash "$0" 2>&1)"; rc=$?',
        String.raw`if [ "$rc" -eq 1 ] && printf '%s\n' "$saida" | grep -F "FAIL [$caso]" >/dev/null; then`,
        `printf '…' "$id" "$desc" "$caso" "$LOC"`,
        'else',
        `printf '…' "$id" "$desc" "$caso" "$rc" "$saida"`,
        'falhas=$((falhas + 1))',
        'fi',
      ],
    ],

  },
  'scripts/test-instrucoes-carregadas.sh': {
    motivo: 'o molde do vigia-gstack: controle verde por locale, cópia que difere, exit EXATO 1 + `FAIL [<caso>]`',
    mede: ['saida', 'rc'],
    ancoras: [
      [
        'saida="$(LC_ALL="$1" INSTR_HOOK="$HOOK" bash "$0" 2>&1)"; rc=$?',
        'if [ "$rc" -ne 0 ]; then',
        `printf '…' "$1" "$rc" "$saida"`,
        'exit 1',
        'fi',
      ],
      [
        'if cmp -s "$HOOK" "$copia"; then',
        `printf '…' "$id"`,
        'falhas=$((falhas + 1)); return',
        'fi',
        'saida="$(LC_ALL="$LOC" INSTR_HOOK="$copia" bash "$0" 2>&1)"; rc=$?',
        String.raw`if [ "$rc" -eq 1 ] && printf '%s\n' "$saida" | grep -F "FAIL [$alvo]" >/dev/null; then`,
        `printf '…' "$id" "$desc" "$alvo" "$LOC"`,
        'else',
        `printf '…' "$id" "$desc" "$alvo" "$rc" "$saida"`,
        'falhas=$((falhas + 1))',
        'fi',
      ],
    ],

  },
  'scripts/test-pr-watch.sh': {
    motivo: 'a marca carrega o ID do caso E o valor errado exato (`FAIL [nao-obrig-mergeia] exit: want 0, got 4`); sed inválido, no-op e sintaxe quebrada são sabotagem vazia',
    mede: ['saida_suite', 'rc_suite'],
    ancoras: [
      'saida_suite="$(LC_ALL="$2" PR_WATCH_ALVO="$1" bash "$0" 2>&1)"; rc_suite=$?',
      'if ! bash -n "$copia" 2>/dev/null; then',
      '"FAIL [nao-obrig-mergeia] exit: want 0, got 4" \\',
      [
        'suite "$copia" "$loc"',
        'if [ "$rc_suite" -eq 0 ]; then',
        'echo "…"; falhas=$((falhas + 1))',
        'elif ! grep -qF -- "$marca" <<<"$saida_suite"; then',
        'echo "…"',
        `grep -F 'FAIL [' <<<"$saida_suite" | cut -c1-150 | sed 's/^/        /'`,
        'falhas=$((falhas + 1))',
        'else',
        'echo "…"',
        'fi',
      ],
    ],

  },
  'scripts/test-claude-mem-saude.sh': {
    motivo: 'controle das duas cópias íntegras; sed inválido/no-op/sintaxe recusados; `FALHA <caso>:` do caso declarado em cada locale',
    mede: ['r'],
    ancoras: [
      [
        'LC_ALL="$loc" CLAUDE_MEM_SAUDE_ALVO="$sensor" VIGIA_ALVO="$vigia" "$BASH_BIN" "$0" >"$tmp/res-$i-$loc.txt" 2>&1',
        'echo "RC=$?" >>"$tmp/res-$i-$loc.txt"',
      ],
      [
        'r="$tmp/res-$i-$loc.txt"',
        `if grep -qx 'RC=0' "$r"; then`,
        `printf '…' "$loc" "\${SNOME[i]}"; falhou=1`,
        'elif ! grep -qF -- "FALHA ${SCASO[i]}:" "$r"; then',
        `printf '…' "$loc" "\${SNOME[i]}" "\${SCASO[i]}" \\`,
        `"$(grep -m1 'FALHA' "$r" | sed 's/^ *//' | cut -c1-80)"`,
        'falhou=1',
        'else',
        `printf '…' "$loc" "\${SNOME[i]}" "\${SCASO[i]}"`,
        'fi',
      ],
      '    elif ! bash -n "$copia" 2>/dev/null; then',
    ],

  },
  'scripts/test-setup-contrato.sh': {
    motivo:
      'marca do ramo (erro do motor, nome do teste) casada só nas linhas de FALHA: fora das `✓` e do code-frame, onde o vitest cita teste VERDE — até 2026-09-29 casava na saída inteira',
    mede: ['saida', 'rc', 'falha_txt'],
    ancoras: [
      `linhas_de_falha() { sem_ansi "$1" | LC_ALL=C grep -avE '^[[:space:]]*(✓|[0-9]*[[:space:]]*\\|)'; }`,
      'rodar_testemunhas() { NO_COLOR=1 FORCE_COLOR=0 COLUMNS=400 bunx vitest run "${TESTEMUNHAS[@]}" >"$1" 2>&1; }',
      [
        'local saida="$TMPD/sabotagem-$SABOTAGENS.txt"',
        'local rc',
        'rodar_testemunhas "$saida"',
        'rc=$?',
        'restaurar',
        'if [ "$rc" -eq 0 ]; then',
        'aviso "…"',
        'FALHAS=$((FALHAS + 1))',
        'return',
        'fi',
      ],
      'falha_txt="$(linhas_de_falha "$saida")"',
      'grep -qaF -- "$alt" <<<"$falha_txt" && { achou=1; break; }',
      ['if [ -n "$faltando" ]; then', 'aviso "…"'],
    ],

  },
  'scripts/test-medir-footprint.sh': {
    motivo:
      'medição incompleta (rc, campo não numérico, 0 amostras) é ruim; o vermelho que conta é o SENTIDO declarado — SAB1 cai, SAB2/SAB4 sobem, SAB3 abaixo do mínimo; até 2026-09-29 valia "fora da janela" para qualquer lado',
    mede: ['S1_LEVE', 'S1_PESADO', 'S2_LEVE', 'S2_DIV', 'S4_LEVE', 'S4_SEQ'],
    ancoras: [
      [
        'bash "$1" sh -c "$2" > "$TMP/saida.txt" 2>"$TMP/erro.txt"',
        'rc=$?',
        `R_PICO="$(sed -n 's/^pico_mb=//p' "$TMP/saida.txt")"`,
      ],
      '  [ "$R_EXIT" -eq 0 ] || return 1',
      `if medir "$SAB1" "$ALVO_LEVE"; then S1_LEVE="$R_PICO"; else S1_LEVE=''; fi`,
      `if medir "$SAB1" "$ALVO_PESADO"; then S1_PESADO="$R_PICO"; else S1_PESADO=''; fi`,
      `if medir "$SAB2" "$ALVO_LEVE"; then S2_LEVE="$R_PICO"; else S2_LEVE=''; fi`,
      `if medir "$SAB2" "$ALVO_DIVERGENTE"; then S2_DIV="$R_PICO"; else S2_DIV=''; fi`,
      `if medir "$SAB4" "$ALVO_LEVE"; then S4_LEVE="$R_PICO"; else S4_LEVE=''; fi`,
      `if medir "$SAB4" "$ALVO_SEQUENCIAL"; then S4_SEQ="$R_PICO"; else S4_SEQ=''; fi`,
      'elif [ "$(( S1_PESADO - S1_LEVE ))" -gt "$JANELA_MAX" ]; then',
      'elif [ "$(( S2_DIV - S2_LEVE ))" -lt "$JANELA_MIN" ]; then',
      'elif [ "$(( S4_SEQ - S4_LEVE ))" -lt "$SEQ_MIN" ]; then',
    ],

  },
  'scripts/test-claude-mem-reanimar.sh': {
    motivo: 'despacha para lab-claude-mem-reanimar/{falsifica.sh, prova_com_tty.sh --falsificar} e exige rc 0 + a LINHA exata do marcador verde de cada um',
    mede: ['saida', 'rc'],
    ancoras: [
      '  roda falsifica.sh FALSIFICACAO-VERDE || exit 1',
      '  roda prova_com_tty.sh FALSIFICACAO-COM-TTY-VERDE --falsificar',
      [
        'saida="$(mktemp)"',
        'if [ "$(uname -s)" = Linux ]; then',
        'python3 "$LAB/subreaper.py" bash "$LAB/$script" "$@" >"$saida" 2>&1',
        'else',
        'bash "$LAB/$script" "$@" >"$saida" 2>&1',
        'fi',
        'rc=$?',
        'cat "$saida"',
        'if [ "$rc" -eq 0 ] && grep -qx "$marca" "$saida"; then',
        'rm -f "$saida"',
        'return 0',
        'fi',
      ],
    ],

  },
  'scripts/lab-claude-mem-reanimar/falsifica.sh': {
    motivo: 'RC≠0 + LAB-VERMELHO (o lab TERMINOU) + o texto da FALHA declarada numa linha `  FALHA `, por locale',
    mede: ['r'],
    ancoras: [
      [
        'LC_ALL="$loc" SCRIPT="$TMP/sabotado-${NOME[i]}.sh" LAB_FAIXAS=1 \\',
        'bash "$L/lab.sh" "${CEN[i]}" >"$TMP/res-$i-$loc.txt" 2>&1',
        'echo "RC=$?" >>"$TMP/res-$i-$loc.txt"',
      ],
      [
        'r="$TMP/res-$i-$loc.txt"',
        "if ! grep -qx 'RC=[1-9][0-9]*' \"$r\"; then",
        'problema="…"',
        "elif ! grep -qx 'LAB-VERMELHO' \"$r\"; then",
        'problema="$problema [$loc] saiu sem o marcador LAB-VERMELHO (o lab nao terminou: $(tail -1 "$r"))"',
        `elif ! grep -F '  FALHA ' "$r" | grep -qF -- "\${ESPERADO[i]}"; then`,
        `problema="$problema [$loc] vermelho pelo MOTIVO ERRADO: $(grep -m1 -F '  FALHA ' "$r" | sed 's/^ *//' | cut -c1-90)"`,
        'fi',
      ],
    ],
    delegadoPor: 'scripts/test-claude-mem-reanimar.sh',
  },
  'scripts/lab-claude-mem-reanimar/prova_com_tty.sh': {
    motivo: 'o python sabotado tem de parsear; PROVA-COM-TTY-VERMELHA (a prova TERMINOU) + a FALHA declarada, com os rc exatos no texto',
    mede: ['r', 'rc'],
    ancoras: [
      [
        'r="$T/res-$i-$loc.txt"',
        'LC_ALL="$loc" COM_TTY="$copia" bash "$L/prova_com_tty.sh" >"$r" 2>&1',
        'rc=$?',
        'if [ "$rc" -eq 0 ]; then',
        'problema="…"',
        "elif ! grep -qx 'PROVA-COM-TTY-VERMELHA' \"$r\"; then",
        'problema="…"',
        `elif ! grep -F '  FALHA ' "$r" | grep -qF -- "\${ESPERADO[i]}"; then`,
        `problema="$problema [$loc] vermelho pelo MOTIVO ERRADO: $(grep -m1 -F '  FALHA ' "$r" | sed 's/^ *//' | cut -c1-90)"`,
        'fi',
      ],
    ],
    delegadoPor: 'scripts/test-claude-mem-reanimar.sh',
  },
  'scripts/test-retry-pgdg.sh': {
    motivo: 'despacha para lab-retry-pgdg/falsifica.sh e exige rc 0 + a LINHA exata do marcador verde',
    mede: ['saida', 'rc'],
    ancoras: [
      '  roda falsifica.sh FALSIFICACAO-VERDE',
      [
        'saida="$(mktemp)"',
        'bash "$LAB/$1" >"$saida" 2>&1',
        'rc=$?',
        'cat "$saida"',
        'if [ "$rc" -eq 0 ] && grep -qx "$2" "$saida"; then',
        'rm -f "$saida"',
        'return 0',
        'fi',
      ],
    ],

  },
  'scripts/lab-retry-pgdg/falsifica.sh': {
    motivo: 'LAB-VERMELHO + o controle C0 do lab VERDE (quebrar o lab não é quebrar a guarda) + CADA caso declarado vermelho, por locale',
    mede: ['SAI'],
    ancoras: [
      'roda_lab() { ALVO_YML="$1" LC_ALL="$2" LAB_CENARIOS="${3:-C1 C2 C3 C4 C5 C6 C7 C8}" bash "$L/lab.sh" 2>&1; }',
      [
        'SAI="$(roda_lab "$TMP/controle.yml" "$loc")"',
        'case "$SAI" in',
        '*LAB-VERDE*) passou "…" ;;',
        '*) echo "…"',
        `echo "$SAI" | sed 's/^/      | /' | head -30`,
        'echo "…"; exit 1 ;;',
        'esac',
      ],
      [
        'local SAI; SAI="$(roda_lab "$TMP/sab.yml" "$loc" "$esperados")"',
        'case "$SAI" in',
        '*LAB-VERMELHO*) ;;',
        '*) falhou "…"; continue ;;',
        'esac',
        'case "$SAI" in',
        '*"✅ C0 controle — sem falha, step verde"*) ;;',
        '*) falhou "…"; continue ;;',
        'esac',
        'local faltando="" c',
        'for c in $esperados; do',
        'case "$SAI" in',
        '*"❌ $c"*) ;;',
        '*) faltando="$faltando $c" ;;',
        'esac',
        'done',
        'if [ -n "$faltando" ]; then',
        'falhou "…"',
        'else',
        'passou "…"',
        'fi',
      ],
    ],
    delegadoPor: 'scripts/test-retry-pgdg.sh',
  },
  'scripts/sonda-cron-prova.ts': {
    motivo:
      'cada sintético DECLARA a classe exata (os seis defeituosos: FALHA) e a FALHA não pode vir do handler que LANÇA (status -1); até 2026-09-29 valia "≠ PASSA", e INVERIFICAVEL/NAO_COMPILA contavam como defeito pego',
    mede: ['cls'],
    ancoras: [
      [
        'const v = JSON.parse(linhas[linhas.length - 1]) as Veredito;',
        'const cls = classificarVeredito(v, false);',
        "const esperado: Classe = classeExata.get(nome) ?? (devemPassar.has(nome) ? 'PASSA' : 'FALHA');",
        "const lancou = esperado === 'FALHA' && [v.a, ...(v.b ?? [])].some((x) => x?.status === -1);",
        'const ok = cls === esperado && !lancou;',
      ],
    ],

  },

  // ── Fora do `test:falsificacao`, com falsificação PRÓPRIA dentro da suíte normal (roda no
  // `test:hooks`). Registro opcional, cobrado igual: sem ele a regressão do juiz voltaria calada.
  'scripts/test-lovable-revert-scan.sh': {
    motivo:
      'o desfecho declarado é SILÊNCIO julgado: stdout mudo E exit 0 E stderr vazio como o do controle — o scan que MORRE também sai mudo; sed inválido, cópia vazia, no-op e sintaxe recusados',
    mede: ['out', 'rc'],
    ancoras: [
      'env $COR_ENV LRS_PATTERNS="^supabase/functions/" bash "${SCAN_ATUAL:-$SCAN}" 2>>"${ERROS_DO_SCAN:-/dev/null}"',
      `if printf '%s' "$out_ctl" | grep -qF "REVERSAO" && [ ! -s "$base/controle.err" ]; then`,
      '  if ! erro_sed="$(sed "$expr" "$SCAN" 2>&1 >"$base/copia.sh")" || [ -n "$erro_sed" ] || [ ! -s "$base/copia.sh" ]; then',
      [
        ': > "$base/copia.err"',
        'out="$(ERROS_DO_SCAN="$base/copia.err" run_scan)"; rc=$?',
        'if [ -n "$out" ]; then',
        'echo "…"; fail=1',
        'elif [ "$rc" -ne 0 ] || [ -s "$base/copia.err" ]; then',
        `echo "  FAIL  $nome → o alarme sumiu por CRASH, não por julgamento (exit $rc, stderr não-vazio): $(head -c 160 "$base/copia.err" | tr '\\n' ' ')"; fail=1`,
        'else',
        'echo "…"',
        'fi',
      ],
    ],

  },

  // ── A camada 4 por LINHA (2026-09-29): o stderr INTEIRO do alvo, que o EMBRULHO recolhe em cada rodada,
  // contra o do controle (scripts/lib/falsificacao-stderr.sh). Registro opcional nos laços do idioma,
  // cobrado igual: sem o embrulho na invocação sabotada, os dois stderr saem vazios — iguais — e a
  // camada fica CEGA sem ninguém acusar.
  'scripts/test-onde-parei.sh': {
    motivo: MOTIVO_CAMADA4,
    mede: ['log', 'emb', 'novas'],
    ancoras: [
      [
        'emb="$(embrulha_alvo "$copia" "$log.stderr")" || { ruim "…"; continue; }',
        'if SONDA_OVERRIDE="$emb" bash "$0" >"$log" 2>&1; then',
      ],
      '    elif novas="$(camada4 "$sab" "$log" "$ctl" "$copia" "$controle")"; [ -n "$novas" ]; then',
    ],

  },
  'scripts/test-orfaos-custosos.sh': {
    motivo: MOTIVO_CAMADA4,
    mede: ['log', 'rc', 'emb_alvo', 'novas'],
    ancoras: [
      [
        'emb_alvo="$(embrulha_alvo "$copia" "$log.stderr")" || { falha "…"; falhou=1; continue; }',
        'LC_ALL="$loc" ORFAOS_ALVO="$emb_alvo" bash "$0" >"$log.cru" 2>&1; rc=$?',
        'sem_cor "$log.cru" > "$log"',
        'if [ "$rc" -eq 0 ]; then',
        'falha "…"; falhou=1; continue',
        'fi',
      ],
      '      elif novas="$(camada4 "$sab" "$log" "$ctl" "$copia" "$controle")"; [ -n "$novas" ]; then',
    ],

  },
  'scripts/test-read-contexto-nudge.sh': {
    motivo: MOTIVO_CAMADA4,
    mede: ['log', 'rc', 'emb_alvo', 'novas'],
    ancoras: [
      [
        `emb_alvo="$(embrulha_alvo "$copia" "$log.stderr")" || { printf '…' "$loc" "$desc"; falhou=1; continue; }`,
        'LC_ALL="$loc" HOOK_SOB_TESTE="$emb_alvo" bash "$0" >"$log.cru" 2>&1; rc=$?',
        'sem_cor "$log.cru" > "$log"',
        'if [ "$rc" -eq 0 ]; then',
        `printf '…' "$loc" "$desc" "$regra"`,
        'falhou=1; continue',
        'fi',
      ],
      '      elif novas="$(camada4 "$sab" "$log" "$ctl" "$copia" "$controle")"; [ -n "$novas" ]; then',
    ],

  },
  'scripts/test-ocupacao-por-arquivo.sh': {
    motivo: `${MOTIVO_CAMADA4}; o mktemp_so_bsd DECLARA o erro do mktemp GNU — é o vermelho dele`,
    mede: ['log', 'rc', 'emb_alvo', 'novas'],
    ancoras: [
      [
        'log="$tmp/sabotada-$sab.log"',
        ': > "$log.stderr"',
        'emb_alvo="$(embrulha_alvo "$copia" "$log.stderr")" || { ruim "…"; continue; }',
        'OCUPACAO_OVERRIDE="$emb_alvo" bash "$0" >"$log.cru" 2>&1; rc=$?',
        'sem_cor "$log.cru" > "$log"',
        'if [ "$rc" -eq 0 ]; then',
        'ruim "…"; continue',
        'fi',
      ],
      '    elif novas="$(camada4 "$sab" "$log" "$ctl" "$copia" "$controle")"; [ -n "$novas" ]; then',
      `  declara_stderr mktemp_so_bsd "mktemp: too few X's in template"`,
    ],

  },
  'scripts/test-ocupacao-por-comando.sh': {
    motivo: `${MOTIVO_CAMADA4}; o stderr aqui é o RELATÓRIO, e as 7 sabotagens que o mudam DECLARAM a família de linha`,
    mede: ['log', 'rc', 'emb_alvo', 'novas'],
    ancoras: [
      [
        'log="$tmp/sabotada-$sab.log"',
        ': > "$log.stderr"',
        'emb_alvo="$(embrulha_alvo "$copia" "$log.stderr")" || { ruim "…"; continue; }',
        'OCUPACAO_OVERRIDE="$emb_alvo" bash "$0" >"$log.cru" 2>&1; rc=$?',
        'sem_cor "$log.cru" > "$log"',
        'if [ "$rc" -eq 0 ]; then',
        'ruim "…"; continue',
        'fi',
      ],
      '    elif novas="$(camada4 "$sab" "$log" "$ctl" "$copia" "$controle")"; [ -n "$novas" ]; then',
    ],

  },
  'scripts/test-fecho-edges-pendentes.sh': {
    motivo: MOTIVO_CAMADA4,
    mede: ['log', 'rc', 'emb_alvo', 'novas'],
    ancoras: [
      [
        ': > "$log.stderr"',
        `emb_alvo="$(embrulha_alvo "$copia" "$log.stderr")" || { printf '…' "$loc" "$desc"; falhou=1; continue; }`,
        '( export LC_ALL="$loc"; ALVO="$emb_alvo"; fail=0; suite; [ "$fail" -eq 0 ] ) > "$log.cru" 2>&1; rc=$?',
        'sem_cor "$log.cru" > "$log"',
        'if [ "$rc" -eq 0 ]; then',
        `printf '…' "$loc" "$desc"; falhou=1; continue`,
      ],
      '      elif novas="$(camada4 "$sab" "$log" "$ctl" "$copia" "$controle")"; [ -n "$novas" ]; then',
    ],

  },
  'scripts/test-eval-diagnostico-cegueira.sh': {
    motivo:
      'o idioma SABOTAGENS com as quatro camadas; o bloco é carregado com `.` (sem embrulho possível), então a 4ª julga tudo o que a rodada imprimiu FORA dos asserts, por linha, contra o controle',
    mede: ['log', 'rc_sab', 'novas'],
    ancoras: [
      [
        'log="$CAIXA/sabotada-$sab.log"',
        '( rodar_asserts "$mut" ) > "$log" 2>&1; rc_sab=$?; fora_dos_asserts "$log"',
        'if [ "$rc_sab" -eq 0 ]; then',
        'echo "…" >&2; cegas=$((cegas + 1)); continue',
        'fi',
      ],
      '  elif novas="$(camada4 "$sab" "$log" "$ctl" "$mut" "$BLOCO")"; [ -n "$novas" ]; then',
    ],

  },
  'scripts/test-idioma-errexit-leitura.sh': {
    motivo:
      'os FAIL declarados e SÓ eles, com a camada 2 (a rodada chega ao recibo com o nº de asserts do controle) e a 4 (nenhuma linha de stderr que o controle não traz) — até 2026-09-29, só os FAIL',
    mede: ['out', 'faltou', 'n', 'novas'],
    ancoras: [
      [
        'bash "$TMP/s.sh" > "$TMP/s.log" 2> "$TMP/s.log.stderr" && { echo "…"; FALH=$((FALH+1)); continue; }',
        'out="$(cat "$TMP/s.log")"',
        'faltou=""',
        `for id in \${decl//,/ }; do printf '%s\\n' "$out" | command grep -q "^  FAIL $id " || faltou="$faltou $id"; done`,
        `n="$(printf '%s\\n' "$out" | command grep -c '^  FAIL ' || true)"; esperado="$(printf '%s\\n' "\${decl//,/ }" | wc -w | tr -d ' ')"`,
        `if [ "$(recibo "$TMP/s.log")" != "$(recibo "$TMP/c.log")" ]; then echo "  ❌ $nome — a rodada NÃO chegou ao recibo com os $(recibo "$TMP/c.log") asserts: vermelho de aborto, não de assert"; FALH=$((FALH+1))`,
        `elif novas="$(camada4 "$nome" "$TMP/s.log" "$TMP/c.log" "$TMP/s.sh" "$SELF")"; [ -n "$novas" ]; then echo "  ❌ $nome — vermelha com erro que o CONTROLE não tem (crash, não julgamento): $(printf '%s' "$novas" | head -c 160)"; FALH=$((FALH+1))`,
        'elif [ -n "$faltou" ]; then echo "…"; FALH=$((FALH+1))',
        'elif [ "$n" != "$esperado" ]; then echo "…"; FALH=$((FALH+1))',
        'else echo "…"; VERM=$((VERM+1)); fi',
      ],
    ],

  },
  'scripts/test-bash-contexto-nudge.sh': {
    motivo:
      'limiar: exit 0 + exatamente 1 JSON + o nudge no additionalContext, E o stderr INTEIRO do hook sabotado sem linha que o hook REAL não traz na mesma entrada (até 2026-09-29, /dev/null); corte: o idioma com a camada 4 por linha',
    mede: ['saida_sab', 'rc_sab', 'novas', 'log', 'rc', 'emb_alvo'],
    ancoras: [
      [
        `saida_sab="$(printf '%s' "$(entrada 500 'ls')" | bash "$sabotado" 2>"$sabotado.err")"; rc_sab=$?`,
        `printf '%s' "$(entrada 500 'ls')" | bash "$HOOK" >/dev/null 2>"$sabotado.ctl.err"`,
        'novas="$(linhas_novas "$sabotado.err" "$sabotado.ctl.err" "$sabotado" "$HOOK")"',
        'if [ -n "$novas" ]; then',
        `echo "  FALHA o hook sabotado trouxe stderr que o REAL nao traz na mesma entrada — crash, nao o limiar: $(printf '%s' "$novas" | head -c 120)"`,
        'falhas=$((falhas + 1))',
        `elif [ "$rc_sab" -eq 0 ] && printf '%s' "$saida_sab" | jq -se 'length == 1' >/dev/null 2>&1 \\`,
        '&& ctx_de "$saida_sab" | command grep -qF "BASH-SAIDA-GRANDE"; then',
        'echo "…"',
        'elif [ -n "$saida_sab" ]; then',
        `echo "  FALHA o silêncio quebrou, mas SEM o nudge — vermelho que não é o do limiar: $(printf '%s' "$saida_sab" | head -c 100)"`,
        'falhas=$((falhas + 1))',
      ],
      [
        'log="$sab_dir/sabotada-$sab.log"; : > "$log.stderr"',
        'emb_alvo="$(embrulha_alvo "$copia" "$log.stderr")" || { echo "…"; falhas=$((falhas + 1)); continue; }',
        'NUDGE_OVERRIDE="$emb_alvo" bash "$0" > "$log" 2>&1; rc=$?',
        'if [ "$rc" -eq 0 ]; then',
        'echo "…"',
        'falhas=$((falhas + 1)); continue',
        'fi',
      ],
      '        elif novas="$(camada4 "$sab" "$log" "$ctl" "$copia" "$sab_dir/controle.sh")"; [ -n "$novas" ]; then',
    ],

  },
};

/**
 * O fecho do JUIZES (`julgarRegistro`): exatamente estes arquivos, em ordem alfabética. Juiz novo entra
 * aqui junto com a entrada; juiz que sai, sai daqui TAMBÉM — com o porquê no PR. Sem isto, apagar a
 * entrada de um juiz voluntário (o da suíte normal, fora de R3/R4) deixava o gate verde.
 */
export const REGISTRO_FECHADO: readonly string[] = [
  'db/test-authz-revoke-anon-rpc.sh',
  'db/test-canaria-veredito.sh',
  'db/test-data-health-sync-reprocess.sh',
  'db/test-db-aplicar.sh',
  'db/test-pedido-edicao-atomica.sh',
  'db/test-pedido-total-liquido-acervo.sh',
  'db/test-tint-promocao-assincrona.sh',
  'db/test-tint-promote.sh',
  'db/test-transporte-nuvem.sh',
  'scripts/lab-claude-mem-reanimar/falsifica.sh',
  'scripts/lab-claude-mem-reanimar/prova_com_tty.sh',
  'scripts/lab-retry-pgdg/falsifica.sh',
  'scripts/sonda-cron-prova.ts',
  'scripts/test-bash-contexto-nudge.sh',
  'scripts/test-claude-mem-reanimar.sh',
  'scripts/test-claude-mem-saude.sh',
  'scripts/test-codex-async-nuvem.sh',
  'scripts/test-codex-async.sh',
  'scripts/test-codex-prompt-paginacao.sh',
  'scripts/test-eval-diagnostico-cegueira.sh',
  'scripts/test-eval-via-morta.sh',
  'scripts/test-fecho-edges-pendentes.sh',
  'scripts/test-gate-senha-bootstrap.sh',
  'scripts/test-gates-frescura.sh',
  'scripts/test-gstack-auto-upgrade.sh',
  'scripts/test-guard-noop-sabotagem.sh',
  'scripts/test-idioma-errexit-leitura.sh',
  'scripts/test-instrucoes-carregadas.sh',
  'scripts/test-lovable-revert-scan.sh',
  'scripts/test-medir-footprint.sh',
  'scripts/test-ocupacao-por-arquivo.sh',
  'scripts/test-ocupacao-por-comando.sh',
  'scripts/test-onde-parei.sh',
  'scripts/test-orfaos-custosos.sh',
  'scripts/test-pr-watch.sh',
  'scripts/test-read-contexto-nudge.sh',
  'scripts/test-retry-pgdg.sh',
  'scripts/test-setup-contrato.sh',
  'scripts/test-vigia-gstack.sh',
  'scripts/test-vigia-nuvem.sh',
];

export type Regra = 'R1' | 'R2' | 'R3' | 'R4';

export interface Violacao {
  regra: Regra;
  arquivo: string;
  linha: number;
  detalhe: string;
}

export interface Analise {
  caminhos: string[];
  listas: number;
  entradas: number;
  lacos: number;
  /** Linhas `falsificar=<n>` lidas do manifesto; `null` = manifesto não fornecido/ilegível. */
  linhasNucleo: number | null;
  /** Arquivos que o `test:falsificacao` executa; `null` = package.json não fornecido/ilegível. */
  alvosFalsificacao: number | null;
  violacoes: Violacao[];
  alarmes: string[];
  /** O que o fiscal não soube medir fora do stripper (forma do roteiro): sempre 2, com ou sem pisos. */
  indeterminados: string[];
}

/** A atribuição da lista: string entre aspas (duplas ou simples) ou array. `SABOTAGENS=0` não é lista. */
const LISTA =
  /(^|[\s;&|(])(?:(?:local|readonly|export|declare(?:\s+-[A-Za-z]+)*)\s+)?SABOTAGENS=(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))/g;
/** Um ID de assert (`A7`, `T11b`), com `!MARCA` opcional: o erro de execução DECLARADO (#2606). */
const ID = '[A-Za-z0-9_]+(?:![A-Za-z0-9_]+)?';
/** Um grupo: IDs unidos por `,` (E) ou `|` (OU). Nada de curinga. */
const GRUPO = `${ID}(?:[,|]${ID})*`;
/** Uma entrada: `nome:VERMELHOS`, com `:VERDES` opcional — o que tem de continuar verde. */
const ENTRADA = new RegExp(`^[A-Za-z_][A-Za-z0-9_.-]*:${GRUPO}(?::${GRUPO})?$`);
const LACO = /\bfor\s+([A-Za-z_]\w*)\s+in\s+(?:"?\$\{?SABOTAGENS\}?"?|"\$\{SABOTAGENS\[@\]\}")(?=\s*(?:;|\n|do\b))/g;

const linhaDe = (texto: string, indice: number) => texto.slice(0, indice).split('\n').length;

/**
 * O corpo do laço: da linha do `for` até o `done` com a MESMA indentação — grep DEPOIS do laço não
 * julga sabotagem nenhuma (Codex). Laço de uma linha termina nela; recuo irregular cai no fim do
 * arquivo (lê a mais, nunca a menos: o erro fica do lado de não acusar).
 */
function corpoDoLaco(limpo: string, inicio: number): string {
  const fimDaLinha = limpo.indexOf('\n', inicio);
  const linhaDoFor = limpo.slice(inicio, fimDaLinha === -1 ? undefined : fimDaLinha);
  if (/\bdone\b/.test(linhaDoFor)) return linhaDoFor;
  const recuo = limpo.slice(limpo.lastIndexOf('\n', inicio - 1) + 1, inicio);
  const fim = /^[ \t]*$/.test(recuo) ? new RegExp(`\\n${recuo}done\\b`).exec(limpo.slice(inicio)) : null;
  return fim ? limpo.slice(inicio, inicio + fim.index + fim[0].length) : limpo.slice(inicio);
}
const ref = (nome: string) => new RegExp(`\\$\\{?${nome}(?![A-Za-z0-9_])`);
const tiraAspas = (t: string) => t.replace(/^(['"])(.*)\1$/, '$2');

/**
 * R2 para UM laço: a declaração extraída chega a um `grep`? Segue a CADEIA até o ponto fixo: toda
 * variável derivada por expansão de outra da cadeia (`verm="${resto%%:*}"`, `id="${x%%!*}"`) e todo
 * `for` sobre uma delas (`for x in ${verm//,/ }`). O idioma do #2606 tem três elos até o grep.
 */
function lacoConsome(depois: string, v: string): { decl: string | null; chega: boolean } {
  const extracao = new RegExp(`\\b([A-Za-z_]\\w*)="?\\$\\{${v}##?\\*:\\}"?`).exec(depois);
  if (!extracao) return { decl: null, chega: false };
  const cadeia = new Set([extracao[1]]);
  for (let visto = 0; visto !== cadeia.size; ) {
    visto = cadeia.size;
    for (const n of [...cadeia]) {
      const deriva = new RegExp(`\\b([A-Za-z_]\\w*)="?\\$\\{${n}(?![A-Za-z0-9_])`, 'g');
      const itera = new RegExp(`\\bfor\\s+([A-Za-z_]\\w*)\\s+in\\s+[^\\n;]*\\$\\{?${n}(?![A-Za-z0-9_])`, 'g');
      for (const m of depois.matchAll(deriva)) cadeia.add(m[1]);
      for (const m of depois.matchAll(itera)) cadeia.add(m[1]);
    }
  }
  // Continuação `\` junta a linha: `grep -Eq … \` + `"$declarado" "$log"` é UM comando (Codex).
  const comandos = depois.replace(/\\\n/g, ' ').split('\n');
  const chega = comandos.some((l) => /\bgrep\b/.test(l) && [...cadeia].some((n) => ref(n).test(l)));
  return { decl: extracao[1], chega };
}

type Deteccao = { listas: number; entradas: number; lacos: number; violacoes: Violacao[] };

export function detectar(caminho: string, fonte: string): Deteccao {
  return detectarLimpo(caminho, removerComentariosShell(fonte));
}

/** R1 e R2 sobre a fonte JÁ limpa pelo stripper compartilhado (uma passagem só por arquivo). */
function detectarLimpo(caminho: string, limpo: string): Deteccao {
  const violacoes: Violacao[] = [];
  let listas = 0;
  let entradas = 0;
  for (const m of limpo.matchAll(LISTA)) {
    listas++;
    const linha = linhaDe(limpo, (m.index ?? 0) + m[1].length);
    const itens = (m[2] ?? m[3] ?? m[4] ?? '').split(/\s+/).filter(Boolean).map(tiraAspas);
    entradas += itens.length;
    if (itens.length === 0) {
      violacoes.push({ regra: 'R1', arquivo: caminho, linha, detalhe: 'lista SABOTAGENS vazia: a falsificação não sabota nada' });
    }
    for (const item of itens) {
      if (!ENTRADA.test(item)) {
        violacoes.push({
          regra: 'R1',
          arquivo: caminho,
          linha,
          detalhe: `entrada "${item}" não declara o assert que TEM de acusá-la (forma: nome:VERMELHOS[:VERDES], IDs por , ou |, ID!MARCA)`,
        });
      }
    }
  }
  let lacos = 0;
  for (const m of limpo.matchAll(LACO)) {
    lacos++;
    const inicio = m.index ?? 0;
    const linha = linhaDe(limpo, inicio);
    const { decl, chega } = lacoConsome(corpoDoLaco(limpo, inicio), m[1]);
    if (decl === null) {
      violacoes.push({
        regra: 'R2',
        arquivo: caminho,
        linha,
        detalhe: `o laço "for ${m[1]} in $SABOTAGENS" descarta a declaração (nenhum \${${m[1]}#*:}): o veredito volta a ser o exit`,
      });
    } else if (!chega) {
      violacoes.push({
        regra: 'R2',
        arquivo: caminho,
        linha,
        detalhe: `a declaração "${decl}" nunca chega a um grep do log: o laço a extrai e julga por outra coisa`,
      });
    }
  }
  if (listas > 0 && lacos === 0) {
    violacoes.push({ regra: 'R2', arquivo: caminho, linha: 1, detalhe: 'lista SABOTAGENS que nenhum laço "for X in $SABOTAGENS" percorre' });
  }
  return { listas, entradas, lacos, violacoes };
}

/** As linhas `falsificar=<n>` do manifesto (fora-do-ci não entra: o CI não lê recibo nenhum dali). */
export function lerNucleo(manifesto: string): { arquivo: string; linha: number }[] {
  return manifesto
    .split('\n')
    .map((l, i) => ({ l: l.trim(), linha: i + 1 }))
    .filter(({ l }) => !l.startsWith('#'))
    .map(({ l, linha }) => ({ m: /^(\S+)\s+\d+\s+falsificar=\d+(?:\s|$)/.exec(l), linha }))
    .filter((x): x is { m: RegExpExecArray; linha: number } => x.m !== null)
    .map(({ m, linha }) => ({ arquivo: m[1], linha }));
}

/**
 * R3: cada `falsificar=<n>` usa o idioma LIMPO (se prova sozinho pelo R1/R2) ou tem juiz; cada juiz
 * registrado foi lido e tem TODAS as âncoras no código.
 */
export function julgarNucleo(
  nucleo: { arquivo: string; linha: number }[],
  limpos: ReadonlyMap<string, string>,
  juizes: Readonly<Record<string, Juiz>>,
  idiomaLimpo: ReadonlySet<string> = new Set(),
  regraDaAncora: (arquivo: string) => Regra = () => 'R3',
): Violacao[] {
  const v: Violacao[] = [];
  for (const { arquivo, linha } of nucleo) {
    if (!(arquivo in juizes) && !idiomaLimpo.has(arquivo)) {
      v.push({
        regra: 'R3',
        arquivo: MANIFESTO_NUCLEO,
        linha,
        detalhe: `${arquivo} tem falsificar=<n> sem o idioma SABOTAGENS limpo e sem JUIZ registrado: o CI confiaria no recibo sem saber se o vermelho é do assert`,
      });
    }
  }
  return [...v, ...julgarAncoras(limpos, juizes, regraDaAncora)];
}

/** Forma normal de uma linha de código: sem recuo nem espaço no fim, espaço interno colapsado. */
const normalizarLinha = (linha: string) => linha.trim().replace(/[ \t]+/g, ' ');
const escaparRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A âncora (já normalizada) como regex: tudo literal, menos o curinga de prosa. `"…"` é UMA string
 * entre aspas duplas (com `\"` escapada dentro, como o shell); `'…'`, uma entre simples (sem escape,
 * como o shell) — nenhum dos dois atravessa a aspa que fecha, então código entre duas strings não some.
 */
const padraoDe = (trecho: string) =>
  normalizarLinha(trecho)
    .split(/("…"|'…')/)
    .map((p) => (p === '"…"' ? String.raw`"(?:[^"\\]|\\.)*"` : p === "'…'" ? "'[^']*'" : escaparRegex(p)))
    .join('');

interface LinhaDeCodigo {
  /** 1-based na fonte (o stripper preserva o número de linhas). */
  n: number;
  texto: string;
}
/** As linhas de CÓDIGO, normalizadas — a vazia (e o comentário, que o stripper esvaziou) não conta. */
const linhasDeCodigo = (limpo: string): LinhaDeCodigo[] =>
  limpo
    .split('\n')
    .map((l, i) => ({ n: i + 1, texto: normalizarLinha(l) }))
    .filter((l) => l.texto !== '');

export interface Achado {
  ini: number;
  fim: number;
  /** A âncora casa a(s) linha(s) INTEIRA(s) — só assim ela prende a escrita que mora ali. */
  inteira: boolean;
}

/** Onde a âncora casa no código limpo (vazio = sumiu). Bloco: linhas CONSECUTIVAS de código, inteiras. */
export function acharAncora(limpo: string, ancora: Ancora): Achado[] {
  const codigo = linhasDeCodigo(limpo);
  if (typeof ancora === 'string') {
    const trecho = new RegExp(padraoDe(ancora));
    const inteira = new RegExp(`^${padraoDe(ancora)}$`);
    return codigo.filter((l) => trecho.test(l.texto)).map((l) => ({ ini: l.n, fim: l.n, inteira: inteira.test(l.texto) }));
  }
  const linhas = ancora.map((l) => new RegExp(`^${padraoDe(l)}$`));
  const achados: Achado[] = [];
  for (let i = 0; i + linhas.length <= codigo.length; i++) {
    if (linhas.every((re, k) => re.test(codigo[i + k].texto))) {
      achados.push({ ini: codigo[i].n, fim: codigo[i + linhas.length - 1].n, inteira: true });
    }
  }
  return achados;
}

/** Por que o bloco não casa: o maior prefixo dele que casa, e a linha que não seguiu. */
function diagnosticoDoBloco(limpo: string, bloco: readonly string[]): string {
  const codigo = linhasDeCodigo(limpo);
  const linhas = bloco.map((l) => new RegExp(`^${padraoDe(l)}$`));
  let melhor = { k: 0, i: -1 };
  for (let i = 0; i < codigo.length; i++) {
    let k = 0;
    while (k < linhas.length && i + k < codigo.length && linhas[k].test(codigo[i + k].texto)) k++;
    if (k > melhor.k) melhor = { k, i };
  }
  if (melhor.k === 0) return 'a 1ª linha não está no código';
  const ultima = codigo[melhor.i + melhor.k - 1];
  const seguinte = codigo[melhor.i + melhor.k];
  return `casa até «${bloco[melhor.k - 1]}» (linha ${ultima.n}), e ${
    seguinte ? `a linha ${seguinte.n} não é` : 'o arquivo acaba antes de'
  } «${bloco[melhor.k]}»`;
}

type Forma = { re: RegExp; emComando: boolean };

/** `"$V"`, `$V`, `"${V}"` ou `${V}` como PALAVRA inteira — `"$V.cru"` é outro arquivo. */
const alvoDe = (n: string) => String.raw`"?\$(?:${n}|\{${n}\})"?(?=[\s;&|)<>]|$)`;

/**
 * As formas de ESCREVER uma variável de shell. O grupo 1 é o ponto que a máscara do stripper julga
 * (1 = código): `echo "D=720"` é prosa, `x="$(D=1)"` é código. Fora daqui (resíduo documentado):
 * `eval`, nameref (`declare -n`), `printf -v "$1"` indireto, `source` de arquivo que a atribui.
 */
function formasShell(n: string): Forma[] {
  const fim = String.raw`(?!\w)`;
  const antesDeOp = String.raw`(?:[-+*/%&|^]|<<|>>)?=(?!=)`;
  return [
    // V=… · V+=… · V[i]=… — começo de palavra, inclusive depois de local/export/declare/readonly
    { re: new RegExp(String.raw`(?<=^|[\s;&|(){}\x60!])(${n})(?:\[[^\]\n]*\])?\+?=`, 'dgm'), emComando: true },
    { re: new RegExp(String.raw`\b(?:read|mapfile|readarray|unset)\b[^\n;&|]*?[ \t](${n})${fim}`, 'dg'), emComando: true },
    { re: new RegExp(String.raw`\bprintf[ \t]+-v[ \t]*(${n})${fim}`, 'dg'), emComando: true },
    { re: new RegExp(String.raw`\bfor[ \t]+(${n})[ \t]+in\b`, 'dg'), emComando: true },
    // `${V:=…}` atribui também dentro de "…"
    { re: new RegExp(String.raw`\$\{(${n}):?=`, 'dg'), emComando: false },
    { re: new RegExp(String.raw`\blet\b[^\n;&|]*?(?<![\w$])(${n})[ \t]*${antesDeOp}`, 'dg'), emComando: true },
    { re: new RegExp(String.raw`\(\([^()\n]*?(?<![\w$])(${n})[ \t]*(?:${antesDeOp}|\+\+|--)`, 'dg'), emComando: true },
    { re: new RegExp(String.raw`\(\([^()\n]*?(?:\+\+|--)(${n})${fim}`, 'dg'), emComando: true },
    // o CONTEÚDO do arquivo que ela nomeia: > "$V" · >> · 2> · &> · | tee [-a] "$V"
    { re: new RegExp(String.raw`(?:^|[^<>&\d])((?:\d|&)?>>?)[ \t]*${alvoDe(n)}`, 'dgm'), emComando: true },
    { re: new RegExp(String.raw`\b(tee)\b(?:[ \t]+-a)?[ \t]+${alvoDe(n)}`, 'dg'), emComando: true },
  ];
}

const OP_TS = String.raw`(?:[-+*/%&|^]|\*\*|<<|>>>?|\?\?|\|\||&&)?=(?![=>])`;
/**
 * TS: atribuição (inclusive a da declaração, `const x = …`) e `++`/`--` — o fonte já sem comentário;
 * string conta (lado fail-closed). `const` em OUTRO escopo cai fora do juízo pelo recorte.
 */
const formasTs = (n: string): Forma[] => [
  { re: new RegExp(String.raw`(?<![\w$.])(${n})[ \t]*${OP_TS}`, 'dg'), emComando: false },
  { re: new RegExp(String.raw`(?:\+\+|--)(${n})(?![\w$])`, 'dg'), emComando: false },
  { re: new RegExp(String.raw`(?<![\w$.])(${n})(?:\+\+|--)`, 'dg'), emComando: false },
];

function linhasDasFormas(limpo: string, formas: Forma[], mascara: Uint8Array | null): number[] {
  const linhas = new Set<number>();
  for (const { re, emComando } of formas) {
    for (const m of limpo.matchAll(re)) {
      const pos = m.indices?.[1]?.[0] ?? m.index ?? 0;
      if (emComando && mascara !== null && mascara[pos] !== 1) continue;
      linhas.add(linhaDe(limpo, pos));
    }
  }
  return [...linhas].sort((a, b) => a - b);
}

/** As linhas onde o código ESCREVE a variável (valor, ou o conteúdo do arquivo que ela nomeia). */
export function escritasDe(limpo: string, variavel: string, ts: boolean): number[] {
  const n = escaparRegex(variavel);
  return ts ? linhasDasFormas(limpo, formasTs(n), null) : linhasDasFormas(limpo, formasShell(n), mascaraContexto(limpo));
}

/**
 * A âncora LÊ a variável? Shell: `$V`/`${V…`, ou o nome nu dentro de `(( … ))` (aritmética não usa `$`).
 * TS: o identificador fora de posição de escrita.
 */
function leVariavel(ancora: Ancora, variavel: string, ts: boolean): boolean {
  const n = escaparRegex(variavel);
  const le = ts
    ? new RegExp(String.raw`(?<![\w$.])(?<!\b(?:const|let|var)[ \t]+)${n}(?![\w$])(?![ \t]*${OP_TS})`)
    : new RegExp(String.raw`\$\{?${n}(?!\w)|\(\([^()]*?(?<![\w$])${n}(?!\w)`);
  return (typeof ancora === 'string' ? [ancora] : ancora).some((l) => le.test(l));
}

const rotuloDoBloco = (b: readonly string[]) => `${b.length} linhas, de «${b[0]}» a «${b[b.length - 1]}»`;

/**
 * Todo juiz registrado foi LIDO, tem TODAS as âncoras no código limpo e a LIGAÇÃO com a medição: cada
 * variável julgada só é escrita em linhas presas inteiras, e alguma âncora a lê. A regra que reprova é
 * a do domínio que obriga o registro — R4 para um alvo do `test:falsificacao`, R3 para o resto.
 */
export function julgarAncoras(
  limpos: ReadonlyMap<string, string>,
  juizes: Readonly<Record<string, Juiz>>,
  regraDe: (arquivo: string) => Regra = () => 'R3',
): Violacao[] {
  const v: Violacao[] = [];
  for (const [arquivo, juiz] of Object.entries(juizes)) {
    const regra = regraDe(arquivo);
    const limpo = limpos.get(arquivo);
    const acusa = (linha: number, detalhe: string) => v.push({ regra, arquivo, linha, detalhe });
    if (limpo === undefined) {
      acusa(1, 'juiz registrado para arquivo que o fiscal não leu (renomeado? removido?)');
      continue;
    }
    /** As linhas presas INTEIRAS por alguma âncora (só elas podem escrever a variável julgada), e as de cada âncora. */
    const presas = new Set<number>();
    const ocupa = new Map<Ancora, number[]>();
    for (const ancora of juiz.ancoras) {
      const achados = acharAncora(limpo, ancora);
      if (achados.length === 0) {
        acusa(
          1,
          typeof ancora === 'string'
            ? `âncora do juiz sumiu do código: ${ancora} — (${juiz.motivo})`
            : `bloco do juízo rompeu (${rotuloDoBloco(ancora)}): ${diagnosticoDoBloco(limpo, ancora)} — (${juiz.motivo})`,
        );
      }
      ocupa.set(ancora, achados.flatMap(({ ini, fim }) => Array.from({ length: fim - ini + 1 }, (_, i) => ini + i)));
      for (const { ini, fim, inteira } of achados) if (inteira) for (let l = ini; l <= fim; l++) presas.add(l);
    }
    const ts = ehTypeScript(arquivo);
    const texto = limpo.split('\n');
    if (juiz.mede.length === 0 && (juiz.semLigacao ?? '').trim() === '') {
      acusa(1, `juiz sem variável julgada (\`mede\` vazio) e sem \`semLigacao\` que diga por quê: a ligação medição→veredito voltaria a ser voluntária (${juiz.motivo})`);
    }
    for (const nome of juiz.mede) {
      const escritas = escritasDe(limpo, nome, ts);
      if (escritas.length === 0) {
        acusa(1, `a variável julgada ${nome} não é ESCRITA em lugar nenhum do código — a medição sumiu, ou mudou de nome (${juiz.motivo})`);
        continue;
      }
      const leitoras = juiz.ancoras.filter((a) => leVariavel(a, nome, ts));
      if (leitoras.length === 0) {
        acusa(1, `nenhuma âncora LÊ a variável julgada ${nome}: a medição presa não está ligada a veredito nenhum (${juiz.motivo})`);
      }
      const medicoes = escritas.filter((l) => presas.has(l));
      if (medicoes.length === 0) {
        acusa(
          escritas[0],
          `a medição da variável julgada ${nome} não está presa: nenhuma escrita dela (${escritas.length === 1 ? 'linha' : 'linhas'} ${escritas.join(', ')}) está numa linha presa INTEIRA por uma âncora (${juiz.motivo})`,
        );
        continue;
      }
      // O JUÍZO vai da 1ª medição presa à última linha de âncora que lê a variável: ali dentro, uma
      // escrita a mais troca o que o veredito julga. Fora dele, não (a medição sobrescreve antes; o
      // veredito já leu depois) — e é por isso que o `rc=$?` da suíte normal não precisa de âncora.
      const lidas = leitoras.flatMap((a) => ocupa.get(a) ?? []);
      const ini = Math.min(...medicoes, ...lidas);
      const fim = Math.max(...medicoes, ...lidas);
      for (const l of escritas) {
        if (l < ini || l > fim || presas.has(l)) continue;
        acusa(
          l,
          `a variável julgada ${nome} é ESCRITA na linha ${l}, dentro do juízo (linhas ${ini}–${fim}), fora das âncoras — o veredito julgaria ela, não a medição: «${normalizarLinha(texto[l - 1] ?? '')}» (${juiz.motivo})`,
        );
      }
    }
  }
  return v;
}

/**
 * O REGISTRO FECHADO: o JUIZES tem exatamente estes arquivos. Metade dos juízes é VOLUNTÁRIA (falsifica
 * dentro da suíte normal, fora de R3/R4) — sem o fecho, apagar a entrada inteira deixava o gate verde e o
 * juiz regredia sem ninguém ver (Codex, 2026-09-27). Remover um juiz passa a ser DUAS mudanças no diff.
 */
export function julgarRegistro(
  juizes: Readonly<Record<string, Juiz>>,
  registro: readonly string[],
  regraDe: (arquivo: string) => Regra = () => 'R3',
): Violacao[] {
  const fechado = new Set(registro);
  const v: Violacao[] = [];
  for (const arquivo of registro) {
    if (!(arquivo in juizes)) {
      v.push({
        regra: regraDe(arquivo),
        arquivo,
        linha: 1,
        detalhe: `juiz do REGISTRO FECHADO sumiu do JUIZES — encolher o registro é decisão EXPLÍCITA: tire-o também do REGISTRO_FECHADO, com o porquê no PR`,
      });
    }
  }
  for (const arquivo of Object.keys(juizes)) {
    if (!fechado.has(arquivo)) {
      v.push({
        regra: regraDe(arquivo),
        arquivo,
        linha: 1,
        detalhe: `juiz fora do REGISTRO FECHADO — acrescente-o ao REGISTRO_FECHADO (é o que torna a remoção dele, depois, uma decisão explícita)`,
      });
    }
  }
  return v;
}

/** O que o roteiro `test:falsificacao` executa, e o que sobrou dele sem o fiscal saber expandir. */
export interface Falsificacao {
  alvos: string[];
  /** Vazio = toda a forma do roteiro foi reconhecida; qualquer texto aqui é INDETERMINADO. */
  residuo: string;
  /** A linha do roteiro no package.json — onde o R4 aponta. */
  linha: number;
}

/** Invocação direta reconhecida: `bash|bun scripts/<arquivo>` (sem `$`: o molde do laço é do parser compartilhado). */
const INVOCACAO = /\b(?:bash|bun)\s+(scripts\/[A-Za-z0-9_./-]+\.(?:sh|ts))(?:\s+--[A-Za-z][A-Za-z-]*)*/g;
const LACO_DO_ROTEIRO = /for\s+\w+\s+in\s+[^;]+;\s*do\b([\s\S]*?)\bdone\b/g;
const MOLDE_DO_LACO = /\bbash\s+scripts\/[A-Za-z0-9_.-]*\$\{?\w+\}?[A-Za-z0-9_.-]*\.sh(?:\s+--[A-Za-z][A-Za-z-]*)*/g;

/**
 * Lê o roteiro do package.json CRU. `null` = sem roteiro ou JSON ilegível (ausente ≠ zero alvos). Os
 * alvos do laço vêm de `arquivosExecutados` — o MESMO parser do `test:hooks`, para os dois não
 * divergirem no dia em que a forma do laço mudar; os de fora dele, das invocações diretas.
 */
export function lerFalsificacao(pacote: string): Falsificacao | null {
  let roteiro: unknown;
  try {
    roteiro = (JSON.parse(pacote) as { scripts?: Record<string, unknown> }).scripts?.[ROTEIRO];
  } catch {
    return null;
  }
  if (typeof roteiro !== 'string') return null;
  const diretos = [...roteiro.matchAll(INVOCACAO)].map((m) => m[1]);
  // `arquivosExecutados` devolve o nome relativo a `scripts/` (é o que os dois leitores dele comparam).
  const doLaco = arquivosExecutados(roteiro).map((f) => `scripts/${f}`);
  const alvos = [...new Set([...doLaco, ...diretos])].sort();
  // O resíduo: o roteiro sem os laços reconhecidos (cabeçalho, molde e `done`), sem as invocações
  // diretas e sem os conectivos. O que sobrar é uma forma que o fiscal não sabe expandir.
  const residuo = roteiro
    .replace(LACO_DO_ROTEIRO, (_laco, corpo: string) => ` ${corpo.replace(MOLDE_DO_LACO, ' ')} `)
    .replace(INVOCACAO, ' ')
    .replace(/&&|\|\||;|\bexit\s+\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const linha = pacote.split('\n').findIndex((l) => l.includes(`"${ROTEIRO}"`)) + 1;
  return { alvos, residuo, linha: linha > 0 ? linha : 1 };
}

/**
 * R4: cada alvo do `test:falsificacao` foi LIDO e usa o idioma limpo ou tem juiz registrado. As âncoras
 * dos juízes registrados são cobradas em `julgarAncoras`, com a regra R4.
 */
export function julgarFalsificacao(
  f: Falsificacao,
  limpos: ReadonlyMap<string, string>,
  juizes: Readonly<Record<string, Juiz>>,
  idiomaLimpo: ReadonlySet<string>,
): Violacao[] {
  const v: Violacao[] = [];
  for (const alvo of f.alvos) {
    if (!limpos.has(alvo)) {
      v.push({
        regra: 'R4',
        arquivo: PACOTE,
        linha: f.linha,
        detalhe: `o ${ROTEIRO} executa ${alvo}, que o fiscal não leu — slug com nome errado, ou extensão fora do corpo julgado: rodar não é estar julgado`,
      });
    } else if (!(alvo in juizes) && !idiomaLimpo.has(alvo)) {
      v.push({
        regra: 'R4',
        arquivo: PACOTE,
        linha: f.linha,
        detalhe: `${alvo} roda no ${ROTEIRO} sem o idioma SABOTAGENS limpo e sem JUIZ registrado: um juiz "exit≠0" entraria no CI sem ninguém acusar`,
      });
    }
  }
  return v;
}

/** Fonte que NÃO é shell (o `sonda-cron-prova.ts` do roteiro): stripper de TS, só âncoras — R1/R2 são idioma de shell. */
const ehTypeScript = (caminho: string) => /\.(?:ts|mts|cts)$/.test(caminho);

export function analisar(
  arquivos: { caminho: string; fonte: string }[],
  manifesto: string | null = null,
  juizes: Readonly<Record<string, Juiz>> = JUIZES,
  pacote: string | null = null,
  /** O fecho do registro (o corpo do repo passa `REGISTRO_FECHADO`); `null` = fixture, sem fecho. */
  registro: readonly string[] | null = null,
): Analise {
  const r: Analise = {
    caminhos: [],
    listas: 0,
    entradas: 0,
    lacos: 0,
    linhasNucleo: null,
    alvosFalsificacao: null,
    violacoes: [],
    alarmes: [],
    indeterminados: [],
  };
  const limpos = new Map<string, string>();
  /** Os arquivos que se provam sozinhos: têm lista SABOTAGENS e nenhuma violação de R1/R2. */
  const idiomaLimpo = new Set<string>();
  for (const a of arquivos) {
    if (ehTypeScript(a.caminho)) {
      // O sentinela do stripper de TS: bloco descartado acima do teto calibrado = a limpeza comeu código.
      const bloco = maiorBlocoDescartado(a.fonte);
      if (bloco > TETO_BLOCO_DESCARTADO) {
        r.alarmes.push(`${a.caminho}: o stripper de TS descartou um bloco de ${bloco} linhas (teto ${TETO_BLOCO_DESCARTADO})`);
      }
      limpos.set(a.caminho, removerComentarios(a.fonte));
      continue;
    }
    const limpo = removerComentariosShell(a.fonte);
    const d = detectarLimpo(a.caminho, limpo);
    r.caminhos.push(a.caminho);
    r.listas += d.listas;
    r.entradas += d.entradas;
    r.lacos += d.lacos;
    r.violacoes.push(...d.violacoes);
    if (d.listas > 0 && d.violacoes.length === 0) idiomaLimpo.add(a.caminho);
    r.alarmes.push(...alarmesDoStripper(a.caminho, diagnosticarShell(a.fonte)));
    limpos.set(a.caminho, limpo);
  }
  const falsificacao = pacote === null ? null : lerFalsificacao(pacote);
  const alvosR4 = new Set(falsificacao?.alvos ?? []);
  const regraDe = (arquivo: string): Regra =>
    alvosR4.has(arquivo) || alvosR4.has(juizes[arquivo]?.delegadoPor ?? '') ? 'R4' : 'R3';
  if (manifesto !== null) {
    const nucleo = lerNucleo(manifesto);
    r.linhasNucleo = nucleo.length;
    r.violacoes.push(...julgarNucleo(nucleo, limpos, juizes, idiomaLimpo, regraDe));
  } else if (pacote !== null) {
    r.violacoes.push(...julgarAncoras(limpos, juizes, regraDe));
  }
  if (registro !== null) r.violacoes.push(...julgarRegistro(juizes, registro, regraDe));
  if (falsificacao !== null) {
    r.alvosFalsificacao = falsificacao.alvos.length;
    r.violacoes.push(...julgarFalsificacao(falsificacao, limpos, juizes, idiomaLimpo));
    if (falsificacao.residuo !== '') {
      r.indeterminados.push(
        `o ${ROTEIRO} tem uma forma que o fiscal não sabe expandir: "${falsificacao.residuo}" — o que ela executa ficaria sem julgamento`,
      );
    }
  }
  return r;
}

export function veredito(r: Analise, comPisos: boolean): { codigo: 0 | 1 | 2; linhas: string[] } {
  const furos = r.alarmes.map((a) => `stripper desabando — ${a}`);
  furos.push(...r.indeterminados);
  if (r.caminhos.length === 0) furos.push('nenhum arquivo shell lido');
  if (comPisos) {
    for (const [raiz, piso] of Object.entries(PISOS.arquivosPorRaiz)) {
      const lidos = r.caminhos.filter((c) => c.startsWith(`${raiz}/`)).length;
      if (lidos < piso) furos.push(`${lidos} arquivo(s) shell em ${raiz}/ < piso ${piso}`);
    }
    if (r.listas < PISOS.listas) furos.push(`${r.listas} lista(s) SABOTAGENS vista(s) < piso ${PISOS.listas}`);
    if (r.entradas < PISOS.entradas) furos.push(`${r.entradas} entrada(s) de sabotagem vista(s) < piso ${PISOS.entradas}`);
    if (r.lacos < PISOS.lacos) furos.push(`${r.lacos} laço(s) sobre SABOTAGENS visto(s) < piso ${PISOS.lacos}`);
    if (r.linhasNucleo === null) furos.push(`manifesto do núcleo (${MANIFESTO_NUCLEO}) não foi lido`);
    else if (r.linhasNucleo < PISOS.linhasFalsificarNucleo) {
      furos.push(`${r.linhasNucleo} linha(s) falsificar=<n> no núcleo < piso ${PISOS.linhasFalsificarNucleo} — o formato mudou?`);
    }
    if (r.alvosFalsificacao === null) furos.push(`roteiro ${ROTEIRO} do ${PACOTE} não foi lido`);
    else if (r.alvosFalsificacao < PISOS.alvosFalsificacao) {
      furos.push(`${r.alvosFalsificacao} alvo(s) do ${ROTEIRO} < piso ${PISOS.alvosFalsificacao} — a forma do roteiro mudou?`);
    }
  }
  if (furos.length > 0) {
    return {
      codigo: 2,
      linhas: ['❌ INDETERMINADO — o fiscal não conseguiu medir (isto NÃO é "limpo"):', ...furos.map((f) => `  · ${f}`)],
    };
  }
  if (r.violacoes.length > 0) {
    return {
      codigo: 1,
      linhas: [
        `❌ ${r.violacoes.length} veredito(s) de falsificação que aceitariam um vermelho que não é do assert:`,
        ...r.violacoes.map((v) => `  [${v.regra}] ${v.arquivo}:${v.linha}  ${v.detalhe}`),
        '',
        '  Exit≠0 não é dente: o vermelho tem de ser do SEU assert (docs/agent/money-path.md). Cada sabotagem',
        '  declara o assert que TEM de acusá-la e o laço exige ESSE assert no log — sabotagem não aplicável ou',
        '  vermelha por outro motivo é FALHA. docs/historico/falsificacao-exit-nao-e-dente.md',
      ],
    };
  }
  const censo = comPisos
    ? `, ${r.linhasNucleo} linha(s) falsificar=<n> do núcleo e ${r.alvosFalsificacao} alvo(s) do ${ROTEIRO} julgados (idioma limpo ou juiz)`
    : '';
  return {
    codigo: 0,
    linhas: [
      `✅ falsificar/exige-assert: ${r.caminhos.length} arquivo(s) shell, ${r.listas} lista(s) SABOTAGENS com ` +
        `${r.entradas} entrada(s) declaradas e ${r.lacos} laço(s) que consomem a declaração${censo}.`,
    ],
  };
}

const lerOuNulo = (caminho: string): string | null => {
  try {
    return readFileSync(caminho, 'utf8');
  } catch {
    return null; // quem acusa é o veredito (INDETERMINADO ou R4), não o silêncio daqui
  }
};

/**
 * O corpo que o CI julga: todo shell das raízes padrão, o manifesto do núcleo, o package.json e os
 * alvos do `test:falsificacao` que não são shell (o `.ts` do fim do roteiro). O teste lê por AQUI.
 */
export function lerCorpoDoRepo(base: string): {
  arquivos: { caminho: string; fonte: string }[];
  manifesto: string | null;
  pacote: string | null;
} {
  const arquivos = enumerar(RAIZES_PADRAO, base).map((c) => ({ caminho: relative(base, c), fonte: readFileSync(c, 'utf8') }));
  const manifesto = lerOuNulo(join(base, MANIFESTO_NUCLEO));
  const pacote = lerOuNulo(join(base, PACOTE));
  const lidos = new Set(arquivos.map((a) => a.caminho));
  for (const alvo of lerFalsificacao(pacote ?? '')?.alvos ?? []) {
    if (lidos.has(alvo)) continue;
    const fonte = lerOuNulo(join(base, alvo));
    if (fonte !== null) arquivos.push({ caminho: alvo, fonte }); // não lido → o R4 acusa pelo nome
  }
  return { arquivos, manifesto, pacote };
}

function main(): number {
  const argv = process.argv.slice(2);
  const { arquivos, manifesto, pacote } =
    argv.length === 0
      ? lerCorpoDoRepo(raizDoRepo())
      : {
          arquivos: enumerar(argv, process.cwd()).map((c) => ({ caminho: relative(process.cwd(), c), fonte: readFileSync(c, 'utf8') })),
          manifesto: null,
          pacote: null,
        };
  const doRepo = argv.length === 0;
  const { codigo, linhas } = veredito(analisar(arquivos, manifesto, JUIZES, pacote, doRepo ? REGISTRO_FECHADO : null), doRepo);
  if (codigo === 0) console.log(linhas.join('\n'));
  else console.error(linhas.join('\n'));
  return codigo;
}

if (import.meta.main) process.exit(main());
