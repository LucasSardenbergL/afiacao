#!/usr/bin/env bun
/**
 * pendencias-deploy.ts — CLI da varredura PASSIVA de deploy divergente.
 *
 * Lê `net._http_response` pelo wrapper read-only e julga contra o mapa commitado. Não dispara
 * sonda, não escreve, não precisa de secret: só do `psql-ro`. Feito para virar cron e só falar
 * quando algo diverge.
 *
 * O julgamento puro vive em `lib/pendencias-deploy.ts` (testável sem rede). Aqui fica só a borda:
 * shell, parse do exit e códigos de saída.
 *
 * EXIT CODES — e o 2 é o que impede este script de virar teatro:
 *   0  nada divergente E houve observação positiva
 *   1  divergência encontrada (há deploy pendente)
 *   2  MECÂNICA não confiável: psql falhou, mapa vazio, ou ZERO observações na janela.
 *      Zero observações NÃO é "tudo limpo" — é a janela do `pg_net.ttl` sem sonda nenhuma,
 *      indistinguível de um instrumento quebrado. Um cron que devolvesse 0 aqui ensinaria o
 *      operador a ler silêncio como aprovação, que é exatamente o hábito que a varredura existe
 *      para desfazer.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { julgar, parsearObservacoes, type Relatorio } from './lib/pendencias-deploy';
import { lerMapaCommitado } from './sonda-fingerprint';

const PSQL_RO = process.env.PSQL_RO ?? join(homedir(), '.config', 'afiacao', 'psql-ro');

/**
 * Só respostas de SONDA: `probe:true` + campo `edge`. O filtro textual roda ANTES do cast para
 * jsonb de propósito — corpo não-JSON no meio da janela abortaria a query inteira, e uma varredura
 * que morre por causa de uma linha alheia não serve de cron.
 */
const SQL = `
SELECT r.c ->> 'edge', r.c ->> 'versao', coalesce(r.c ->> 'fonte', 'sem-campo'), r.created
FROM (
  SELECT (content::jsonb) AS c, created
  FROM net._http_response
  WHERE status_code = 200
    AND content IS NOT NULL
    AND left(ltrim(content), 1) = '{'
    AND content LIKE '%"probe"%'
    AND content LIKE '%"edge"%'
) r
WHERE r.c ? 'edge' AND r.c ? 'versao' AND (r.c ->> 'probe') = 'true'
ORDER BY r.created DESC;
`.trim();

function consultar(): string {
  return execFileSync(PSQL_RO, ['-A', '-F', '|', '-t', '-c', SQL], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function imprimir(rel: Relatorio): void {
  const ordem = ['DIVERGE', 'SEM_MAPA_NO_BUNDLE', 'FORA_DO_MAPA', 'NAO_OBSERVADA', 'CONFERE'];
  const rotulo: Record<string, string> = {
    DIVERGE: '🔴 DEPLOY PENDENTE',
    SEM_MAPA_NO_BUNDLE: '🔴 BUNDLE SEM O MAPA (_shared ficou para trás)',
    FORA_DO_MAPA: '🟠 prod serve edge que a main não mapeia',
    NAO_OBSERVADA: '⚪ sem sonda na janela (ausência de dado, NÃO é ok)',
    CONFERE: '✅ confere',
  };

  for (const estado of ordem) {
    const grupo = rel.vereditos.filter((v) => v.estado === estado);
    if (grupo.length === 0) continue;
    console.log(`\n${rotulo[estado]} — ${grupo.length}`);
    for (const v of grupo) {
      const det =
        v.estado === 'DIVERGE'
          ? `  esperado ${v.esperado?.slice(0, 16)}… · observado ${v.observado?.slice(0, 16)}…`
          : v.estado === 'NAO_OBSERVADA'
            ? ''
            : `  ${v.versao ?? ''}`;
      console.log(`   ${v.edge.padEnd(34)}${det}`);
    }
  }

  console.log(
    `\n─── cobertura: ${rel.totalObservadas}/${rel.totalMapeadas} edges mapeadas responderam na janela` +
      ` (pg_net.ttl = 6h)`,
  );
  if (rel.linhasIgnoradas > 0) {
    console.log(`⚠️  ${rel.linhasIgnoradas} linha(s) da saída do psql não casaram o formato`);
  }
}

export function main(): number {
  let mapa: Record<string, string>;
  try {
    mapa = lerMapaCommitado();
  } catch (e) {
    console.error(`❌ MECÂNICA: não li o mapa commitado — ${(e as Error).message}`);
    return 2;
  }
  if (Object.keys(mapa).length === 0) {
    console.error('❌ MECÂNICA: mapa de fingerprints VAZIO. Rode `bun run sonda:fingerprint`.');
    return 2;
  }

  let saida: string;
  try {
    saida = consultar();
  } catch (e) {
    console.error(`❌ MECÂNICA: '${PSQL_RO}' falhou — ${(e as Error).message}`);
    console.error('   Sem leitura de prod NÃO existe veredito. Isto não é "tudo limpo".');
    return 2;
  }

  const { observacoes, linhasIgnoradas } = parsearObservacoes(saida);
  const rel = julgar(mapa, observacoes, linhasIgnoradas);

  if (rel.totalObservadas === 0) {
    console.error(
      `❌ MECÂNICA: ZERO das ${rel.totalMapeadas} edges mapeadas respondeu na janela de 6h.`,
    );
    console.error('   Isto é ausência de dado, não aprovação — dispare a leva com `bun run sonda:sql`.');
    return 2;
  }

  imprimir(rel);
  return rel.totalDivergentes > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main());
