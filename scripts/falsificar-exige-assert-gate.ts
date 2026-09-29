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
 *      aceitar qualquer vermelho. Juiz de arquivo não lido reprova.
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
 * linha que sustenta o juiz; quem prova o juiz é a meta-falsificação registrada no diário.
 */

import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { maiorBlocoDescartado, removerComentarios } from '@/lib/gates/limpeza-fonte';
import { diagnosticarShell, removerComentariosShell } from '@/lib/gates/limpeza-shell';
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

export interface Juiz {
  /** POR QUE o vermelho que este arquivo conta é do assert — o idioma dele, em uma frase. */
  motivo: string;
  /** Trechos de CÓDIGO (sobrevivem ao stripper) sem os quais o juiz volta a aceitar qualquer vermelho. */
  ancoras: string[];
  /**
   * O arquivo que DESPACHA para este juiz (o slug do `test:falsificacao` que roda um `lab-*`): a
   * âncora que some daqui reprova com a regra do despachante — o juiz de verdade mora aqui.
   */
  delegadoPor?: string;
}

/**
 * Os juízes do núcleo. Obrigatório para toda linha `falsificar=<n>` do manifesto; opcional (mas
 * cobrado igual, âncora por âncora) para os que fazem a falsificação DENTRO da suíte normal e foram
 * consertados na mesma leva — sem o registro, a regressão deles voltaria calada.
 */
export const JUIZES: Readonly<Record<string, Juiz>> = {
  'db/test-data-health-sync-reprocess.sh': {
    motivo:
      'SABOTAGENS nome:A<n> (R1/R2), e a rodada só conta se a sabotagem APLICOU, a suíte rodou INTEIRA e o assert declarado virou de verde para vermelho',
    ancoras: [
      `if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then`,
      `elif [ "$(executados "$log")" != "$asserts_controle" ]; then`,
      `! grep -Eq "^  ❌ ($exigido) " "$log"`,
      `elif [ "$erros_sql" != "$erros_controle" ]; then`,
      `elif [ -n "$faltam" ]; then`,
    ],
  },
  'db/test-canaria-veredito.sh': {
    motivo:
      'sabota <id> <desc> <marca>: CERTO só com a marca da asserção nos 2 locales; SQL inválido e morte do shell recusados; padrão que não casa invalida',
    ancoras: [`m="$(julga_log "$log" "$marca")"`, `if tem_marca "$1" "$2"; then printf 'CERTO'; else printf "vermelho SEM a marca`, 'padrao nao casou, SQL intacto'],
  },
  'db/test-db-aplicar.sh': {
    motivo: 'confere <rc> <rc-esperado> <log> <marca>…: CERTO só com o rc EXATO e TODAS as marcas; o rc sozinho é recusado',
    ancoras: [
      'confere sem marca: o rc sozinho aceita qualquer vermelho',
      `grep -qF -- "$marca" "$log" || faltam=`,
      `if [ -n "$faltam" ]; then printf 'rc %s certo, SEM a marca`,
    ],
  },
  'db/test-pedido-total-liquido-acervo.sh': {
    motivo:
      'vermelha <rótulo> <valor> <verde> <declarado>: conta só o valor que a sabotagem DECLARA; vermelha_por exige a assinatura do ramo; texto inalterado é falha',
    ancoras: [
      `elif [ "$2" = "$4" ]; then sab_verm`,
      `vermelha_por() { if [ "$2" = "$3" ]; then sab_verm`,
      'a sabotagem não alterou o texto da migration',
      'else sab_falha "$1 — vermelha, mas NÃO no valor que a sabotagem declara',
      '"$(estado_c)" "23514:pedido_venda_coerencia"',
      `elif grep -q 'ERROR:  POSTCONDICAO FALHOU' "$TMPD/post.out"`,
    ],
  },
  'db/test-transporte-nuvem.sh': {
    motivo:
      'sabota <id> <marca>: vermelho só com a marca do assert (`FALHA [T<n>]`) no log, sobre um controle `0 fail` da MESMA invocação; sabotagem que não aplica é falha',
    ancoras: [
      `grep -qE '^RESULTADO: [0-9]+ ok / 0 fail$' "$TMP/controle.log"`,
      `if grep -qF -- "$marca" "$log"; then`,
      `echo "  FALHA $id: vermelho SEM a marca '$marca' (motivo errado)"`,
      'a sabotagem nao aplicou (o texto-alvo mudou?)',
    ],
  },
  // Pré-registrado para o #2605, que o põe no núcleo com `falsificar=12` (o registro de arquivo lido e
  // ancorado vale mesmo antes da linha do manifesto existir).
  'db/test-tint-promocao-assincrona.sh': {
    motivo:
      'fals <nome> <esperado>: vermelho só com o CONJUNTO EXATO de asserts caídos (falhas_de); sabotagem no-op aborta (cmp na migration, RAISE no corpo do promote)',
    ancoras: [
      `got="$(suite "$mig" "$sab" | falhas_de)"`,
      `if [ "$got" = "$esperado" ]; then`,
      'echo "  ✗ $nome: esperado [$esperado], veio [$got]"',
      `if cmp -s "$MIG" "$1"; then echo "✗ sabotagem no-op`,
    ],
  },
  'db/test-authz-revoke-anon-rpc.sh': {
    motivo: 'falsificação na suíte normal: ABORTOU só com a marca da postcondição na saída do apply; outro erro vira "ERRO ALHEIO"',
    ancoras: [`elif grep -q 'ERROR:  POSTCONDICAO FALHOU' "$alvo.out"; then echo "ABORTOU"`, 'else echo "ERRO ALHEIO a postcondicao:'],
  },
  'db/test-tint-promote.sh': {
    motivo:
      'falsificação na suíte normal: a divergência EXATA que cada sabotagem declara (F1 720, F2 1928) — "qualquer ≠ 0" aceitava divergência de outra causa',
    ancoras: [
      '  720)  ok "F1 — NULL-honesto furado diverge do loop em $DSAB linhas',
      '  *)    echo "✗ F1 FALHOU: a identidade divergiu em $DSAB linhas, NÃO nas 720 que a sabotagem declara"; exit 1 ;;',
      '  1928) ok "F2 — fator=1 diverge do loop em $DSAB2 linhas',
      '  *)    echo "✗ F2 FALHOU: a identidade divergiu em $DSAB2 linhas, NÃO nas 1928 que a sabotagem declara"; exit 1 ;;',
    ],
  },
  'db/test-pedido-edicao-atomica.sh': {
    motivo:
      'falsificação na suíte normal: rc≠0 só conta com a marca do que a sabotagem DECLARA vir no lugar da recusa (default: a chamada completa)',
    ancoras: [
      'no_lugar="${5:-ASSERT_NAO_LANCOU}"',
      'erro="${out#*ERROR:  }"',
      `*:*"$no_lugar"*)`,
      'bad "$1 — sabotado, mas o vermelho não é o declarado [$no_lugar]',
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
    ancoras: [
      `      elif printf '%s' "$saida_suite" | grep -qF "FAIL [$marca]"; then`,
      `        printf '  FAIL [%s]  vermelho pelo motivo ERRADO (locale %s): faltou FAIL [%s]. Veio:\\n' "$id" "$loc" "$marca"`,
      `    bash -n "$alvo" 2>/dev/null || { printf '  FAIL [%s]  sabotagem quebrou a SINTAXE (vermelho por crash nao prova nada)\\n' "$id"; falhas=1; return; }`,
      '  [ "$falhas" -eq 0 ] || { echo "FALSIFICACAO ABORTADA: sem controle verde nada abaixo tem valor."; exit 1; }',
    ],
  },
  'scripts/test-codex-async-nuvem.sh': {
    motivo: 'o molde do codex-async: troca LITERAL que casa exatamente 1×, `bash -n`, controle verde nos 2 locales, e `FAIL [<marca>]` do assert declarado',
    ancoras: [
      '      elif grep -qF "FAIL [$marca]" <<< "$saida_suite"; then',
      'if s.count(de)!=1: sys.exit(1)',
      '  [ "$falhas" -eq 0 ] || { echo "FALSIFICACAO ABORTADA: sem controle verde nada abaixo tem valor."; exit 1; }',
    ],
  },
  'scripts/test-gate-senha-bootstrap.sh': {
    motivo:
      'sabota a ENTRADA (planta o defeito na raiz-fixture) com controle antes de cada uma: rc EXATO + o marcador do ramo + a senha falsa ausente; sabotagem que não muda a raiz aborta',
    ancoras: [
      '  if [ "$rc" -ne "$rc_esp" ]; then falhou "$desc — esperava rc=$rc_esp, veio rc=$rc"; return; fi',
      '  if ! grep -q "$marca" "$TMP/saida"; then falhou "$desc — rc certo, mas sem o marcador $marca"; return; fi',
      '  if grep -q "$FALSA" "$TMP/saida"; then falhou "$desc — VAZOU a senha falsa na saída do gate"; return; fi',
      '  if [ "$antes" = "$depois" ]; then',
    ],
  },
  'scripts/test-codex-prompt-paginacao.sh': {
    motivo: 'o VALOR devolvido pela definição sabotada: G1/G2 = o SHA do citador, G3/G4 vazios, e exatamente 2 vermelhos — o defeito exato, não um erro que esvazia a resposta',
    ancoras: [
      `[ "$got_1856" = "$sha_citador" ]      || faltam="$faltam G1(veio '$got_1856', esperado o citador '$sha_citador')"`,
      `[ "$got_1889" = "$sha_citador_1889" ] || faltam="$faltam G2(veio '$got_1889', esperado o citador '$sha_citador_1889')"`,
      'if [ -n "$faltam" ] || [ "$falhas" -ne 2 ]; then',
    ],
  },
  'scripts/test-guard-noop-sabotagem.sh': {
    motivo: 'rc 1 E a LINHA exata (`grep -qxF`) da resposta do guard frágil com o alvo presente; `bash -n` antes — o bash cita a linha do erro de sintaxe',
    ancoras: [
      "  marca_exata='     com o alvo PRESENTE o guard respondeu:   [XX ] sabotagem NO-OP (alvo sumiu)'",
      '  LC_ALL=C grep -qxF -- "$marca_exata" <<<"$veredito" && rc_v="$rc_v+marca"',
      '    1+marca:*)',
      '  if ! bash -n "$TMP/sabotado.sh" 2>/dev/null; then',
    ],
  },
  'scripts/test-eval-via-morta.sh': {
    motivo: 'S1: exit EXATO 1 + o baseline do caso-alvo vermelho + o recibo do laço completo (12); S2: nenhuma pegada, com o recibo — erro alheio e laço abortado são recusados',
    ancoras: [
      `  1:*'o caso-alvo "velho_com_controle"'*'cegueira(s) em 12 sabotagem(ns)'*)`,
      '  *) ruim "S1 saiu do verde, mas NÃO pelo declarado (exit 1 + o baseline do caso-alvo vermelho): saiu $r_rc — erro alheio não é dente"',
      '  *"cegueira(s) em 12 sabotagem(ns)"*)',
    ],
  },
  'scripts/test-gates-frescura.sh': {
    motivo: 'sabota a ENTRADA (a raiz-fixture) com controle remontado antes de cada uma: rc EXATO + o marcador do ramo (ORFAO, CENSO-OBSOLETO, …)',
    ancoras: [
      '  if [ "$rc" -ne "$rc_esp" ]; then',
      `  if ! printf '%s' "$saida" | grep -q "$marca"; then`,
      '    falhou "$desc — rc correto mas sem o marcador $marca"',
    ],
  },
  'scripts/test-vigia-gstack.sh': {
    motivo: 'controle verde por locale (aborta sem ele); cópia que difere; exit EXATO 1 + `FAIL [<caso>]` do caso-alvo',
    ancoras: [
      `    if [ "$rc" -eq 1 ] && printf '%s\\n' "$saida" | grep -F "FAIL [$alvo]" >/dev/null; then`,
      '    if cmp -s "$HOOK" "$copia"; then',
      `      printf 'ABORTA — controle nao esta verde (LC_ALL=%s, rc=%s). Sabotar agora aprovaria qualquer coisa.\\n%s\\n' "$1" "$rc" "$saida"`,
    ],
  },
  'scripts/test-vigia-nuvem.sh': {
    motivo: 'o molde do vigia-gstack: controle verde por locale, sabotagem que muda o arquivo, exit EXATO 1 + `FAIL [<caso>]`',
    ancoras: [
      `    if [ "$rc" -eq 1 ] && printf '%s\\n' "$saida" | grep -F "FAIL [$2]" >/dev/null; then`,
      '    if ! preparar "$1-$LOC" "$4" "$5"; then',
      `      printf 'ABORTA — controle SEM sabotagem ja esta VERMELHO (LC_ALL=%s, rc=%s). Sabotar agora aprovaria qualquer coisa.\\n%s\\n' \\`,
    ],
  },
  // Entrou no roteiro com o #2655 DURANTE este PR — e o R4 o acusou no rebase, antes de registrado:
  // exatamente o caso que o R4 existe para pegar. Relido: o molde do vigia-gstack, recortado ao caso.
  'scripts/test-gstack-auto-upgrade.sh': {
    motivo:
      'o molde do vigia-gstack: controle verde por locale (aborta sem ele), cópia que difere, e a rodada RECORTADA ao caso-alvo (SO_CASO) tem de sair exit EXATO 1 com `FAIL [<caso>]`',
    ancoras: [
      `    if [ "$rc" -eq 1 ] && printf '%s\\n' "$saida" | grep -F "FAIL [$caso]" >/dev/null; then`,
      '    saida="$(LC_ALL="$LOC" SO_CASO="$caso" GSTACK_AUTO_UPGRADE_SCRIPT="$copia" bash "$0" 2>&1)"; rc=$?',
      '    if cmp -s "$ALVO" "$copia"; then',
      `      printf 'ABORTA — controle nao esta verde (LC_ALL=%s, rc=%s). Sabotar agora aprovaria qualquer coisa.\\n%s\\n' "$1" "$rc" "$saida"`,
    ],
  },
  'scripts/test-instrucoes-carregadas.sh': {
    motivo: 'o molde do vigia-gstack: controle verde por locale, cópia que difere, exit EXATO 1 + `FAIL [<caso>]`',
    ancoras: [
      `    if [ "$rc" -eq 1 ] && printf '%s\\n' "$saida" | grep -F "FAIL [$alvo]" >/dev/null; then`,
      '    if cmp -s "$HOOK" "$copia"; then',
      `      printf 'ABORTA — controle nao esta verde (LC_ALL=%s, rc=%s). Sabotar agora aprovaria qualquer coisa.\\n%s\\n' "$1" "$rc" "$saida"`,
    ],
  },
  'scripts/test-pr-watch.sh': {
    motivo: 'a marca carrega o ID do caso E o valor errado exato (`FAIL [nao-obrig-mergeia] exit: want 0, got 4`); sed inválido, no-op e sintaxe quebrada são sabotagem vazia',
    ancoras: [
      '      elif ! grep -qF -- "$marca" <<<"$saida_suite"; then',
      '    if ! bash -n "$copia" 2>/dev/null; then',
      '         "FAIL [nao-obrig-mergeia] exit: want 0, got 4" \\',
    ],
  },
  'scripts/test-claude-mem-saude.sh': {
    motivo: 'controle das duas cópias íntegras; sed inválido/no-op/sintaxe recusados; `FALHA <caso>:` do caso declarado em cada locale',
    ancoras: [
      '      elif ! grep -qF -- "FALHA ${SCASO[i]}:" "$r"; then',
      "      if grep -qx 'RC=0' \"$r\"; then",
      '    elif ! bash -n "$copia" 2>/dev/null; then',
    ],
  },
  'scripts/test-setup-contrato.sh': {
    motivo:
      'marca do ramo (erro do motor, nome do teste) casada só nas linhas de FALHA: fora das `✓` e do code-frame, onde o vitest cita teste VERDE — até 2026-09-29 casava na saída inteira',
    ancoras: [
      `linhas_de_falha() { sem_ansi "$1" | LC_ALL=C grep -avE '^[[:space:]]*(✓|[0-9]*[[:space:]]*\\|)'; }`,
      '  falha_txt="$(linhas_de_falha "$saida")"',
      '      grep -qaF -- "$alt" <<<"$falha_txt" && { achou=1; break; }',
      '    aviso "  ❌ [$nome] vermelho (rc=$rc) mas SEM a marca do ramo:$faltando"',
    ],
  },
  'scripts/test-medir-footprint.sh': {
    motivo:
      'medição incompleta (rc, campo não numérico, 0 amostras) é ruim; o vermelho que conta é o SENTIDO declarado — SAB1 cai, SAB2/SAB4 sobem, SAB3 abaixo do mínimo; até 2026-09-29 valia "fora da janela" para qualquer lado',
    ancoras: [
      'elif [ "$(( S1_PESADO - S1_LEVE ))" -gt "$JANELA_MAX" ]; then',
      'elif [ "$(( S2_DIV - S2_LEVE ))" -lt "$JANELA_MIN" ]; then',
      'elif [ "$(( S4_SEQ - S4_LEVE ))" -lt "$SEQ_MIN" ]; then',
      '  [ "$R_EXIT" -eq 0 ] || return 1',
    ],
  },
  'scripts/test-claude-mem-reanimar.sh': {
    motivo: 'despacha para lab-claude-mem-reanimar/{falsifica.sh, prova_com_tty.sh --falsificar} e exige rc 0 + a LINHA exata do marcador verde de cada um',
    ancoras: [
      '  roda falsifica.sh FALSIFICACAO-VERDE || exit 1',
      '  roda prova_com_tty.sh FALSIFICACAO-COM-TTY-VERDE --falsificar',
      '  if [ "$rc" -eq 0 ] && grep -qx "$marca" "$saida"; then',
    ],
  },
  'scripts/lab-claude-mem-reanimar/falsifica.sh': {
    motivo: 'RC≠0 + LAB-VERMELHO (o lab TERMINOU) + o texto da FALHA declarada numa linha `  FALHA `, por locale',
    ancoras: [
      "    if ! grep -qx 'RC=[1-9][0-9]*' \"$r\"; then",
      "    elif ! grep -qx 'LAB-VERMELHO' \"$r\"; then",
      `    elif ! grep -F '  FALHA ' "$r" | grep -qF -- "\${ESPERADO[i]}"; then`,
    ],
    delegadoPor: 'scripts/test-claude-mem-reanimar.sh',
  },
  'scripts/lab-claude-mem-reanimar/prova_com_tty.sh': {
    motivo: 'o python sabotado tem de parsear; PROVA-COM-TTY-VERMELHA (a prova TERMINOU) + a FALHA declarada, com os rc exatos no texto',
    ancoras: [
      "        elif ! grep -qx 'PROVA-COM-TTY-VERMELHA' \"$r\"; then",
      `        elif ! grep -F '  FALHA ' "$r" | grep -qF -- "\${ESPERADO[i]}"; then`,
    ],
    delegadoPor: 'scripts/test-claude-mem-reanimar.sh',
  },
  'scripts/test-retry-pgdg.sh': {
    motivo: 'despacha para lab-retry-pgdg/falsifica.sh e exige rc 0 + a LINHA exata do marcador verde',
    ancoras: ['  roda falsifica.sh FALSIFICACAO-VERDE', '  if [ "$rc" -eq 0 ] && grep -qx "$2" "$saida"; then'],
  },
  'scripts/lab-retry-pgdg/falsifica.sh': {
    motivo: 'LAB-VERMELHO + o controle C0 do lab VERDE (quebrar o lab não é quebrar a guarda) + CADA caso declarado vermelho, por locale',
    ancoras: [
      '      *LAB-VERMELHO*) ;;',
      '      *"✅ C0 controle — sem falha, step verde"*) ;;',
      '        *"❌ $c"*) ;;',
      '      falhou "$nome [$loc] — vermelho, mas os casos${faltando} seguiram verdes"',
    ],
    delegadoPor: 'scripts/test-retry-pgdg.sh',
  },
  'scripts/sonda-cron-prova.ts': {
    motivo:
      'cada sintético DECLARA a classe exata (os seis defeituosos: FALHA) e a FALHA não pode vir do handler que LANÇA (status -1); até 2026-09-29 valia "≠ PASSA", e INVERIFICAVEL/NAO_COMPILA contavam como defeito pego',
    ancoras: [
      "        const esperado: Classe = classeExata.get(nome) ?? (devemPassar.has(nome) ? 'PASSA' : 'FALHA');",
      "        const lancou = esperado === 'FALHA' && [v.a, ...(v.b ?? [])].some((x) => x?.status === -1);",
      '        const ok = cls === esperado && !lancou;',
    ],
  },

  // ── Fora do `test:falsificacao`, com falsificação PRÓPRIA dentro da suíte normal (roda no
  // `test:hooks`). Registro opcional, cobrado igual: sem ele a regressão do juiz voltaria calada.
  'scripts/test-lovable-revert-scan.sh': {
    motivo:
      'o desfecho declarado é SILÊNCIO julgado: stdout mudo E exit 0 E stderr vazio como o do controle — o scan que MORRE também sai mudo; sed inválido, cópia vazia, no-op e sintaxe recusados',
    ancoras: [
      '  if [ -n "$out" ]; then',
      '  elif [ "$rc" -ne 0 ] || [ -s "$base/copia.err" ]; then',
      `if printf '%s' "$out_ctl" | grep -qF "REVERSAO" && [ ! -s "$base/controle.err" ]; then`,
      '  if ! erro_sed="$(sed "$expr" "$SCAN" 2>&1 >"$base/copia.sh")" || [ -n "$erro_sed" ] || [ ! -s "$base/copia.sh" ]; then',
    ],
  },
};

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

/**
 * Todo juiz registrado foi LIDO e tem TODAS as âncoras no código limpo. A regra que reprova é a do
 * domínio que obriga o registro — R4 para um alvo do `test:falsificacao`, R3 para o resto.
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
    if (limpo === undefined) {
      v.push({ regra, arquivo, linha: 1, detalhe: 'juiz registrado para arquivo que o fiscal não leu (renomeado? removido?)' });
      continue;
    }
    for (const ancora of juiz.ancoras) {
      if (!limpo.includes(ancora)) {
        v.push({ regra, arquivo, linha: 1, detalhe: `âncora do juiz sumiu do código: ${ancora} — (${juiz.motivo})` });
      }
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
  const { codigo, linhas } = veredito(analisar(arquivos, manifesto, JUIZES, pacote), argv.length === 0);
  if (codigo === 0) console.log(linhas.join('\n'));
  else console.error(linhas.join('\n'));
  return codigo;
}

if (import.meta.main) process.exit(main());
