import { describe, it, expect } from 'vitest';
import { AUTHZ_TABELAS_FECHADAS, type TabelaFechada } from './authz-tabelas-fechadas';
import {
  auditGrantsTabelas,
  compararGrantsProd,
  type GrantFinding,
  type MedicaoProd,
} from './lib/authz-grants';

describe('AUTHZ_TABELAS_FECHADAS — sanidade do contrato', () => {
  // Lista EXAUSTIVA de propósito: a allowlist é curada, então crescer é decisão, não acidente.
  // Adicionar tabela aqui sem medir prod é o modo de falha que o §5.2 do design descreve.
  it('tem as três tabelas money-path fechadas por privilégio', () => {
    expect(Object.keys(AUTHZ_TABELAS_FECHADAS).sort()).toEqual([
      'public.omie_products',
      'public.product_costs',
      'public.sales_orders',
    ]);
  });

  it('toda entrada tem permitido para anon e authenticated e um motivo não-vazio', () => {
    for (const [chave, e] of Object.entries(AUTHZ_TABELAS_FECHADAS) as [string, TabelaFechada][]) {
      expect(Array.isArray(e.permitido.anon), chave).toBe(true);
      expect(Array.isArray(e.permitido.authenticated), chave).toBe(true);
      expect(e.motivo.length, chave).toBeGreaterThan(10);
    }
  });

  it('chave está em minúsculo e no formato schema.name', () => {
    for (const chave of Object.keys(AUTHZ_TABELAS_FECHADAS)) {
      expect(chave).toBe(chave.toLowerCase());
      expect(chave.split('.')).toHaveLength(2);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// Gate estático (Parte C). Os testes casam o CÓDIGO ASCII, nunca a mensagem em português —
// lição do #1483 (grep -qi sobre string acentuada falsifica por acidente de locale).
// Metade dos cenários são casos que DEVEM passar batido: um gate que grita demais é abandonado
// tão rápido quanto um que nunca grita.
// ══════════════════════════════════════════════════════════════════════════════════════════

const ANCORA = '20260725130000_fecha_product_costs.sql';

const AL: Record<string, TabelaFechada> = {
  'public.product_costs': {
    fechadaPor: ANCORA,
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo: 'custo unitário — fixture',
  },
};
const AL_PENDENTE: Record<string, TabelaFechada> = {
  'public.product_costs': {
    fechadaPor: null,
    permitido: { anon: [], authenticated: ['SELECT'] },
    motivo: 'custo unitário — fixture pendente',
  },
};

const mig = (file: string, sql: string) => ({ file, sql });
const codigos = (f: GrantFinding[]) => f.map((x) => x.codigo).sort();
/** existingFiles inclui a âncora + os arquivos passados (salvo no teste de ANCORA_AUSENTE) */
const files = (...fs: string[]) => new Set([ANCORA, ...fs]);

describe('auditGrantsTabelas — gate estático de reabertura', () => {
  it('1. GRANT INSERT a authenticated pós-âncora → REABERTURA', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_reabre.sql', 'GRANT INSERT ON TABLE public.product_costs TO authenticated;')],
      AL,
      files('20260801000000_reabre.sql'),
    );
    expect(f).toHaveLength(1);
    expect(f[0].codigo).toBe('REABERTURA');
    expect(f[0].level).toBe('error');
  });

  it('2. GRANT INSERT idêntico ANTES da âncora → silêncio (o fecho veio depois e venceu)', () => {
    const f = auditGrantsTabelas(
      [mig('20260101000000_antigo.sql', 'GRANT INSERT ON TABLE public.product_costs TO authenticated;')],
      AL,
      files('20260101000000_antigo.sql'),
    );
    expect(f).toHaveLength(0);
  });

  it('3. GRANT ALL a service_role pós-âncora → silêncio (é o writer)', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_svc.sql', 'GRANT ALL ON TABLE public.product_costs TO service_role;')],
      AL,
      files('20260801000000_svc.sql'),
    );
    expect(f).toHaveLength(0);
  });

  it('4. GRANT SELECT a authenticated pós-âncora → silêncio (dentro do permitido)', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_sel.sql', 'GRANT SELECT ON TABLE public.product_costs TO authenticated;')],
      AL,
      files('20260801000000_sel.sql'),
    );
    expect(f).toHaveLength(0);
  });

  it('5. CREATE TABLE da tabela pós-âncora → RECRIACAO', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_recria.sql', 'CREATE TABLE public.product_costs (id int primary key);')],
      AL,
      files('20260801000000_recria.sql'),
    );
    expect(codigos(f)).toContain('RECRIACAO');
  });

  it('6. DISABLE ROW LEVEL SECURITY pós-âncora → RLS_OFF', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_rls.sql', 'ALTER TABLE public.product_costs DISABLE ROW LEVEL SECURITY;')],
      AL,
      files('20260801000000_rls.sql'),
    );
    expect(codigos(f)).toContain('RLS_OFF');
  });

  it('7. âncora aponta arquivo inexistente → ANCORA_AUSENTE', () => {
    const f = auditGrantsTabelas([], AL, new Set());
    expect(f).toHaveLength(1);
    expect(f[0].codigo).toBe('ANCORA_AUSENTE');
    expect(f[0].level).toBe('error');
  });

  it('8. fechadaPor=null sem REVOKE no repo → FECHO_PENDENTE (warn)', () => {
    const f = auditGrantsTabelas([mig('20260101_x.sql', 'SELECT 1;')], AL_PENDENTE, new Set(['20260101_x.sql']));
    expect(f).toHaveLength(1);
    expect(f[0].codigo).toBe('FECHO_PENDENTE');
    expect(f[0].level).toBe('warn');
  });

  it('9. GRANT da tabela DENTRO de comentário → silêncio (stripNoise)', () => {
    const f = auditGrantsTabelas(
      [
        mig(
          '20260801000000_comentado.sql',
          '-- GRANT INSERT ON TABLE public.product_costs TO authenticated;\nSELECT 1;',
        ),
      ],
      AL,
      files('20260801000000_comentado.sql'),
    );
    expect(f).toHaveLength(0);
  });

  it('10. fechadaPor=null MAS REVOKE ... FROM authenticated no repo → ANCORA_NAO_DECLARADA', () => {
    const f = auditGrantsTabelas(
      [mig('20260725130000_fecha.sql', 'REVOKE ALL ON TABLE public.product_costs FROM authenticated;')],
      AL_PENDENTE,
      new Set(['20260725130000_fecha.sql']),
    );
    expect(f).toHaveLength(1);
    expect(f[0].codigo).toBe('ANCORA_NAO_DECLARADA');
    expect(f[0].level).toBe('error');
  });

  it('11. GRANT ALL TABLES IN SCHEMA public a authenticated pós-âncora → REABERTURA', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_massa.sql', 'GRANT INSERT ON ALL TABLES IN SCHEMA public TO authenticated;')],
      AL,
      files('20260801000000_massa.sql'),
    );
    expect(codigos(f)).toContain('REABERTURA');
  });

  it('12. GRANT em forma não-parseável mencionando a tabela → GRANT_NAO_PARSEAVEL (fail-closed)', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_estranho.sql', 'GRANT INSERT ON public.product_costs;')],
      AL,
      files('20260801000000_estranho.sql'),
    );
    expect(codigos(f)).toContain('GRANT_NAO_PARSEAVEL');
  });

  it('13. função com ; no corpo + GRANT limpo na mesma migration → não confunde', () => {
    const sql = `CREATE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; RETURN 2; END; $$;
GRANT SELECT ON TABLE public.product_costs TO authenticated;`;
    const f = auditGrantsTabelas([mig('20260801000000_mista.sql', sql)], AL, files('20260801000000_mista.sql'));
    expect(f).toHaveLength(0);
  });

  it('14. não vaza para tabela homônima em outro schema', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_outra.sql', 'GRANT INSERT ON TABLE outros.product_costs TO authenticated;')],
      AL,
      files('20260801000000_outra.sql'),
    );
    expect(f).toHaveLength(0);
  });

  // 15/16: o RECRIACAO julga o ALVO do CREATE TABLE, não a menção no statement. Tabela nova com FK
  // para a protegida é o caso mais comum de todos e não recria nada — foi o falso positivo que a
  // entrada de sales_orders destampou (2 migrations do ATP, agosto/2026, ambas só com REFERENCES).
  it('15. CREATE TABLE de OUTRA tabela com FK para a protegida → silêncio (não recria nada)', () => {
    const f = auditGrantsTabelas(
      [
        mig(
          '20260801000000_fk.sql',
          'CREATE TABLE IF NOT EXISTS public.estoque_reservas (\n' +
            '  id uuid PRIMARY KEY,\n' +
            '  custo_id uuid REFERENCES public.product_costs(id) ON DELETE SET NULL\n' +
            ');',
        ),
      ],
      AL,
      files('20260801000000_fk.sql'),
    );
    expect(f).toHaveLength(0);
  });

  it('16. CREATE TABLE da protegida com identificador entre aspas → RECRIACAO (segue pegando)', () => {
    const f = auditGrantsTabelas(
      [mig('20260801000000_aspas.sql', 'CREATE TABLE IF NOT EXISTS "public"."product_costs" (id int);')],
      AL,
      files('20260801000000_aspas.sql'),
    );
    expect(codigos(f)).toContain('RECRIACAO');
  });
});

describe('compararGrantsProd — audit de prod (puro)', () => {
  it('1. estado fechado (só SELECT p/ authenticated) → limpo', () => {
    const m: MedicaoProd = { 'public.product_costs': { anon: [], authenticated: ['SELECT'] } };
    expect(compararGrantsProd(m, AL)).toHaveLength(0);
  });

  it('2. authenticated ainda com INSERT+UPDATE+DELETE → NAO_APLICADA', () => {
    const m: MedicaoProd = {
      'public.product_costs': { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
    };
    const f = compararGrantsProd(m, AL);
    expect(f.some((x) => x.codigo === 'NAO_APLICADA')).toBe(true);
    expect(f.every((x) => x.level === 'error')).toBe(true);
  });

  it('3. grant parcial à mão (só INSERT) → DRIFT_PROD, não NAO_APLICADA', () => {
    const m: MedicaoProd = { 'public.product_costs': { anon: [], authenticated: ['SELECT', 'INSERT'] } };
    const f = compararGrantsProd(m, AL);
    expect(codigos(f)).toEqual(['DRIFT_PROD']);
  });

  it('4. anon com SELECT (fora do permitido []) → achado na tabela certa', () => {
    const m: MedicaoProd = { 'public.product_costs': { anon: ['SELECT'], authenticated: ['SELECT'] } };
    const f = compararGrantsProd(m, AL);
    expect(f).toHaveLength(1);
    expect(f[0].tabela).toBe('public.product_costs');
    expect(f[0].file).toBe('(prod)');
  });

  it('5. fechadaPor=null → FECHO_PENDENTE (warn), sem comparar prod', () => {
    const m: MedicaoProd = { 'public.product_costs': { anon: ['INSERT'], authenticated: ['INSERT'] } };
    const f = compararGrantsProd(m, AL_PENDENTE);
    expect(f).toHaveLength(1);
    expect(f[0].codigo).toBe('FECHO_PENDENTE');
    expect(f[0].level).toBe('warn');
  });

  it('6. tabela ausente da medição → limpo (zero privilégio é o estado mais fechado)', () => {
    // Só entra no mapa o privilégio PRESENTE; tabela sem nenhum privilégio simplesmente não
    // aparece. Tabela INEXISTENTE em prod não chega aqui: has_table_privilege já teria feito o
    // psql falhar, e o executável sai 2 (erro de execução) antes de comparar.
    expect(compararGrantsProd({}, AL)).toHaveLength(0);
  });

  it('7. anon com o DML completo (default aberto do Supabase) → NAO_APLICADA', () => {
    const m: MedicaoProd = {
      'public.product_costs': { anon: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] },
    };
    const f = compararGrantsProd(m, AL);
    expect(codigos(f)).toEqual(['NAO_APLICADA']);
  });
});
