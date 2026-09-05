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

import {
  cobreOPiso,
  coberturaPct,
  julgar,
  lerPiso,
  parsearObservacoes,
  type Estado,
  type Relatorio,
  type Veredito,
} from './lib/pendencias-deploy';
import { lerMapaCommitado } from './sonda-fingerprint';

const PSQL_RO = process.env.PSQL_RO ?? join(homedir(), '.config', 'afiacao', 'psql-ro');

/**
 * As DUAS vias pelas quais prod já disse qual bundle está no ar.
 *
 * 1. SONDA ATIVA (`probe:true`): alguém colou o `sonda:sql` no SQL Editor e a edge respondeu o
 *    corpo de `criarRespostaSonda`. Depende de um humano lembrar.
 * 2. ECO PASSIVO (`edge`+`versao` presentes, `probe` AUSENTE): as edges cujo `jsonRes` planta
 *    `versao`/`edge`/`fonte` em TODA resposta — não só na da sonda. O cron chama a edge pelo seu
 *    próprio motivo, o corpo cai em `net._http_response`, e o marcador se lê de graça.
 *
 * A via 2 é a MAIOR, e era 100% invisível: o filtro antigo exigia `probe:true`, então a
 * `analytics-outbox-drain` — cron de 5 em 5 minutos, 72 respostas na janela, `fonte` batendo com o
 * mapa commitado — saía como "⚪ sem sonda na janela (ausência de dado)". O dado estava lá o tempo
 * todo; quem estava cego era a query. Medido em 2026-08-31 (7/40) e de novo em 2026-09-04, onde a
 * cobertura ia de 1 para 2 edges só por aceitar o eco. O #2103 já tinha nomeado isto — em DOCS; o
 * script nunca acompanhou, e um diagnóstico que documenta o próprio ponto cego continua cego.
 *
 * `NOT (r.c ? 'probe')` e não `(r.c ->> 'probe') <> 'true'`: o `<>` é NULL-blind (chave ausente
 * devolve NULL, que não é TRUE, e a linha sumiria de novo — exatamente o bug). O `?` devolve
 * booleano sempre. `probe` presente com valor que não é `true` fica DE FORA de propósito: é forma
 * que não emitimos, e admitir shape desconhecido no instrumento de deploy é fail-OPEN.
 *
 * O filtro textual continua ANTES do cast para jsonb: corpo não-JSON no meio da janela abortaria a
 * query inteira, e uma varredura que morre por causa de uma linha alheia não serve de cron. Ele
 * ficou mais ESTRITO, não menos — sem o `LIKE '%"probe"%'`, o que chega ao cast passou de ~1 para
 * ~76 linhas por janela, então entram o `LIKE '%"versao"%'` (que o predicado externo exige de todo
 * jeito) e o `IS JSON OBJECT` do PG16+ (prod é 17.6), que pega o corpo truncado que começa com `{`
 * e que o `left(...)` sozinho deixava passar direto para o cast.
 *
 * O veredito continua julgando o `fonte`, não o `versao`: o `coalesce(..., 'sem-campo')` faz eco
 * sem fingerprint cair em DIVERGE em vez de sumir — e `versao` certo com `fonte` errado é
 * exatamente o deploy incompleto que a ARMADILHA 2 da lib descreve.
 */
export const SQL = `
SELECT r.c ->> 'edge', r.c ->> 'versao', coalesce(r.c ->> 'fonte', 'sem-campo'), r.created
FROM (
  SELECT (content::jsonb) AS c, created
  FROM net._http_response
  WHERE status_code = 200
    AND content IS NOT NULL
    AND left(ltrim(content), 1) = '{'
    AND content IS JSON OBJECT
    AND content LIKE '%"edge"%'
    AND content LIKE '%"versao"%'
) r
WHERE r.c ? 'edge' AND r.c ? 'versao'
  AND ((r.c ->> 'probe') = 'true' OR NOT (r.c ? 'probe'))
ORDER BY r.created DESC;
`.trim();

function consultar(): string {
  return execFileSync(PSQL_RO, ['-A', '-F', '|', '-t', '-c', SQL], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function imprimir(rel: Relatorio): void {
  // Tipados como `Estado` de propósito: um estado novo na lib sem rótulo aqui — ou um nome
  // digitado errado — vira erro de compilação, não seção que some calada do relatório.
  const ordem: Estado[] = ['DIVERGE', 'SEM_MAPA_NO_BUNDLE', 'FORA_DO_MAPA', 'NAO_OBSERVADA', 'CONFERE'];
  const rotulo: Record<Estado, string> = {
    DIVERGE: '🔴 DEPLOY PENDENTE',
    SEM_MAPA_NO_BUNDLE: '🔴 BUNDLE SEM O MAPA (_shared ficou para trás)',
    FORA_DO_MAPA: '🟠 prod serve edge que a main não mapeia',
    NAO_OBSERVADA: '⚪ sem sonda na janela (ausência de dado, NÃO é ok)',
    CONFERE: '✅ confere',
  };

  for (const estado of ordem) {
    const grupo: Veredito[] = rel.vereditos.filter((v) => v.estado === estado);
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
  let piso: number;
  try {
    piso = lerPiso(process.env.PENDENCIAS_COBERTURA_MINIMA);
  } catch (e) {
    console.error(`❌ MECÂNICA: ${(e as Error).message}`);
    return 2;
  }

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

  if (rel.totalDivergentes > 0) return 1;

  // Nada divergiu ENTRE AS OBSERVADAS — que é uma frase muito mais fraca que "nada divergiu".
  // Sem o piso, 2 de 39 edges saía com o mesmo exit 0 de 39 de 39, e o cron calava nos dois.
  if (!cobreOPiso(rel, piso)) {
    console.error(
      `\n⚠️  COBERTURA ABAIXO DO PISO: ${coberturaPct(rel).toFixed(0)}% < ${piso}%.` +
        ` Nada divergiu entre as ${rel.totalObservadas} observadas, mas as outras` +
        ` ${rel.totalMapeadas - rel.totalObservadas} não foram vistas.`,
    );
    console.error('   Dispare a leva com `bun run sonda:sql <edge>…` e rode de novo.');
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(main());
