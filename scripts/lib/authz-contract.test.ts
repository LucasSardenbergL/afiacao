import { describe, it, expect } from 'vitest';
import { extractFunctionDefs, extractFunctions, stripNoise, checkGate, touchesSensitive, blocksOnCall } from './authz-contract';

const FN = `CREATE OR REPLACE FUNCTION public.foo(p_x text)
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (COALESCE(public.pode_ver_carteira_completa(auth.uid()), false)) THEN
    RAISE EXCEPTION 'Acesso negado' USING ERRCODE = '42501';
  END IF;
  RETURN true;
END;
$function$;`;

describe('extractFunctionDefs', () => {
  it('extrai nome, assinatura, secdef e corpo limpo', () => {
    const defs = extractFunctionDefs(FN);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('foo');
    expect(defs[0].securityDefiner).toBe(true);
    expect(defs[0].key).toBe('function:public.foo(p_x text)');
    expect(defs[0].body).toContain('pode_ver_carteira_completa');
  });

  it('trata SECURITY INVOKER como não-definer', () => {
    expect(extractFunctionDefs(FN.replace('SECURITY DEFINER', 'SECURITY INVOKER'))[0].securityDefiner).toBe(false);
  });

  it('lida com dollar-quote vazio $$', () => {
    const dd = [
      "CREATE OR REPLACE FUNCTION public.foo(p_x text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$",
      'BEGIN',
      "  IF NOT (COALESCE(public.pode_ver_carteira_completa(auth.uid()), false)) THEN RAISE EXCEPTION 'x'; END IF;",
      '  RETURN true;',
      'END;',
      '$$;',
    ].join('\n');
    const defs = extractFunctionDefs(dd);
    expect(defs).toHaveLength(1);
    expect(defs[0].body).toContain('pode_ver_carteira_completa');
  });

  it('separa dois CREATE FUNCTION sem vazar corpo entre eles', () => {
    expect(extractFunctionDefs(FN + '\n' + FN.replace('foo', 'bar'))).toHaveLength(2);
  });
});

describe('stripNoise', () => {
  it('remove comentário de linha e de bloco', () => {
    expect(stripNoise('a -- segredo\nb')).not.toContain('segredo');
    expect(stripNoise('a /* segredo */ b')).not.toContain('segredo');
  });
  it('mascara string-literais (evita falso-positivo de tabela em mensagem)', () => {
    expect(stripNoise("raise 'erro em inventory_position'")).not.toContain('inventory_position');
  });
});

describe('checkGate', () => {
  const req = { anyOf: [{ call: 'pode_ver_carteira_completa' }] };

  it('ok quando o gate está em forma de bloqueio', () => {
    expect(checkGate(extractFunctionDefs(FN)[0].body, req).ok).toBe(true);
  });

  it('FALHA quando o gate some', () => {
    const r = checkGate('BEGIN RETURN true; END', req);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('pode_ver_carteira_completa');
  });

  it('gate só em comentário não conta (após stripNoise)', () => {
    const body = stripNoise('BEGIN -- pode_ver_carteira_completa(auth.uid())\n RETURN true; END');
    expect(checkGate(body, req).ok).toBe(false);
  });

  it('allOf exige todas as cláusulas presentes', () => {
    const reqAll = { allOf: [{ call: 'has_role' }, { call: 'pode_ver_carteira_completa' }] };
    const body = "IF NOT has_role(uid,'master') THEN RAISE EXCEPTION 'x'; END IF;";
    const r = checkGate(body, reqAll);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('pode_ver_carteira_completa');
  });

  it('anyOf: 1 gate em bloqueio basta, o outro (uso p/ detalhe) não vira ruído', () => {
    const reqAny = { anyOf: [{ call: 'has_role' }, { call: 'pode_ver_carteira_completa' }] };
    const body = "IF NOT has_role(uid,'master') THEN RAISE EXCEPTION 'x'; END IF; v_full := pode_ver_carteira_completa(uid);";
    const r = checkGate(body, reqAny);
    expect(r.ok).toBe(true);
    expect(r.weak).toHaveLength(0);
  });
});

describe('blocksOnCall', () => {
  it('reconhece IF ... NOT ... gate() ... THEN ... RAISE mesmo com v_uid is null or', () => {
    const b = "if v_uid is null or not (has_role(v_uid,'employee') or has_role(v_uid,'master')) then raise exception 'x'; end if;";
    expect(blocksOnCall(b, 'has_role')).toBe(true);
  });
  it('não reconhece chamada solta sem bloqueio', () => {
    expect(blocksOnCall('v_full := pode_ver_carteira_completa(uid);', 'pode_ver_carteira_completa')).toBe(false);
  });
});

describe('touchesSensitive', () => {
  it('pega tabela e coluna sensíveis', () => {
    expect(touchesSensitive('select saldo*cmc from inventory_position')).toEqual(expect.arrayContaining(['inventory_position', 'cmc']));
  });
  it('não casa palavra inocente', () => {
    expect(touchesSensitive('select nome, telefone from clientes')).toHaveLength(0);
  });
});

// ── endurecimentos do challenge Codex (2026-07-09) ──
describe('blocksOnCall — anti falso-negativo', () => {
  it('REJEITA guard invertido (IS NOT NULL AND gate → dispara p/ quem É staff)', () => {
    const b = "IF v_uid IS NOT NULL AND public.has_role(v_uid, 'employee') THEN RAISE EXCEPTION 'x'; END IF;";
    expect(blocksOnCall(b, 'has_role')).toBe(false);
  });
  it('REJEITA RAISE NOTICE (não bloqueia de verdade)', () => {
    const b = "IF NOT public.has_role(uid, 'master') THEN RAISE NOTICE 'x'; END IF;";
    expect(blocksOnCall(b, 'has_role')).toBe(false);
  });
  it('aceita NOT sem parênteses (IF NOT gate() THEN RAISE EXCEPTION)', () => {
    const b = "IF NOT pode_ver_carteira_completa(auth.uid()) THEN RAISE EXCEPTION 'x'; END IF;";
    expect(blocksOnCall(b, 'pode_ver_carteira_completa')).toBe(true);
  });
});

describe('extractFunctions — parser endurecido', () => {
  it('extrai quoted identifier "fin_estimar_estoque_omie"', () => {
    const sql = 'CREATE OR REPLACE FUNCTION public."fin_estimar_estoque_omie"(p text) RETURNS numeric LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;';
    const defs = extractFunctionDefs(sql);
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('fin_estimar_estoque_omie');
    expect(defs[0].securityDefiner).toBe(true);
  });
  it('extrai corpo single-quoted', () => {
    const sql = "CREATE FUNCTION public.foo(p text) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN RETURN (SELECT cmc FROM inventory_position); END';";
    const r = extractFunctions(sql);
    expect(r.defs).toHaveLength(1);
    expect(r.defs[0].body).toContain('inventory_position');
    expect(r.unparsed).toHaveLength(0);
  });
  it('detecta SECURITY DEFINER DEPOIS do AS (trailer)', () => {
    const sql = 'CREATE FUNCTION public.fuga() RETURNS numeric AS $$ SELECT cmc FROM inventory_position $$ LANGUAGE sql SECURITY DEFINER;';
    expect(extractFunctionDefs(sql)[0].securityDefiner).toBe(true);
  });
  it('registra unparsed quando não acha corpo (sql-body BEGIN ATOMIC, sem AS)', () => {
    const sql = 'CREATE OR REPLACE FUNCTION public.weird(p text) RETURNS numeric LANGUAGE sql SECURITY DEFINER BEGIN ATOMIC SELECT 1; END;';
    const r = extractFunctions(sql);
    expect(r.defs).toHaveLength(0);
    expect(r.unparsed.map((u) => u.name)).toContain('weird');
  });
});
