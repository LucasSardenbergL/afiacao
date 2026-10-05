#!/usr/bin/env bash
# falsificar-prompt-escopo.sh — o escopo do prompt de deploy e o sensor pós-envio sabem ficar VERMELHOS?
#
# #2541 e #2579: o agente do Lovable deployou certo e DEPOIS "consertou" outras edges pelo
# build-errors.log. A defesa tem duas metades — a proibição na colagem (`blocoDeEscopo`) e o sensor
# por fora (`lovable-sensor-edicao`). Este harness instala, UM de cada vez, os defeitos que cada
# metade existe para impedir — frase amputada, bloco fora de um dos ramos, cobertura cega ao escopo,
# sensor que aceita "cedo demais" ou tolera `src/` inteiro — e exige vermelho PELO TESTE CERTO.
# Desde 2026-10-01, também a FONTE ÚNICA da colagem: molde à mão de volta a uma instrução viva
# (S13 na skill, S14 quebrado entre linhas no docs/agent) e os dois controles que impedem o teste
# de aprovar por vacuidade — assinatura cega (S15) e varredura que não lê as skills (S16).
# Desde 2026-10-05, a instrução pós-envio (`INSTRUCAO_POS_ENVIO`) nos DOIS emissores, uma camada por
# sabotagem: a chamada no pacote (S07), a chamada no `pendencias:prompt` (S17), o texto compartilhado
# sem o comando do sensor (S18) e a instrução vazando para DENTRO da colagem (S19).
#
# Regras (CLAUDE.md §Armadilhas, "Teste SQL negativo"; docs/historico/falsificacao-sem-linha-de-base.md):
# 1. COMMIT antes: a restauração é `git checkout --`; alvo sujo aborta.
# 2. Controle verde na MESMA invocação, antes da 1ª sabotagem, em CADA locale.
# 3. Os DOIS locales (`C` e `pt_BR.UTF-8`); marca ASCII, caixa fixa, sem `-i`.
# 4. A marca é o título do teste dono da regra e tem de ser EXCLUSIVA do vermelho (ausente do log
#    do controle).
# 5. Sabotagem que não aplicou é falsificação INVÁLIDA (falha), nunca "o gate não pega".
#
# `--maxWorkers=1`: sob pressão de RAM o vitest com vários workers morre em
# `Timeout calling "fetch"` antes de carregar a suíte (medido 2026-09-26) — vermelho mecânico que
# o passo 2 recusaria como controle, mas que numa sabotagem passaria por "vermelho sem a marca".
#
# Uso: bun run falsificar:prompt-escopo · exit 0 = todas viraram vermelho pela marca certa nos dois
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

const SUITES = [
  'scripts/lib/prompt-deploy.test.ts',
  'scripts/lib/pacote-entrega.test.ts',
  'scripts/lib/lovable-sensor-edicao.test.ts',
  'scripts/pendencias-prompt.test.ts',
];
const LOCALES = ['C', 'pt_BR.UTF-8'];
const PROMPT = 'scripts/lib/prompt-deploy.ts';
const PACOTE = 'scripts/lib/pacote-entrega.ts';
const PROMPT_CLI = 'scripts/pendencias-prompt.ts';
const SENSOR = 'scripts/lib/lovable-sensor-edicao.ts';
const SKILL = '.claude/skills/lovable-deploy-verify/SKILL.md';
const DEPLOY_MD = 'docs/agent/deploy.md';
const TESTE_PROMPT = 'scripts/lib/prompt-deploy.test.ts';

interface Sabotagem { id: string; arquivo: string; defeito: string; velho: string; novo: string; marca: string }

const SABOTAGENS: Sabotagem[] = [
  // ── a proibição na colagem ────────────────────────────────────────────────────────────────
  { id: 'S01', arquivo: PROMPT, defeito: 'a frase "nenhum arquivo" sai do texto',
    velho: '`- Do NOT edit, create, rename or delete ANY file — not the files listed above, and not any`,',
    novo: '`- Do not change the deployed code — not the files listed above, and not any`,',
    marca: '[ESCOPO_PROIBE_EDITAR_QUALQUER_ARQUIVO]' },
  { id: 'S02', arquivo: PROMPT, defeito: 'erro visto em log volta a poder ser consertado',
    velho: '`  do NOT fix them. List them in your reply (file and message) and leave the code exactly as it`,',
    novo: '`  fix them if trivial. List them in your reply (file and message) and leave the code exactly as it`,',
    marca: '[ESCOPO_PROIBE_CONSERTAR_ERRO_DE_LOG]' },
  { id: 'S03', arquivo: PROMPT, defeito: 'a confirmacao "No files were edited." deixa de ser exigida',
    velho: '`- End your reply with this exact line: \\`No files were edited.\\` If you edited, created or`,',
    novo: '`- If you edited, created or`,',
    marca: '[ESCOPO_EXIGE_CONFIRMACAO]' },
  { id: 'S04', arquivo: PROMPT, defeito: 'o ramo de 1 edge perde o bloco de escopo',
    velho: "      blocoDeEscopo(),\n", novo: '',
    marca: '[ESCOPO_PROIBE_EDITAR_QUALQUER_ARQUIVO]' },
  { id: 'S05', arquivo: PROMPT, defeito: 'o ramo da leva perde o bloco de escopo',
    velho: "    '',\n    blocoDeEscopo(),\n    '',", novo: "    '',",
    marca: '[ESCOPO_PROIBE_EDITAR_QUALQUER_ARQUIVO]' },
  { id: 'S06', arquivo: PROMPT, defeito: 'o conferirCobertura fica cego ao escopo',
    velho: "    if (!prompt.includes(marca)) faltando.push(`escopo:${marca}`);",
    novo: "    void marca;",
    marca: '[ESCOPO_COBERTURA_ACUSA_MARCA_AMPUTADA]' },
  { id: 'S07', arquivo: PACOTE, defeito: 'o pacote para de mandar rodar o sensor pos-envio',
    velho: '    L.push(INSTRUCAO_POS_ENVIO);\n', novo: '',
    marca: '[PACOTE_COLAGEM_PROIBE_EDITAR]' },
  // ── o sensor por fora ─────────────────────────────────────────────────────────────────────
  { id: 'S08', arquivo: SENSOR, defeito: 'main lida cedo demais vira limpa',
    velho: "  if (!assentou) return 'CEDO_DEMAIS';\n", novo: '',
    marca: '[SENSOR_CEDO_DEMAIS]' },
  { id: 'S09', arquivo: SENSOR, defeito: 'sem a confirmacao ainda da SEM_EDICAO',
    velho: "  if (!r.confirmou) return 'SEM_CONFIRMACAO';\n", novo: '',
    marca: '[SENSOR_SEM_CONFIRMACAO]' },
  { id: 'S10', arquivo: SENSOR, defeito: 'a tolerancia vira src/ inteiro',
    velho: "c.arquivos.some((a) => !ARQUIVOS_TOLERADOS_DO_BOT.includes(a))",
    novo: "c.arquivos.some((a) => !a.startsWith('src/'))",
    marca: '[SENSOR_TYPES_TOLERADO]' },
  { id: 'S11', arquivo: SENSOR, defeito: 'JSON embrulhado em string nao e re-parseado',
    velho: "        varrer(JSON.parse(u), sinais, profundidade + 1);", novo: "        void JSON.parse(u);",
    marca: '[SENSOR_COMMIT_SHA_ANINHADO]' },
  { id: 'S12', arquivo: SENSOR, defeito: 'valor nulo em string vira sinal',
    velho: "  return t !== '' && t.toLowerCase() !== 'null' && t.toLowerCase() !== 'none';",
    novo: "  return true;",
    marca: '[SENSOR_NULO_NAO_E_SINAL]' },
  // ── a fonte única da colagem (nenhum molde à mão nas instruções vivas) ─────────
  { id: 'S13', arquivo: SKILL, defeito: 'o molde de 1 edge a mao volta a skill de deploy',
    velho: '`[COLAGEM_SO_DO_GERADOR]` do `prompt-deploy.test.ts`.\n',
    novo: '`[COLAGEM_SO_DO_GERADOR]` do `prompt-deploy.test.ts`.\n\n' +
      '> Edit the existing edge function `<nome>` and replace its code with the current contents of\n' +
      '> `supabase/functions/<nome>/index.ts` from the `main` branch. Deploy it **verbatim** — do NOT modify,\n' +
      '> reinterpret, "improve", or reformat the code. After deploying, confirm it shows **Active**.\n',
    marca: '[COLAGEM_SO_DO_GERADOR]' },
  { id: 'S14', arquivo: DEPLOY_MD, defeito: 'molde da leva, com a assinatura quebrada entre linhas, aparece no docs/agent',
    velho: '`8f005805-000a-42b7-88a1-9683f785fab6`). O prompt carrega o `sha256` de cada arquivo do closure e\n',
    novo: '`8f005805-000a-42b7-88a1-9683f785fab6`). O prompt carrega o `sha256` de cada arquivo do closure e\n\n' +
      '> Edit the following **two** existing edge functions and update **each** of them. Deploy all of them\n' +
      '> **verbatim** — do NOT modify, reinterpret, "improve", or reformat any code.\n\n',
    marca: '[COLAGEM_SO_DO_GERADOR]' },
  { id: 'S15', arquivo: TESTE_PROMPT, defeito: 'a assinatura fica cega e a varredura aprova por vacuidade',
    velho: 'const ASSINATURA_DE_COLAGEM = /Deploy (?:it|them|all of them) (?:\\*\\*)?verbatim/;',
    novo: 'const ASSINATURA_DE_COLAGEM = /Deploy (?:it|them|all of them) (?:\\*\\*)?verbatin/;',
    marca: '[COLAGEM_ASSINATURA_CASA_O_GERADOR]' },
  { id: 'S16', arquivo: TESTE_PROMPT, defeito: 'a varredura deixa de ler as skills',
    velho: "const INSTRUCOES_VIVAS = ['.claude/skills', 'docs/agent', 'docs/runbooks'];",
    novo: "const INSTRUCOES_VIVAS = ['docs/agent', 'docs/runbooks'];",
    marca: '[COLAGEM_VARREDURA_VE_AS_INSTRUCOES]' },
  // ── a instrução pós-envio nos DOIS emissores (2026-10-05) — o S07 acima é a chamada no pacote ──
  { id: 'S17', arquivo: PROMPT_CLI, defeito: 'o pendencias:prompt volta a mandar so a sonda',
    velho: "      `  ${INSTRUCAO_POS_ENVIO}\\n\\n`,", novo: '      `\\n`,',
    marca: '[PROMPT_MANDA_RODAR_O_SENSOR]' },
  { id: 'S18', arquivo: PROMPT, defeito: 'a instrucao pos-envio compartilhada perde o comando do sensor',
    velho: "  '`bun scripts/lovable-sensor-edicao.ts --desde <ISO do envio> <arquivo>` — ele lê `edit_id`/`commit_sha` ' +",
    novo: "  'confira a resposta — ele lê `edit_id`/`commit_sha` ' +",
    marca: '[PACOTE_COLAGEM_PROIBE_EDITAR]' },
  { id: 'S19', arquivo: PROMPT_CLI, defeito: 'a instrucao pos-envio vaza para dentro da colagem',
    velho: '  process.stdout.write(`${prompt}\\n`);',
    novo: '  process.stdout.write(`${prompt}\\n\\n${INSTRUCAO_POS_ENVIO}\\n`);',
    marca: '[PROMPT_MANDA_RODAR_O_SENSOR]' },
];

const ALVOS = [...new Set(SABOTAGENS.map((s) => s.arquivo))];
const LOGS = mkdtempSync(join(tmpdir(), 'falsif-escopo-'));

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
