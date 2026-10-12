/**
 * Gate do snapshot de `cron.job` (M-37 do plano 2026-09-05 · banco B08).
 *
 * O `supabase/schema-snapshot.sql` é `pg_dump --schema-only`: ele não leva as LINHAS de `cron.job`.
 * Um DR recriaria o schema sem os crons de prod — o runbook falava em 33, prod tinha 93 (hoje 99).
 * `db/refresh-snapshot.sh` passou a capturar `cron.job` em `supabase/cron-jobs-snapshot.tsv`
 * (`db/cron-jobs-snapshot.sql`); este gate confere, no CI, duas coisas:
 *
 *  1. o arquivo está ÍNTEGRO — cabeçalho, 6 campos, ordenado e sem nome repetido, e o marcador
 *     `#fim<TAB>n` batendo com o nº de jobs (sem ele, a captura foi truncada e "passaria");
 *  2. o DIFF prod → repo: todo job capturado em prod tem o nome citado em alguma migration
 *     (`'nome'`), ou seja, o DR consegue recriá-lo. Cron criado à mão no SQL Editor, sem migration,
 *     aparece aqui no próximo refresh.
 *
 * E barra segredo LITERAL em `command` (JWT, `Bearer <valor>`): o arquivo vai para o git.
 * O sentido repo → prod não é checado: migration antiga cita jobs depois removidos por
 * `unschedule` (3 hoje), e decidir isso exige modelar a ordem das migrations.
 */

export const CABECALHO = ['jobname', 'schedule', 'active', 'username', 'database', 'command'].join('\t');

/** Mesmo padrão do `capturar_cron` do db/refresh-snapshot.sh — mudar um exige mudar o outro. */
export const SEGREDO_LITERAL = /eyJ[A-Za-z0-9_-]{10,}|[Bb]earer\s+[A-Za-z0-9]/;

export type Problema =
  | { tipo: 'cabecalho'; veio: string }
  | { tipo: 'sem-marcador-fim' }
  | { tipo: 'contagem'; declarado: number; linhas: number }
  | { tipo: 'campos'; linha: number; campos: number }
  | { tipo: 'active-invalido'; jobname: string; veio: string }
  | { tipo: 'fora-de-ordem'; jobname: string; anterior: string }
  | { tipo: 'duplicado'; jobname: string }
  | { tipo: 'segredo-literal'; jobname: string }
  | { tipo: 'sem-migration'; jobname: string };

export function verificarSnapshotCron(tsv: string, corpusMigrations: string): Problema[] {
  const problemas: Problema[] = [];
  const linhas = tsv.replace(/\n$/, '').split('\n');

  if (linhas[0] !== CABECALHO) problemas.push({ tipo: 'cabecalho', veio: (linhas[0] ?? '').slice(0, 80) });

  const ultima = linhas[linhas.length - 1] ?? '';
  const fim = /^#fim\t(\d+)$/.exec(ultima);
  const corpo = linhas.slice(1, fim ? -1 : undefined);
  if (!fim) problemas.push({ tipo: 'sem-marcador-fim' });
  else if (Number(fim[1]) !== corpo.length || corpo.length === 0) {
    problemas.push({ tipo: 'contagem', declarado: Number(fim[1]), linhas: corpo.length });
  }

  const vistos = new Set<string>();
  let anterior = '';
  corpo.forEach((linha, i) => {
    const campos = linha.split('\t');
    if (campos.length !== 6) {
      problemas.push({ tipo: 'campos', linha: i + 2, campos: campos.length });
      return;
    }
    const [jobname, , active, , , command] = campos;
    if (active !== 'true' && active !== 'false') problemas.push({ tipo: 'active-invalido', jobname, veio: active });
    if (vistos.has(jobname)) problemas.push({ tipo: 'duplicado', jobname });
    // ordem byte a byte, a mesma do `ORDER BY jobname COLLATE "C"` da captura
    else if (anterior !== '' && jobname < anterior) problemas.push({ tipo: 'fora-de-ordem', jobname, anterior });
    vistos.add(jobname);
    anterior = jobname;
    if (SEGREDO_LITERAL.test(command)) problemas.push({ tipo: 'segredo-literal', jobname });
    if (!corpusMigrations.includes(`'${jobname}'`)) problemas.push({ tipo: 'sem-migration', jobname });
  });

  return problemas;
}
