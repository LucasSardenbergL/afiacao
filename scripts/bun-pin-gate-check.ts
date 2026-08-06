#!/usr/bin/env bun
/**
 * bun-pin-gate-check.ts — gate de CI que prova o PIN ESTRITO do bun no setup-bun.
 * ============================================================================================
 *
 * Follow-up do PR #1352. Mata um bug SILENCIOSO: a `oven-sh/setup-bun@v2` só pula a chamada a
 * api.github.com/repos/oven-sh/bun/git/refs/tags quando o `bun-version` casa o `validateStrict()`
 * dela (src/download-url.ts) — ou seja, semver ESTRITO `x.y.z`. Qualquer outro formato (`latest`,
 * `1.3`, `^1.3.14`, `v1.3.14`, `1.3.x`, `>=1.3.14`, `bun-v1.3.15`) cai na API e reintroduz uma
 * dependência de REDE no caminho de entrega de todo PR.
 *
 * Por que um gate e não um comentário: a regressão é INVISÍVEL pro CI. Com `latest` o CI fica
 * VERDE (a action baixa o bun pela API e tudo passa) — só quebra quando a API do GitHub degrada.
 * Foi o que aconteceu em 2026-07-16: o incidente "Degraded REST API Availability" (~35% das
 * chamadas REST falhando) derrubou TODO PR do repo em ~6s no setup do bun, inclusive PRs de 1
 * linha de markdown. Comentário no YAML não barra ninguém; e como todo PR não-draft auto-mergeia
 * no verde (auto-merge.yml), sem gate a regressão entra na main sem olho humano.
 *
 * Três invariantes (cada uma é uma armadilha validada empiricamente contra a lib real):
 *  1. FORMATO: todo `bun-version` é semver estrito `x.y.z`. `1.3.x` é o exemplo da PRÓPRIA doc do
 *     input da action — e não serve. Um bot mal configurado escreveria `bun-v1.3.15` (as releases
 *     do oven-sh/bun são tagueadas `bun-v*`), que também cai na API.
 *  2. FLOAT: o YAML lê `bun-version: 1.3` como o float 1.3 — e `1.30` também vira `1.3` (perde o
 *     zero). Razão INDEPENDENTE pra exigir x.y.z; o regex de formato já barra os dois.
 *  3. CONVERGÊNCIA: as ocorrências (hoje `validate` e `mutation-check`) têm que subir JUNTAS —
 *     senão os jobs rodam em versões diferentes de bun e divergem.
 *  + Todo `uses: oven-sh/setup-bun` precisa de um `bun-version`: o default da action é `latest`
 *    (mesmo SPOF). Provado por CONTAGEM (nº de usos == nº de pins) — ver checkArquivo.
 *
 * Sem dependência de terceiro de propósito (só builtins), igual ao scripts/authz-gate-check.ts: o
 * pacote `yaml` do node_modules é TRANSITIVO (só aparece em `overrides` do package.json, que é
 * pinagem de versão, não declaração) — um gate anti-fragilidade não pode pender de dep transitiva.
 *
 * Uso:  bun run bunpin:check          # roda no CI (ci.yml, job validate) e local
 *       bun scripts/bun-pin-gate-check.ts --json
 * Fonte: .github/workflows/*.yml — estático, sem rede.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PinFinding {
  level: 'error';
  file: string;
  /** 1-based; 0 quando o achado é do arquivo inteiro (ex.: contagem). */
  line: number;
  msg: string;
}

export interface WorkflowFile {
  file: string;
  yaml: string;
}

/** `- uses: oven-sh/setup-bun@v2` (também casa pin por SHA e a forma sem `- `). */
const RE_USES_SETUP_BUN = /^\s*(?:-\s+)?uses:\s*["']?oven-sh\/setup-bun(?:@[^\s"']+)?["']?\s*(?:#.*)?$/;
/** `bun-version: <valor>` — captura o valor cru, pra ver o TEXTO (é assim que `1.3` se revela). */
const RE_BUN_VERSION = /^\s*bun-version:\s*(.+?)\s*$/;
/** O que a `validateStrict()` da action aceita p/ PULAR a api.github.com. */
const STRICT_SEMVER = /^\d+\.\d+\.\d+$/;
/** `x.y` (o que o YAML degrada pra float). */
const LOOKS_FLOAT = /^\d+\.\d+$/;

const WORKFLOWS_DIR = '.github/workflows';

/** Tira comentário inline e aspas: `"1.3.14"  # nota` → `1.3.14`. */
function limpaValor(raw: string): string {
  const semComentario = raw.replace(/\s+#.*$/, '').trim();
  return semComentario.replace(/^(["'])(.*)\1$/, '$2').trim();
}

/**
 * Audita os pins de bun. Função PURA (recebe o conteúdo, não lê disco) — o teste monta os YAMLs
 * inline e o runner abaixo passa os arquivos reais.
 */
export function auditBunPins(files: WorkflowFile[]): PinFinding[] {
  const findings: PinFinding[] = [];
  /** Pins VÁLIDOS de todos os arquivos — alimenta a invariante 3 (convergência). */
  const pins: { file: string; line: number; value: string }[] = [];

  for (const { file, yaml } of files) {
    const linhas = yaml.split('\n');
    let usos = 0;
    let pinsNoArquivo = 0;

    linhas.forEach((linha, i) => {
      const line = i + 1;

      if (RE_USES_SETUP_BUN.test(linha)) usos++;

      const m = linha.match(RE_BUN_VERSION);
      if (!m) return;
      pinsNoArquivo++;
      const valor = limpaValor(m[1]);

      if (STRICT_SEMVER.test(valor)) {
        pins.push({ file, line, value: valor });
        return;
      }

      // Invariante 2 (FLOAT) — mensagem específica, o erro mais fácil de cometer sem perceber.
      if (LOOKS_FLOAT.test(valor)) {
        findings.push({
          level: 'error',
          file,
          line,
          msg: `\`bun-version: ${valor}\` não é semver estrito x.y.z — e o YAML ainda lê x.y como FLOAT (\`1.30\` vira \`1.3\`, perde o zero). Fixe o patch: ex. \`${valor}.0\`.`,
        });
        return;
      }

      // Invariante 1 (FORMATO).
      findings.push({
        level: 'error',
        file,
        line,
        msg: `\`bun-version: ${valor}\` não é semver estrito x.y.z → a action NÃO casa validateStrict(), cai na api.github.com e reintroduz o SPOF de rede (o CI segue VERDE até a API do GitHub degradar).`,
      });
    });

    // Todo setup-bun precisa do seu pin — sem o input, o default da action é `latest`.
    if (usos > pinsNoArquivo) {
      findings.push({
        level: 'error',
        file,
        line: 0,
        msg: `${usos} step(s) usam oven-sh/setup-bun mas há só ${pinsNoArquivo} \`bun-version\` — o default da action é \`latest\`, que cai na api.github.com. Todo setup-bun precisa do pin estrito x.y.z.`,
      });
    }
  }

  // Invariante 3 (CONVERGÊNCIA): todas as ocorrências na MESMA versão.
  const distinct = [...new Set(pins.map((p) => p.value))];
  if (distinct.length > 1) {
    const onde = pins.map((p) => `${p.file}:${p.line}=${p.value}`).join(', ');
    findings.push({
      level: 'error',
      file: WORKFLOWS_DIR,
      line: 0,
      msg: `os jobs divergem de versão de bun (${distinct.join(' vs ')}) — as ocorrências têm que subir JUNTAS. Onde: ${onde}.`,
    });
  }

  return findings;
}

/** Lê os workflows do disco. Isolado do audit p/ o teste não precisar de fixture em arquivo. */
export function readWorkflows(dir: string = WORKFLOWS_DIR): WorkflowFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => ({ file: join(dir, f), yaml: readFileSync(join(dir, f), 'utf8') }));
}

if (import.meta.main) {
  const findings = auditBunPins(readWorkflows());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    for (const f of findings) console.error(`✗ ${f.file}${f.line ? `:${f.line}` : ''} ${f.msg}`);
    if (findings.length === 0) console.log('✓ bun-pin gate: pin estrito x.y.z e convergente em todos os workflows.');
  }
  process.exit(findings.length > 0 ? 1 : 0);
}
