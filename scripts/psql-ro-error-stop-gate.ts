#!/usr/bin/env bun
/**
 * psql-ro-error-stop-gate.ts — CLI do fiscal. Puramente TEXTUAL: não abre conexão, não precisa da
 * credencial `psql-ro` (o CI não a tem, e é assim que tem de ser).
 *
 *   bun scripts/psql-ro-error-stop-gate.ts              # corpo do repo (com PISO de denominador)
 *   bun scripts/psql-ro-error-stop-gate.ts <dir…>       # corpo arbitrário (sem piso — é fixture)
 *
 * exit 0 = limpo · 1 = violação · 2 = o fiscal não conseguiu medir (piso de denominador furado,
 * stripper desabando, raiz ausente). 2 NUNCA é "passou": é ausência de dado, e o dente prova isso.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { diagnosticarShell } from '@/lib/gates/limpeza-shell';
import { analisar, type Sitio } from './lib/psql-ro-error-stop';

/**
 * `import.meta.dir` é API do Bun: sob o vitest ela é `undefined`. Calcular a raiz no TOPO do
 * módulo fazia o import explodir no CI antes de qualquer teste rodar — por isso ela é preguiçosa,
 * como no `edges-typecheck-gate.ts`. Quem importa este módulo passa a própria base.
 */
const raizDoRepo = () => resolve(import.meta.dir, '..');
export const RAIZES_PADRAO = ['db', 'scripts', '.claude'];
const IGNORAR = new Set(['node_modules', '.git', 'dist', 'coverage', '.turbo']);

/**
 * PISOS — o denominador do fiscal, medido em 2026-09-05 no corpo do repo.
 *
 * Sem eles o gate tem a falha que ele próprio existe para pegar: se o walker parar de achar
 * arquivo (raiz renomeada, glob quebrado, stripper engolindo tudo), "0 violações" é ausência de
 * dado e sai VERDE — indistinguível de verde por mérito. Piso não é meta: é alarme de fumaça,
 * folgado abaixo do medido e para ser SUBIDO quando o repo crescer, nunca baixado para caber.
 */
export const PISOS = {
  arquivos: 300,          // medido 2026-09-05: 456
  arquivosComVinculo: 11, // medido: 14 (o censo do histórico bate: 14 consumidores)
  sitios: 18,             // medido: 24
  /**
   * Alarmes do stripper shell, CALIBRADOS no corpo real (373 `.sh`, medido 2026-09-05):
   *  · fração: o menor legítimo é 0,336 (`prove-sql-money-path/references/harness-template.sh`,
   *    quase todo prosa). Piso 0,25 fica abaixo dele e ainda 4× acima do desabamento Sayerlack
   *    (0,15) que deu origem à classe.
   *  · bloco contíguo: o maior cabeçalho honesto tem 105 linhas (`db/test-tint-canonica.sh`).
   *    Teto 200 fica ~2× acima do legítimo — é a métrica FINA, porque separa cabeçalho grande de
   *    desabamento por aspa dessincronizada, coisa que a fração não separa.
   */
  preservacaoShell: 0.25,
  blocoDescartado: 200,
  /**
   * Comentário `#` que SOBREVIVEU à limpeza, fora de heredoc e fora de literal de outra
   * linguagem. Medido: **0** nos 373 `.sh` do repo. É o alarme de SUB-limpeza, e é o único que
   * pega o stripper que PARA de limpar — os dois de cima só veem o que come demais. Os dois furos
   * reais desta máquina (`<<<` lido como `<<`; `$(` dentro de `"…"`) apareceram só aqui.
   */
  comentariosSobreviventes: 0,
  /**
   * Heredoc aberto que nunca fecha até o EOF. Medido: **0** nos 373 `.sh`. É o único alarme que
   * NÃO consulta a crença da máquina sobre heredoc — e é por isso que ele existe: o de
   * sub-limpeza isenta o que está "dentro de heredoc" e portanto não vê a falha que faz a
   * máquina achar que está num. A matriz de sabotagem provou essa cegueira antes de o gate subir.
   */
  heredocsAbertos: 0,
} as const;

export function enumerar(raizes: string[], base: string): string[] {
  const achados: string[] = [];
  const andar = (dir: string) => {
    let entradas: string[];
    try {
      entradas = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entradas.sort()) {
      if (IGNORAR.has(e)) continue;
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) andar(p);
      else if (/\.(sh|bash)$/.test(e) || /\.[cm]?tsx?$/.test(e)) achados.push(p);
    }
  };
  for (const r of raizes) andar(resolve(base, r));
  return achados;
}

function formatar(s: Sitio): string {
  const fonte = s.temF ? '-f' : s.temStdin ? 'stdin/heredoc' : '?';
  return `  ${s.arquivo}:${s.linha}  $${s.variavel} lê de ${fonte} SEM -v ON_ERROR_STOP=1\n      ${s.trecho.split('\n')[0].slice(0, 140)}`;
}

function main(): number {
  const argv = process.argv.slice(2);
  const usaPadrao = argv.length === 0;
  const base = usaPadrao ? raizDoRepo() : process.cwd();
  const raizes = usaPadrao ? RAIZES_PADRAO : argv;

  const caminhos = enumerar(raizes, base);
  const arquivos = caminhos.map((c) => ({
    caminho: relative(base, c),
    fonte: readFileSync(c, 'utf8'),
  }));

  // Alarme do stripper ANTES do veredito: gate cego devolve 0 violações e parece aprovação.
  const desabando: string[] = [];
  for (const a of arquivos) {
    if (!/\.(sh|bash)$/.test(a.caminho)) continue;
    const d = diagnosticarShell(a.fonte);
    if (d.linhasOriginais >= 20 && d.fracaoPreservada < PISOS.preservacaoShell) {
      desabando.push(`${a.caminho} (fração ${d.fracaoPreservada.toFixed(2)})`);
    }
    if (d.maiorBlocoDescartado > PISOS.blocoDescartado) {
      desabando.push(`${a.caminho} (bloco descartado ${d.maiorBlocoDescartado})`);
    }
    if (d.heredocsAbertos > PISOS.heredocsAbertos) {
      desabando.push(`${a.caminho} (${d.heredocsAbertos} heredoc(s) ABERTO(s) até o EOF — a máquina perdeu o fio)`);
    }
    if (d.comentariosSobreviventes > PISOS.comentariosSobreviventes) {
      desabando.push(`${a.caminho} (${d.comentariosSobreviventes} comentário(s) NÃO limpo(s) — stripper parou)`);
    }
  }

  const r = analisar(arquivos);

  if (usaPadrao) {
    const furos: string[] = [];
    if (r.arquivosLidos < PISOS.arquivos) furos.push(`arquivos lidos ${r.arquivosLidos} < piso ${PISOS.arquivos}`);
    if (r.arquivosComVinculo < PISOS.arquivosComVinculo) {
      furos.push(`arquivos com vínculo ao wrapper ${r.arquivosComVinculo} < piso ${PISOS.arquivosComVinculo}`);
    }
    if (r.sitios.length < PISOS.sitios) furos.push(`sítios de invocação ${r.sitios.length} < piso ${PISOS.sitios}`);
    if (desabando.length > 0) furos.push(`stripper shell desabando em: ${desabando.join(', ')}`);
    if (furos.length > 0) {
      console.error('❌ INDETERMINADO — o fiscal não conseguiu medir (isto NÃO é "limpo"):');
      for (const f of furos) console.error(`  · ${f}`);
      return 2;
    }
  }

  if (r.violacoes.length > 0) {
    console.error(`❌ ${r.violacoes.length} invocação(ões) do wrapper psql-ro leem SQL de -f/stdin sem ON_ERROR_STOP:`);
    for (const s of r.violacoes) console.error(formatar(s));
    console.error('');
    console.error('  O wrapper NÃO passa -v ON_ERROR_STOP=1 e o psql, lido de -f/stdin, sai 0 MESMO COM ERROR.');
    console.error('  A query não roda, o script recebe SUCESSO e o zero-resultado vira veredito.');
    console.error('  Conserto: acrescente `-v ON_ERROR_STOP=1` à invocação (e um marcador de fim na query).');
    console.error('  docs/historico/psql-ro-exit-zero-em-sql-que-falhou.md');
    return 1;
  }

  console.log(
    `✅ psql-ro/ON_ERROR_STOP: ${r.sitios.length} invocação(ões) em ${r.arquivosComVinculo} arquivo(s), ` +
      `${r.arquivosLidos} fontes lidas. Nenhuma lê de -f/stdin sem ON_ERROR_STOP.`,
  );
  return 0;
}

if (import.meta.main) process.exit(main());
