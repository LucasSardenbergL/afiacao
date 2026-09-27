#!/usr/bin/env bun
/**
 * lovable-sensor-edicao.ts — rode LOGO DEPOIS de mandar um deploy ao agente do Lovable.
 *
 * Responde "o agente editou algo além de deployar?" por dois eixos que não dependem da palavra dele:
 * a resposta do MCP (`edit_id`/`commit_sha`) e os commits `gpt-engineer-app` na `origin/main` desde
 * o envio. Lógica e porquês em `lib/lovable-sensor-edicao.ts`; incidente em
 * `docs/historico/agente-lovable-conserta-o-que-nao-pediram.md`.
 *
 * Uso:
 *   bun scripts/lovable-sensor-edicao.ts --desde <ISO-8601 do envio> <resposta.json | ->
 *   (a resposta é o texto devolvido por `mcp__lovable__send_message`/`get_message`, salvo em arquivo)
 *
 * O `git fetch` é do script: comparar contra a `origin/main` em disco é medir um retrato velho.
 *
 * EXIT CODES:
 *   0  SEM_EDICAO — nenhum sinal na resposta, nenhum commit do bot fora de `types.ts`, a `main` foi
 *      lida ≥ `--assentar-min` (padrão 5) depois do envio, e o agente escreveu a linha de confirmação
 *   1  EDICAO_DETECTADA — reverta por PR (bumpando `VERSAO` se tocou edge) antes de qualquer outra coisa
 *   2  mecânica: argumento ausente, `--desde` inválido, `git fetch`/`git log` que não respondem
 *   3  SEM_CONFIRMACAO — nada detectado, mas o agente não escreveu `No files were edited.`: leia a resposta
 *   4  CEDO_DEMAIS — nada detectado AINDA; o sync pode não ter empurrado. Re-rode depois do prazo
 *   5  ILEGIVEL — resposta vazia: sem resposta não há "sem edição"
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { commitsSuspeitos, julgar, lerResposta, parsearLogDoBot, type Veredito } from './lib/lovable-sensor-edicao';

const EXIT: Record<Veredito, number> = {
  SEM_EDICAO: 0,
  EDICAO_DETECTADA: 1,
  SEM_CONFIRMACAO: 3,
  CEDO_DEMAIS: 4,
  ILEGIVEL: 5,
};

function mecanica(msg: string): never {
  console.error(`SENSOR_MECANICA: ${msg}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const iDesde = args.indexOf('--desde');
const desdeTxt = iDesde >= 0 ? args[iDesde + 1] : undefined;
if (!desdeTxt) mecanica('falta --desde <ISO do envio> — sem o instante do envio não há janela de commits a ler');
const desde = new Date(desdeTxt);
if (Number.isNaN(desde.getTime())) mecanica(`--desde "${desdeTxt}" não é data ISO`);
const iAssentar = args.indexOf('--assentar-min');
const assentarMin = iAssentar >= 0 ? Number(args[iAssentar + 1]) : 5;
if (!Number.isFinite(assentarMin) || assentarMin < 0) mecanica('--assentar-min precisa ser número ≥ 0');
const usados = new Set([iDesde, iDesde + 1, iAssentar, iAssentar >= 0 ? iAssentar + 1 : -1]);
const posicionais = args.filter((_, i) => !usados.has(i));
if (posicionais.length !== 1) mecanica('passe exatamente UM arquivo de resposta (ou - para stdin)');

let texto: string;
try {
  texto = readFileSync(posicionais[0] === '-' ? 0 : posicionais[0], 'utf8');
} catch (e) {
  mecanica(`não li a resposta: ${(e as Error).message}`);
}

const fetch = spawnSync('git', ['fetch', '-q', 'origin', 'main'], { encoding: 'utf8' });
if (fetch.status !== 0) mecanica(`git fetch origin main saiu ${fetch.status}: ${fetch.stderr.trim()}`);
const log = spawnSync(
  'git',
  ['log', 'origin/main', '--author=gpt-engineer-app', `--since=${desde.toISOString()}`, '--format=%x1e%H%x09%s', '--name-only', '--diff-merges=first-parent'],
  { encoding: 'utf8' },
);
if (log.status !== 0) mecanica(`git log saiu ${log.status}: ${log.stderr.trim()}`);

const resposta = lerResposta(texto);
const commits = parsearLogDoBot(log.stdout);
const suspeitos = commitsSuspeitos(commits);
const decorridoMin = (Date.now() - desde.getTime()) / 60_000;
const veredito = julgar(resposta, suspeitos, decorridoMin >= assentarMin);

console.log(`resposta do MCP: ${resposta.legivel ? (resposta.sinais.length > 0 ? `SINAIS ${resposta.sinais.join(', ')}` : 'sem edit_id/commit_sha') : 'VAZIA'}`);
console.log(`confirmação "No files were edited.": ${resposta.confirmou ? 'presente' : 'AUSENTE'}`);
console.log(`commits gpt-engineer-app em origin/main desde ${desde.toISOString()}: ${commits.length} (${suspeitos.length} fora de types.ts)`);
for (const c of commits) {
  const marca = suspeitos.includes(c) ? 'SUSPEITO' : 'tolerado';
  console.log(`  ${marca}  ${c.sha.slice(0, 9)}  ${c.assunto}  [${c.arquivos.join(', ')}]`);
}
console.log(`decorrido desde o envio: ${decorridoMin.toFixed(1)} min (assentar: ${assentarMin} min)`);
console.log(`VEREDITO: ${veredito}`);
if (veredito === 'EDICAO_DETECTADA') {
  console.log('  → o agente editou. Reverta por PR (bump de VERSAO se tocou edge — o sonda:bump compara contra a main com os "Changes") e NÃO considere a leva fechada.');
}
if (veredito === 'CEDO_DEMAIS') {
  console.log(`  → nada ainda não é nada: re-rode depois de ${assentarMin} min do envio.`);
}
process.exit(EXIT[veredito]);
