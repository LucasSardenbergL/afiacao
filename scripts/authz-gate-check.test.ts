import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditAuthz, auditCompleto, type Migration } from './authz-gate-check';
import { AUTHZ_TABELAS_FECHADAS } from './authz-tabelas-fechadas';

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
const GATE = `IF NOT (COALESCE(auth.role()='service_role',false) OR COALESCE(private.cap_custo_ler(auth.uid()),false)) THEN RAISE EXCEPTION 'Acesso negado' USING ERRCODE='42501'; END IF;`;
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
    expect(err[0].msg).toContain('cap_custo_ler');
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
    const body = `v_can := private.cap_custo_ler(auth.uid()); ${READ}`;
    const f = auditAuthz([mig('20260710000000_x.sql', fn('fin_estimar_estoque_omie', body))]);
    expect(errorsOf(f)).toHaveLength(1);
    expect(errorsOf(f)[0].msg).toContain('decorativo');
  });

  it('guard INVERTIDO (IS NOT NULL AND gate) → ERRO', () => {
    const body = `IF v_uid IS NOT NULL AND private.cap_custo_ler(v_uid) THEN RAISE EXCEPTION 'x'; END IF; ${READ}`;
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
    const body = `IF NOT v_disabled AND private.cap_custo_ler(auth.uid()) THEN RAISE EXCEPTION 'x'; END IF; ${READ}`;
    const f = auditAuthz([mig('20260710000000_x.sql', fn('fin_estimar_estoque_omie', body))]);
    expect(errorsOf(f)).toHaveLength(1);
  });

  it('AS $x$ comentado + corpo real sem gate → ERRO (parser pega o corpo real)', () => {
    const sql = [
      'CREATE OR REPLACE FUNCTION public.fin_estimar_estoque_omie(p text) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER',
      "-- AS $x$ IF NOT private.cap_custo_ler(auth.uid()) THEN RAISE EXCEPTION 'x'; END IF; $x$",
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

describe('auditAuthz — Parte C (grants de tabela fechada por privilégio)', () => {
  /** as âncoras declaradas precisam existir entre as migrations, senão o gate acusa ANCORA_AUSENTE */
  const ancoras = Object.values(AUTHZ_TABELAS_FECHADAS)
    .map((e) => e.fechadaPor)
    .filter((a): a is string => a !== null)
    .map((a) => mig(a, '-- âncora (fixture)'));

  it('as entradas com fechadaPor=null viram FECHO_PENDENTE (warn), e nenhum erro da Parte C', () => {
    const f = auditCompleto([...ancoras, mig('20260101000000_noop.sql', 'SELECT 1;')]);
    const pendentes = f.filter((x) => x.msg.includes('FECHO_PENDENTE'));
    const esperado = Object.values(AUTHZ_TABELAS_FECHADAS).filter((e) => e.fechadaPor === null).length;
    expect(pendentes).toHaveLength(esperado);
    expect(pendentes.every((x) => x.level === 'warn')).toBe(true);
    // nenhum erro vindo da Parte C (os códigos ASCII só existem nela)
    expect(errorsOf(f).filter((e) => /\[[A-Z_]+\]/.test(e.msg))).toHaveLength(0);
  });

  it('a msg convertida carrega o CÓDIGO ASCII, não a frase em pt-BR', () => {
    // O cenário é CONSTRUÍDO (omitir as migrations de âncora ⇒ ANCORA_AUSENTE), não herdado do
    // estado de AUTHZ_TABELAS_FECHADAS. Antes este assert exigia `[FECHO_PENDENTE]`, que só
    // existia porque product_costs era a última entrada com fechadaPor=null: declarar a âncora
    // dela (PR #1520) zerava as pendências e derrubava o teste — sem que nada da CONVERSÃO,
    // que é o que ele prova, tivesse mudado. Um teste do formato da mensagem não pode depender
    // de quantas tabelas estão pendentes hoje.
    const f = auditCompleto([mig('20260101000000_noop.sql', 'SELECT 1;')]);
    expect(f.some((x) => /\[ANCORA_AUSENTE\]/.test(x.msg))).toBe(true);
    expect(f.every((x) => !/fecho pendente|ausente de supabase\/migrations/.test(x.msg.split(']')[0]))).toBe(true);
  });

  it('DENTE: GRANT INSERT a authenticated pós-âncora na tabela REAL → erro REABERTURA', () => {
    const ancora = AUTHZ_TABELAS_FECHADAS['public.omie_products'].fechadaPor;
    expect(ancora).not.toBeNull(); // se um dia voltar a null, este teste tem de gritar
    const f = auditCompleto([
      ...ancoras,
      mig('20991231000000_reabre.sql', 'GRANT INSERT ON TABLE public.omie_products TO authenticated;'),
    ]);
    const reab = errorsOf(f).filter((e) => e.msg.includes('[REABERTURA]'));
    expect(reab).toHaveLength(1);
    expect(reab[0].fn).toBe('public.omie_products');
  });
});

// ══════════ CONTROLE ≠ MENÇÃO — a RPC de compras entra no contrato (2026-08-14) ══════════
// A defesa que existia para public.reposicao_pos_candidatos era um bloco `DO $pos$` de regex sobre
// pg_get_functiondef que rodou UMA vez, dentro da própria migration 20260813195914. Ele não protege
// nenhuma recriação futura — e o FU4-G (20260720120000) já reescreveu essa função uma vez.
// Estes testes fazem duas coisas ao mesmo tempo, contra o ARQUIVO REAL do repo:
//   1. a definição real passa no contrato de gate (senão o CI ficaria vermelho por falso positivo);
//   2. as 3 formas da revisão do #1718 REPROVAM aqui — e, no mesmo teste, PASSAM nos 3 regexes da
//      pós-condição. É o par que mostra por que a sentinela textual não bastava.
// A prova EXECUTADA (a RPC roda e nega/entrega de verdade) é db/test-pos-candidatos-guard-temporal.sh
// — asserts D1/D4 e falsificações N1/N2/N3. Este arquivo é a metade estática, que roda em todo PR.
describe('auditAuthz — reposicao_pos_candidatos: presença não é controle', () => {
  const ARQ = '20260813195914_reposicao_pos_candidatos_guard_temporal.sql';
  const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', ARQ), 'utf8');

  const errosDaRpc = (s: string) =>
    errorsOf(auditAuthz([mig(ARQ, s)])).filter((e) => e.fn.includes('reposicao_pos_candidatos'));

  /** sabota exigindo que o trecho exista — sed que não casa nada deixaria o teste verde à toa */
  function sabota(de: string, para: string): string {
    expect(sql).toContain(de);
    return sql.replace(de, para);
  }

  /**
   * Os 3 regexes do bloco `DO $pos$` da migration, VERBATIM, aplicados só ao corpo da função (é o
   * que pg_get_functiondef devolve — a prosa da migration ficaria de fora). true = a pós-condição
   * teria deixado a migration aplicar.
   */
  function posCondicaoAprova(s: string): boolean {
    const i = s.indexOf('CREATE OR REPLACE FUNCTION public.reposicao_pos_candidatos');
    const d = s.slice(i, s.indexOf('$$;', i) + 3);
    return (
      /private\.cap_compras_ler\s*\(\s*\(\s*SELECT/.test(d) &&
      !/pode_ver_carteira_completa\s*\(\s*\(\s*SELECT/.test(d) &&
      /AND \(p\.omie_registrado_em IS NULL OR p\.omie_registrado_em <= m\.finalizado_em\)/.test(d)
    );
  }

  it('a migration REAL do repo passa no contrato de gate', () => {
    expect(errosDaRpc(sql)).toHaveLength(0);
    expect(posCondicaoAprova(sql)).toBe(true); // canário: os regexes aprovam o corpo íntegro
  });

  it('gate em RAMO MORTO → ERRO aqui, APROVADO pelos regexes da migration', () => {
    const s = sabota('IF (SELECT auth.uid()) IS NOT NULL', 'IF false AND (SELECT auth.uid()) IS NOT NULL');
    expect(posCondicaoAprova(s)).toBe(true); // a defesa antiga não via nada de errado
    const err = errosDaRpc(s);
    expect(err).toHaveLength(1);
    expect(err[0].msg).toContain('decorativo');
  });

  it('chamada nova só em COMENTÁRIO + gate velho real → ERRO aqui, APROVADO pelos regexes', () => {
    // `pode_ver_carteira_completa(auth.uid())` sem o `((SELECT` escapa do regex c_velho, e o
    // comentário satisfaz o c_novo. Autorização regride de master-only para "gerencial também vê".
    const s = sabota(
      'AND (SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE THEN',
      'AND /* (SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE */ public.pode_ver_carteira_completa(auth.uid()) IS NOT TRUE THEN',
    );
    expect(posCondicaoAprova(s)).toBe(true);
    const err = errosDaRpc(s);
    expect(err).toHaveLength(1);
    expect(err[0].msg).toContain('cap_compras_ler');
  });

  it('gate REMOVIDO inteiro → ERRO (a regressão clássica que a Parte A existe para pegar)', () => {
    const s = sabota(
      'AND (SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE THEN',
      'AND false THEN',
    );
    expect(errosDaRpc(s)).toHaveLength(1);
  });

  it('recriação POSTERIOR sem gate vence a migration com gate (last-writer)', () => {
    const semGate = `CREATE OR REPLACE FUNCTION public.reposicao_pos_candidatos(p_empresa text)
 RETURNS SETOF record LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ BEGIN RETURN QUERY SELECT 1; END $$;`;
    const err = errorsOf(
      auditAuthz([mig(ARQ, sql), mig('20991231000000_recria.sql', semGate)]),
    ).filter((e) => e.fn.includes('reposicao_pos_candidatos'));
    expect(err).toHaveLength(1);
    expect(err[0].file).toBe('20991231000000_recria.sql');
  });
});
