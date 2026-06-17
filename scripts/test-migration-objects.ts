#!/usr/bin/env bun
/**
 * test-migration-objects.ts — TDD de scripts/lib/migration-objects.ts
 *
 * A lib extrai objetos SQL criados por uma migration e gera uma CHAVE de
 * colisão estável. É a fundação do wt:preflight (detecta 2 migrations que
 * recriam o MESMO objeto → "última a rodar vence" sobrescreve uma).
 *
 * Casos críticos (apontados pelo Codex):
 *  - CREATE VIEW (o audit atual NÃO detecta → views v_grupo_* ficavam cegas)
 *  - assinatura de função: identidade PG = nome + tipos de arg (overload)
 *  - paridade com o extractObjects original (table/index/trigger/cron/enum/policy)
 *
 * Rodar: bun scripts/test-migration-objects.ts   (exit 0 = verde)
 */
import { extractObjects, objectKey } from './lib/migration-objects';

let fail = 0;
function check(desc: string, cond: boolean) {
  if (cond) console.log(`  ok    ${desc}`);
  else {
    console.log(`  FAIL  ${desc}`);
    fail = 1;
  }
}
function has(objs: Array<Record<string, unknown>>, partial: Record<string, string>): boolean {
  return objs.some((o) => Object.entries(partial).every(([k, v]) => o[k] === v));
}

console.log('── VIEW (gap que o audit não cobria) ──');
check(
  'CREATE OR REPLACE VIEW public.v_grupo_x',
  has(extractObjects('CREATE OR REPLACE VIEW public.v_grupo_x AS SELECT 1;'), { kind: 'view', schema: 'public', name: 'v_grupo_x' }),
);
check(
  'CREATE VIEW sem schema → public',
  has(extractObjects('CREATE VIEW v_simple AS SELECT 1;'), { kind: 'view', schema: 'public', name: 'v_simple' }),
);

console.log('── function + assinatura (identidade = nome + tipos de arg) ──');
const fInt = extractObjects('CREATE OR REPLACE FUNCTION foo(x integer) RETURNS void AS $$ $$ LANGUAGE sql;');
const fTxt = extractObjects('CREATE OR REPLACE FUNCTION foo(x text) RETURNS void AS $$ $$ LANGUAGE sql;');
const fIntAgain = extractObjects('CREATE OR REPLACE FUNCTION foo(x integer) RETURNS int AS $$ select 1 $$ LANGUAGE sql;');
check('function detectada', has(fInt, { kind: 'function', name: 'foo' }));
check('overload foo(integer) ≠ foo(text) → chaves distintas', objectKey(fInt[0]) !== objectKey(fTxt[0]));
check('foo(integer) recriada → MESMA chave (colide)', objectKey(fInt[0]) === objectKey(fIntAgain[0]));

console.log('── paridade com o extractObjects original ──');
check('table', has(extractObjects('CREATE TABLE IF NOT EXISTS public.t (id int);'), { kind: 'table', name: 't' }));
check('index', has(extractObjects('CREATE UNIQUE INDEX idx_x ON public.t (id);'), { kind: 'index', name: 'idx_x', parent: 't' }));
check(
  'trigger',
  has(extractObjects('CREATE TRIGGER trg AFTER INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION f();'), { kind: 'trigger', name: 'trg', parent: 't' }),
);
check('cron_job', has(extractObjects("SELECT cron.schedule('job_x','* * * * *',$$ select 1 $$);"), { kind: 'cron_job', name: 'job_x' }));
check(
  'enum_value',
  has(extractObjects("ALTER TYPE public.my_enum ADD VALUE IF NOT EXISTS 'val';"), { kind: 'enum_value', name: 'val', parent: 'my_enum' }),
);
check('rls_policy', has(extractObjects('CREATE POLICY "p_sel" ON public.t FOR SELECT USING (true);'), { kind: 'rls_policy', name: 'p_sel', parent: 't' }));

console.log('── robustez ──');
check('ignora CREATE comentado', extractObjects('-- CREATE OR REPLACE FUNCTION fake() ...\nSELECT 1;').length === 0);
const v1 = extractObjects('CREATE OR REPLACE VIEW public.v_grupo_x AS SELECT 1;')[0];
const v2 = extractObjects('CREATE OR REPLACE VIEW v_grupo_x AS SELECT 2;')[0];
check('view schema implícito public → mesma chave', objectKey(v1) === objectKey(v2));

console.log();
console.log(fail === 0 ? 'PASS — migration-objects' : 'FALHOU');
process.exit(fail);
