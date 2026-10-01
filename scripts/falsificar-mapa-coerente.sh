#!/usr/bin/env bash
# falsificar-mapa-coerente.sh — a recusa de mapa incoerente com a fonte da REF sabe ficar VERMELHA?
#
# #2611: o bot do Lovable edita corpo de edge na `main` sem regravar o mapa de fingerprints, e a
# sonda serve o valor ESTÁTICO do mapa. `lib/mapa-coerente-na-ref.ts` recalcula o fecho NA REF e os
# dois emissores de colagem (`pendencias:pacote`, `pendencias:prompt`) recusam com exit 5. Este
# harness instala, UM de cada vez, os defeitos que a recusa existe para impedir — comparar o mapa
# consigo mesmo, ler o DISCO em vez da ref (no fecho ou no digest), aceitar edge fora do mapa,
# esquecer a predecessora, ignorar o exit 5, engolir mapa ausente ou inventário cego, tratar edge
# sem sonda como instrumentada, amputar o remédio — e exige vermelho PELO TESTE CERTO.
#
# Regras (CLAUDE.md §Armadilhas, "Teste SQL negativo"; docs/historico/falsificacao-sem-linha-de-base.md):
# 1. COMMIT antes: a restauração é `git checkout --`; alvo sujo aborta.
# 2. Controle verde na MESMA invocação, antes da 1ª sabotagem, em CADA locale.
# 3. Os DOIS locales (`C` e `pt_BR.UTF-8`); marca ASCII, caixa fixa, sem `-i`.
# 4. A marca é o título do teste dono da regra e tem de ser EXCLUSIVA do vermelho (ausente do log
#    do controle).
# 5. Sabotagem que não aplicou é falsificação INVÁLIDA (falha), nunca "o gate não pega".
#
# Modelo: `scripts/falsificar-prompt-escopo.sh` (mesmo laço, outras sabotagens).
#
# Uso: bun run falsificar:mapa-coerente · exit 0 = todas viraram vermelho pela marca certa nos dois
#      locales · 1 = alguma não virou · 2 = mecânica (árvore suja, locale ausente, bun)
set -euo pipefail

cd "$(dirname "$0")/.."

if ! bun --version >/dev/null 2>&1; then
  echo "FALSIF_SEM_BUN: bun nao respondeu a --version — sem runtime nao ha falsificacao, e 'pulei' nao e verde"
  exit 2
fi

if [ -z "${FALSIF_DENTRO_DO_HEAVY:-}" ] && command -v heavy >/dev/null 2>&1; then
  exec heavy env FALSIF_DENTRO_DO_HEAVY=1 bash "$0" "$@"
fi

exec bun - <<'TS'
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUITES = ['scripts/lib/mapa-coerente-na-ref.test.ts'];
const LOCALES = ['C', 'pt_BR.UTF-8'];
const LIB = 'scripts/lib/mapa-coerente-na-ref.ts';
const FINGERPRINT = 'scripts/sonda-fingerprint.ts';
const PACOTE = 'scripts/pendencias-pacote.ts';
const PROMPT = 'scripts/pendencias-prompt.ts';

interface Sabotagem { id: string; arquivo: string; defeito: string; velho: string; novo: string; marca: string }

const SABOTAGENS: Sabotagem[] = [
  // ── a comparação ──────────────────────────────────────────────────────────────────────────
  { id: 'S01', arquivo: LIB, defeito: 'fonte divergente do mapa vira coerente',
    velho: "    else if (commitado !== recalculado) incoerentes.push(", novo: "    else if (false) incoerentes.push(",
    marca: '[MAPA_BOT_EDITA_INDEX_RECUSA]' },
  { id: 'S02', arquivo: LIB, defeito: 'edge com versao.ts fora do mapa vira coerente',
    velho: 'Object.hasOwn(mapa, edge) ? mapa[edge] : null;', novo: 'Object.hasOwn(mapa, edge) ? mapa[edge] : recalculado;',
    marca: '[MAPA_EDGE_FORA_DO_MAPA_RECUSA]' },
  { id: 'S03', arquivo: LIB, defeito: 'edge no mapa sem versao.ts sai do regime (escape do marcador)',
    velho: 'comMarcador.has(e) || Object.hasOwn(mapa, e)', novo: 'comMarcador.has(e)',
    marca: '[MAPA_SEM_MARCADOR_NO_MAPA_RECUSA]' },
  { id: 'S04', arquivo: LIB, defeito: 'a forma do mapa deixa de ser conferida',
    velho: 'mapaForaDaForma: texto !== renderizarMapa(mapa) }', novo: 'mapaForaDaForma: false }',
    marca: '[MAPA_FORA_DA_FORMA_RECUSA]' },
  { id: 'S05', arquivo: LIB, defeito: 'recusa() ignora o mapa fora da forma',
    velho: 'return c.incoerentes.length > 0 || c.mapaForaDaForma;', novo: 'return c.incoerentes.length > 0;',
    marca: '[MAPA_FORA_DA_FORMA_RECUSA]' },
  // ── o eixo ARVORE: ref, nunca o disco ─────────────────────────────────────────────────────
  { id: 'S06', arquivo: LIB, defeito: 'o fecho e recalculado sobre o DISCO, nao sobre a ref',
    velho: 'fingerprintDaEdge(edge, raiz, arvore)', novo: 'fingerprintDaEdge(edge, raiz)',
    marca: '[MAPA_BOT_EDITA_INDEX_RECUSA]' },
  { id: 'S07', arquivo: FINGERPRINT, defeito: 'o digest le os bytes do DISCO com o fecho da ref',
    velho: '    const bytes = arvore.ler(rel);\n    if (bytes === null) throw new Error(`arquivo do fecho',
    novo: '    const bytes = arvoreDeTrabalho(raiz).ler(rel);\n    if (bytes === null) throw new Error(`arquivo do fecho',
    marca: '[MAPA_BOT_EDITA_INDEX_RECUSA]' },
  // ── os emissores ──────────────────────────────────────────────────────────────────────────
  { id: 'S08', arquivo: PACOTE, defeito: 'o pacote ignora a recusa e emite',
    velho: '  if (recusa(mapa)) {', novo: '  if (false) {',
    marca: '[MAPA_BOT_EDITA_INDEX_RECUSA]' },
  { id: 'S09', arquivo: PACOTE, defeito: 'a predecessora sai da conferencia',
    velho: '[...nomes, ...predecessoras]', novo: '[...nomes]',
    marca: '[MAPA_PREDECESSORA_INCOERENTE_RECUSA]' },
  { id: 'S10', arquivo: PACOTE, defeito: 'a 1a rodada da nuvem escapa da recusa',
    velho: '  if (recusa(mapa)) {', novo: '  if (recusa(mapa) && !nuvem.sqlNuvem) {',
    marca: '[MAPA_SQL_NUVEM_RECUSA]' },
  { id: 'S11', arquivo: PROMPT, defeito: 'o prompt ignora a recusa e emite',
    velho: '  if (recusa(mapa)) {', novo: '  if (false) {',
    marca: '[MAPA_PROMPT_BOT_RECUSA]' },
  // ── fail-closed da mecanica ───────────────────────────────────────────────────────────────
  { id: 'S12', arquivo: LIB, defeito: 'mapa ausente com edge instrumentada vira fora do regime',
    velho: '    if (comMarcador.size > 0) {\n', novo: '    if (comMarcador.size < 0) {\n',
    marca: '[MAPA_SEM_ARQUIVO_MECANICA]' },
  { id: 'S13', arquivo: LIB, defeito: 'inventario cego vira fora do regime',
    velho: '  if (cegas.length > 0) {', novo: '  if (cegas.length < 0) {',
    marca: '[MAPA_INVENTARIO_CEGO_LANCA]' },
  // ── o outro lado: nao recusar o que nao serve fonte ──────────────────────────────────────
  { id: 'S14', arquivo: LIB, defeito: 'edge sem versao.ts e fora do mapa e tratada como instrumentada',
    velho: 'inventario.has(`${RAIZ_EDGES}/${e}/${ARQ_MARCADOR}`)', novo: 'true',
    marca: '[MAPA_SEM_SONDA_FORA_DO_REGIME]' },
  // ── a mensagem diz o remedio ──────────────────────────────────────────────────────────────
  { id: 'S15', arquivo: LIB, defeito: 'a recusa perde o remedio (revert por PR)',
    velho: 'Remédio: edição NÃO pedida → revert por PR', novo: 'Remédio: edição NÃO pedida → reverta',
    marca: '[MAPA_BOT_EDITA_INDEX_RECUSA]' },
];

const ALVOS = [...new Set(SABOTAGENS.map((s) => s.arquivo))];
const LOGS = mkdtempSync(join(tmpdir(), 'falsif-mapa-coerente-'));

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
  const r = spawnSync('bunx', ['vitest', 'run', '--reporter=dot', '--maxWorkers=1', ...SUITES], {
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
