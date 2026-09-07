import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditRevokeSemPublic, type FuncaoFinding } from './lib/authz-funcoes';
import { REVOKE_SEM_PUBLIC_BASELINE, chaveRevokeSemPublic } from './authz-revoke-public-baseline';

/**
 * Parte F — `REVOKE … FROM anon|authenticated` desacompanhado de `FROM PUBLIC` na MESMA função.
 *
 * Os testes casam o CÓDIGO ASCII (`FUNCAO_REVOKE_SEM_PUBLIC`), nunca a mensagem em português —
 * lição #1483 (`grep -qi` sobre string acentuada falsifica por acidente de locale).
 */
const cods = (fs: FuncaoFinding[]) => fs.map((f) => f.codigo).sort();
const alvos = (fs: FuncaoFinding[]) => fs.map((f) => f.funcao).sort();
const m = (sql: string, file = '20260901000000_x.sql') => [{ file, sql }];

describe('Parte F — revoke de role nomeada sem fechar PUBLIC', () => {
  it('acusa REVOKE FROM anon sozinho', () => {
    const f = auditRevokeSemPublic(m('REVOKE EXECUTE ON FUNCTION public.f() FROM anon;'), new Set());
    expect(cods(f)).toEqual(['FUNCAO_REVOKE_SEM_PUBLIC']);
    expect(alvos(f)).toEqual(['public.f']);
  });

  it('acusa REVOKE FROM authenticated sozinho (o espelho vale p/ as duas roles)', () => {
    const f = auditRevokeSemPublic(m('REVOKE EXECUTE ON FUNCTION public.f() FROM authenticated;'), new Set());
    expect(cods(f)).toEqual(['FUNCAO_REVOKE_SEM_PUBLIC']);
  });

  it('aceita quando o FROM PUBLIC acompanha a MESMA função', () => {
    const f = auditRevokeSemPublic(
      m('REVOKE EXECUTE ON FUNCTION public.f() FROM anon;\nREVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC;'),
      new Set(),
    );
    expect(f).toEqual([]);
  });

  it('aceita as duas roles + PUBLIC num único statement', () => {
    const f = auditRevokeSemPublic(m('REVOKE ALL ON FUNCTION public.f() FROM anon, authenticated, PUBLIC;'), new Set());
    expect(f).toEqual([]);
  });

  // O caso que um grep POR ARQUIVO erra — e que é exatamente a forma da 20260821200000.
  it('julga POR FUNÇÃO: arquivo com A fechada e B aberta acusa só B', () => {
    const sql = [
      'REVOKE EXECUTE ON FUNCTION public.a(jsonb) FROM authenticated;',
      'REVOKE EXECUTE ON FUNCTION public.a(jsonb) FROM anon;',
      'REVOKE EXECUTE ON FUNCTION public.a(jsonb) FROM PUBLIC;',
      'REVOKE EXECUTE ON FUNCTION public.b() FROM anon;',
    ].join('\n');
    const f = auditRevokeSemPublic(m(sql), new Set());
    expect(alvos(f)).toEqual(['public.b']);
  });

  it('aceita o REVOKE abrangente ON ALL FUNCTIONS IN SCHEMA … FROM PUBLIC', () => {
    const sql = [
      'REVOKE EXECUTE ON FUNCTION public.f() FROM anon;',
      'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;',
    ].join('\n');
    expect(auditRevokeSemPublic(m(sql), new Set())).toEqual([]);
  });

  it('não confunde schema: sweep de PUBLIC em OUTRO schema não fecha a função de public', () => {
    const sql = [
      'REVOKE EXECUTE ON FUNCTION public.f() FROM anon;',
      'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;',
    ].join('\n');
    expect(cods(auditRevokeSemPublic(m(sql), new Set()))).toEqual(['FUNCAO_REVOKE_SEM_PUBLIC']);
  });

  it('ignora o que está em COMENTÁRIO (stripNoise compartilhado)', () => {
    const f = auditRevokeSemPublic(m('-- REVOKE EXECUTE ON FUNCTION public.f() FROM anon;\nSELECT 1;'), new Set());
    expect(f).toEqual([]);
  });

  it('GRANT não é REVOKE', () => {
    expect(auditRevokeSemPublic(m('GRANT EXECUTE ON FUNCTION public.f() TO anon;'), new Set())).toEqual([]);
  });

  it('caixa e aspas não escapam', () => {
    const sql = 'revoke execute on function public."f"() from anon;\nrevoke execute on function public.f() from public;';
    expect(auditRevokeSemPublic(m(sql), new Set())).toEqual([]);
  });

  it('vários alvos num REVOKE só rendem um achado cada', () => {
    const f = auditRevokeSemPublic(m('REVOKE EXECUTE ON FUNCTION public.a(), public.b() FROM anon;'), new Set());
    expect(alvos(f)).toEqual(['public.a', 'public.b']);
  });


  // ── corpus ORDENADO: migration aplicada não se edita, então o conserto vem numa POSTERIOR.
  it('fix-forward: FROM PUBLIC numa migration POSTERIOR fecha o débito da anterior', () => {
    const migs = [
      { file: '20260101000000_cria.sql', sql: 'REVOKE EXECUTE ON FUNCTION public.f() FROM anon;' },
      { file: '20260202000000_conserta.sql', sql: 'REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC;' },
    ];
    expect(auditRevokeSemPublic(migs, new Set())).toEqual([]);
  });

  it('ordem importa: PUBLIC fechado ANTES de um DROP+CREATE posterior NÃO vale (recriação reseta o ACL)', () => {
    const migs = [
      { file: '20260101000000_fecha.sql', sql: 'REVOKE EXECUTE ON FUNCTION public.f() FROM anon;\nREVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC;' },
      { file: '20260202000000_recria.sql', sql: 'DROP FUNCTION IF EXISTS public.f();\nCREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nREVOKE EXECUTE ON FUNCTION public.f() FROM anon;' },
    ];
    const f = auditRevokeSemPublic(migs, new Set());
    expect(cods(f)).toEqual(['FUNCAO_REVOKE_SEM_PUBLIC']);
    expect(f[0].file).toBe('20260202000000_recria.sql');
  });

  // Âncora INCLUSIVA: a forma REAL de recriação no repo é DROP+CREATE+REVOKE no MESMO arquivo.
  // Com `>` estrito o detector reprovava justamente a forma correta (13 falsos medidos).
  it('DROP+CREATE+REVOKE dos 3 no MESMO arquivo é válido', () => {
    const sql = [
      'DROP FUNCTION IF EXISTS public.f();',
      'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
      'REVOKE EXECUTE ON FUNCTION public.f() FROM anon;',
      'REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC;',
    ].join('\n');
    expect(auditRevokeSemPublic(m(sql), new Set())).toEqual([]);
  });


  // O motivo de usar `elementosDeTopo` em vez de varrer `ident(`: o tipo parametrizado de um
  // argumento também casa com `ident(` e viraria um ALVO FANTASMA (`public.numeric`).
  it('tipo parametrizado no argumento não vira alvo fantasma', () => {
    const f = auditRevokeSemPublic(m('REVOKE EXECUTE ON FUNCTION public.f(numeric(10,2)) FROM anon;'), new Set());
    expect(alvos(f)).toEqual(['public.f']);
  });


  // Fail-closed do DROP ILEGÍVEL: se o parser não leu a lista de alvos do DROP, ele não pode
  // afirmar que a função recriada logo abaixo NÃO foi derrubada — e uma recriação anula o
  // `FROM PUBLIC` anterior. Sem esta trava o gate ficaria verde sobre um ACL possivelmente resetado.
  it('DROP que o parser não leu marca recriação (fail-closed) e invalida o PUBLIC anterior', () => {
    const migs = [
      { file: '20260101000000_fecha.sql', sql: 'REVOKE EXECUTE ON FUNCTION public.f() FROM anon;\nREVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC;' },
      { file: '20260202000000_drop_ilegivel.sql', sql: 'DROP FUNCTION IF EXISTS (public.f);\nCREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nREVOKE EXECUTE ON FUNCTION public.f() FROM anon;' },
    ];
    expect(cods(auditRevokeSemPublic(migs, new Set()))).toEqual(['FUNCAO_REVOKE_SEM_PUBLIC']);
  });

  it('fail-closed: REVOKE que menciona anon e cujo ALVO não parseia vira achado', () => {
    const f = auditRevokeSemPublic(m('REVOKE EXECUTE ON FUNCTION FROM anon;'), new Set());
    expect(cods(f)).toEqual(['FUNCAO_REVOKE_ALVO_NAO_PARSEAVEL']);
  });

  it('baseline silencia o par histórico — e SÓ ele', () => {
    const base = new Set([chaveRevokeSemPublic('20260101000000_velha.sql', 'public.f')]);
    expect(auditRevokeSemPublic(m('REVOKE EXECUTE ON FUNCTION public.f() FROM anon;', '20260101000000_velha.sql'), base)).toEqual([]);
    // mesma função, arquivo NOVO → volta a acusar
    const novo = auditRevokeSemPublic(m('REVOKE EXECUTE ON FUNCTION public.f() FROM anon;', '20260901000000_nova.sql'), base);
    expect(cods(novo)).toEqual(['FUNCAO_REVOKE_SEM_PUBLIC']);
  });
});

describe('Parte F — contrato contra o repo real', () => {
  const dir = join(process.cwd(), 'supabase', 'migrations');
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ file: f, sql: readFileSync(join(dir, f), 'utf8') }));

  it('nenhuma migration viola a regra fora da baseline', () => {
    const f = auditRevokeSemPublic(migrations, REVOKE_SEM_PUBLIC_BASELINE);
    expect(f.map((x) => `${x.file} → ${x.funcao}`)).toEqual([]);
  });

  it('baseline não apodrece: todo par baselinado ainda existe e ainda violaria', () => {
    const vivos = new Set(auditRevokeSemPublic(migrations, new Set()).map((x) => chaveRevokeSemPublic(x.file, x.funcao)));
    const mortos = [...REVOKE_SEM_PUBLIC_BASELINE].filter((k) => !vivos.has(k));
    expect(mortos).toEqual([]);
  });
});
