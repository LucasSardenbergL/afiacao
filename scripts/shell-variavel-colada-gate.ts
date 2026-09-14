#!/usr/bin/env bun
/**
 * shell-variavel-colada-gate.ts — fiscal TEXTUAL da forma `$NOME…`: expansão de variável SEM chaves
 * com um caractere NÃO-ASCII colado ao nome. Não executa shell nenhum.
 *
 *   bun scripts/shell-variavel-colada-gate.ts              # corpo do repo (com PISOS)
 *   bun scripts/shell-variavel-colada-gate.ts <dir…>       # corpo arbitrário (sem piso — é fixture)
 *
 * exit 0 = limpo · 1 = violação · 2 = o fiscal não conseguiu medir (nenhum arquivo lido, piso de
 * denominador furado, stripper desabando). 2 NUNCA é "passou". Roda no CI pelo vitest
 * (`shell-variavel-colada-gate.test.ts`); as mutações que provam o dente de cada camada estão em
 * `scripts/mutcheck.d/shell-variavel-colada.mut`.
 *
 * ## A classe (docs/historico/shell-variavel-colada-em-nao-ascii.md)
 *
 * O bash do macOS (3.2.57 — o que o `env bash` acha na máquina do founder e de toda sessão) decide
 * onde o NOME termina perguntando ao `isalnum()` do locale. Sob UTF-8, a libc responde "letra" para
 * o 1º byte de quase todo caractere multibyte (medido: todo byte-líder de 0xC2 a 0xF4, menos 0xD7).
 * Então `"$marca…"` expande `${marca\xE2}`:
 *   · com `set -u`, `marca�: unbound variable` — e o script MORRE. Foi isso que fez TODA sabotagem
 *     do 2º locale da canária (#2472) "ficar vermelha" por crash, sem julgar nada;
 *   · sem `set -u` é pior, porque é CALADO: o valor some, levando junto o 1º byte do `…`.
 * No Linux (glibc) não reproduz: pela execução, o CI nunca veria. Só pelo texto.
 *
 * Conserto: `${marca}…`. É inócuo em todo contexto em que o bash expande — e é isso que deixa a
 * assinatura ser LARGA: qualquer caractere não-ASCII colado, sem adivinhar quais bytes a libc de
 * cada máquina chama de letra.
 *
 * ## O que NÃO isenta, de propósito
 *
 * Aspas simples, `$'…'` e heredoc citado. Ali o bash de AGORA não expande, mas o texto costuma
 * alimentar um bash DEPOIS (`trap '…' EXIT`, `bash -c '…'`, `cat > fake.sh <<'EOF'`) — e lá a forma
 * morde igual. A ÚNICA isenção é comentário, e quem a decide é o stripper COMPARTILHADO: `#` dentro
 * de aspas é dado, e uma regex local, que não sabe disso, apagaria justamente a linha que o fiscal
 * existe para ler (docs/historico/gates-textuais-cegos.md).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { diagnosticarShell, removerComentariosShell } from '@/lib/gates/limpeza-shell';
import { PISOS as PISOS_DO_IRMAO } from './psql-ro-error-stop-gate';

/** `import.meta.dir` é do Bun e não existe sob o vitest — por isso preguiçosa, como no irmão. */
const raizDoRepo = () => resolve(import.meta.dir, '..');

/**
 * O universo: as raízes onde mora TODO `.sh` rastreado do repo (432, medido 2026-09-14 — o teste
 * confere contra o `git ls-files`, então raiz nova fica vermelha em vez de invisível). `.claude`
 * INTEIRO, e não só `hooks/`: as skills têm 17 `.sh` que rodam no mesmo bash. E `connector/`: a
 * release e a falsificação do conector Go rodam com `set -u` na mesma máquina.
 */
export const RAIZES_PADRAO = ['db', 'scripts', '.claude', 'connector'];

const IGNORAR_NOMES = new Set(['node_modules', '.git', 'dist', 'coverage', '.turbo']);
/**
 * Por CAMINHO, não por nome: no checkout PRINCIPAL, `.claude/worktrees/` guarda cópias inteiras do
 * repo — mas um `scripts/worktrees/` legítimo não pode sumir junto só por se chamar igual.
 */
const IGNORAR_CAMINHOS = ['.claude/worktrees'];

/**
 * PISOS — o denominador do fiscal, medido em 2026-09-14. Sem eles, "0 violações" com o walker
 * quebrado é indistinguível de "0 violações" por mérito. Piso é alarme de fumaça: folgado abaixo do
 * medido, SOBE quando o repo cresce, nunca desce para caber.
 */
export const PISOS = {
  /**
   * Por RAIZ, e não só no total: sumir com `.claude/` inteiro (36 de 432) não furaria um piso de
   * total — e `.claude/` é o diretório OCULTO que o `rg` cru pula (19ª armadilha de
   * docs/historico/evidencia-positiva-shell.md).
   */
  arquivosPorRaiz: {
    db: 250, // medido: 307
    scripts: 70, // medido: 87
    '.claude/hooks': 15, // medido: 19
    '.claude/skills': 12, // medido: 17
    connector: 1, // medido: 2
  } as Readonly<Record<string, number>>,
  /** Expansões `$NOME`, com qualquer vizinho: prova que o fiscal leu CÓDIGO, não só abriu arquivo. */
  expansoes: 25_000, // medido: 31.221
  /**
   * A forma CERTA, `${NOME}…`, vista. É o eixo que nenhum alarme do stripper cobre: se a LEITURA
   * perder o não-ASCII (encoding errado, flag `u` removida), as violações zeram junto — e só este
   * piso diz que o zero não foi mérito.
   */
  formaCerta: 14, // medido: 18
} as const;

/** Abaixo disto a FRAÇÃO não julga — script curto de cabeçalho honesto. A mesma régua do irmão. */
const LINHAS_MINIMAS_PARA_FRACAO = 20;

/** `$` + NOME + o 1º caractere depois dele, fora do ASCII: a forma, e só ela. */
const FORMA = /\$([A-Za-z_][A-Za-z0-9_]*)(\P{ASCII})/gu;
const EXPANSAO = /\$[A-Za-z_]/g;
const FORMA_CERTA = /\$\{[A-Za-z_][A-Za-z0-9_]*\}\P{ASCII}/gu;

const EXTENSAO_SHELL = /\.(sh|bash)$/;
/** Sem extensão, vale o shebang de `sh`/`bash`: hook novo sem `.sh` não fica de fora (zsh é outra gramática). */
const SHEBANG_SHELL = /^#![^\n]*\b(?:ba)?sh\b/;

export interface Sitio {
  arquivo: string;
  linha: number;
  nome: string;
  /** O caractere colado ao nome (`…`, `»`, `≠`). */
  colado: string;
  trecho: string;
}

export interface Analise {
  caminhos: string[];
  expansoes: number;
  formaCerta: number;
  violacoes: Sitio[];
  alarmes: string[];
}

const contar = (linha: string, re: RegExp) => (linha.match(re) ?? []).length;

/** `$$NOME…` é o PID seguido de texto: aquele `$` fecha um par, não abre expansão de NOME. */
function fechaUmPar(linha: string, i: number): boolean {
  let cifroes = 0;
  for (let j = i - 1; j >= 0 && linha[j] === '$'; j--) cifroes++;
  return cifroes % 2 === 1;
}

export function detectar(caminho: string, fonte: string): Pick<Analise, 'expansoes' | 'formaCerta'> & { sitios: Sitio[] } {
  const sitios: Sitio[] = [];
  let expansoes = 0;
  let formaCerta = 0;
  // A limpeza preserva o número de linhas: o índice aqui é a linha da FONTE.
  const limpo = removerComentariosShell(fonte);
  limpo.split('\n').forEach((linha, i) => {
    expansoes += contar(linha, EXPANSAO);
    formaCerta += contar(linha, FORMA_CERTA);
    for (const m of linha.matchAll(FORMA)) {
      if (fechaUmPar(linha, m.index)) continue;
      sitios.push({ arquivo: caminho, linha: i + 1, nome: m[1], colado: m[2], trecho: linha.trim() });
    }
  });
  return { sitios, expansoes, formaCerta };
}

type Diagnostico = ReturnType<typeof diagnosticarShell>;

/**
 * Os QUATRO alarmes do stripper — sobre-limpeza (fração e bloco contíguo), sub-limpeza e heredoc
 * aberto até o EOF, o eixo medido POR FORA da crença da máquina. Os pisos são os CALIBRADOS no
 * irmão `psql-ro-error-stop-gate.ts` sobre o mesmo corpo, importados e não copiados: dois números
 * para a mesma calibração divergem; um só não tem com quem divergir.
 */
export function alarmesDoStripper(caminho: string, d: Diagnostico): string[] {
  const alarmes: string[] = [];
  if (d.linhasOriginais >= LINHAS_MINIMAS_PARA_FRACAO && d.fracaoPreservada < PISOS_DO_IRMAO.preservacaoShell) {
    alarmes.push(`${caminho}: só ${d.fracaoPreservada.toFixed(2)} das linhas sobreviveu à limpeza (sobre-limpeza)`);
  }
  if (d.maiorBlocoDescartado > PISOS_DO_IRMAO.blocoDescartado) {
    alarmes.push(`${caminho}: bloco contíguo de ${d.maiorBlocoDescartado} linhas descartado (sobre-limpeza)`);
  }
  if (d.comentariosSobreviventes > PISOS_DO_IRMAO.comentariosSobreviventes) {
    alarmes.push(`${caminho}: ${d.comentariosSobreviventes} comentário(s) NÃO limpo(s) (sub-limpeza: o stripper parou)`);
  }
  if (d.heredocsAbertos > PISOS_DO_IRMAO.heredocsAbertos) {
    alarmes.push(`${caminho}: ${d.heredocsAbertos} heredoc(s) aberto(s) até o EOF (a máquina perdeu o fio)`);
  }
  return alarmes;
}

export function analisar(arquivos: { caminho: string; fonte: string }[]): Analise {
  const r: Analise = { caminhos: [], expansoes: 0, formaCerta: 0, violacoes: [], alarmes: [] };
  for (const a of arquivos) {
    const d = detectar(a.caminho, a.fonte);
    r.caminhos.push(a.caminho);
    r.expansoes += d.expansoes;
    r.formaCerta += d.formaCerta;
    r.violacoes.push(...d.sitios);
    r.alarmes.push(...alarmesDoStripper(a.caminho, diagnosticarShell(a.fonte)));
  }
  return r;
}

function ehShell(nome: string, caminho: string): boolean {
  if (EXTENSAO_SHELL.test(nome)) return true;
  return !nome.includes('.') && SHEBANG_SHELL.test(readFileSync(caminho, 'utf8').slice(0, 200));
}

export function enumerar(raizes: string[], base: string): string[] {
  const ignorados = new Set(IGNORAR_CAMINHOS.map((c) => resolve(base, c)));
  const achados: string[] = [];
  const andar = (dir: string) => {
    let entradas: string[];
    try {
      entradas = readdirSync(dir);
    } catch {
      return; // raiz ausente: quem acusa é o piso (ou o "nenhum arquivo lido"), não o silêncio daqui
    }
    for (const e of entradas.sort()) {
      const p = join(dir, e);
      if (IGNORAR_NOMES.has(e) || ignorados.has(p)) continue;
      // Sem try/catch de propósito: symlink quebrado DERRUBA o fiscal em vez de sumir com o arquivo.
      if (statSync(p).isDirectory()) andar(p);
      else if (ehShell(e, p)) achados.push(p);
    }
  };
  for (const r of raizes) andar(resolve(base, r));
  return achados;
}

export function veredito(r: Analise, comPisos: boolean): { codigo: 0 | 1 | 2; linhas: string[] } {
  const furos = r.alarmes.map((a) => `stripper desabando — ${a}`);
  if (r.caminhos.length === 0) furos.push('nenhum arquivo shell lido');
  const porRaiz = Object.entries(PISOS.arquivosPorRaiz).map(([raiz, piso]) => ({
    raiz,
    piso,
    lidos: r.caminhos.filter((c) => c.startsWith(`${raiz}/`)).length,
  }));
  if (comPisos) {
    for (const { raiz, piso, lidos } of porRaiz) {
      if (lidos < piso) furos.push(`${lidos} arquivo(s) shell em ${raiz}/ < piso ${piso}`);
    }
    if (r.expansoes < PISOS.expansoes) furos.push(`${r.expansoes} expansões $NOME vistas < piso ${PISOS.expansoes}`);
    if (r.formaCerta < PISOS.formaCerta) {
      furos.push(`${r.formaCerta} \${NOME} colados em não-ASCII vistos < piso ${PISOS.formaCerta} — a leitura perdeu o não-ASCII?`);
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
        `❌ ${r.violacoes.length} expansão(ões) $NOME sem chaves com caractere não-ASCII colado ao nome:`,
        ...r.violacoes.map((s) => `  ${s.arquivo}:${s.linha}  $${s.nome} + ${s.colado}\n      ${s.trecho.slice(0, 140)}`),
        '',
        '  No bash do macOS sob locale UTF-8, o 1º byte do caractere vira parte do NOME: `$marca…` expande',
        '  `${marca\\xE2}` — `unbound variable` com `set -u` (o script morre); sem `set -u`, o valor some calado.',
        '  Conserto: chaves — `${marca}…`. docs/historico/shell-variavel-colada-em-nao-ascii.md',
      ],
    };
  }
  const censo = comPisos ? ` (${porRaiz.map((p) => `${p.raiz} ${p.lidos}`).join(' · ')})` : '';
  return {
    codigo: 0,
    linhas: [
      `✅ shell/variável colada: ${r.caminhos.length} arquivo(s) shell${censo}, ${r.expansoes} expansões $NOME e ` +
        `${r.formaCerta} \${NOME}… vistas. Nenhuma expansão sem chaves colada em não-ASCII.`,
    ],
  };
}

function main(): number {
  const argv = process.argv.slice(2);
  const usaPadrao = argv.length === 0;
  const base = usaPadrao ? raizDoRepo() : process.cwd();
  const arquivos = enumerar(usaPadrao ? RAIZES_PADRAO : argv, base).map((c) => ({
    caminho: relative(base, c),
    fonte: readFileSync(c, 'utf8'),
  }));
  const { codigo, linhas } = veredito(analisar(arquivos), usaPadrao);
  if (codigo === 0) console.log(linhas.join('\n'));
  else console.error(linhas.join('\n'));
  return codigo;
}

if (import.meta.main) process.exit(main());
