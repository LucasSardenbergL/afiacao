#!/usr/bin/env bun
// gerar-sonda-disparo-prova.ts — emite os blocos de DISPARO (sonda e canária) PELO GERADOR DESTE
// DISCO, para a prova executada `db/test-sonda-passo-pelo-db-aplicar.sh`.
//
// ## Por que o disparo aqui NÃO é inerte (e o do `gerar-canaria-fixture.ts` é)
//
// A prova da canária julga o PASSO 2 e o monta ela mesma, com `format()` no PG17: o disparo nunca
// precisa rodar, e por isso o artefato dela pode — e deve — ser inerte. Esta prova mede outra coisa,
// o TRANSPORTE: o que o disparo devolve, e por onde. O `db:aplicar` roda o arquivo dentro do
// `aplicar_sql()`, por `EXECUTE`, e é essa execução que decide se o passo seguinte chega ao log. Sem
// executar o disparo não há o que medir — então ele roda, contra STUBS de `net.http_post` e `vault`
// num cluster descartável.
//
// ## A trava contra colar isto em produção é o REF
//
// `prova-sem-rede.invalid/` vira `https://prova-sem-rede.invalid/.supabase.co/functions/v1/<edge>`: o
// host é um TLD RESERVADO (RFC 2606), que nenhum resolvedor responde. Colado em produção por engano,
// o `http_post` morre no DNS e o `x-cron-secret` que ele lê do vault não sai da máquina. E os
// arquivos vão para o diretório TEMPORÁRIO que a prova passa, nunca para `db/`, onde virariam
// candidatos a `db:aplicar`.
//
// ## Uso
//
//   bun db/lib/gerar-sonda-disparo-prova.ts <dir-de-saída>
//
// Escreve `<dir>/sonda.sql` (PASSO 1 com duas edges baratas + PASSO 3 com uma cara, travada),
// `<dir>/canaria.sql` (uma canária barata + uma cara, as primeiras alcançáveis do registro) e
// `<dir>/meta.env` — o que a prova precisa para montar respostas de mentira.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { lerCanariasDoRepo } from '../../scripts/canaria-leitor-do-repo';
import {
  CANARIAS,
  gerarSqlDaLeva,
  gerarSqlDeCanariasResolvidas,
  resolverCanarias,
} from '../../scripts/sonda-versao-sql';

const REF_SEM_REDE = 'prova-sem-rede.invalid/';

/** As edges da leva de mentira: duas baratas (a e b) e uma cara (c), cada uma com a sua versão. */
const EDGES_DA_PROVA = {
  'sonda-a': 'v9.1-prova-a',
  'sonda-b': 'v9.2-prova-b',
  'sonda-c': 'v9.3-prova-c',
} as const;

const JANELA_MIN = 20;

/** Fingerprint na FORMA que o mapa exige (64 hex), determinístico pelo nome da edge. */
function fonteDe(edge: string): string {
  return createHash('sha256').update(edge).digest('hex');
}

/**
 * Repo de mentira com o mínimo que o gerador lê: o `project_id`, um `versao.ts` com o sensor por
 * edge e o mapa de fingerprints — na MESMA forma do `fixture()` de `scripts/sonda-versao-sql.test.ts`.
 */
function montarRaizDeMentira(): string {
  const raiz = mkdtempSync(join(tmpdir(), 'sonda-disparo-prova-'));
  const funcoes = join(raiz, 'supabase', 'functions');
  mkdirSync(join(funcoes, '_shared'), { recursive: true });
  writeFileSync(join(raiz, 'supabase', 'config.toml'), `project_id = "${REF_SEM_REDE}"\n`);
  for (const [edge, versao] of Object.entries(EDGES_DA_PROVA)) {
    mkdirSync(join(funcoes, edge), { recursive: true });
    writeFileSync(
      join(funcoes, edge, 'versao.ts'),
      'export { classificarSonda } from "../_shared/sonda-versao.ts";\n' +
        `export const VERSAO = "${versao}";\n`,
    );
  }
  const linhas = Object.keys(EDGES_DA_PROVA).map(
    (edge) => `  ${JSON.stringify(edge)}: ${JSON.stringify(fonteDe(edge))},`,
  );
  writeFileSync(
    join(funcoes, '_shared', 'sonda-fingerprints.ts'),
    `export const FONTE_SHA256: Record<string, string> = {\n${linhas.join('\n')}\n};\n`,
  );
  return raiz;
}

/** A 1ª canária alcançável de cada classe — escolhida pelo registro, não por nome decorado aqui. */
function canariasDaProva(): { barata: string; cara: string } {
  const alcancaveis = CANARIAS.filter((c) => c.inalcancavel === null);
  const barata = alcancaveis.find((c) => !c.fluxoRealSeVelho)?.nome;
  const cara = alcancaveis.find((c) => c.fluxoRealSeVelho)?.nome;
  if (!barata || !cara) {
    throw new Error(
      'o registro CANARIAS não tem uma canária alcançável de cada classe (barata e cara) — a prova ' +
        'precisa das duas para exercitar o PASSO 2 e o PASSO 4. Nenhum arquivo foi escrito.',
    );
  }
  return { barata, cara };
}

/** Valor de `meta.env` entre aspas simples — nome de canária pode ter `:`. */
function valorEnv(v: string): string {
  if (v.includes("'")) throw new Error(`valor com aspa simples não cabe no meta.env: ${v}`);
  return `'${v}'`;
}

if (import.meta.main) {
  const saida = process.argv[2];
  const raizDoRepo = join(import.meta.dirname, '..', '..');
  if (!saida) {
    console.error('❌ uso: bun db/lib/gerar-sonda-disparo-prova.ts <dir-de-saída>');
    process.exit(1);
  }
  const raizDeMentira = montarRaizDeMentira();
  try {
    const edges = Object.keys(EDGES_DA_PROVA);
    const sonda = gerarSqlDaLeva({
      raiz: raizDeMentira,
      edges,
      caras: ['sonda-c'],
      janelaMin: JANELA_MIN,
      soDisparo: true,
    });
    const { barata, cara } = canariasDaProva();
    // A leva sai do registro do repo REAL (é dele que o marcador esperado vem); o REF sai da raiz
    // de mentira — é ela que tira o host da rede.
    const leva = resolverCanarias(raizDoRepo, [barata, cara], lerCanariasDoRepo);
    const canaria = gerarSqlDeCanariasResolvidas(raizDeMentira, leva, JANELA_MIN);
    mkdirSync(saida, { recursive: true });
    writeFileSync(join(saida, 'sonda.sql'), sonda);
    writeFileSync(join(saida, 'canaria.sql'), canaria);
    const meta = [
      `VERSAO_A=${valorEnv(EDGES_DA_PROVA['sonda-a'])}`,
      `FONTE_A=${valorEnv(fonteDe('sonda-a'))}`,
      `CANARIA_BARATA=${valorEnv(barata)}`,
      `CANARIA_CARA=${valorEnv(cara)}`,
    ];
    writeFileSync(join(saida, 'meta.env'), `${meta.join('\n')}\n`);
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  } finally {
    rmSync(raizDeMentira, { recursive: true, force: true });
  }
}
