import { describe, it, expect } from 'vitest';
import { auditAuthz, type Migration } from './authz-gate-check';

function mig(file: string, sql: string): Migration {
  return { file, sql };
}
/** helper: monta um CREATE FUNCTION com corpo dado */
function fn(name: string, body: string, opts: { invoker?: boolean } = {}): string {
  const sec = opts.invoker ? 'SECURITY INVOKER' : 'SECURITY DEFINER';
  return `CREATE OR REPLACE FUNCTION public.${name}(p_company text)
 RETURNS numeric LANGUAGE plpgsql STABLE ${sec} SET search_path TO 'public'
AS $function$ BEGIN ${body} END; $function$;`;
}
const GATE = `IF NOT (COALESCE(auth.role()='service_role',false) OR COALESCE(public.pode_ver_carteira_completa(auth.uid()),false)) THEN RAISE EXCEPTION 'Acesso negado' USING ERRCODE='42501'; END IF;`;
const READ = `RETURN (SELECT sum(saldo*cmc) FROM inventory_position WHERE account='vendas');`;

const errorsOf = (f: ReturnType<typeof auditAuthz>) => f.filter((x) => x.level === 'error');

describe('auditAuthz — Parte A (regressão de gate)', () => {
  it('passa quando a última def de uma função do manifest tem o gate', () => {
    const f = auditAuthz([mig('20260709120500_fix.sql', fn('fin_estimar_estoque_omie', GATE + READ))]);
    expect(errorsOf(f)).toHaveLength(0);
  });

  it('FALHA quando a última def perde o gate (o bug que o check existe p/ matar)', () => {
    const f = auditAuthz([mig('20260710000000_regressao.sql', fn('fin_estimar_estoque_omie', READ))]);
    const err = errorsOf(f);
    expect(err).toHaveLength(1);
    expect(err[0].fn).toBe('public.fin_estimar_estoque_omie');
    expect(err[0].msg).toContain('pode_ver_carteira_completa');
  });

  it('last-writer-wins: recriação NOVA sem gate vence a antiga com gate → FALHA', () => {
    const f = auditAuthz([
      mig('20260101000000_a.sql', fn('fin_estimar_estoque_omie', GATE + READ)),
      mig('20260710000000_b.sql', fn('fin_estimar_estoque_omie', READ)),
    ]);
    expect(errorsOf(f).map((e) => e.fn)).toContain('public.fin_estimar_estoque_omie');
  });

  it('last-writer-wins: sem-gate seguida de correção NOVA → passa (não trava no histórico)', () => {
    const f = auditAuthz([
      mig('20260710000000_a.sql', fn('fin_estimar_estoque_omie', READ)),
      mig('20260711000000_b.sql', fn('fin_estimar_estoque_omie', GATE + READ)),
    ]);
    expect(errorsOf(f)).toHaveLength(0);
  });

  it('gate só em comentário não conta → FALHA', () => {
    const f = auditAuthz([mig('20260710000000_x.sql', fn('fin_estimar_estoque_omie', `-- ${GATE}\n ${READ}`))]);
    expect(errorsOf(f)).toHaveLength(1);
  });
});

describe('auditAuthz — Parte B (cobertura)', () => {
  it('FALHA para SECDEF nova sensível não classificada', () => {
    const f = auditAuthz([mig('20260710000000_novo.sql', fn('fuga_de_custo', READ))]);
    const err = errorsOf(f);
    expect(err).toHaveLength(1);
    expect(err[0].fn).toContain('public.fuga_de_custo'); // fn inclui a assinatura (distingue overloads)
    expect(err[0].msg).toContain('inventory_position');
  });

  it('ignora função classificada em ACKNOWLEDGED (cmc_ledger_capture)', () => {
    const f = auditAuthz([mig('20260710000000_x.sql', fn('cmc_ledger_capture', `RETURN (SELECT cmc FROM inventory_position);`))]);
    expect(errorsOf(f)).toHaveLength(0);
  });

  it('ignora SECURITY INVOKER (não é SECDEF, não bypassa RLS)', () => {
    const f = auditAuthz([mig('20260710000000_x.sql', fn('fuga_de_custo', READ, { invoker: true }))]);
    expect(errorsOf(f)).toHaveLength(0);
  });

  it('ignora SECDEF que não toca dado sensível', () => {
    const f = auditAuthz([mig('20260710000000_x.sql', fn('coisa_qualquer', `RETURN (SELECT count(*) FROM clientes);`))]);
    expect(errorsOf(f)).toHaveLength(0);
  });
});

// ── falsos-negativos do challenge Codex (2026-07-09): cada um DEVE virar erro ──
describe('auditAuthz — anti falso-negativo (challenge Codex)', () => {
  it('gate DECORATIVO (presente sem bloquear) numa função do manifest → ERRO', () => {
    const body = `v_can := public.pode_ver_carteira_completa(auth.uid()); ${READ}`;
    const f = auditAuthz([mig('20260710000000_x.sql', fn('fin_estimar_estoque_omie', body))]);
    expect(errorsOf(f)).toHaveLength(1);
    expect(errorsOf(f)[0].msg).toContain('decorativo');
  });

  it('guard INVERTIDO (IS NOT NULL AND gate) → ERRO', () => {
    const body = `IF v_uid IS NOT NULL AND public.pode_ver_carteira_completa(v_uid) THEN RAISE EXCEPTION 'x'; END IF; ${READ}`;
    const f = auditAuthz([mig('20260710000000_x.sql', fn('fin_estimar_estoque_omie', body))]);
    expect(errorsOf(f)).toHaveLength(1);
  });

  it('recriação NÃO-parseável da última def de função do manifest → fail-closed ERRO', () => {
    const naoParseavel = `CREATE OR REPLACE FUNCTION public.fin_estimar_estoque_omie(p text) RETURNS numeric LANGUAGE sql SECURITY DEFINER BEGIN ATOMIC SELECT sum(saldo*cmc) FROM inventory_position; END;`;
    const f = auditAuthz([
      mig('20260101000000_a.sql', fn('fin_estimar_estoque_omie', GATE + READ)),
      mig('20260710000000_b.sql', naoParseavel),
    ]);
    expect(errorsOf(f).some((e) => e.fn === 'public.fin_estimar_estoque_omie')).toBe(true);
  });

  it('overload sensível NÃO some (Parte B por assinatura)', () => {
    const fooInt = `CREATE FUNCTION public.foo_amb(p_x integer) RETURNS numeric LANGUAGE sql SECURITY DEFINER AS $$ SELECT cmc FROM product_costs $$;`;
    const fooText = `CREATE FUNCTION public.foo_amb(p_y text) RETURNS numeric LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;`;
    const f = auditAuthz([mig('20260710000000_x.sql', fooInt + '\n' + fooText)]);
    expect(errorsOf(f).some((e) => e.fn.startsWith('public.foo_amb'))).toBe(true);
  });

  it('SECURITY DEFINER depois do AS é pego pela Parte B', () => {
    const sql = `CREATE FUNCTION public.fuga_tardia() RETURNS numeric AS $$ SELECT cmc FROM inventory_position $$ LANGUAGE sql SECURITY DEFINER;`;
    const f = auditAuthz([mig('20260710000000_x.sql', sql)]);
    expect(errorsOf(f).some((e) => e.fn.startsWith('public.fuga_tardia'))).toBe(true);
  });
});

// ── re-challenge Codex: NOT-de-outra-coisa, comentário-engana, unparsed-sensível ──
describe('auditAuthz — anti falso-negativo (re-challenge Codex)', () => {
  it('NOT nega outra coisa (NOT v_disabled AND gate) → ERRO', () => {
    const body = `IF NOT v_disabled AND public.pode_ver_carteira_completa(auth.uid()) THEN RAISE EXCEPTION 'x'; END IF; ${READ}`;
    const f = auditAuthz([mig('20260710000000_x.sql', fn('fin_estimar_estoque_omie', body))]);
    expect(errorsOf(f)).toHaveLength(1);
  });

  it('AS $x$ comentado + corpo real sem gate → ERRO (parser pega o corpo real)', () => {
    const sql = [
      'CREATE OR REPLACE FUNCTION public.fin_estimar_estoque_omie(p text) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER',
      "-- AS $x$ IF NOT public.pode_ver_carteira_completa(auth.uid()) THEN RAISE EXCEPTION 'x'; END IF; $x$",
      'AS $$ BEGIN RETURN (SELECT sum(saldo * cmc) FROM inventory_position); END $$;',
    ].join('\n');
    const f = auditAuthz([mig('20260710000000_x.sql', sql)]);
    expect(errorsOf(f)).toHaveLength(1);
  });

  it('BEGIN ATOMIC sensível fora do manifest → ERRO fail-closed (não só warn)', () => {
    const sql = 'CREATE OR REPLACE FUNCTION public.fuga_atomic() RETURNS numeric LANGUAGE sql SECURITY DEFINER BEGIN ATOMIC SELECT sum(cmc) FROM inventory_position; END;';
    const f = auditAuthz([mig('20260710000000_x.sql', sql)]);
    expect(errorsOf(f).some((e) => e.fn === 'public.fuga_atomic')).toBe(true);
  });
});
