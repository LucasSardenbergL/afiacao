import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CABECALHO, verificarSnapshotCron, type Problema } from './cron-jobs-snapshot-gate';

/**
 * Dente do gate do snapshot de cron.job (M-37). O arquivo real é capturado de prod pelo
 * `bash db/refresh-snapshot.sh` (ou `--so-cron`); aqui o CI confere integridade + o diff
 * prod → repo (todo job de prod recriável por migration). Cada defeito sintético casa o TIPO
 * do problema, não "deu algum problema" — senão um ramo quebrado esconderia outro.
 */

const RAIZ = resolve(fileURLToPath(import.meta.url), '../..');
const DIR_MIG = join(RAIZ, 'supabase/migrations');
const corpus = readdirSync(DIR_MIG)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(DIR_MIG, f), 'utf8'))
  .join('\n');
const real = readFileSync(join(RAIZ, 'supabase/cron-jobs-snapshot.tsv'), 'utf8');

const tipos = (p: Problema[]) => p.map((x) => x.tipo);
const job = (nome: string, command = 'select 1', active = 'true') =>
  [nome, '*/5 * * * *', active, 'postgres', 'postgres', command].join('\t');
const tsv = (...linhas: string[]) => [CABECALHO, ...linhas, `#fim\t${linhas.length}`].join('\n') + '\n';
const MIG = "select cron.schedule('a-job', '* * * * *', 'select 1'); select cron.schedule('b-job', '* * * * *', 'x');";

describe('o snapshot REAL de prod', () => {
  it('controle positivo: tem jobs (um arquivo vazio passaria em "nenhum problema")', () => {
    const n = Number(/#fim\t(\d+)\s*$/.exec(real)?.[1]);
    expect(n).toBeGreaterThan(50);
  });

  it('está íntegro, sem segredo literal, e todo job de prod é recriável por migration', () => {
    expect(verificarSnapshotCron(real, corpus)).toEqual([]);
  });
});

describe('cada defeito é pego pelo ramo certo', () => {
  it('controle: arquivo bem-formado e coberto não acusa nada', () => {
    expect(verificarSnapshotCron(tsv(job('a-job'), job('b-job')), MIG)).toEqual([]);
  });

  it('captura truncada (sem #fim) → sem-marcador-fim', () => {
    expect(tipos(verificarSnapshotCron([CABECALHO, job('a-job')].join('\n'), MIG))).toEqual(['sem-marcador-fim']);
  });

  it('marcador que não bate com as linhas → contagem', () => {
    const t = [CABECALHO, job('a-job'), '#fim\t2'].join('\n');
    expect(verificarSnapshotCron(t, MIG)).toEqual([{ tipo: 'contagem', declarado: 2, linhas: 1 }]);
  });

  it('zero jobs → contagem (prod sem cron é anomalia, não snapshot)', () => {
    expect(tipos(verificarSnapshotCron(tsv(), MIG))).toEqual(['contagem']);
  });

  it('cabeçalho trocado → cabecalho', () => {
    const t = tsv(job('a-job')).replace(CABECALHO, 'jobid\t' + CABECALHO);
    expect(tipos(verificarSnapshotCron(t, MIG))).toEqual(['cabecalho']);
  });

  it('TAB cru no command (escape quebrado) → campos', () => {
    expect(tipos(verificarSnapshotCron(tsv(job('a-job', 'select\t1')), MIG))).toEqual(['campos']);
  });

  it('active fora de true/false → active-invalido', () => {
    expect(tipos(verificarSnapshotCron(tsv(job('a-job', 'select 1', 't')), MIG))).toEqual(['active-invalido']);
  });

  it('fora de ordem → fora-de-ordem; nome repetido → duplicado', () => {
    expect(tipos(verificarSnapshotCron(tsv(job('b-job'), job('a-job')), MIG))).toEqual(['fora-de-ordem']);
    expect(tipos(verificarSnapshotCron(tsv(job('a-job'), job('a-job')), MIG))).toEqual(['duplicado']);
  });

  it('JWT ou Bearer literal no command → segredo-literal', () => {
    const jwt = job('a-job', "select net.http_post(headers:='{\"apikey\":\"eyJhbGciOiJIUzI1NiJ9xx\"}')");
    const bearer = job('a-job', "jsonb_build_object('Authorization', 'Bearer abc123')");
    expect(tipos(verificarSnapshotCron(tsv(jwt), MIG))).toEqual(['segredo-literal']);
    expect(tipos(verificarSnapshotCron(tsv(bearer), MIG))).toEqual(['segredo-literal']);
  });

  it('Bearer montado do vault NÃO é segredo literal', () => {
    const vault = job('a-job', "jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets))");
    expect(verificarSnapshotCron(tsv(vault), MIG)).toEqual([]);
  });

  it('job de prod que nenhuma migration cita → sem-migration (o diff prod → repo)', () => {
    expect(verificarSnapshotCron(tsv(job('a-job'), job('criado-a-mao')), MIG)).toEqual([
      { tipo: 'sem-migration', jobname: 'criado-a-mao' },
    ]);
  });
});
