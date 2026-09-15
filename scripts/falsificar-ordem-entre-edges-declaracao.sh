#!/usr/bin/env bash
# falsificar-ordem-entre-edges-declaracao.sh — o gate da declaração de ordem no CORPO do PR sabe ficar VERMELHO?
#
# Irmão de `falsificar-ordem-entre-edges.sh` (#2501), com as mesmas regras e pelo mesmo motivo: um gate
# que só se viu passar não provou nada — sempre-verde aprova tudo, e sempre-vermelho também "pega" o
# defeito (docs/historico/falsificacao-sem-linha-de-base.md). Este harness instala, UM de cada vez, os
# defeitos que o desenho existe para impedir, em três camadas:
#
# · o NÚCLEO — cada regra da gramática da linha, da população e do julgamento contra o manifesto;
# · a FIAÇÃO — o diff, o inventário com controle positivo, os manifestos do HEAD e da base, a releitura
#   do re-run, o exit;
# · o YAML — cada invariante que, quebrada, faz o check exigido aprovar sem julgar ou travar o PR.
#
# e exige que a suíte fique vermelha PELO TESTE CERTO.
#
# ## As regras que ele obedece (CLAUDE.md §Armadilhas, "Teste SQL negativo")
#
# 1. COMMIT antes de falsificar. A restauração é `git checkout --` do arquivo sabotado; com alvo
#    sujo o harness recusa começar, porque restaurar apagaria trabalho que não é dele.
# 2. Controle verde na MESMA invocação, antes da primeira sabotagem, em CADA locale. Controle que
#    não fecha "3 arquivos passaram" aborta sem sabotar nada — sabotar sobre vermelho não mede.
# 3. Os DOIS locales: `LC_ALL=C` e `pt_BR.UTF-8`. Falsificar num ambiente só não prova a asserção
#    (#1483). A marca é ASCII, caixa fixa, casada sem `-i`.
# 4. A marca é o título do teste dono da regra, e tem de ser EXCLUSIVA do vermelho: se ela aparece
#    no log do controle verde da mesma invocação, casaria qualquer vermelho (#2487) — a captura é
#    recusada.
# 5. Sabotagem que não aplicou (trecho ausente ou repetido) é falsificação INVÁLIDA, contada como
#    falha — nunca como "o gate não pega".
#
# ## UMA vaga do `heavy` para a execução inteira
#
# São ~140 execuções do vitest (controle + 68 sabotagens, × 2 locales). Pedir vaga por execução
# entraria na fila FIFO a cada uma, intercalado com as outras sessões. O wrapper se re-executa UMA vez
# sob o `heavy`, e o filho sabe pela variável que já está dentro: o `heavy` não é reentrante.
#
# ## Por que ferramenta de mão, e não step de CI
#
# A cobertura de CI é a própria suíte (`bun run test` roda os três arquivos). Este harness prova que
# ela tem DENTE; rodá-lo a cada PR custaria ~140 execuções do vitest. Rode ao mexer no gate.
#
# Uso: bun run falsificar:ordem-declaracao   ·   exit 0 = cada sabotagem virou vermelho pela marca
#      certa nos dois locales · 1 = alguma não virou · 2 = mecânica (árvore suja, locale ausente, bun)
set -euo pipefail

cd "$(dirname "$0")/.."

# Sonda ausente é fail-CLOSED: este script decide se um gate é confiável, e `command -v` não basta —
# presente-porém-quebrado esvazia o guard do mesmo jeito.
if ! bun --version >/dev/null 2>&1; then
  echo "FALSIF_SEM_BUN: bun nao respondeu a --version — sem runtime nao ha falsificacao, e 'pulei' nao e verde"
  exit 2
fi

# `heavy` quebrado faz o `exec` sair ≠ 0: o harness falha alto, nunca "falsificou" sem rodar.
if [ -z "${FALSIF_DENTRO_DO_HEAVY:-}" ] && command -v heavy >/dev/null 2>&1; then
  exec heavy env FALSIF_DENTRO_DO_HEAVY=1 bash "$0" "$@"
fi

exec bun - <<'TS'
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUITES = [
  'scripts/lib/ordem-entre-edges-declaracao.test.ts',
  'scripts/ordem-entre-edges-declaracao.test.ts',
  'scripts/ordem-entre-edges-workflow.test.ts',
];
const LOCALES = ['C', 'pt_BR.UTF-8'];
const NUCLEO = 'scripts/lib/ordem-entre-edges-declaracao.ts';
const CLI = 'scripts/ordem-entre-edges-declaracao.ts';
const WF = '.github/workflows/ordem-entre-edges.yml';
const AUTO_MERGE = '.github/workflows/auto-merge.yml';
const PACOTE = 'package.json';

interface Sabotagem { id: string; arquivo: string; defeito: string; velho: string; novo: string; marca: string }

const SABOTAGENS: Sabotagem[] = [
  // ── núcleo: a linha e o valor ─────────────────────────────────────────────────────────────
  { id: 'D01', arquivo: NUCLEO, defeito: 'nenhuma com outra caixa declara',
    velho: "  if (v === 'nenhuma') return { ok: true, declaracao: { tipo: 'nenhuma' } };",
    novo: "  if (v.toLowerCase() === 'nenhuma') return { ok: true, declaracao: { tipo: 'nenhuma' } };",
    marca: '[DECL_CAIXA_FIXA]' },
  { id: 'D02', arquivo: NUCLEO, defeito: 'nenhuma se mistura com pares',
    velho: "    if (trecho === 'nenhuma') return", novo: "    if (trecho === 'nenhuma') continue; if (false) return",
    marca: '[DECL_NENHUMA_COM_PARES]' },
  { id: 'D03', arquivo: NUCLEO, defeito: 'par sem uma das pontas passa',
    velho: "    if (nos.length < 2 || nos.includes('')) {", novo: '    if (nos.length < 1) {',
    marca: '[DECL_PAR_INCOMPLETO]' },
  { id: 'D04', arquivo: NUCLEO, defeito: 'nome fora do slug passa',
    velho: '    const torto = nos.find((n) => !SLUG_EDGE.test(n));', novo: '    const torto = nos.find(() => false);',
    marca: '[DECL_SLUG]' },
  { id: 'D05', arquivo: NUCLEO, defeito: 'edge antes dela mesma passa',
    velho: '      if (antes === depois) return', novo: '      if (false) return',
    marca: '[DECL_EDGE_ANTES_DELA_MESMA]' },
  { id: 'D06', arquivo: NUCLEO, defeito: 'par repetido aparece duas vezes',
    velho: '      if (vistos.has(chaveDoPar(antes, depois))) continue;', novo: '      if (false) continue;',
    marca: '[DECL_PAR_REPETIDO]' },
  { id: 'D07', arquivo: NUCLEO, defeito: 'cadeia vira so o primeiro par',
    velho: '    for (let i = 1; i < nos.length; i++) {', novo: '    for (let i = 1; i < Math.min(nos.length, 2); i++) {',
    marca: '[DECL_CADEIA]' },
  // `String.raw` no Bun devolve o não-ASCII ESCAPADO (a seta vira o texto →), então trecho com
  // não-ASCII vai em string comum. Medido: com String.raw a D08 saiu "0 ocorrencia(s)" nos dois locales.
  { id: 'D08', arquivo: NUCLEO, defeito: 'seta ASCII nao vale',
    velho: 'const SETA = /\\s*(?:→|->)\\s*/;', novo: 'const SETA = /\\s*→\\s*/;',
    marca: '[DECL_SETAS]' },
  { id: 'D09', arquivo: NUCLEO, defeito: 'crases ficam no nome',
    velho: '  return m ? m[1].trim() : no;', novo: '  return no;',
    marca: '[DECL_CRASES_NO_NOME]' },
  { id: 'D10', arquivo: NUCLEO, defeito: 'virgula nao separa pares',
    velho: '  for (const trecho of v.split(/[;,]/).map((t) => t.trim())) {', novo: '  for (const trecho of v.split(/[;]/).map((t) => t.trim())) {',
    marca: '[DECL_SEPARADORES]' },
  { id: 'D11', arquivo: NUCLEO, defeito: 'linha indentada declara',
    velho: String.raw`const LINHA_DECLARACAO = /^Ordem entre edges:([\s\S]*)$/;`, novo: String.raw`const LINHA_DECLARACAO = /^\s*Ordem entre edges:([\s\S]*)$/;`,
    marca: '[DECL_QUASE_ACERTO_DECORACAO]' },
  { id: 'D12', arquivo: NUCLEO, defeito: 'chave com outra caixa declara',
    velho: String.raw`const LINHA_DECLARACAO = /^Ordem entre edges:([\s\S]*)$/;`, novo: String.raw`const LINHA_DECLARACAO = /^Ordem entre edges:([\s\S]*)$/i;`,
    marca: '[DECL_QUASE_ACERTO_CAIXA]' },
  { id: 'D13', arquivo: NUCLEO, defeito: 'exemplo em bloco cercado declara',
    velho: '  const { texto, cercaAberta } = removerCercas(corpo);', novo: '  const { cercaAberta } = removerCercas(corpo);\n  const texto = corpo;',
    marca: '[DECL_CERCA_IGNORADA]' },
  { id: 'D14', arquivo: NUCLEO, defeito: 'o \\r do CRLF vira parte do valor',
    velho: '  const v = valor.trim();', novo: "  const v = valor.replace(/^ +| +$/g, '');",
    marca: '[DECL_CRLF]' },
  { id: 'D15', arquivo: NUCLEO, defeito: 'quase-acerto nunca e apontado',
    velho: String.raw`  return /^ordem entre edges\s*:/.test(nua);`, novo: '  return false;',
    marca: '[DECL_QUASE_ACERTO_DECORACAO]' },
  { id: 'D16', arquivo: NUCLEO, defeito: 'titulo nao e decoracao',
    velho: "    .replace(/[*_`>#]/g, '')", novo: "    .replace(/[*_`>]/g, '')",
    marca: '[DECL_QUASE_ACERTO_DECORACAO]' },
  { id: 'D17', arquivo: NUCLEO, defeito: 'marcador de lista nao e decoracao',
    velho: String.raw`    .replace(/^\s*(?:[-+]|\d+[.)])\s+/, '')`, novo: "    .replace(/^$/, '')",
    marca: '[DECL_QUASE_ACERTO_DECORACAO]' },
  { id: 'D18', arquivo: NUCLEO, defeito: 'duplicada vale a primeira',
    velho: "  if (declaracoes.length > 1) return { estado: 'duplicada', linhas: declaracoes.map((d) => d.linha) };",
    novo: '  if (declaracoes.length > 1) declaracoes.splice(1);',
    marca: '[DECL_DUPLICADA]' },
  { id: 'D19', arquivo: NUCLEO, defeito: 'valor ilegivel vira ausente',
    velho: "    return lido.ok ? { estado: 'valida', linha, declaracao: lido.declaracao } : { estado: 'invalida', linha, motivo: lido.motivo };",
    novo: "    if (lido.ok) return { estado: 'valida', linha, declaracao: lido.declaracao };",
    marca: '[DECL_INVALIDA]' },
  { id: 'D20', arquivo: NUCLEO, defeito: 'linha em base 0',
    velho: '    if (m) declaracoes.push({ linha: i + 1, valor: m[1] });', novo: '    if (m) declaracoes.push({ linha: i, valor: m[1] });',
    marca: '[DECL_LINHA_BASE_1]' },
  // ── núcleo: a população ───────────────────────────────────────────────────────────────────
  { id: 'P01', arquivo: NUCLEO, defeito: 'teste e versao.ts contam como corpo',
    velho: '    if (edgesNoHead.has(edge) && contaComoCorpo(caminho, edge)) comCorpo.add(edge);',
    novo: '    if (edgesNoHead.has(edge) && caminho !== caminhoDoManifesto(edge)) comCorpo.add(edge);',
    marca: '[POP_TESTE_NAO_E_CORPO]' },
  { id: 'P02', arquivo: NUCLEO, defeito: 'pasta sem index.ts no HEAD conta como edge',
    velho: '    if (edgesNoHead.has(edge) && contaComoCorpo(caminho, edge)) comCorpo.add(edge);',
    novo: '    if (contaComoCorpo(caminho, edge)) comCorpo.add(edge);',
    marca: '[POP_SO_EDGE_DO_HEAD]' },
  { id: 'P03', arquivo: NUCLEO, defeito: 'fatia declarada em _shared/ nao conta',
    velho: '      if (f.arquivo === caminho && edgesNoHead.has(f.edge)) comCorpo.add(f.edge);', novo: '      if (false) comCorpo.add(f.edge);',
    marca: '[POP_FATIA_EM_SHARED]' },
  { id: 'P04', arquivo: NUCLEO, defeito: 'manifesto tocado nao exige declaracao',
    velho: '  return { edgesComCorpo, manifestosTocados, exigida: edgesComCorpo.length >= 2 || manifestosTocados.length > 0 };',
    novo: '  return { edgesComCorpo, manifestosTocados, exigida: edgesComCorpo.length >= 2 };',
    marca: '[POP_MANIFESTO_TOCADO]' },
  { id: 'P05', arquivo: NUCLEO, defeito: 'uma edge so ja exige',
    velho: '  return { edgesComCorpo, manifestosTocados, exigida: edgesComCorpo.length >= 2 || manifestosTocados.length > 0 };',
    novo: '  return { edgesComCorpo, manifestosTocados, exigida: edgesComCorpo.length >= 1 || manifestosTocados.length > 0 };',
    marca: '[POP_UMA_EDGE]' },
  { id: 'P06', arquivo: NUCLEO, defeito: 'manifesto tocado nao e reconhecido',
    velho: '    if (caminho === caminhoDoManifesto(edge)) manifestos.add(edge);', novo: '    if (false) manifestos.add(edge);',
    marca: '[POP_MANIFESTO_TOCADO]' },
  // ── núcleo: o julgamento ──────────────────────────────────────────────────────────────────
  { id: 'J01', arquivo: NUCLEO, defeito: 'ausente na populacao aprova',
    velho: "    if (!populacao.exigida) return { aprovado: true, marca: 'ORDEM_NAO_EXIGIDA', populacao, notas };",
    novo: "    return { aprovado: true, marca: 'ORDEM_NAO_EXIGIDA', populacao, notas };",
    marca: '[JULG_AUSENTE_REPROVA]' },
  { id: 'J02', arquivo: NUCLEO, defeito: 'edge inexistente passa',
    velho: '    const fora = [antes, depois].filter((edge) => !e.edgesNoHead.has(edge));', novo: '    const fora = [antes, depois].filter(() => false);',
    marca: '[JULG_EDGE_INEXISTENTE]' },
  { id: 'J03', arquivo: NUCLEO, defeito: 'manifesto ilegivel do par declarado vira ausente',
    velho: '    const erro = e.ilegiveisNoHead.get(depois);', novo: "    const erro = e.ilegiveisNoHead.get('');",
    marca: '[JULG_MANIFESTO_ILEGIVEL_DECLARADO]' },
  { id: 'J04', arquivo: NUCLEO, defeito: 'manifesto ausente vira par presente',
    velho: '    const noHead = e.paresNoHead.get(depois);', novo: '    const noHead = e.paresNoHead.get(depois) ?? new Set([antes]);',
    marca: '[JULG_MANIFESTO_AUSENTE]' },
  { id: 'J05', arquivo: NUCLEO, defeito: 'manifesto sem o par passa',
    velho: '    } else if (!noHead.has(antes)) {', novo: '    } else if (false) {',
    marca: '[JULG_MANIFESTO_SEM_PAR]' },
  { id: 'J06', arquivo: NUCLEO, defeito: 'par novo no manifesto dispensa declaracao',
    velho: '      if (naBase.has(a) || declarado.has(chaveDoPar(a, b))) continue;', novo: '      continue;',
    marca: '[JULG_PAR_NOVO_NAO_DECLARADO]' },
  { id: 'J07', arquivo: NUCLEO, defeito: 'par que a base ja tinha exige declaracao',
    velho: '      if (naBase.has(a) || declarado.has(chaveDoPar(a, b))) continue;', novo: '      if (declarado.has(chaveDoPar(a, b))) continue;',
    marca: '[JULG_PAR_ANTIGO_NAO_EXIGE]' },
  { id: 'J08', arquivo: NUCLEO, defeito: 'base ilegivel vira base sem pares novos',
    velho: '    const naBase = erroNaBase === undefined ? (e.paresNaBase.get(b) ?? new Set<string>()) : new Set<string>();',
    novo: '    const naBase = e.paresNaBase.get(b) ?? new Set<string>();',
    marca: '[JULG_BASE_ILEGIVEL_TUDO_NOVO]' },
  { id: 'J09', arquivo: NUCLEO, defeito: 'manifesto tocado e ilegivel passa',
    velho: '    const erro = e.ilegiveisNoHead.get(b);', novo: "    const erro = e.ilegiveisNoHead.get('');",
    marca: '[JULG_MANIFESTO_TOCADO_ILEGIVEL]' },
  { id: 'J10', arquivo: NUCLEO, defeito: 'duplicada so reprova na populacao',
    velho: "  if (x.estado === 'duplicada') {\n    return reprova([",
    novo: "  if (x.estado === 'duplicada') {\n    if (!populacao.exigida) return { aprovado: true, marca: 'ORDEM_NAO_EXIGIDA', populacao, notas };\n    return reprova([",
    marca: '[JULG_DUPLICADA_REPROVA]' },
  { id: 'J11', arquivo: NUCLEO, defeito: 'invalida so reprova na populacao',
    velho: "  if (x.estado === 'invalida') {\n    return reprova(",
    novo: "  if (x.estado === 'invalida') {\n    if (!populacao.exigida) return { aprovado: true, marca: 'ORDEM_NAO_EXIGIDA', populacao, notas };\n    return reprova(",
    marca: '[JULG_INVALIDA_REPROVA]' },
  { id: 'J12', arquivo: NUCLEO, defeito: 'so o primeiro achado aparece',
    velho: '  if (achados.length > 0) return reprova(achados);', novo: '  if (achados.length > 0) return reprova(achados.slice(0, 1));',
    marca: '[JULG_ACHADOS_ACUMULAM]' },
  { id: 'J13', arquivo: NUCLEO, defeito: 'mensagem de ausente sem as edges',
    velho: '  if (p.edgesComCorpo.length >= 2) porque.push(', novo: '  if (false) porque.push(',
    marca: '[JULG_AUSENTE_REPROVA]' },
  { id: 'J14', arquivo: NUCLEO, defeito: 'mensagem de ausente sem a dica do quase-acerto',
    velho: '  for (const q of quase) linhas.push(', novo: '  for (const q of quase.slice(quase.length)) linhas.push(',
    marca: '[JULG_DICA_QUASE_ACERTO]' },
  { id: 'F01', arquivo: NUCLEO, defeito: 'achado nao abre a linha com a marca',
    velho: 'v.achados.map((a) => `${a.marca}: ${a.mensagem}`)', novo: 'v.achados.map((a) => `- ${a.marca}: ${a.mensagem}`)',
    marca: '[FMT_MARCA_NO_INICIO]' },
  { id: 'F02', arquivo: NUCLEO, defeito: 'aprovado nao abre a linha com a marca',
    velho: '[`${v.marca}: ${RESUMO[v.marca]}`]', novo: '[`veredito ${v.marca}: ${RESUMO[v.marca]}`]',
    marca: '[FMT_MARCA_NO_INICIO]' },
  // ── fiação ────────────────────────────────────────────────────────────────────────────────
  { id: 'C01', arquivo: CLI, defeito: 'o diff vira lista vazia',
    velho: '    entradas = lerDiffNameStatus(diff.saida);', novo: "    entradas = lerDiffNameStatus('');",
    marca: '[CLI_REPO_AUSENTE]' },
  { id: 'C02', arquivo: CLI, defeito: 'manifestos do HEAD nao sao lidos',
    velho: '  const lidosHead = lerManifestos(head.saida, invHead.manifestos);', novo: '  const lidosHead = lerManifestos(head.saida, []);',
    marca: '[CLI_REPO_MANIFESTO_DO_HEAD]' },
  { id: 'C03', arquivo: CLI, defeito: 'manifestos da base nao sao lidos',
    velho: '  const lidosBase = lerManifestos(base, tocadosNaBase);', novo: '  const lidosBase = lerManifestos(base, []);',
    marca: '[CLI_REPO_PAR_DA_BASE]' },
  { id: 'C04', arquivo: CLI, defeito: 'manifesto ilegivel vira manifesto ausente',
    velho: "      lidos.ilegiveis.set(edge, mensagemDeErro(e) ?? 'ilegível');", novo: '      void e;',
    marca: '[CLI_REPO_MANIFESTO_ILEGIVEL]' },
  { id: 'C05', arquivo: CLI, defeito: 'inventario sem controle positivo',
    velho: '  if (controle !== null) return falhou(controle);', novo: '  if (controle !== null && false) return falhou(controle);',
    marca: '[CLI_REPO_HEAD_SEM_EDGE]' },
  { id: 'C06', arquivo: CLI, defeito: 're-run julga o corpo do payload velho',
    velho: "  if (Number(ambiente.GITHUB_RUN_ATTEMPT ?? '1') <= 1) return { corpo: doEvento.corpo };", novo: '  return { corpo: doEvento.corpo };',
    marca: '[CLI_CORPO_RERUN_RELE]' },
  { id: 'C07', arquivo: CLI, defeito: 'releitura que falha vira corpo vazio',
    velho: '  return r.ok ? { corpo: r.saida } :', novo: '  return true ? { corpo: r.saida } :',
    marca: '[CLI_CORPO_RELEITURA_FALHA]' },
  { id: 'C08', arquivo: CLI, defeito: 'evento sem pull_request vira corpo vazio',
    velho: '  if (!ehObjeto(pr)) return', novo: "  if (!ehObjeto(pr)) return { corpo: '', numero: 0 }; if (false) return",
    marca: '[CLI_EVENTO_MALFORMADO]' },
  { id: 'C09', arquivo: CLI, defeito: 'o diff e lido por linha, sem -z',
    velho: String.raw`  const campos = saida.split('\0');`, novo: String.raw`  const campos = saida.split('\n');`,
    marca: '[CLI_DIFF_Z]' },
  { id: 'C10', arquivo: CLI, defeito: 'achado sai com exit 0',
    velho: '  return { codigo: v.aprovado ? 0 : 1, saida: formatarVeredito(v) };', novo: '  return { codigo: 0, saida: formatarVeredito(v) };',
    marca: '[CLI_REPO_AUSENTE]' },
  { id: 'C11', arquivo: CLI, defeito: 'pasta sem index.ts vira edge',
    velho: "    if (arquivo === 'index.ts') edges.add(pasta);", novo: '    edges.add(pasta);',
    marca: '[CLI_INVENTARIO]' },
  { id: 'C12', arquivo: CLI, defeito: 'o -- do bun run vira argumento',
    velho: "  const resto = argv.filter((a) => a !== '--');", novo: '  const resto = [...argv];',
    marca: '[CLI_ARGS_SEPARADOR]' },
  { id: 'C13', arquivo: CLI, defeito: 'saida truncada do diff passa calada',
    velho: '    if (caminho === undefined) throw', novo: '    if (caminho === undefined) break; if (false) throw',
    marca: '[CLI_DIFF_INESPERADO_LANCA]' },
  // ── o YAML: cada invariante que faz o check exigido aprovar sem julgar, ou travar ───────────
  { id: 'W01', arquivo: WF, defeito: 'sem edited, vale o veredito do corpo antigo',
    velho: '    types: [opened, synchronize, reopened, edited, ready_for_review]', novo: '    types: [opened, synchronize, reopened, ready_for_review]',
    marca: '[WF_EVENTOS]' },
  { id: 'W02', arquivo: WF, defeito: 'sem ready_for_review, o draft pronto mergeia no verde antigo',
    velho: '    types: [opened, synchronize, reopened, edited, ready_for_review]', novo: '    types: [opened, synchronize, reopened, edited]',
    marca: '[WF_EVENTOS]' },
  { id: 'W03', arquivo: WF, defeito: 'filtro de caminho deixa o check exigido sem reportar',
    velho: '    branches: [main]', novo: "    branches: [main]\n    paths: ['supabase/functions/**']",
    marca: '[WF_SEM_FILTRO_DE_CAMINHO]' },
  { id: 'W04', arquivo: WF, defeito: 'job pulado por if conta como satisfeito',
    velho: '    runs-on: ubuntu-latest', novo: '    if: github.event.pull_request.draft == false\n    runs-on: ubuntu-latest',
    marca: '[WF_JOB_SEM_IF]' },
  { id: 'W05', arquivo: WF, defeito: 'passo com continue-on-error aprova o vermelho',
    velho: '      - name: Declaração de ordem entre edges', novo: '      - name: Declaração de ordem entre edges\n        continue-on-error: true',
    marca: '[WF_JOB_SEM_IF]' },
  { id: 'W06', arquivo: WF, defeito: 'job com id diferente do contexto exigido',
    velho: '  ordem-entre-edges:\n    runs-on: ubuntu-latest', novo: '  declaracao:\n    runs-on: ubuntu-latest',
    marca: '[WF_JOB_COM_NOME_DO_CONTEXTO]' },
  { id: 'W07', arquivo: WF, defeito: 'job com name diferente do contexto exigido',
    velho: '  ordem-entre-edges:\n    runs-on: ubuntu-latest', novo: '  ordem-entre-edges:\n    name: ordem\n    runs-on: ubuntu-latest',
    marca: '[WF_JOB_COM_NOME_DO_CONTEXTO]' },
  { id: 'W08', arquivo: WF, defeito: 'o CLI roda sem o evento',
    velho: '        run: bun run ordem:declaracao -- --evento "$GITHUB_EVENT_PATH"', novo: '        run: bun run ordem:declaracao -- --corpo-arquivo /dev/null',
    marca: '[WF_RODA_O_CLI_COM_EVENTO]' },
  { id: 'W09', arquivo: WF, defeito: 'sem token, o re-run nao rele o corpo',
    velho: '          GH_TOKEN: ${{ github.token }}', novo: '          SEM_TOKEN: ${{ github.token }}',
    marca: '[WF_RODA_O_CLI_COM_EVENTO]' },
  { id: 'W10', arquivo: WF, defeito: 'run antigo nao e cancelado pelo evento novo',
    velho: '  cancel-in-progress: true', novo: '  cancel-in-progress: false',
    marca: '[WF_CONCORRENCIA_POR_PR]' },
  { id: 'W11', arquivo: WF, defeito: 'token com escrita no PR',
    velho: '  pull-requests: read', novo: '  pull-requests: write',
    marca: '[WF_PERMISSOES_MINIMAS]' },
  { id: 'W12', arquivo: AUTO_MERGE, defeito: 'outro workflow disputa o nome do contexto',
    velho: '  enable-auto-merge:', novo: '  ordem-entre-edges:',
    marca: '[WF_NOME_UNICO_ENTRE_WORKFLOWS]' },
  { id: 'W13', arquivo: PACOTE, defeito: 'o script do package.json aponta para outro arquivo',
    velho: '"ordem:declaracao": "bun scripts/ordem-entre-edges-declaracao.ts"', novo: '"ordem:declaracao": "bun scripts/ordem-entre-edges.ts"',
    marca: '[WF_PACKAGE_JSON_TEM_O_SCRIPT]' },
];

const ALVOS = [...new Set(SABOTAGENS.map((s) => s.arquivo))];
const LOGS = mkdtempSync(join(tmpdir(), 'falsif-ordem-declaracao-'));

function git(args: string[]): number {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status ?? -1;
}

// ── pré-voo ─────────────────────────────────────────────────────────────────────────────────
// `git diff --quiet` sai 0 limpo, 1 sujo, outro valor é git que não respondeu: só o 0 autoriza.
const sujo = git(['diff', '--quiet', 'HEAD', '--', ...ALVOS, ...SUITES]);
if (sujo !== 0) {
  console.log(
    sujo === 1
      ? 'FALSIF_ARVORE_SUJA: commite os alvos e as suites antes — a restauracao e `git checkout --` do commit.\n' +
          '  Se a sujeira for sabotagem deixada por uma execucao interrompida, confira `git diff` antes de restaurar.'
      : `FALSIF_SEM_GIT: git diff saiu ${sujo} — sem saber se a arvore esta limpa, nao sabotar nada`,
  );
  process.exit(2);
}
const locais = spawnSync('locale', ['-a'], { encoding: 'utf8' });
const disponiveis = new Set((locais.stdout ?? '').split('\n').map((l) => l.trim().toLowerCase().replace('utf-8', 'utf8')));
for (const loc of LOCALES) {
  if (loc !== 'C' && !disponiveis.has(loc.toLowerCase().replace('utf-8', 'utf8'))) {
    console.log(`FALSIF_SEM_LOCALE: ${loc} nao aparece em \`locale -a\` — falsificar num locale so nao prova a assercao`);
    process.exit(2);
  }
}
console.log(
  process.env.FALSIF_DENTRO_DO_HEAVY === '1'
    ? 'vaga do heavy segurada para a execucao inteira'
    : 'heavy ausente: rodando sem semaforo de RAM',
);

// O wrapper já segurou a vaga do `heavy` (ou ele não existe): aqui dentro o vitest roda direto.
function vitest(locale: string, rotulo: string): { rc: number; log: string; arquivo: string } {
  const r = spawnSync('bunx', ['vitest', 'run', '--reporter=dot', ...SUITES], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: locale, LANG: locale },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 900_000,
  });
  const log = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const arquivo = join(LOGS, `${rotulo}.${locale}.log`);
  writeFileSync(arquivo, log);
  return { rc: r.status ?? -1, log, arquivo };
}

const RODOU_TUDO = new RegExp(`Test Files +${SUITES.length} passed \\(${SUITES.length}\\)`);
const RODOU = /Test Files +/;

let falhas = 0;
let certas = 0;
const ok = (msg: string) => console.log(`  OK   ${msg}`);
const xx = (msg: string) => { falhas++; console.log(`  XX   ${msg}`); };

for (const locale of LOCALES) {
  console.log(`\n=== locale ${locale} ===`);
  // ── CONTROLE VERDE, antes de qualquer sabotagem ──────────────────────────────────────────
  const controle = vitest(locale, 'controle');
  if (controle.rc !== 0 || !RODOU_TUDO.test(controle.log)) {
    console.log(`FALSIF_CONTROLE_VERMELHO: rc=${controle.rc}, sem "Test Files ${SUITES.length} passed" — abortei ANTES de sabotar`);
    console.log(`  log: ${controle.arquivo}`);
    process.exit(1);
  }
  ok(`controle verde (${SUITES.length} arquivos) — ${controle.arquivo}`);

  for (const s of SABOTAGENS) {
    const original = readFileSync(s.arquivo, 'utf8');
    const ocorrencias = original.split(s.velho).length - 1;
    if (ocorrencias !== 1) {
      xx(`${s.id} [${locale}] SABOTAGEM_NAO_APLICOU: ${ocorrencias} ocorrencia(s) do trecho em ${s.arquivo} — falsificacao invalida`);
      continue;
    }
    writeFileSync(s.arquivo, original.replace(s.velho, () => s.novo));
    let veredito: string;
    try {
      if (git(['diff', '--quiet', 'HEAD', '--', s.arquivo]) !== 1) {
        veredito = 'SABOTAGEM_NAO_APLICOU: o arquivo nao ficou diferente do commit';
      } else {
        const r = vitest(locale, s.id);
        if (r.rc === 0) veredito = 'a suite ficou VERDE com o defeito instalado';
        else if (controle.log.includes(s.marca)) veredito = `a marca ${s.marca} aparece no CONTROLE VERDE — casaria qualquer vermelho`;
        else if (!RODOU.test(r.log)) veredito = `vermelho (rc=${r.rc}) sem o sumario do vitest — a suite nem rodou`;
        else if (!r.log.includes(s.marca)) veredito = `vermelho (rc=${r.rc}) SEM a marca ${s.marca} — motivo nao confirmado (${r.arquivo})`;
        else veredito = 'CERTO';
      }
    } finally {
      if (git(['checkout', '--', s.arquivo]) !== 0 || git(['diff', '--quiet', 'HEAD', '--', s.arquivo]) !== 0) {
        console.log(`FALSIF_RESTAURACAO_FALHOU: ${s.arquivo} nao voltou ao commit — pare e confira \`git diff\``);
        process.exit(2);
      }
    }
    if (veredito === 'CERTO') {
      certas++;
      ok(`${s.id} [${locale}] ${s.defeito} -> vermelho por ${s.marca}`);
    } else {
      xx(`${s.id} [${locale}] ${s.defeito}: ${veredito}`);
    }
  }
}

const esperado = SABOTAGENS.length * LOCALES.length;
console.log(
  falhas === 0 && certas === esperado
    ? `\nFALSIFICADO: ${certas}/${esperado} sabotagens (${SABOTAGENS.length} x ${LOCALES.length} locales) viraram vermelho pela marca certa; controles verdes; alvos restaurados. Logs: ${LOGS}`
    : `\nNAO_FALSIFICADO: ${falhas} falha(s), ${certas}/${esperado} capturas certas. Logs: ${LOGS}`,
);
process.exit(falhas === 0 && certas === esperado ? 0 : 1);
TS
