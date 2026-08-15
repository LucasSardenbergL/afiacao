import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { auditAuthz, auditCompleto, type Migration } from './authz-gate-check';
import { AUTHZ_TABELAS_FECHADAS } from './authz-tabelas-fechadas';
import { AUTHZ_MANIFEST, ACKNOWLEDGED_SENSITIVE, manifestKey } from './authz-manifest';
import { AUTHZ_REESCRITAS_CONHECIDAS } from './authz-reescritas-conhecidas';
import { detectarReescritaViva } from './lib/authz-reescrita';

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

// ══════════ EIXO COMERCIAL DE COMPRAS — a classe fechada (2026-08-14) ══════════
// Follow-up 1 de docs/historico/sentinela-authz-controle-nao-mencao.md. A RPC do bloco acima entrou
// no manifest À MÃO porque a Parte B só exigia classificação no eixo custo/preço/estoque. Ampliar
// `SENSITIVE_*` para compras revelou 12 SECDEF sem classificação (medido: `authz:check` exit 1 com
// 12 erros ANTES de classificar). Cada uma foi classificada pelos GRANTS REAIS de prod (psql-ro):
// 2 alcançáveis por `authenticated` → AUTHZ_MANIFEST; 10 fechadas por privilégio → ACKNOWLEDGED.
//
// Os testes abaixo existem porque baseline é o momento de maior risco de contrato FALSO: uma lista
// pode ficar verde por estar silenciando, e não por estar cobrindo.
const COMPRAS_MANIFEST: Array<{ nome: string; gate: string; arquivo: string; de: string }> = [
  {
    nome: 'pedido_compra_split',
    gate: 'has_role',
    arquivo: '20260515213420_868822bb-e38c-4fcf-8879-c64e48bd7630.sql',
    de: "IF NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN",
  },
  {
    nome: 'converter_sugestao_em_campanha_flat',
    gate: 'has_role',
    arquivo: '20260512101121_a96fa007-f688-4c3a-8cd9-43f9d88e5505.sql',
    de: "IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN",
  },
  {
    nome: 'reposicao_pos_marcador',
    gate: 'cap_compras_ler',
    arquivo: '20260814000125_reposicao_pos_frescor_marcador.sql',
    de: 'AND (SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE THEN',
  },
];

/** as 10 que fecham por PRIVILÉGIO (auth=NAO/anon=NAO medido em prod) — baseline desta entrega */
const COMPRAS_ACK = [
  'public.detectar_skus_sem_grupo',
  'public.reposicao_alerta_pedido_minimo_tick',
  'public.sayerlack_retry_orfaos',
  'public.reposicao_pedido_auto_aprovavel',
  'public.reposicao_aplicar_depara_sayerlack_auto',
  'public.envio_portal_lock_candidatos',
  'public.envio_portal_claim_ids',
  'public.iniciar_envio_portal_pre_claim',
  'public.reposicao_persistir_qtde_inteira',
  'public.set_status_envio_portal_on_disparo',
];

/** SECDEF sintética que toca o eixo de compras, sem gate nenhum */
function secdefCompras(nome: string): string {
  return `CREATE OR REPLACE FUNCTION public.${nome}()
 RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$ BEGIN RETURN (SELECT count(*) FROM public.pedido_compra_sugerido WHERE fornecedor_nome IS NOT NULL); END; $function$;`;
}

describe('Parte B — o eixo de compras alcança o que o eixo de custo não alcançava', () => {
  it('SECDEF nova que toca pedido_compra_sugerido/fornecedor_nome e não está classificada → ERRO', () => {
    const err = errorsOf(auditAuthz([mig('20991231000000_nova.sql', secdefCompras('fuga_de_compras'))]));
    expect(err).toHaveLength(1);
    expect(err[0].fn).toContain('public.fuga_de_compras');
    expect(err[0].msg).toContain('pedido_compra_sugerido');
  });

  it('SECURITY INVOKER no eixo de compras continua ignorado (não bypassa RLS)', () => {
    const invoker = secdefCompras('fuga_invoker').replace('SECURITY DEFINER', 'SECURITY INVOKER');
    expect(errorsOf(auditAuthz([mig('20991231000000_x.sql', invoker)]))).toHaveLength(0);
  });

  it('as 10 chaves de ACKNOWLEDGED silenciam DE VERDADE (pega chave com typo)', () => {
    // Uma chave escrita errada não silencia nada e a função fica sem classificação — este teste é
    // o que separa "a lista está certa" de "a lista tem 10 strings dentro".
    for (const chave of COMPRAS_ACK) {
      expect(ACKNOWLEDGED_SENSITIVE.has(chave)).toBe(true);
      const nome = chave.replace('public.', '');
      const err = errorsOf(auditAuthz([mig('20991231000000_ack.sql', secdefCompras(nome))]));
      expect(err.filter((e) => e.fn.includes(nome))).toHaveLength(0);
    }
  });
});

describe('AUTHZ_MANIFEST — as 3 entradas de compras estão VIVAS, não apenas silenciosas', () => {
  /**
   * Recorta a definição de UMA função no arquivo REAL e sabota só dentro dela.
   * `String.replace(string, …)` troca a PRIMEIRA ocorrência, e a linha de gate
   * `IF auth.uid() IS NULL OR NOT (has_role…)` aparece 5× em 20260512101121 — a primeira pertence
   * a `fin_consolidado_intercompany`, não à função sob teste. Sabotar a função errada deixaria o
   * teste verde pelo motivo errado, que é o modo de falha que este arquivo inteiro existe p/ evitar.
   */
  function sabotaFn(sql: string, nome: string, de: string, para: string): string {
    const ancora = `CREATE OR REPLACE FUNCTION public.${nome}(`;
    const ini = sql.indexOf(ancora);
    expect(ini).toBeGreaterThan(-1);
    expect(sql.indexOf(ancora, ini + 1)).toBe(-1); // âncora única: senão o recorte é ambíguo
    const prox = sql.indexOf('CREATE OR REPLACE FUNCTION', ini + ancora.length);
    const fim = prox === -1 ? sql.length : prox;
    const trecho = sql.slice(ini, fim);
    expect(trecho).toContain(de); // sabotagem que não casa nada deixaria o teste verde à toa
    return sql.slice(0, ini) + trecho.replace(de, para) + sql.slice(fim);
  }

  const leia = (arq: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', arq), 'utf8');

  for (const alvo of COMPRAS_MANIFEST) {
    it(`${alvo.nome}: a migration REAL passa no contrato (senão o CI ficaria vermelho por falso positivo)`, () => {
      expect(AUTHZ_MANIFEST[manifestKey('public', alvo.nome)]).toBeDefined();
      const err = errorsOf(auditAuthz([mig(alvo.arquivo, leia(alvo.arquivo))])).filter((e) => e.fn.includes(alvo.nome));
      expect(err).toHaveLength(0);
    });

    it(`${alvo.nome}: gate REMOVIDO do arquivo real → ERRO nomeando ${alvo.gate}`, () => {
      const s = sabotaFn(leia(alvo.arquivo), alvo.nome, alvo.de, 'IF false THEN');
      const err = errorsOf(auditAuthz([mig(alvo.arquivo, s)])).filter((e) => e.fn.includes(alvo.nome));
      expect(err).toHaveLength(1);
      expect(err[0].msg).toContain(alvo.gate);
    });

    it(`${alvo.nome}: recriação POSTERIOR sem gate vence a com gate (last-writer)`, () => {
      const err = errorsOf(
        auditAuthz([mig(alvo.arquivo, leia(alvo.arquivo)), mig('20991231000000_recria.sql', secdefCompras(alvo.nome))]),
      ).filter((e) => e.fn.includes(alvo.nome));
      expect(err).toHaveLength(1);
      expect(err[0].file).toBe('20991231000000_recria.sql');
    });
  }

  it('gate DECORATIVO (chamada presente, sem bloquear) não salva a entrada', () => {
    // A distinção que o #1729 comprou: presença de chamada ≠ controle.
    const decorativo = `CREATE OR REPLACE FUNCTION public.pedido_compra_split(p_pedido_id bigint)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$ DECLARE v boolean; BEGIN
  v := public.has_role(auth.uid(), 'employee'::app_role);
  INSERT INTO public.pedido_compra_sugerido (fornecedor_nome) VALUES ('x');
END; $function$;`;
    const err = errorsOf(auditAuthz([mig('20991231000000_dec.sql', decorativo)])).filter((e) => e.fn.includes('pedido_compra_split'));
    expect(err).toHaveLength(1);
    expect(err[0].msg).toContain('decorativo');
  });
});

describe('contrato de classificação — as duas listas não podem se contradizer', () => {
  it('nenhuma chave está nas DUAS listas (manifest venceria em silêncio e a justificativa do ACK seria mentira)', () => {
    const nas2 = Object.keys(AUTHZ_MANIFEST).filter((k) => ACKNOWLEDGED_SENSITIVE.has(k));
    expect(nas2).toEqual([]);
  });

  it('toda chave está na forma de manifestKey (lowercase schema.name) — chave torta nunca casa', () => {
    const tortas = [...Object.keys(AUTHZ_MANIFEST), ...ACKNOWLEDGED_SENSITIVE].filter((k) => {
      const [schema, ...resto] = k.split('.');
      return resto.length !== 1 || manifestKey(schema, resto[0]) !== k;
    });
    expect(tortas).toEqual([]);
  });
});

/**
 * Parte D — a reescrita da definição VIVA (`pg_get_functiondef` + `EXECUTE`), que recria uma
 * função SEM escrever `CREATE FUNCTION` e portanto é INVISÍVEL ao last-writer da Parte A.
 * Medido em 2026-08-14: 7 das 648 migrations usam o padrão; 2 delas deixam 3 funções do manifest
 * com a Parte A medindo uma definição que não é a última (confirmado contra o corpo vivo de prod).
 * As asserções casam CÓDIGO ASCII, nunca a frase em pt-BR (lição #1483: `grep -i` + pt_BR.UTF-8
 * dobra acento e a asserção passa a casar o ramo errado).
 */
describe('auditAuthz — Parte D (recriação por reescrita da definição viva)', () => {
  /** o idioma real do repo: lê a definição viva, transforma e devolve por EXECUTE */
  const reescritaViva = (alvo: string) => `DO $r$
DECLARE v_def text := pg_get_functiondef('${alvo}'::regprocedure);
BEGIN
  EXECUTE replace(v_def, 'antigo', 'novo');
END $r$;`;

  it('reescrita POSTERIOR ao last-writer → erro que nomeia o arquivo e a função', () => {
    const f = auditAuthz([
      mig('20260101000000_cria.sql', fn('fin_estimar_estoque_omie', GATE + READ)),
      mig('20260710000000_reescreve.sql', reescritaViva('public.fin_estimar_estoque_omie(text)')),
    ]);
    const err = errorsOf(f).filter((e) => e.msg.includes('REESCRITA_VIVA_NAO_MEDIDA'));
    expect(err).toHaveLength(1);
    expect(err[0].file).toBe('20260710000000_reescreve.sql');
    expect(err[0].fn).toBe('public.fin_estimar_estoque_omie');
  });

  it('CREATE OR REPLACE POSTERIOR à reescrita restabelece a auditabilidade → sem erro', () => {
    const f = auditAuthz([
      mig('20260101000000_cria.sql', fn('fin_estimar_estoque_omie', GATE + READ)),
      mig('20260710000000_reescreve.sql', reescritaViva('public.fin_estimar_estoque_omie(text)')),
      mig('20260711000000_recria.sql', fn('fin_estimar_estoque_omie', GATE + READ)),
    ]);
    expect(errorsOf(f).filter((e) => e.msg.includes('REESCRITA_VIVA'))).toHaveLength(0);
  });

  it('reescrita de função FORA do manifest não é assunto da Parte D (senão vira ruído e é desligada)', () => {
    const f = auditAuthz([
      mig('20260101000000_cria.sql', fn('fin_estimar_estoque_omie', GATE + READ)),
      mig('20260710000000_outra.sql', reescritaViva('public.uma_funcao_qualquer(text)')),
    ]);
    expect(errorsOf(f).filter((e) => e.msg.includes('REESCRITA_VIVA'))).toHaveLength(0);
  });

  it('alvo OPACO (loop sobre pg_proc, sem literal) vira AVISO — declara o não-medido sem erro falso', () => {
    const opaca = `DO $x$ DECLARE r record; BEGIN
      FOR r IN SELECT p.oid FROM pg_proc p WHERE p.prosecdef LOOP
        EXECUTE regexp_replace(pg_get_functiondef(r.oid), 'a', 'b', 'g');
      END LOOP; END $x$;`;
    const f = auditAuthz([
      mig('20260101000000_cria.sql', fn('fin_estimar_estoque_omie', GATE + READ)),
      mig('20260710000000_opaca.sql', opaca),
    ]);
    expect(errorsOf(f).filter((e) => e.msg.includes('REESCRITA_VIVA'))).toHaveLength(0);
    const av = f.filter((x) => x.level === 'warn' && x.msg.includes('REESCRITA_VIVA_ALVO_OPACO'));
    expect(av).toHaveLength(1);
    expect(av[0].file).toBe('20260710000000_opaca.sql');
  });
});

/**
 * Contrato da BASELINE de reescritas. O §7.3 do histórico ensinou que "a lista está certa" e
 * "a lista tem N strings dentro" são coisas diferentes: chave com typo não silencia nada e a
 * entrada vira decoração. Aqui as entradas são conferidas contra o REPO REAL.
 */
describe('AUTHZ_REESCRITAS_CONHECIDAS — a baseline não pode ser decoração', () => {
  const dirMig = join(import.meta.dirname, '..', 'supabase', 'migrations');

  it('toda entrada aponta para migration que EXISTE e função que está no AUTHZ_MANIFEST', () => {
    const quebradas = AUTHZ_REESCRITAS_CONHECIDAS.filter(
      (r) => !existsSync(join(dirMig, r.arquivo)) || !AUTHZ_MANIFEST[r.funcao],
    );
    expect(quebradas.map((r) => `${r.arquivo}::${r.funcao}`)).toEqual([]);
  });

  it('toda entrada REALMENTE dispara o detector no arquivo real (entrada morta mascararia o vivo)', () => {
    // Se a migration deixar de casar o padrão (ou a entrada tiver typo), o silêncio deixa de ser
    // justificado e passa a ser cego — exatamente o estado que a Parte D existe para acabar.
    const mortas = AUTHZ_REESCRITAS_CONHECIDAS.filter((r) => {
      const det = detectarReescritaViva(readFileSync(join(dirMig, r.arquivo), 'utf8'));
      return !det.detectada || !det.alvos.includes(r.funcao);
    });
    expect(mortas.map((r) => `${r.arquivo}::${r.funcao}`)).toEqual([]);
  });

  it('md5ProdEsperado tem forma de md5 (32 hex) — placeholder não ancora nada', () => {
    const tortos = AUTHZ_REESCRITAS_CONHECIDAS.filter((r) => !/^[0-9a-f]{32}$/.test(r.md5ProdEsperado));
    expect(tortos.map((r) => r.funcao)).toEqual([]);
  });

  it('o repo real não tem NENHUMA reescrita de função do manifest fora da baseline', () => {
    // O canário do estado atual: se um PR novo introduzir o padrão sobre função do manifest,
    // este teste cai junto com o `authz:check` — e a mensagem diz qual arquivo.
    const migs = readdirSync(dirMig)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => ({ file: f, sql: readFileSync(join(dirMig, f), 'utf8') }));
    const naoMedidas = auditCompleto(migs).filter((f) => f.msg.includes('REESCRITA_VIVA_NAO_MEDIDA'));
    expect(naoMedidas.map((f) => `${f.file}::${f.fn}`)).toEqual([]);
  });
});
