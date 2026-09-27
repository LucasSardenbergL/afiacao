#!/usr/bin/env bun
/**
 * relogio-bash-em-provas-gate.ts — fiscal TEXTUAL da prova SQL que tira o ESPERADO do relógio do
 * BASH num campo de calendário. Não executa shell nenhum.
 *
 *   bun scripts/relogio-bash-em-provas-gate.ts              # todo shell de db/ (com PISOS)
 *   bun scripts/relogio-bash-em-provas-gate.ts <dir…>       # corpo arbitrário (sem piso — é fixture)
 *
 * exit 0 = limpo · 1 = violação · 2 = o fiscal não conseguiu medir (nenhum arquivo lido, piso de
 * denominador furado, stripper desabando). 2 NUNCA é "passou". Roda no CI pelo vitest
 * (`relogio-bash-em-provas-gate.test.ts`); as mutações que provam o dente de cada camada estão em
 * `scripts/mutcheck.d/relogio-bash-em-provas.mut`.
 *
 * ## A classe (docs/historico/provas-janela-de-relogio-fora-do-nucleo.md)
 *
 * A prova calcula o ESPERADO com o `date` do bash e o compara com a saída de uma função que lê o
 * `now()` do BANCO. São dois relógios, lidos a ~50–70 ms um do outro (medido): quando uma borda
 * (08:00/18:00 BRT, meia-noite, virada de mês) cai entre as duas leituras, a prova reprova
 * sozinha. E cada rodada só exercita o lado da borda que a hora do CI sortear — no resto, verde
 * cego. Caso de origem, o N9 de `db/test-data-health-estoque-fonte-dado.sh`:
 *   H_BRT=$(TZ=America/Sao_Paulo date +%H | sed 's/^0//')
 *
 * Conserto: relógio CONTROLADO. `public.now()` lê `test.agora`, e a prova FIXA o instante e cruza
 * a borda de propósito, em pares de 1 s (docs/agent/money-path.md).
 *
 * ## A assinatura, e o que fica de fora de propósito
 *
 * `date` (ou o `gdate` do coreutils do Homebrew) com formato que tem campo de CALENDÁRIO: `+%H`,
 * `-u "+%d/%m"`, `'+%u'`, `+"%F"`. O `+%s` (epoch) não entra: medir DURAÇÃO é legítimo, e duração
 * não tem borda.
 *
 * A única isenção é comentário, e quem a decide é o stripper COMPARTILHADO: `#` dentro de aspas é
 * dado, e uma regex local, que não sabe disso, apagaria justamente a linha que o fiscal existe para
 * ler (docs/historico/gates-textuais-cegos.md). Aspas e heredoc citado CONTAM: o texto costuma
 * alimentar um bash depois (`bash -c '…'`, `cat > x.sh <<'EOF'`), e lá o relógio é lido igual.
 *
 * O universo é TODO shell de `db/`, e não só `test-*.sh`: um `hora_brt() { date +%H; }` em
 * `db/lib/` que as provas chamassem seria a mesma leitura, fora do alcance de um fiscal só de provas.
 */

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { diagnosticarShell, removerComentariosShell } from '@/lib/gates/limpeza-shell';
import { alarmesDoStripper, enumerar } from './shell-variavel-colada-gate';

/** `import.meta.dir` é do Bun e não existe sob o vitest — por isso preguiçosa, como no irmão. */
const raizDoRepo = () => resolve(import.meta.dir, '..');

/**
 * O walker e os quatro alarmes do stripper vêm do irmão `shell-variavel-colada-gate.ts`, e não são
 * copiados: dois walkers para o mesmo corpo divergem em silêncio, um só não tem com quem divergir.
 * O teste confere o universo contra o `git ls-files` — shell novo em `db/` fica vermelho em vez de
 * invisível.
 */
export const RAIZES_PADRAO = ['db'];

/**
 * PISOS — o denominador do fiscal, medido em 2026-09-27. Sem eles, "0 violações" com o walker
 * quebrado é indistinguível de "0 violações" por mérito. Piso é alarme de fumaça: folgado abaixo do
 * medido, SOBE quando o repo cresce, nunca desce para caber.
 */
export const PISOS = {
  /** As provas, `db/test-*.sh`. Medido: 304 (de 313 shells em `db/`). */
  provas: 250,
  /**
   * Linhas de CÓDIGO lidas — não vazias, DEPOIS da limpeza. Leitura que devolve vazio não dispara
   * alarme nenhum do stripper (a fração preservada de 0 linhas é 1) e zera as violações junto: só
   * este piso diz que o zero foi mérito e não cegueira. Medido: 76.420.
   */
  linhasDeCodigo: 60_000,
} as const;

/** `date`/`gdate` + formato com campo de calendário. `%s` é epoch: duração, e fica de fora. */
const ASSINATURA = /\bg?date\b[^|;#\n]*\+["']?%[^s]/;
const PROVA = /^db\/test-[^/]*\.sh$/;

export interface Sitio {
  arquivo: string;
  linha: number;
  trecho: string;
}

export interface Analise {
  caminhos: string[];
  linhasDeCodigo: number;
  violacoes: Sitio[];
  alarmes: string[];
}

export function detectar(caminho: string, fonte: string): { sitios: Sitio[]; linhasDeCodigo: number } {
  const sitios: Sitio[] = [];
  let linhasDeCodigo = 0;
  // A limpeza preserva o número de linhas: o índice aqui é a linha da FONTE.
  const limpo = removerComentariosShell(fonte);
  limpo.split('\n').forEach((linha, i) => {
    if (linha.trim() !== '') linhasDeCodigo++;
    if (ASSINATURA.test(linha)) sitios.push({ arquivo: caminho, linha: i + 1, trecho: linha.trim() });
  });
  return { sitios, linhasDeCodigo };
}

export function analisar(arquivos: { caminho: string; fonte: string }[]): Analise {
  const r: Analise = { caminhos: [], linhasDeCodigo: 0, violacoes: [], alarmes: [] };
  for (const a of arquivos) {
    const d = detectar(a.caminho, a.fonte);
    r.caminhos.push(a.caminho);
    r.linhasDeCodigo += d.linhasDeCodigo;
    r.violacoes.push(...d.sitios);
    r.alarmes.push(...alarmesDoStripper(a.caminho, diagnosticarShell(a.fonte)));
  }
  return r;
}

export function veredito(r: Analise, comPisos: boolean): { codigo: 0 | 1 | 2; linhas: string[] } {
  const furos = r.alarmes.map((a) => `stripper desabando — ${a}`);
  if (r.caminhos.length === 0) furos.push('nenhum arquivo shell lido');
  const provas = r.caminhos.filter((c) => PROVA.test(c)).length;
  if (comPisos) {
    if (provas < PISOS.provas) furos.push(`${provas} prova(s) db/test-*.sh lida(s) < piso ${PISOS.provas}`);
    if (r.linhasDeCodigo < PISOS.linhasDeCodigo) {
      furos.push(`${r.linhasDeCodigo} linhas de código lidas < piso ${PISOS.linhasDeCodigo} — abriu arquivo, mas não leu código?`);
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
        `❌ ${r.violacoes.length} leitura(s) do relógio do BASH com campo de calendário em shell de db/:`,
        ...r.violacoes.map((s) => `  ${s.arquivo}:${s.linha}\n      ${s.trecho.slice(0, 140)}`),
        '',
        '  O esperado vem do `date` do bash e o real do now() do banco: DOIS relógios, lidos a ~50–70 ms',
        '  um do outro. Se uma borda (08:00/18:00 BRT, meia-noite, virada de mês) cair entre as leituras,',
        '  a prova reprova sozinha — e cada rodada só exercita o lado da borda que a hora do CI sortear.',
        '  Conserto: relógio CONTROLADO — `public.now()` lê `test.agora`; FIXE o instante e cruze a borda',
        '  de propósito, em pares de 1 s. Duração segue livre com `date +%s`.',
        '  docs/historico/provas-janela-de-relogio-fora-do-nucleo.md',
      ],
    };
  }
  const censo = comPisos ? ` (${provas} provas)` : '';
  return {
    codigo: 0,
    linhas: [
      `✅ relógio do bash em provas: ${r.caminhos.length} arquivo(s) shell${censo}, ${r.linhasDeCodigo} linhas de código ` +
        'lidas. Nenhum esperado tirado do `date` com campo de calendário.',
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
