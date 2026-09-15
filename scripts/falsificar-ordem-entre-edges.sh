#!/usr/bin/env bash
# falsificar-ordem-entre-edges.sh — o gate de ordem ENTRE edges (#2469) sabe ficar VERMELHO?
#
# Um gate que só se viu passar não provou nada: sempre-verde aprova tudo, e sempre-vermelho também
# "pega" o defeito (docs/historico/falsificacao-sem-linha-de-base.md). Este harness instala, UM de
# cada vez, os defeitos que o desenho existe para impedir — "estar na leva prova a predecessora",
# "o par é só o fonte", "prova sem frescor", "manifesto ilegível é sem ordem", "a colagem leva a
# leva inteira" — e exige que a suíte fique vermelha PELO TESTE CERTO.
#
# ## As regras que ele obedece (CLAUDE.md §Armadilhas, "Teste SQL negativo")
#
# 1. COMMIT antes de falsificar. A restauração é `git checkout --` do arquivo sabotado; com alvo
#    sujo o harness recusa começar, porque restaurar apagaria trabalho que não é dele.
# 2. Controle verde na MESMA invocação, antes da primeira sabotagem, em CADA locale. Controle que
#    não fecha "4 arquivos passaram" aborta sem sabotar nada — sabotar sobre vermelho não mede.
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
# São ~52 execuções do vitest (controle + 25 sabotagens, × 2 locales). Pedir vaga ao `heavy` por
# execução entraria 52 vezes na fila FIFO, intercalado com as outras sessões — medido em 2026-09-14:
# 8º da fila com 1 vaga. Então o wrapper se re-executa UMA vez sob o `heavy`, e o filho sabe pela
# variável que já está dentro: o `heavy` não é reentrante, e pedir vaga aqui dentro travaria.
#
# ## Por que ferramenta de mão, e não step de CI
#
# A cobertura de CI é a própria suíte (`bun run test` roda as quatro). Este arquivo prova que ela
# tem DENTE; rodá-lo a cada PR custaria ~50 execuções do vitest, o mesmo raciocínio medido em
# `db/falsificar-gate-corpo.sh`. Rode ao mexer no gate.
#
# Uso: bun run falsificar:ordem-edges   ·   exit 0 = cada sabotagem virou vermelho pela marca certa
#      nos dois locales · 1 = alguma não virou · 2 = mecânica (árvore suja, locale ausente, bun)
set -euo pipefail

cd "$(dirname "$0")/.."

# Sonda ausente é fail-CLOSED: este script decide se um gate de money-path é confiável, e
# `command -v` não basta — presente-porém-quebrado esvazia o guard do mesmo jeito.
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
  'scripts/lib/ordem-entre-edges.test.ts',
  'scripts/lib/pacote-entrega.test.ts',
  'scripts/pendencias-pacote.test.ts',
  'scripts/pendencias-prompt.test.ts',
];
const LOCALES = ['C', 'pt_BR.UTF-8'];
const LIB = 'scripts/lib/ordem-entre-edges.ts';
const MONTADOR = 'scripts/lib/pacote-entrega.ts';
const PACOTE = 'scripts/pendencias-pacote.ts';
const PROMPT = 'scripts/pendencias-prompt.ts';

interface Sabotagem { id: string; arquivo: string; defeito: string; velho: string; novo: string; marca: string }

const SABOTAGENS: Sabotagem[] = [
  // ── o planejador ──────────────────────────────────────────────────────────────────────────
  { id: 'S01', arquivo: LIB, defeito: 'estar na leva prova a predecessora',
    velho: '  if (naLeva.has(predecessora)) {', novo: '  if (false && naLeva.has(predecessora)) {',
    marca: '[ORDEM_B_ESPERA_A_NA_LEVA]' },
  { id: 'S02', arquivo: LIB, defeito: 'o par vira so o fonte',
    velho: '  if (obs.observado !== alvo.fonte || obs.versao !== alvo.versao) {', novo: '  if (obs.observado !== alvo.fonte) {',
    marca: '[ORDEM_PAR_VERSAO_DIVERGE_BLOQUEIA]' },
  { id: 'S03', arquivo: LIB, defeito: 'prova sem teto de frescor',
    velho: '  if (idadeMin > FRESCOR_MAX_H * 60) {', novo: '  if (false && idadeMin > FRESCOR_MAX_H * 60) {',
    marca: '[ORDEM_A_VELHA_BLOQUEIA]' },
  { id: 'S04', arquivo: LIB, defeito: 'prova sem assentamento',
    velho: '  if (idadeMin < ASSENTAR_MIN) {', novo: '  if (false && idadeMin < ASSENTAR_MIN) {',
    marca: '[ORDEM_A_RECENTE_ADIA]' },
  { id: 'S05', arquivo: LIB, defeito: 'idade real ignora a idade do JSON',
    velho: '  const idadeMin = obs.idadeHoras * 60 + Math.max(0, idadeJsonMin);', novo: '  const idadeMin = obs.idadeHoras * 60;',
    marca: '[ORDEM_IDADE_REAL_SOMA_JSON]' },
  { id: 'S06', arquivo: LIB, defeito: 'leva por nome vira prova',
    velho: '  if (e.ledger === null) {\n    return bloqueia(', novo: '  if (e.ledger === null) {\n    return { ok: true } as Prova; bloqueia(',
    marca: '[ORDEM_SEM_LEDGER_BLOQUEIA]' },
  { id: 'S07', arquivo: LIB, defeito: 'JSON sem geradoEm vira prova',
    velho: '  if (e.ledger.geradoEm === null) {\n    return bloqueia(', novo: '  if (e.ledger.geradoEm === null) {\n    return { ok: true } as Prova; bloqueia(',
    marca: '[ORDEM_SEM_GERADO_EM_BLOQUEIA]' },
  { id: 'S08', arquivo: LIB, defeito: 'veredito velho do ledger libera',
    velho: '  if (idadeJsonMin > JSON_MAX_MIN) {', novo: '  if (false && idadeJsonMin > JSON_MAX_MIN) {',
    marca: '[ORDEM_JSON_VELHO_BLOQUEIA]' },
  { id: 'S09', arquivo: LIB, defeito: 'JSON do futuro vira idade que assenta',
    velho: '  if (idadeJsonMin < -1) {', novo: '  if (false && idadeJsonMin < -1) {',
    marca: '[ORDEM_JSON_NO_FUTURO_BLOQUEIA]' },
  { id: 'S10', arquivo: LIB, defeito: 'predecessora sem par na REF vira prova',
    velho: '  if (alvo === undefined) {\n    return bloqueia(', novo: '  if (alvo === undefined) {\n    return { ok: true } as Prova; bloqueia(',
    marca: '[ORDEM_ALVO_AUSENTE_BLOQUEIA]' },
  { id: 'S11', arquivo: LIB, defeito: 'ausente do ledger vira prova',
    velho: "  if (obs === undefined) return bloqueia('ausente do veredito do ledger');", novo: '  if (obs === undefined) return { ok: true };',
    marca: '[ORDEM_A_AUSENTE_DO_LEDGER_BLOQUEIA]' },
  { id: 'S12', arquivo: LIB, defeito: 'bloqueio perde para adiamento',
    velho: '      if (p.bloqueia) bloqueada = true;', novo: '      if (p.bloqueia) bloqueada = false;',
    marca: '[ORDEM_BLOQUEIO_VENCE_ADIAMENTO]' },
  { id: 'S13', arquivo: LIB, defeito: 'ciclo nao e detectado',
    velho: '  const ciclo = acharCiclo(e.leva, e.manifestos);', novo: '  const ciclo = null as string[] | null;',
    marca: '[ORDEM_CICLO_LANCA]' },
  { id: 'S14', arquivo: LIB, defeito: 'chave desconhecida do manifesto e ignorada',
    velho: "  exigirChaves(bruto, ['formato', 'depoisDe'], onde);", novo: "  // exigirChaves(bruto, ['formato', 'depoisDe'], onde);",
    marca: '[MANIFESTO_CHAVE_EXTRA_LANCA]' },
  { id: 'S15', arquivo: LIB, defeito: 'manifesto dentro do fecho de imports nao e acusado',
    velho: '  return fecho.filter((c) => c === NOME_MANIFESTO || c.endsWith(`/${NOME_MANIFESTO}`));', novo: '  return fecho.filter(() => false);',
    marca: '[FECHO_COM_MANIFESTO]' },
  // ── o montador ────────────────────────────────────────────────────────────────────────────
  { id: 'S16', arquivo: MONTADOR, defeito: 'a colagem leva a leva inteira',
    velho: '    const daOnda = f.edges.filter((e) => liberadas.includes(e.edge));', novo: '    const daOnda = f.edges;',
    marca: '[PACOTE_RETIDA_SEM_COLAGEM]' },
  { id: 'S17', arquivo: MONTADOR, defeito: 'Publish aparece com edge retida',
    velho: '      : emOndas\n        ?', novo: '      : false\n        ?',
    marca: '[PACOTE_PUBLISH_SO_NA_ULTIMA_ONDA]' },
  { id: 'S18', arquivo: MONTADOR, defeito: 'plano incoerente com a leva passa',
    velho: '  conferirPlano(f);', novo: '  // conferirPlano(f);',
    marca: '[PACOTE_PLANO_INCOERENTE_LANCA]' },
  { id: 'S19', arquivo: MONTADOR, defeito: 'a ordem vaza para o SHA da leva sem regra',
    velho: '    ...(f.ordem.regras.length > 0', novo: '    ...(f.ordem.regras.length >= 0',
    marca: '[PACOTE_SHA_SEM_REGRA_INALTERADO]' },
  // ── o CLI do pacote ───────────────────────────────────────────────────────────────────────
  { id: 'S20', arquivo: PACOTE, defeito: 'onda parcial sai com exit 0',
    velho: '    return 4;', novo: '    return 0;',
    marca: '[PACOTE_ONDA_PARCIAL_EXIT_4]' },
  { id: 'S21', arquivo: PACOTE, defeito: 'tudo retido nao vira exit 3',
    velho: '  if (ordem.liberadas.length === 0) {', novo: '  if (false && ordem.liberadas.length === 0) {',
    marca: '[PACOTE_TUDO_RETIDO_EXIT_3]' },
  { id: 'S22', arquivo: PACOTE, defeito: 'a regua da prova le a VERSAO torta',
    velho: '    if (versao !== null) alvos.set(edge, { fonte, versao });', novo: '    if (versao !== null) alvos.set(edge, { fonte, versao: `${versao}-torta` });',
    marca: '[PACOTE_A_PROVADA_LIBERA_B_EXIT_0]' },
  // ── o inventário e o outro emissor ────────────────────────────────────────────────────────
  { id: 'S23', arquivo: PROMPT, defeito: 'manifesto listado e ilegivel vira sem ordem',
    velho: '    if (!r.ok) {\n      throw new Error(`${caminho} está no commit', novo: '    if (!r.ok) {\n      continue; throw new Error(`${caminho} está no commit',
    marca: '[PACOTE_MANIFESTO_ILEGIVEL_MECANICA]' },
  { id: 'S24', arquivo: PROMPT, defeito: 'inventario sem controle positivo',
    velho: '  if (cegas.length > 0) {', novo: '  if (false && cegas.length > 0) {',
    marca: '[PACOTE_INVENTARIO_CEGO_MECANICA]' },
  { id: 'S25', arquivo: PROMPT, defeito: 'pendencias:prompt nao recusa leva com ordem',
    velho: '  if (comOrdem.length > 0) {', novo: '  if (false && comOrdem.length > 0) {',
    marca: '[PROMPT_RECUSA_ORDEM_DECLARADA]' },
];

const ALVOS = [...new Set(SABOTAGENS.map((s) => s.arquivo))];
const LOGS = mkdtempSync(join(tmpdir(), 'falsif-ordem-'));

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
