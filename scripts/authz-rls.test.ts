/**
 * authz-rls.test.ts — dente do comparador de RLS, sem banco.
 * ============================================================================================
 *
 * Este arquivo prova DUAS coisas diferentes, e a separação importa:
 *
 *   §1 O COMPARADOR reage — para cada eixo, um estado sabotado tem de produzir o código CERTO.
 *      Casar só "produziu algum achado" deixaria POLICY_NOVA e POLICY_ALTERADA indistinguíveis, e
 *      o operador aplicaria a correção errada (declarar × investigar).
 *   §2 O CONTRATO do repo é bem-formado — invariantes que o `authz:rls:prod` não pode conferir
 *      contra prod porque são sobre o ARQUIVO. Rodam no CI, onde não há psql-ro.
 *
 * O que ele NÃO prova, e por isso o harness `db/test-audit-rls-prod.sh` existe: que a query mede o
 * catálogo certo, que o parser sobrevive ao eco de `SET`, e que a RLS de fato BARRA (efeito, sob
 * `SET ROLE authenticated` + GUC). Comparador correto sobre medição errada é verde cego.
 */
import { describe, it, expect } from 'vitest';

import { compararRlsProd, md5Lista, rotuloGrupo, type MedicaoRls, type MedPolicy } from './lib/authz-rls';
import {
  AUTHZ_RLS_ESPERADO,
  LACUNAS_DECLARADAS,
  LACUNAS_POR_GRUPO,
  AUTHZ_RLS_PREDICADOS,
  PREDICADOS_PLATAFORMA,
  type TabelaRls,
  type PredicadoEsperado,
  type LacunaGrupo,
} from './authz-rls-esperado';

// ── cenário sintético: 1 tabela curada, 2 policies, 1 predicado ────────────────────────────────
const QUAL_A = 'a'.repeat(32);
const QUAL_B = 'b'.repeat(32);
const SRC_FN = 'c'.repeat(32);

const CONTRATO: Record<string, TabelaRls> = {
  'public.zz_alvo': {
    forceRls: false,
    motivo: 'tabela sintética do teste',
    policies: {
      zz_select: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: QUAL_A,
        withCheckMd5: null,
        motivo: 'leitura staff',
      },
      zz_all: {
        cmd: '*',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: QUAL_B,
        withCheckMd5: QUAL_B,
        motivo: 'FOR ALL simétrico',
      },
    },
  },
};

const PREDICADOS: Record<string, PredicadoEsperado> = {
  'public.zz_gate': { secdef: true, cfg: 'search_path=public', srcMd5: SRC_FN, motivo: 'gate' },
};

const PLATAFORMA: ReadonlySet<string> = new Set(['auth.uid']);

// Grupo sintético do eixo 4: `zz_gate` gateia DUAS tabelas, das quais só `zz_alvo` está curada —
// uma curada e uma lacuna é o estado mínimo em que o eixo tem algo a afirmar. Com zero lacunas o
// cenário limpo já nasceria acusando LACUNA_GRUPO_CURADO, e o teste mediria outra coisa.
const GRUPO_TABS = ['zz_alvo', 'zz_outra'];
const GRUPOS: LacunaGrupo[] = [
  {
    def: { tipo: 'predicado', predicado: 'public.zz_gate' },
    tabelasNoGrafo: 2,
    tabelasMd5: md5Lista(GRUPO_TABS),
    medidoEm: '2026-08-28',
    motivo: 'grupo sintético do teste',
  },
];

function medLimpa(): MedicaoRls {
  return {
    universal: { totalTabelas: 10, tabelasSemRls: [] },
    tabelas: [{ tabela: 'public.zz_alvo', existe: true, rls: true, force: false }],
    policies: [
      { tabela: 'public.zz_alvo', nome: 'zz_select', cmd: 'r', permissiva: true, roles: 'authenticated', qualMd5: QUAL_A, wcMd5: null },
      { tabela: 'public.zz_alvo', nome: 'zz_all', cmd: '*', permissiva: true, roles: 'authenticated', qualMd5: QUAL_B, wcMd5: QUAL_B },
    ],
    predicados: [
      { funcao: 'public.zz_gate', secdef: true, cfg: 'search_path=public', srcMd5: SRC_FN },
      { funcao: 'auth.uid', secdef: false, cfg: '', srcMd5: 'd'.repeat(32) },
    ],
    grupos: [{ grupo: 'public.zz_gate', tabelas: [...GRUPO_TABS] }],
  };
}

function rodar(mut: (m: MedicaoRls) => void = () => {}) {
  const m = medLimpa();
  mut(m);
  return compararRlsProd(m, CONTRATO, PREDICADOS, PLATAFORMA, GRUPOS);
}
const codigos = (fs: ReturnType<typeof rodar>) => fs.map((f) => f.codigo);
function pol(m: MedicaoRls, nome: string): MedPolicy {
  const p = m.policies.find((x) => x.nome === nome);
  if (!p) throw new Error(`policy ${nome} sumiu do fixture — o teste está medindo outra coisa`);
  return p;
}

describe('§1 comparador — cada eixo sabotado produz o código certo', () => {
  it('estado limpo não produz achado nenhum', () => {
    expect(rodar()).toEqual([]);
  });

  // ── eixo 1: o interruptor ────────────────────────────────────────────────────────────────
  it('RLS desligada em tabela CURADA → RLS_DESLIGADA', () => {
    const fs = rodar((m) => {
      m.universal.tabelasSemRls = ['public.zz_alvo'];
      m.tabelas[0].rls = false;
    });
    expect(codigos(fs)).toContain('RLS_DESLIGADA');
    expect(codigos(fs)).not.toContain('RLS_DESLIGADA_FORA_DO_CONTRATO');
    expect(fs[0].msg).toContain('INERTES');
  });

  it('RLS desligada FORA do contrato → o código genérico, não o curado', () => {
    const fs = rodar((m) => {
      m.universal.tabelasSemRls = ['public.qualquer_outra'];
    });
    expect(codigos(fs)).toEqual(['RLS_DESLIGADA_FORA_DO_CONTRATO']);
  });

  // ── eixo 2: o conteúdo ───────────────────────────────────────────────────────────────────
  it('tabela declarada e ausente em prod → TABELA_AUSENTE (nunca silêncio)', () => {
    const fs = rodar((m) => {
      m.tabelas[0].existe = false;
      m.policies = [];
    });
    expect(codigos(fs)).toContain('TABELA_AUSENTE');
    // não deve tentar comparar as policies de uma tabela que não existe
    expect(codigos(fs)).not.toContain('POLICY_SUMIU');
  });

  it('relforcerowsecurity divergente → FORCE_DIVERGENTE', () => {
    expect(codigos(rodar((m) => (m.tabelas[0].force = true)))).toEqual(['FORCE_DIVERGENTE']);
  });

  it('policy em prod fora do contrato → POLICY_NOVA', () => {
    const fs = rodar((m) =>
      m.policies.push({
        tabela: 'public.zz_alvo', nome: 'zz_backdoor', cmd: 'r', permissiva: true,
        roles: 'PUBLIC', qualMd5: 'e'.repeat(32), wcMd5: null,
      }),
    );
    expect(codigos(fs)).toEqual(['POLICY_NOVA']);
    expect(fs[0].msg).toContain('SOMA por OR');
  });

  it('policy do contrato ausente em prod → POLICY_SUMIU', () => {
    const fs = rodar((m) => (m.policies = m.policies.filter((p) => p.nome !== 'zz_select')));
    expect(codigos(fs)).toEqual(['POLICY_SUMIU']);
  });

  it.each([
    ['USING', (m: MedicaoRls) => (pol(m, 'zz_select').qualMd5 = 'f'.repeat(32)), 'USING'],
    ['WITH CHECK', (m: MedicaoRls) => (pol(m, 'zz_select').wcMd5 = 'f'.repeat(32)), 'WITH CHECK'],
    ['cmd', (m: MedicaoRls) => (pol(m, 'zz_select').cmd = 'd'), 'cmd DELETE'],
    ['roles', (m: MedicaoRls) => (pol(m, 'zz_select').roles = 'PUBLIC'), 'roles PUBLIC'],
    ['permissividade', (m: MedicaoRls) => (pol(m, 'zz_select').permissiva = false), 'RESTRICTIVE'],
  ])('campo %s alterado → POLICY_ALTERADA nomeando o campo', (_rot, mut, trecho) => {
    const fs = rodar(mut);
    expect(codigos(fs)).toContain('POLICY_ALTERADA');
    expect(fs.find((f) => f.codigo === 'POLICY_ALTERADA')!.msg).toContain(trecho);
  });

  it('FOR ALL com WITH CHECK ≠ USING → FOR_ALL_ASSIMETRICO (a armadilha do DELETE, §4)', () => {
    const fs = rodar((m) => (pol(m, 'zz_all').wcMd5 = 'f'.repeat(32)));
    expect(codigos(fs)).toContain('FOR_ALL_ASSIMETRICO');
    // e o achado é ESTRUTURAL: vem junto do POLICY_ALTERADA, não no lugar dele
    expect(codigos(fs)).toContain('POLICY_ALTERADA');
  });

  it('FOR ALL sem WITH CHECK NÃO é assimetria — o Postgres reusa o USING', () => {
    const contratoSemWc: Record<string, TabelaRls> = {
      'public.zz_alvo': {
        ...CONTRATO['public.zz_alvo'],
        policies: {
          ...CONTRATO['public.zz_alvo'].policies,
          zz_all: { ...CONTRATO['public.zz_alvo'].policies.zz_all, withCheckMd5: null },
        },
      },
    };
    const m = medLimpa();
    pol(m, 'zz_all').wcMd5 = null;
    expect(compararRlsProd(m, contratoSemWc, PREDICADOS, PLATAFORMA, GRUPOS)).toEqual([]);
  });

  it('forAllAssimetricoOk silencia o check estrutural — e SÓ ele', () => {
    const comEscape: Record<string, TabelaRls> = {
      'public.zz_alvo': { ...CONTRATO['public.zz_alvo'], forAllAssimetricoOk: 'desenho revisado' },
    };
    const m = medLimpa();
    pol(m, 'zz_all').wcMd5 = 'f'.repeat(32);
    const fs = compararRlsProd(m, comEscape, PREDICADOS, PLATAFORMA, GRUPOS);
    expect(fs.map((f) => f.codigo)).toEqual(['POLICY_ALTERADA']); // o drift do md5 continua acusado
  });

  // ── eixo 3: os predicados ────────────────────────────────────────────────────────────────
  it('função-predicado não declarada → PREDICADO_NAO_DECLARADO', () => {
    const fs = rodar((m) =>
      m.predicados.push({ funcao: 'private.zz_novo', secdef: true, cfg: '', srcMd5: 'a'.repeat(32) }),
    );
    expect(codigos(fs)).toEqual(['PREDICADO_NAO_DECLARADO']);
  });

  it.each([
    ['corpo', (m: MedicaoRls) => (m.predicados[0].srcMd5 = '9'.repeat(32)), 'corpo md5'],
    ['SECDEF', (m: MedicaoRls) => (m.predicados[0].secdef = false), 'SECURITY DEFINER'],
    ['search_path', (m: MedicaoRls) => (m.predicados[0].cfg = ''), 'proconfig'],
  ])('predicado com %s alterado → PREDICADO_ALTERADO', (_r, mut, trecho) => {
    const fs = rodar(mut);
    expect(codigos(fs)).toEqual(['PREDICADO_ALTERADO']);
    expect(fs[0].msg).toContain(trecho);
  });

  it('o md5 do CORPO é o ponto cego que o md5 da POLICY não cobre', () => {
    // Cenário exato do vetor: a policy fica byte-a-byte idêntica; só o corpo do gate muda.
    const fs = rodar((m) => (m.predicados[0].srcMd5 = '0'.repeat(32)));
    expect(codigos(fs)).toEqual(['PREDICADO_ALTERADO']);
    expect(codigos(fs)).not.toContain('POLICY_ALTERADA'); // ninguém mais veria isto
  });

  it('predicado declarado que nenhuma policy referencia mais → PREDICADO_SUMIU', () => {
    const fs = rodar((m) => (m.predicados = m.predicados.filter((f) => f.funcao !== 'public.zz_gate')));
    expect(codigos(fs)).toEqual(['PREDICADO_SUMIU']);
  });

  it('função da PLATAFORMA não vira achado (corpo não congelado, por decisão)', () => {
    expect(rodar((m) => (m.predicados[1].srcMd5 = '7'.repeat(32)))).toEqual([]);
  });

  // ── controles INÓCUOS: mudanças reais que NÃO podem disparar nada ────────────────────────
  it('controle inócuo — tabela nova em public COM RLS ligada não é achado', () => {
    expect(rodar((m) => (m.universal.totalTabelas = 999))).toEqual([]);
  });

  it('controle inócuo — prosa do contrato (motivo) não participa da comparação', () => {
    const outraProsa: Record<string, TabelaRls> = {
      'public.zz_alvo': { ...CONTRATO['public.zz_alvo'], motivo: 'texto completamente diferente' },
    };
    expect(compararRlsProd(medLimpa(), outraProsa, PREDICADOS, PLATAFORMA, GRUPOS)).toEqual([]);
  });

  it('controle inócuo — policy de tabela FORA do contrato não é reconciliada', () => {
    const fs = rodar((m) =>
      m.policies.push({
        tabela: 'public.outra', nome: 'p', cmd: '*', permissiva: true,
        roles: 'PUBLIC', qualMd5: QUAL_A, wcMd5: QUAL_B, // assimétrica de propósito
      }),
    );
    expect(fs).toEqual([]); // o eixo 2 mede só o que foi curado — e diz isso na doc
  });

  // ── eixo 4 — a declaração de lacuna em BLOCO ────────────────────────────────────────────────
  // Este eixo não afirma nada sobre autorização: afirma que a DECLARAÇÃO ainda descreve prod. Os
  // três primeiros eixos reconciliam o contrato contra o banco; a declaração de não-cobertura
  // ninguém reconciliava, e ela apodrece pelo evento mais banal do repo — uma migration que
  // gateie mais uma tabela pela mesma capability.
  it('grupo CRESCEU (a migration gateou mais uma) → LACUNA_GRUPO_MUDOU, com os dois números', () => {
    const fs = rodar((m) => m.grupos[0].tabelas.push('zz_nova'));
    expect(codigos(fs)).toEqual(['LACUNA_GRUPO_MUDOU']);
    expect(fs[0].objeto).toBe('public.zz_gate');
    expect(fs[0].msg).toContain('CRESCEU');
    expect(fs[0].msg).toContain('3 tabela(s) em prod contra 2 declarada(s)');
    expect(fs[0].msg).toContain('zz_nova'); // a lista viva vai na mensagem, não só a contagem
  });

  it('grupo ENCOLHEU (uma rodada curou, ou a policy trocou de gate) → LACUNA_GRUPO_MUDOU', () => {
    const fs = rodar((m) => (m.grupos[0].tabelas = ['zz_outra']));
    expect(codigos(fs)).toEqual(['LACUNA_GRUPO_MUDOU']);
    expect(fs[0].msg).toContain('ENCOLHEU');
  });

  it('SUBSTITUIÇÃO — a contagem bate e o conjunto não → LACUNA_GRUPO_MUDOU pelo md5', () => {
    // O buraco que a contagem sozinha deixa: uma tabela sai do grupo e outra entra no mesmo
    // intervalo. É a mesma classe de "duas mudanças opostas se cancelam" que fez a declaração
    // guardar o TOTAL em vez do número de lacunas.
    const fs = rodar((m) => (m.grupos[0].tabelas = ['zz_alvo', 'zz_trocada']));
    expect(codigos(fs)).toEqual(['LACUNA_GRUPO_MUDOU']);
    expect(fs[0].msg).toContain('a CONTAGEM bate (2) e o CONJUNTO não');
    expect(fs[0].msg).toContain('zz_trocada');
  });

  it('grupo INTEIRAMENTE curado → LACUNA_GRUPO_CURADO (apagar a entrada, não renovar o número)', () => {
    // O espelho, no nível do grupo, do defeito de §7.1: a declaração passa a mentir na direção
    // que finge NÃO cobrir. A correção é oposta à do MUDOU, por isso o código é outro.
    const contratoCompleto: Record<string, TabelaRls> = {
      ...CONTRATO,
      'public.zz_outra': { forceRls: false, policies: {}, motivo: 'curada depois' },
    };
    const m = medLimpa();
    // A tabela recém-curada também passa a ser MEDIDA pelo eixo 2 — sem esta linha o teste
    // acusaria TABELA_AUSENTE junto e mediria duas coisas ao mesmo tempo.
    m.tabelas.push({ tabela: 'public.zz_outra', existe: true, rls: true, force: false });
    const fs = compararRlsProd(m, contratoCompleto, PREDICADOS, PLATAFORMA, GRUPOS);
    expect(codigos(fs)).toEqual(['LACUNA_GRUPO_CURADO']);
    expect(fs[0].msg).toContain('REMOVA a entrada');
  });

  it('medição VAZIA de um grupo não vira "curado" — o diagnóstico perigoso', () => {
    // `lacunas === 0` é verdade tanto para "todas curadas" quanto para "a query não devolveu
    // nada". Diagnosticar a segunda como a primeira convidaria a APAGAR a declaração por causa de
    // uma medição quebrada. O guard manda a lista vazia para MUDOU, que é o honesto.
    const fs = rodar((m) => (m.grupos[0].tabelas = []));
    expect(codigos(fs)).toEqual(['LACUNA_GRUPO_MUDOU']);
    expect(fs[0].msg).toContain('ENCOLHEU');
  });

  it('grupo declarado SEM linha de medição → achado, nunca silêncio', () => {
    const fs = rodar((m) => (m.grupos = []));
    expect(codigos(fs)).toEqual(['LACUNA_GRUPO_MUDOU']);
    expect(fs[0].msg).toContain('SEM linha de medição');
  });

  it('controle inócuo — a ORDEM em que prod devolve as tabelas do grupo não é achado', () => {
    // O md5 ordena em JS antes de hashear justamente para isto: `jsonb_agg` não promete ordem.
    const fs = rodar((m) => (m.grupos[0].tabelas = [...GRUPO_TABS].reverse()));
    expect(fs).toEqual([]);
  });
});

describe('§2 contrato do repo — invariantes conferíveis sem prod', () => {
  const entradas = Object.entries(AUTHZ_RLS_ESPERADO);

  it('cada tabela curada declara ao menos uma policy', () => {
    for (const [chave, e] of entradas) {
      expect(Object.keys(e.policies).length, `${chave} sem policy declarada`).toBeGreaterThan(0);
    }
  });

  it('nenhum FOR ALL declarado é assimétrico sem escape explícito', () => {
    for (const [chave, e] of entradas) {
      for (const [nome, p] of Object.entries(e.policies)) {
        if (p.cmd !== '*' || p.withCheckMd5 === null || p.withCheckMd5 === p.qualMd5) continue;
        expect(e.forAllAssimetricoOk, `${chave} » ${nome}: FOR ALL assimétrico sem justificativa`).toBeTruthy();
      }
    }
  });

  it('todo md5 declarado tem forma de md5 (32 hex) — typo vira vermelho eterno em prod', () => {
    const hex = /^[0-9a-f]{32}$/;
    for (const [chave, e] of entradas) {
      for (const [nome, p] of Object.entries(e.policies)) {
        for (const [campo, v] of [['qual', p.qualMd5], ['withCheck', p.withCheckMd5]] as const) {
          if (v !== null) expect(v, `${chave} » ${nome} (${campo})`).toMatch(hex);
        }
      }
    }
    for (const [fn, p] of Object.entries(AUTHZ_RLS_PREDICADOS)) {
      expect(p.srcMd5, `predicado ${fn}`).toMatch(hex);
    }
  });

  // A allowlist só não vira depósito enquanto CADA entrada carregar a razão de ter passado no
  // critério do cabeçalho. "Motivo vazio" é a forma que o apodrecimento toma: a tabela entra numa
  // rodada de curadoria, ninguém escreve por quê, e a rodada seguinte não tem como reavaliá-la.
  // O piso é grosseiro de propósito — não mede qualidade de texto, mede que alguém escreveu algo.
  it('toda entrada declara um motivo com substância — allowlist sem razão vira depósito', () => {
    for (const [chave, e] of entradas) {
      expect(e.motivo.trim().length, `${chave}: motivo de TABELA ausente ou raso`).toBeGreaterThan(80);
      for (const [nome, pol] of Object.entries(e.policies)) {
        expect(
          pol.motivo.trim().length,
          `${chave} » ${nome}: motivo de POLICY ausente ou raso`,
        ).toBeGreaterThan(40);
      }
    }
    for (const [fn, pred] of Object.entries(AUTHZ_RLS_PREDICADOS)) {
      expect(pred.motivo.trim().length, `predicado ${fn}: motivo ausente ou raso`).toBeGreaterThan(80);
    }
  });

  // ── LACUNAS DECLARADAS × contrato ───────────────────────────────────────────────────────────
  // O defeito que estes três testes existem para pegar aconteceu de verdade, e em UM dia: a lista
  // de lacunas era prosa no cabeçalho, uma rodada seguinte curou 3 das tabelas que ela declarava
  // como não-cobertas, e o texto seguiu afirmando o contrário — verde em TODOS os gates, porque
  // os audits reconciliam o CONTRATO contra prod e ninguém reconcilia a declaração contra o
  // contrato. Declaração que mente sobre a própria cobertura é a mesma classe de "contrato falso",
  // só que na direção que finge NÃO cobrir.
  it('nenhuma tabela declarada como lacuna está curada — a declaração não pode mentir', () => {
    for (const chave of Object.keys(LACUNAS_DECLARADAS)) {
      expect(
        chave in AUTHZ_RLS_ESPERADO,
        `${chave}: declarada como LACUNA e curada ao mesmo tempo — ao curar uma tabela, remova-a ` +
          `de LACUNAS_DECLARADAS no MESMO PR`,
      ).toBe(false);
    }
  });

  it('toda lacuna vem QUALIFICADA e com razão de substância', () => {
    const qual = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
    for (const [chave, motivo] of Object.entries(LACUNAS_DECLARADAS)) {
      expect(chave, 'chave de lacuna sem schema').toMatch(qual);
      expect(motivo.trim().length, `${chave}: lacuna sem razão escrita`).toBeGreaterThan(80);
    }
  });

  // Sentinela do próprio gate: sem piso, esvaziar LACUNAS_DECLARADAS deixaria os dois testes
  // acima passando por VACUIDADE (`for` sobre lista vazia não itera) — e o contrato voltaria a
  // não declarar nada, que é o estado que esta rodada existiu para corrigir.
  it('a lista de lacunas não pode ser esvaziada em silêncio', () => {
    expect(Object.keys(LACUNAS_DECLARADAS).length).toBeGreaterThanOrEqual(8);
  });

  // ── LACUNAS_POR_GRUPO — o que só o ARQUIVO pode garantir ────────────────────────────────────
  // A verdade das CONTAGENS mora em prod e é conferida por `bun run authz:rls:prod` (eixo 4);
  // aqui ficam as invariantes de forma, que rodam no CI, onde não há psql-ro. Sem elas o eixo 4
  // seria conferível mas não confiável: um `tabelasNoGrafo: 0` ou um rótulo duplicado fazem o
  // runner comparar contra lixo sem nada reclamar.
  it('a lista de GRUPOS não pode ser esvaziada em silêncio', () => {
    // A mesma sentinela de vacuidade da lista de tabelas, e pela mesma razão: o eixo 4 é um `for`
    // sobre esta lista, e `for` sobre lista vazia não itera — o audit sairia ✅ tendo conferido
    // zero grupos, que é o estado que esta rodada existiu para corrigir.
    expect(LACUNAS_POR_GRUPO.length).toBeGreaterThanOrEqual(3);
  });

  it('todo grupo tem contagem POSITIVA, md5 de 32 hex, data ISO e razão de substância', () => {
    for (const g of LACUNAS_POR_GRUPO) {
      const rot = rotuloGrupo(g.def);
      // `0` seria vacuidade disfarçada de medição: casaria com um grupo que sumiu de prod e com
      // uma query quebrada, e as duas leituras são opostas.
      expect(g.tabelasNoGrafo, `${rot}: contagem não-positiva`).toBeGreaterThan(0);
      expect(g.tabelasMd5, `${rot}: md5 malformado`).toMatch(/^[0-9a-f]{32}$/);
      expect(g.medidoEm, `${rot}: data de medição fora do ISO`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(g.motivo.trim().length, `${rot}: razão ausente ou rasa`).toBeGreaterThan(80);
    }
  });

  it('o rótulo de grupo é único e QUALIFICADO, e não contém ":"', () => {
    const qual = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
    const vistos = new Set<string>();
    for (const g of LACUNAS_POR_GRUPO) {
      const rot = rotuloGrupo(g.def);
      // O rótulo é a CHAVE que o runner casa entre declaração e medição: dois grupos com o mesmo
      // rótulo fariam um deles ser conferido duas vezes e o outro nunca, em silêncio.
      expect(vistos.has(rot), `rótulo duplicado: ${rot}`).toBe(false);
      vistos.add(rot);
      expect(rot).not.toContain(':'); // o idFinding do carimbo parte por ':'
      if (g.def.tipo === 'predicado') expect(g.def.predicado).toMatch(qual);
      else expect(g.def.prefixo.length, `prefixo vazio casaria TODA tabela de public`).toBeGreaterThan(2);
    }
  });

  it('nomes de tabela e de policy não contêm ":" — o idFinding do carimbo parte por ele', () => {
    for (const [chave, e] of entradas) {
      expect(chave).not.toContain(':');
      for (const nome of Object.keys(e.policies)) expect(`${chave} » ${nome}`).not.toContain(':');
    }
    for (const fn of Object.keys(AUTHZ_RLS_PREDICADOS)) expect(fn).not.toContain(':');
  });

  it('chave de tabela e de função vem QUALIFICADA (schema.objeto)', () => {
    const qual = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
    for (const [chave] of entradas) expect(chave).toMatch(qual);
    for (const fn of Object.keys(AUTHZ_RLS_PREDICADOS)) expect(fn).toMatch(qual);
    for (const fn of PREDICADOS_PLATAFORMA) expect(fn).toMatch(qual);
  });

  it('nenhuma função está declarada como predicado congelado E como plataforma', () => {
    for (const fn of Object.keys(AUTHZ_RLS_PREDICADOS)) {
      expect(PREDICADOS_PLATAFORMA.has(fn), `${fn} nos dois conjuntos`).toBe(false);
    }
  });

  it('o contrato real, comparado consigo mesmo, é limpo — nenhuma entrada nasce vermelha', () => {
    // Fabrica a medição a partir do próprio contrato: se o comparador acusar algo aqui, é o
    // contrato que está mal-formado (cmd inválido, roles fora de ordem, campo esquecido).
    const med: MedicaoRls = {
      universal: { totalTabelas: entradas.length, tabelasSemRls: [] },
      tabelas: entradas.map(([t, e]) => ({ tabela: t, existe: true, rls: true, force: e.forceRls })),
      policies: entradas.flatMap(([t, e]) =>
        Object.entries(e.policies).map(([nome, p]) => ({
          tabela: t, nome, cmd: p.cmd, permissiva: p.permissiva,
          roles: [...p.roles].sort().join('+'), qualMd5: p.qualMd5, wcMd5: p.withCheckMd5,
        })),
      ),
      predicados: Object.entries(AUTHZ_RLS_PREDICADOS).map(([funcao, p]) => ({
        funcao, secdef: p.secdef, cfg: p.cfg, srcMd5: p.srcMd5,
      })),
      // O eixo 4 entra VAZIO aqui de propósito, e a razão é o que o eixo é: a verdade dele mora em
      // PROD (quantas tabelas o grupo tem hoje), não no arquivo. Fabricar a medição a partir da
      // declaração — reconstruir a lista de tabelas de um md5 é impossível, e inventar uma lista
      // que casasse seria escrever a resposta antes da pergunta — provaria só que a igualdade é
      // reflexiva. Quem prova o eixo 4 são os testes de §1 (comparador) e o harness PG17.
      grupos: [],
    };
    expect(compararRlsProd(med, AUTHZ_RLS_ESPERADO, AUTHZ_RLS_PREDICADOS, PREDICADOS_PLATAFORMA, [])).toEqual([]);
  });
});
