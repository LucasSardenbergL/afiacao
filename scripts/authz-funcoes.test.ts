import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTHZ_FUNCOES_FECHADAS, type FuncaoFechada } from './authz-funcoes-fechadas';
import { AUTHZ_MANIFEST, ACKNOWLEDGED_SENSITIVE, ACL_ONLY_INTERNAL } from './authz-manifest';
import {
  auditGrantsFuncoes,
  compararExecuteProd,
  type FuncaoFinding,
  type MedicaoExecuteProd,
} from './lib/authz-funcoes';

/** allowlist mínima de teste — `public.f` fecha por gate (authenticated OK), `public.g` por privilégio. */
const ALLOW: Record<string, FuncaoFechada> = {
  'public.f': {
    fechadaPor: '20260101000000_ancora.sql',
    permitido: { anon: false, authenticated: true },
    motivo: 'fecha por gate no corpo — authenticated alcança de propósito',
  },
  'public.g': {
    fechadaPor: '20260101000000_ancora.sql',
    permitido: { anon: false, authenticated: false },
    motivo: 'fecha por privilégio — só service_role executa',
  },
};
const ANCORA = { file: '20260101000000_ancora.sql', sql: '-- fecho\nREVOKE EXECUTE ON FUNCTION public.f(uuid) FROM anon;' };
const cods = (fs: FuncaoFinding[]) => fs.map((f) => f.codigo).sort();

describe('AUTHZ_FUNCOES_FECHADAS — sanidade do contrato', () => {
  it('cobre TODA função do AUTHZ_MANIFEST', () => {
    const faltando = Object.keys(AUTHZ_MANIFEST).filter((k) => !AUTHZ_FUNCOES_FECHADAS[k]);
    expect(faltando).toEqual([]);
  });

  it('cobre TODA função do ACKNOWLEDGED_SENSITIVE', () => {
    const faltando = [...ACKNOWLEDGED_SENSITIVE].filter((k) => !AUTHZ_FUNCOES_FECHADAS[k]);
    expect(faltando).toEqual([]);
  });

  it('não inventa função: toda chave da allowlist está classificada no manifesto', () => {
    // A união é dos TRÊS catálogos. Não é o assert afrouxado: `ACL_ONLY_INTERNAL` traz consigo um
    // discriminante próprio (tem de continuar INVOKER — Parte B), e o teste logo abaixo exige a
    // cobertura na direção inversa. O princípio preservado é classificação EXAUSTIVA.
    const orfas = Object.keys(AUTHZ_FUNCOES_FECHADAS).filter(
      (k) => !AUTHZ_MANIFEST[k] && !ACKNOWLEDGED_SENSITIVE.has(k) && !ACL_ONLY_INTERNAL.has(k),
    );
    expect(orfas).toEqual([]);
  });

  it('cobre TODA função do ACL_ONLY_INTERNAL (a direção inversa)', () => {
    const faltando = [...ACL_ONLY_INTERNAL].filter((k) => !AUTHZ_FUNCOES_FECHADAS[k]);
    expect(faltando).toEqual([]);
  });

  it('ACL_ONLY_INTERNAL e ACKNOWLEDGED_SENSITIVE são DISJUNTOS (categoria é discriminante)', () => {
    const nos2 = [...ACL_ONLY_INTERNAL].filter((k) => ACKNOWLEDGED_SENSITIVE.has(k) || !!AUTHZ_MANIFEST[k]);
    expect(nos2).toEqual([]);
  });

  it('toda entrada tem permitido booleano p/ anon e authenticated, e motivo não-vazio', () => {
    for (const [chave, e] of Object.entries(AUTHZ_FUNCOES_FECHADAS)) {
      expect(typeof e.permitido.anon, chave).toBe('boolean');
      expect(typeof e.permitido.authenticated, chave).toBe('boolean');
      expect(e.motivo.length, chave).toBeGreaterThan(10);
    }
  });

  it('chave em minúsculo, formato schema.name', () => {
    for (const chave of Object.keys(AUTHZ_FUNCOES_FECHADAS)) {
      expect(chave).toBe(chave.toLowerCase());
      expect(chave.split('.')).toHaveLength(2);
    }
  });

  // Medido em prod 2026-08-15 (psql-ro, has_function_privilege nas 40): NENHUMA é alcançável por
  // anon. Permitir anon aqui é decisão de política — que passa por mudar este teste.
  it('nenhuma entrada permite anon (estado medido em prod)', () => {
    const comAnon = Object.entries(AUTHZ_FUNCOES_FECHADAS).filter(([, e]) => e.permitido.anon);
    expect(comAnon.map(([k]) => k)).toEqual([]);
  });

  // A fronteira do cabeçalho de authz-manifest.ts: MANIFEST = alcançável por authenticated (fecha
  // por gate); ACK = fecha por privilégio. `get_carteira_margem_faixa` é a exceção MEDIDA — ACK que
  // authenticated alcança, porque fecha por gate de escopo/projeção, não por privilégio.
  it('MANIFEST ⇒ authenticated permitido; ACK ⇒ proibido, exceto a exceção medida', () => {
    for (const k of Object.keys(AUTHZ_MANIFEST)) {
      expect(AUTHZ_FUNCOES_FECHADAS[k].permitido.authenticated, k).toBe(true);
    }
    const ackComAuth = [...ACKNOWLEDGED_SENSITIVE].filter(
      (k) => AUTHZ_FUNCOES_FECHADAS[k].permitido.authenticated,
    );
    expect(ackComAuth).toEqual(['public.get_carteira_margem_faixa']);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// Gate estático (Parte E). Testes casam o CÓDIGO ASCII, nunca a frase em pt-BR (lição #1483).
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('auditGrantsFuncoes — reabertura por GRANT', () => {
  it('GRANT EXECUTE a anon após a âncora acusa FUNCAO_REABERTURA', () => {
    const r = auditGrantsFuncoes(
      [ANCORA, { file: '20260202000000_x.sql', sql: 'GRANT EXECUTE ON FUNCTION public.f(uuid) TO anon;' }],
      ALLOW,
    );
    expect(cods(r)).toEqual(['FUNCAO_REABERTURA']);
    expect(r[0].funcao).toBe('public.f');
    expect(r[0].file).toBe('20260202000000_x.sql');
    expect(r[0].level).toBe('error');
  });

  it('GRANT EXECUTE a authenticated numa função que fecha por PRIVILÉGIO acusa', () => {
    const r = auditGrantsFuncoes(
      [ANCORA, { file: '20260202000000_x.sql', sql: 'GRANT EXECUTE ON FUNCTION public.g() TO authenticated;' }],
      ALLOW,
    );
    expect(cods(r)).toEqual(['FUNCAO_REABERTURA']);
    expect(r[0].funcao).toBe('public.g');
  });

  it('GRANT EXECUTE a authenticated numa função que o contrato PERMITE fica quieto', () => {
    const r = auditGrantsFuncoes(
      [ANCORA, { file: '20260202000000_x.sql', sql: 'GRANT EXECUTE ON FUNCTION public.f(uuid) TO authenticated;' }],
      ALLOW,
    );
    expect(r).toEqual([]);
  });

  it('GRANT a service_role não é vigiado', () => {
    const r = auditGrantsFuncoes(
      [ANCORA, { file: '20260202000000_x.sql', sql: 'GRANT EXECUTE ON FUNCTION public.g() TO service_role;' }],
      ALLOW,
    );
    expect(r).toEqual([]);
  });

  it('GRANT ANTERIOR à âncora não conta (o fecho veio depois)', () => {
    const r = auditGrantsFuncoes(
      [{ file: '20250101000000_antes.sql', sql: 'GRANT EXECUTE ON FUNCTION public.g() TO anon;' }, ANCORA],
      ALLOW,
    );
    expect(r).toEqual([]);
  });

  it('GRANT ON ALL FUNCTIONS IN SCHEMA alcança as funções daquele schema', () => {
    const r = auditGrantsFuncoes(
      [ANCORA, { file: '20260202000000_x.sql', sql: 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon;' }],
      ALLOW,
    );
    expect(cods(r)).toEqual(['FUNCAO_REABERTURA', 'FUNCAO_REABERTURA']);
  });

  it('GRANT ON ALL FUNCTIONS de OUTRO schema não alcança', () => {
    const r = auditGrantsFuncoes(
      [ANCORA, { file: '20260202000000_x.sql', sql: 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO anon;' }],
      ALLOW,
    );
    expect(r).toEqual([]);
  });

  it('nome com SUFIXO não é confundido com a função protegida', () => {
    const r = auditGrantsFuncoes(
      [ANCORA, { file: '20260202000000_x.sql', sql: 'GRANT EXECUTE ON FUNCTION public.f_customer360(uuid) TO anon;' }],
      ALLOW,
    );
    expect(r).toEqual([]);
  });

  it('homônima em OUTRO schema não é confundida', () => {
    const r = auditGrantsFuncoes(
      [ANCORA, { file: '20260202000000_x.sql', sql: 'GRANT EXECUTE ON FUNCTION outro.g() TO anon;' }],
      ALLOW,
    );
    expect(r).toEqual([]);
  });

  it('GRANT dentro de COMENTÁRIO não acusa', () => {
    const r = auditGrantsFuncoes(
      [ANCORA, { file: '20260202000000_x.sql', sql: '-- GRANT EXECUTE ON FUNCTION public.g() TO anon;\nSELECT 1;' }],
      ALLOW,
    );
    expect(r).toEqual([]);
  });

  it('GRANT numa forma que o parser não entende é fail-closed', () => {
    const r = auditGrantsFuncoes(
      [ANCORA, { file: '20260202000000_x.sql', sql: 'GRANT ON FUNCTION public.g() anon;' }],
      ALLOW,
    );
    expect(cods(r)).toEqual(['FUNCAO_GRANT_NAO_PARSEAVEL']);
  });
});

describe('auditGrantsFuncoes — recriação que RESETA o ACL (o vetor DROP+CREATE)', () => {
  const drop = (fn: string, args = '') => `DROP FUNCTION IF EXISTS ${fn}(${args});`;
  const create = (fn: string, args = '') => `CREATE FUNCTION ${fn}(${args}) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`;

  it('DROP+CREATE após a âncora, sem REVOKE, acusa FUNCAO_RECRIADA_SEM_FECHO', () => {
    const r = auditGrantsFuncoes(
      [ANCORA, { file: '20260202000000_x.sql', sql: `${drop('public.g')}\n${create('public.g')}` }],
      ALLOW,
    );
    expect(cods(r)).toEqual(['FUNCAO_RECRIADA_SEM_FECHO']);
    expect(r[0].funcao).toBe('public.g');
    expect(r[0].file).toBe('20260202000000_x.sql');
  });

  // O caso REAL da 20260704120000 (get_ultimos_precos_cliente): DROP + CREATE + REVOKE de anon.
  it('DROP+CREATE que REVOGA a role proibida pelo NOME fica quieto', () => {
    const r = auditGrantsFuncoes(
      [
        ANCORA,
        {
          file: '20260202000000_x.sql',
          sql: `${drop('public.f', 'uuid')}\n${create('public.f', 'p uuid')}\nREVOKE EXECUTE ON FUNCTION public.f(uuid) FROM anon, PUBLIC;`,
        },
      ],
      ALLOW,
    );
    expect(r).toEqual([]);
  });

  // Regra do projeto (CLAUDE.md): REVOKE FROM PUBLIC **não** tira anon/authenticated — o grant
  // delas é explícito, vindo do default privilege. Revogar só de PUBLIC deixa o buraco aberto.
  it('REVOKE só de PUBLIC NÃO restaura o fecho — anon segue com o default privilege', () => {
    const r = auditGrantsFuncoes(
      [
        ANCORA,
        {
          file: '20260202000000_x.sql',
          sql: `${drop('public.f', 'uuid')}\n${create('public.f', 'p uuid')}\nREVOKE EXECUTE ON FUNCTION public.f(uuid) FROM PUBLIC;`,
        },
      ],
      ALLOW,
    );
    expect(cods(r)).toEqual(['FUNCAO_RECRIADA_SEM_FECHO']);
  });

  it('função que fecha por privilégio precisa revogar as DUAS roles', () => {
    const parcial = auditGrantsFuncoes(
      [
        ANCORA,
        {
          file: '20260202000000_x.sql',
          sql: `${drop('public.g')}\n${create('public.g')}\nREVOKE EXECUTE ON FUNCTION public.g() FROM anon;`,
        },
      ],
      ALLOW,
    );
    expect(cods(parcial)).toEqual(['FUNCAO_RECRIADA_SEM_FECHO']);

    const completo = auditGrantsFuncoes(
      [
        ANCORA,
        {
          file: '20260202000000_x.sql',
          sql: `${drop('public.g')}\n${create('public.g')}\nREVOKE EXECUTE ON FUNCTION public.g() FROM anon, authenticated;`,
        },
      ],
      ALLOW,
    );
    expect(completo).toEqual([]);
  });

  it('REVOKE ANTES do CREATE não restaura nada (a função renasce depois dele)', () => {
    const r = auditGrantsFuncoes(
      [
        ANCORA,
        {
          file: '20260202000000_x.sql',
          sql: `REVOKE EXECUTE ON FUNCTION public.g() FROM anon, authenticated;\n${drop('public.g')}\n${create('public.g')}`,
        },
      ],
      ALLOW,
    );
    expect(cods(r)).toEqual(['FUNCAO_RECRIADA_SEM_FECHO']);
  });

  it('CREATE OR REPLACE sem DROP não reseta o ACL — silêncio', () => {
    const r = auditGrantsFuncoes(
      [ANCORA, { file: '20260202000000_x.sql', sql: 'CREATE OR REPLACE FUNCTION public.g() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;' }],
      ALLOW,
    );
    expect(r).toEqual([]);
  });

  it('DROP sem CREATE (remoção definitiva) não acusa', () => {
    const r = auditGrantsFuncoes([ANCORA, { file: '20260202000000_x.sql', sql: drop('public.g') }], ALLOW);
    expect(r).toEqual([]);
  });

  it('DROP numa migration e CREATE em OUTRA posterior também é recriação', () => {
    const r = auditGrantsFuncoes(
      [
        ANCORA,
        { file: '20260202000000_a.sql', sql: drop('public.g') },
        { file: '20260203000000_b.sql', sql: create('public.g') },
      ],
      ALLOW,
    );
    expect(cods(r)).toEqual(['FUNCAO_RECRIADA_SEM_FECHO']);
    expect(r[0].file).toBe('20260203000000_b.sql');
  });

  it('REVOKE numa migration POSTERIOR ao CREATE restaura o fecho', () => {
    const r = auditGrantsFuncoes(
      [
        ANCORA,
        { file: '20260202000000_a.sql', sql: `${drop('public.g')}\n${create('public.g')}` },
        { file: '20260203000000_b.sql', sql: 'REVOKE EXECUTE ON FUNCTION public.g() FROM anon, authenticated;' },
      ],
      ALLOW,
    );
    expect(r).toEqual([]);
  });

  it('DROP+CREATE ANTERIOR à âncora não conta', () => {
    const r = auditGrantsFuncoes(
      [{ file: '20250101000000_antes.sql', sql: `${drop('public.g')}\n${create('public.g')}` }, ANCORA],
      ALLOW,
    );
    expect(r).toEqual([]);
  });
});

describe('auditGrantsFuncoes — estado da âncora e do default privilege', () => {
  it('âncora ausente do repo acusa FUNCAO_ANCORA_AUSENTE', () => {
    const r = auditGrantsFuncoes([{ file: '20260202000000_x.sql', sql: 'SELECT 1;' }], ALLOW);
    expect(cods(r)).toEqual(['FUNCAO_ANCORA_AUSENTE', 'FUNCAO_ANCORA_AUSENTE']);
  });

  it('fechadaPor=null com REVOKE presente no repo acusa FUNCAO_ANCORA_NAO_DECLARADA', () => {
    const allow: Record<string, FuncaoFechada> = {
      'public.g': { fechadaPor: null, permitido: { anon: false, authenticated: false }, motivo: 'fecho ainda não declarado aqui' },
    };
    const r = auditGrantsFuncoes(
      [{ file: '20260202000000_x.sql', sql: 'REVOKE EXECUTE ON FUNCTION public.g() FROM anon, authenticated;' }],
      allow,
    );
    expect(cods(r)).toEqual(['FUNCAO_ANCORA_NAO_DECLARADA']);
    expect(r[0].file).toBe('20260202000000_x.sql');
  });

  // O caso REAL da 20260510235956 ("Fatia E3 Fase 1"): revoga de PUBLIC+anon e MANTÉM o GRANT a
  // authenticated. Para uma função que fecha por privilégio isso não é o fecho — e tratá-lo como
  // fecho exigiria declarar como âncora um arquivo que concede justamente o que o contrato proíbe.
  it('REVOKE PARCIAL (só uma das roles proibidas) não conta como fecho declarado', () => {
    const allow: Record<string, FuncaoFechada> = {
      'public.g': { fechadaPor: null, permitido: { anon: false, authenticated: false }, motivo: 'fecho parcial no repo' },
    };
    const r = auditGrantsFuncoes(
      [{ file: '20260202000000_x.sql', sql: 'REVOKE EXECUTE ON FUNCTION public.g() FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.g() TO authenticated;' }],
      allow,
    );
    expect(cods(r)).toEqual(['FUNCAO_FECHO_PENDENTE']);
  });

  it('fechadaPor=null sem REVOKE no repo é AVISO de fecho pendente', () => {
    const allow: Record<string, FuncaoFechada> = {
      'public.g': { fechadaPor: null, permitido: { anon: false, authenticated: false }, motivo: 'fechada só em prod, à mão' },
    };
    const r = auditGrantsFuncoes([{ file: '20260202000000_x.sql', sql: 'SELECT 1;' }], allow);
    expect(cods(r)).toEqual(['FUNCAO_FECHO_PENDENTE']);
    expect(r[0].level).toBe('warn');
  });

  // O detector assume o DEFACL medido (anon+authenticated com EXECUTE). Mexer nele muda a premissa
  // de TODO o resto: não é erro, é revisita obrigatória da medição.
  it('ALTER DEFAULT PRIVILEGES sobre FUNCTIONS avisa UMA vez (é achado do projeto, não da função)', () => {
    const r = auditGrantsFuncoes(
      [
        ANCORA,
        { file: '20260202000000_x.sql', sql: 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;' },
      ],
      ALLOW,
    );
    expect(cods(r)).toEqual(['FUNCAO_DEFAULT_PRIVILEGE_ALTERADO']);
    expect(r[0].level).toBe('warn');
  });

  it('ALTER DEFAULT PRIVILEGES sobre TABLES não é assunto desta parte', () => {
    const r = auditGrantsFuncoes(
      [ANCORA, { file: '20260202000000_x.sql', sql: 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;' }],
      ALLOW,
    );
    expect(r).toEqual([]);
  });
});

// Os códigos da Parte E CONTÊM os da Parte C como substring (FUNCAO_REABERTURA ⊃ REABERTURA).
// O contrato que impede as duas de se confundirem é o DELIMITADOR que o authz-gate-check emite —
// `[CODIGO]` —, não o prefixo. Este teste trava isso: quem filtrar por substring solta cai aqui.
describe('códigos da Parte E vs Parte C — só o delimitador desambigua', () => {
  it('todo código FUNCAO_* delimitado é distinto do código homônimo sem prefixo', () => {
    const r = auditGrantsFuncoes(
      [ANCORA, { file: '20260202000000_x.sql', sql: 'GRANT EXECUTE ON FUNCTION public.f(uuid) TO anon;' }],
      ALLOW,
    );
    const msgConvertida = `[${r[0].codigo}] ${r[0].msg}`;
    expect(msgConvertida.includes('REABERTURA')).toBe(true); // substring solta: colide, e por isso não serve
    expect(msgConvertida.includes('[REABERTURA]')).toBe(false); // delimitado: não colide
    expect(msgConvertida.includes('[FUNCAO_REABERTURA]')).toBe(true);
  });
});

describe('auditGrantsFuncoes — contra o repo REAL', () => {
  const migrations = readdirSync(join(process.cwd(), 'supabase', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ file: f, sql: readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8') }));

  it('as migrations do repo não têm reabertura de função (zero ERROS)', () => {
    const erros = auditGrantsFuncoes(migrations, AUTHZ_FUNCOES_FECHADAS).filter((f) => f.level === 'error');
    expect(erros.map((e) => `${e.codigo} ${e.funcao} ${e.file}`)).toEqual([]);
  });

  /** Tira todo REVOKE da migration que DROPa `fn`. `REVOKE ALL` **e** `REVOKE EXECUTE`: as duas
   *  formas convivem no repo (a 20260723150000 usa ALL; a 20260704120000, EXECUTE), e sabotar só
   *  uma deixaria a sabotagem sem efeito — o teste afirmaria "o detector é cego" quando o cego
   *  era o `replace`. Custou uma falha vermelha para descobrir. */
  const semRevokeNaMigrationDoDrop = (fn: string) =>
    migrations.map((m) =>
      m.sql.includes(`DROP FUNCTION IF EXISTS ${fn}`)
        ? { ...m, sql: m.sql.replace(/REVOKE\s+(?:EXECUTE|ALL)[^;]*;/gi, '-- revoke removido') }
        : m,
    );

  // O repo TEM 5 DROP+CREATE de função do contrato (medido 2026-08-15) e as 5 restauram o fecho.
  // Sem este teste, o verde acima seria indistinguível de "o detector não olhou nada". Estas 4 são
  // as que recriam DENTRO da própria migration-âncora — a forma que motivou a âncora inclusiva.
  it('o detector ENXERGA os DROP+CREATE que moram na âncora (não está inerte)', () => {
    const alvo = [
      'public.get_ultimos_precos_cliente',
      'public.get_regua_preco',
      'public.tint_calc_preco_final',
      'public.tint_recalc_preco_oficial',
    ];
    for (const fn of alvo) {
      const r = auditGrantsFuncoes(semRevokeNaMigrationDoDrop(fn), AUTHZ_FUNCOES_FECHADAS).filter(
        (f) => f.codigo === 'FUNCAO_RECRIADA_SEM_FECHO' && f.funcao === fn,
      );
      expect(r.length, fn).toBeGreaterThan(0);
    }
  });

  // A 5ª recriação do contrato, e ela documenta o MODELO em vez de escondê-lo: o DROP+CREATE de
  // `reposicao_pos_candidatos` está na 20260814000125, ANTERIOR à âncora dela (a 20260814022626,
  // que reemite REVOKE+GRANT). Sabotar a migration do DROP não produz achado — e não deve: o ACL
  // foi reestabelecido DEPOIS dela. Se um dia a âncora recuar, este teste vira vermelho e obriga
  // a revisitar a entrada, em vez de deixar a lacuna passar como silêncio.
  it('DROP+CREATE ANTERIOR à âncora não acusa — o ACL foi reestabelecido depois', () => {
    const fn = 'public.reposicao_pos_candidatos';
    const r = auditGrantsFuncoes(semRevokeNaMigrationDoDrop(fn), AUTHZ_FUNCOES_FECHADAS).filter(
      (f) => f.funcao === fn,
    );
    expect(r).toEqual([]);
    expect(AUTHZ_FUNCOES_FECHADAS[fn].fechadaPor! > '20260814000125').toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// Audit de PROD — o que o estático não vê: apply que nunca aconteceu e grant colado à mão.
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('compararExecuteProd', () => {
  it('prod batendo com o contrato não produz achado', () => {
    const medido: MedicaoExecuteProd = {
      'public.f': { roles: ['authenticated'], aclNulo: false },
      'public.g': { roles: [], aclNulo: false },
    };
    expect(compararExecuteProd(medido, ALLOW)).toEqual([]);
  });

  it('anon E authenticated com EXECUTE = o default privilege intacto ⇒ FUNCAO_NAO_APLICADA', () => {
    const medido: MedicaoExecuteProd = {
      'public.f': { roles: ['authenticated'], aclNulo: false },
      'public.g': { roles: ['anon', 'authenticated'], aclNulo: false },
    };
    const r = compararExecuteProd(medido, ALLOW);
    expect(cods(r)).toEqual(['FUNCAO_NAO_APLICADA']);
    expect(r[0].funcao).toBe('public.g');
    expect(r[0].file).toBe('(prod)');
  });

  it('sobra PARCIAL (só anon) é grant colado à mão ⇒ FUNCAO_DRIFT_PROD', () => {
    const medido: MedicaoExecuteProd = {
      'public.f': { roles: ['authenticated'], aclNulo: false },
      'public.g': { roles: ['anon'], aclNulo: false },
    };
    const r = compararExecuteProd(medido, ALLOW);
    expect(cods(r)).toEqual(['FUNCAO_DRIFT_PROD']);
  });

  it('função do MANIFEST com anon a mais também é o default intacto', () => {
    const medido: MedicaoExecuteProd = {
      'public.f': { roles: ['anon', 'authenticated'], aclNulo: false },
      'public.g': { roles: [], aclNulo: false },
    };
    const r = compararExecuteProd(medido, ALLOW);
    expect(cods(r)).toEqual(['FUNCAO_NAO_APLICADA']);
    expect(r[0].funcao).toBe('public.f');
  });

  // proacl NULL = EXECUTE implícito a PUBLIC. É o estado de função nascida sem NENHUM
  // GRANT/REVOKE — em `private`, onde não há default privilege, é assim que ela nasce.
  it('proacl NULL acusa mesmo com roles vazias (PUBLIC implícito)', () => {
    const medido: MedicaoExecuteProd = {
      'public.f': { roles: ['authenticated'], aclNulo: false },
      'public.g': { roles: [], aclNulo: true },
    };
    const r = compararExecuteProd(medido, ALLOW);
    expect(cods(r)).toEqual(['FUNCAO_NAO_APLICADA']);
  });

  it('função do contrato ausente do banco acusa FUNCAO_AUSENTE_EM_PROD', () => {
    const medido: MedicaoExecuteProd = { 'public.f': { roles: ['authenticated'], aclNulo: false } };
    const r = compararExecuteProd(medido, ALLOW);
    expect(cods(r)).toEqual(['FUNCAO_AUSENTE_EM_PROD']);
    expect(r[0].funcao).toBe('public.g');
  });

  // Diverge de propósito da irmã de tabela: em função, `fechadaPor: null` significa "prod está
  // fechada e o REVOKE não está no repo". Como o gate estático já não vigia esses casos, pular a
  // comparação AQUI também os deixaria sem nenhuma guarda — o pior desfecho possível, e um verde
  // que afirmaria cobertura exatamente onde ela não existe.
  it('fechadaPor=null avisa E compara mesmo assim (o audit é a única guarda dessas)', () => {
    const allow: Record<string, FuncaoFechada> = {
      'public.g': { fechadaPor: null, permitido: { anon: false, authenticated: false }, motivo: 'fecho só em prod, fora do repo' },
    };
    const r = compararExecuteProd({ 'public.g': { roles: ['anon', 'authenticated'], aclNulo: false } }, allow);
    expect(cods(r)).toEqual(['FUNCAO_FECHO_PENDENTE', 'FUNCAO_NAO_APLICADA']);
    expect(r.find((f) => f.codigo === 'FUNCAO_FECHO_PENDENTE')!.level).toBe('warn');
    expect(r.find((f) => f.codigo === 'FUNCAO_NAO_APLICADA')!.level).toBe('error');
  });

  it('fechadaPor=null que BATE com o contrato sai só com o aviso', () => {
    const allow: Record<string, FuncaoFechada> = {
      'public.g': { fechadaPor: null, permitido: { anon: false, authenticated: false }, motivo: 'fecho só em prod, fora do repo' },
    };
    const r = compararExecuteProd({ 'public.g': { roles: [], aclNulo: false } }, allow);
    expect(cods(r)).toEqual(['FUNCAO_FECHO_PENDENTE']);
    expect(r.every((f) => f.level === 'warn')).toBe(true);
  });
});
