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
    expect(err[0].fn).toBe('public.fuga_de_custo');
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
