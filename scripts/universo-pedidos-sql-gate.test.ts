/**
 * universo-pedidos-sql-gate.test.ts — o gate da classe do universo de pedidos (CI, vitest lendo FONTE).
 * Regra e limites: scripts/lib/universo-pedidos-sql.ts. Diário: docs/historico/universo-pedidos-classe-sql.md.
 *
 * Três camadas, e cada uma com controle:
 *   1. o REPO está limpo — com DENOMINADOR (zero leitor é leitura quebrada, nunca "limpo");
 *   2. CALIBRAÇÃO com as formas REAIS: os 13 corpos PRÉ-fix (verbatim da prod, no fixture da prova
 *      PG17) reprovam todos; os 13 PÓS-fix (as 4 migrations) passam todos;
 *   3. CANÁRIOS de reintrodução: cada forma da classe, plantada numa migration nova, reprova — e os
 *      controles inócuos (o predicado dentro de LITERAL ou de COMENTÁRIO não conta) também.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { eventosDaMigration, julgar, julgarDefinicao, lerAutoridade, modelar, modelarPassos } from './lib/universo-pedidos-sql';
import { lerMigrations, REGISTRO_UNIVERSO_PEDIDOS, rodarGatePassos } from './universo-pedidos-sql-gate';
import { contarPulsos, descreverPulsos, drenarCedendo } from '@/test/loop-livre';

const RAIZ = resolve(fileURLToPath(import.meta.url), '../..');
const AUT = lerAutoridade(readFileSync(join(RAIZ, 'src/lib/farmer/universo-pedidos.ts'), 'utf8'));
const CORRIGIDOS = [
  'public.get_regua_preco', 'public.get_regua_preco_customer360', 'public.get_whatsapp_proposta_cotacao',
  'public.get_ultimos_precos_cliente', 'public.medir_abaixo_piso_tier', 'public.get_defasagem_cliente',
  'public.tint_ultimo_preco_cliente', 'public.melhoria_clientes_por_produto', 'public.classificar_clientes_fornecedores',
  'public.v_grupo_comercial', 'public.v_caca_compradores', 'public.v_caca_candidatos', 'private.customer_metrics_mv',
];
/** O repo + uma migration nova no fim (ordena depois de todas). */
// O fold das ~760 migrations DENTRO do `it`, drenado CEDENDO o event loop do worker: de uma vez, cada
// modelagem era um bloqueio síncrono (até 4,4s sob carga em 2026-10-05, 17 janelas acima de 250ms
// neste arquivo), e acima de 60s o RPC do vitest estoura — `test` rc=1 sem teste falhando
// (src/test/loop-livre.ts). Os dois helpers conferem o pulso de toda modelagem que fazem.
async function modelarCedendo(migrations: ReadonlyArray<{ nome: string; sql: string }>) {
  const p = await contarPulsos(() => drenarCedendo(modelarPassos(migrations)));
  expect(p.batidas, descreverPulsos(p)).toBeGreaterThanOrEqual(2);
  return p.resultado;
}
async function rodarGateCedendo(raiz: string) {
  const p = await contarPulsos(() => drenarCedendo(rodarGatePassos(raiz)));
  expect(p.batidas, descreverPulsos(p)).toBeGreaterThanOrEqual(2);
  return p.resultado;
}
const comMigration = (sql: string) => modelarCedendo([...lerMigrations(RAIZ), { nome: '99999999999999_canario.sql', sql }]);
const violacoesDe = (modelo: ReturnType<typeof modelar>, objeto: string) =>
  julgar(modelo, REGISTRO_UNIVERSO_PEDIDOS, AUT).violacoes.filter((v) => v.objeto === objeto).map((v) => v.motivo);

describe('universo de pedidos — o repo', () => {
  it('a autoridade é a do TS e tem os 4 status de não-venda', () => {
    expect([...AUT].sort()).toEqual(['cancelado', 'orcamento', 'pendente', 'rascunho']);
  });

  it('nenhuma violação, com denominador (38 leitores medidos em 2026-10-01, prod = repo)', async () => {
    const r = await rodarGateCedendo(RAIZ);
    expect(r.migrations).toBeGreaterThan(700);
    expect(r.leitores.length).toBeGreaterThanOrEqual(38);
    expect(r.violacoes).toEqual([]);
  });

  it('os 13 corrigidos são leitores e NÃO estão no registro (são canônicos)', async () => {
    const r = await rodarGateCedendo(RAIZ);
    for (const o of CORRIGIDOS) {
      expect(r.leitores).toContain(o);
      expect(REGISTRO_UNIVERSO_PEDIDOS[o]).toBeUndefined();
    }
  });
});

describe('universo de pedidos — calibração com as formas REAIS', () => {
  it('os 13 corpos PRÉ-fix (prod verbatim) reprovam, cada um', () => {
    const fixture = readFileSync(join(RAIZ, 'db/fixtures/universo-pedidos-predecessoras-prod-20261001.sql'), 'utf8');
    const defs = new Map<string, Parameters<typeof julgarDefinicao>[0]>();
    for (const e of eventosDaMigration('fixture', fixture)) if (e.tipo === 'def') defs.set(e.objeto, e.def);
    // a MV vem com o nome de prod (private.customer_metrics_mv) no fixture
    for (const o of CORRIGIDOS) {
      const d = defs.get(o);
      expect(d, `${o} ausente do fixture`).toBeDefined();
      expect(julgarDefinicao(d!, AUT), `${o} pré-fix devia reprovar`).not.toEqual([]);
    }
  });

  it('os 13 corpos PÓS-fix (as 4 migrations) passam, cada um', async () => {
    const modelo = await modelarCedendo(lerMigrations(RAIZ));
    for (const o of CORRIGIDOS) {
      const d = modelo.get(o)!;
      expect(d.migration, o).toMatch(/^20261001014(000|100|210|220)_universo_pedidos_/);
      expect(julgarDefinicao(d, AUT), o).toEqual([]);
    }
  });

  it('a MV movida de schema dentro de um DO (20260629120000) é seguida pelo modelo', async () => {
    const sem = await modelarCedendo(lerMigrations(RAIZ).filter((m) => !m.nome.startsWith('20261001014')));
    expect(sem.get('private.customer_metrics_mv')?.migration).toBe('20260623140000_recencia_mv_order_date_kpi.sql');
    expect(sem.get('public.customer_metrics_mv')?.migration).not.toBe('20260623140000_recencia_mv_order_date_kpi.sql');
  });
});

describe('universo de pedidos — canários de reintrodução', () => {
  const fn = (nome: string, corpo: string) =>
    `CREATE OR REPLACE FUNCTION public.${nome}(p uuid) RETURNS numeric LANGUAGE sql STABLE AS $f$ ${corpo} $f$;`;
  const DENY = `('cancelado','rascunho','pendente','orcamento')`;

  it('função nova SEM universo reprova', async () => {
    const m = await comMigration(fn('canario_sem', `SELECT sum(total) FROM public.sales_orders so WHERE so.customer_user_id = p`));
    expect(violacoesDe(m, 'public.canario_sem').join(' ')).toMatch(/0 com a denylist canônica/);
  });

  it('denylist PARCIAL (a do customer_metrics_mv antigo) reprova', async () => {
    const m = await comMigration(fn('canario_parcial', `SELECT sum(total) FROM sales_orders so WHERE so.status NOT IN ('cancelado','rascunho') AND so.deleted_at IS NULL`));
    expect(violacoesDe(m, 'public.canario_parcial').join(' ')).toMatch(/outra comparação de status/);
  });

  it('ALLOWLIST (a da defasagem antiga) reprova', async () => {
    const m = await comMigration(fn('canario_allow', `SELECT sum(total) FROM sales_orders so WHERE so.status IN ('faturado','importado','separacao','enviado') AND so.deleted_at IS NULL`));
    expect(violacoesDe(m, 'public.canario_allow').join(' ')).toMatch(/outra comparação de status/);
  });

  it('COALESCE(status, \'\') NOT IN (os 4) reprova — deixa o NULL entrar', async () => {
    const m = await comMigration(fn('canario_coalesce', `SELECT sum(total) FROM sales_orders so WHERE COALESCE(so.status,'') NOT IN ${DENY} AND so.deleted_at IS NULL`));
    expect(violacoesDe(m, 'public.canario_coalesce').join(' ')).toMatch(/0 com a denylist canônica/);
  });

  it('canônico SEM deleted_at reprova', async () => {
    const m = await comMigration(fn('canario_sem_del', `SELECT sum(total) FROM sales_orders so WHERE so.status NOT IN ${DENY}`));
    expect(violacoesDe(m, 'public.canario_sem_del').join(' ')).toMatch(/0 com deleted_at IS NULL/);
  });

  it('duas leituras com o universo em UMA só reprova (o defeito parcial da régua)', async () => {
    const m = await comMigration(fn('canario_duas', `SELECT (SELECT sum(total) FROM sales_orders so WHERE so.status NOT IN ${DENY} AND so.deleted_at IS NULL)
      + (SELECT sum(total) FROM sales_orders so WHERE so.deleted_at IS NULL)`));
    expect(violacoesDe(m, 'public.canario_duas').join(' ')).toMatch(/2 leitura\(s\).*1 com a denylist canônica/);
  });

  it('o predicado só dentro de LITERAL (texto de um RAISE) não conta', async () => {
    const m = await comMigration(`CREATE OR REPLACE FUNCTION public.canario_lit(p uuid) RETURNS numeric LANGUAGE plpgsql AS $f$
      BEGIN RAISE NOTICE 'so.status NOT IN ${DENY.replace(/'/g, "''")} AND so.deleted_at IS NULL';
      RETURN (SELECT sum(total) FROM sales_orders so WHERE so.customer_user_id = p); END $f$;`);
    expect(violacoesDe(m, 'public.canario_lit')).not.toEqual([]);
  });

  it('o predicado só dentro de COMENTÁRIO não conta', async () => {
    const m = await comMigration(fn('canario_com', `SELECT sum(total) FROM sales_orders so -- WHERE so.status NOT IN ${DENY} AND so.deleted_at IS NULL
      WHERE so.customer_user_id = p`));
    expect(violacoesDe(m, 'public.canario_com')).not.toEqual([]);
  });

  it('VIEW nova sem universo reprova; com o par canônico (forma do deparse) passa', async () => {
    const ruim = await comMigration(`CREATE OR REPLACE VIEW public.canario_v WITH (security_invoker = on) AS SELECT so.total FROM sales_orders so;`);
    expect(violacoesDe(ruim, 'public.canario_v')).not.toEqual([]);
    const boa = await comMigration(`CREATE OR REPLACE VIEW public.canario_v WITH (security_invoker = on) AS SELECT so.total FROM sales_orders so
      WHERE so.status <> ALL (ARRAY['cancelado'::text, 'rascunho'::text, 'pendente'::text, 'orcamento'::text]) AND so.deleted_at IS NULL;`);
    expect(violacoesDe(boa, 'public.canario_v')).toEqual([]);
  });

  it('re-criar um corrigido com o corpo ANTIGO reprova (a regressão por recolagem)', async () => {
    const fixture = readFileSync(join(RAIZ, 'db/fixtures/universo-pedidos-predecessoras-prod-20261001.sql'), 'utf8');
    const corpoAntigo = /CREATE OR REPLACE FUNCTION public\.tint_ultimo_preco_cliente[\s\S]*?\$function\$;/.exec(fixture)![0];
    expect(violacoesDe(await comMigration(corpoAntigo), 'public.tint_ultimo_preco_cliente')).not.toEqual([]);
  });

  it('o REGISTRO só encolhe: exceção que virou canônica reprova; objeto apagado deixa entrada órfã', async () => {
    const canonizado = await comMigration(fn('order_feed_x', `SELECT 1`)); // controle: não toca o registro
    expect(julgar(canonizado, REGISTRO_UNIVERSO_PEDIDOS, AUT).violacoes).toEqual([]);
    const virouCanonica = await comMigration(`CREATE OR REPLACE VIEW public.order_feed WITH (security_invoker = true) AS SELECT so.id FROM sales_orders so
      WHERE so.status NOT IN ${DENY} AND so.deleted_at IS NULL;`);
    expect(violacoesDe(virouCanonica, 'public.order_feed').join(' ')).toMatch(/tire do registro/);
    const apagada = await comMigration(`DROP VIEW IF EXISTS public.order_feed;`);
    expect(violacoesDe(apagada, 'public.order_feed').join(' ')).toMatch(/registro órfão/);
  });

  it('isenção por ALIAS: só o alias registrado sai; o outro do mesmo objeto segue julgado, e o isento tem de existir', async () => {
    const reg = { ...REGISTRO_UNIVERSO_PEDIDOS, 'public.canario_alias': { tipo: 'lookup' as const, aliases: ['t'], motivo: 'canário' } };
    const corpo = (principal: string) =>
      fn('canario_alias', `SELECT count(*) FROM sales_orders a WHERE ${principal}
        AND EXISTS (SELECT 1 FROM sales_orders t WHERE t.omie_pedido_id = a.omie_pedido_id)`);
    const doCanario = (m: ReturnType<typeof modelar>) =>
      julgar(m, reg, AUT).violacoes.filter((v) => v.objeto === 'public.canario_alias').map((v) => v.motivo).join(' ');
    // controle: principal canônico + o gêmeo isento → limpo
    expect(doCanario(await comMigration(corpo(`a.status NOT IN ${DENY} AND a.deleted_at IS NULL`)))).toBe('');
    // o principal regride: a isenção do `t` NÃO o cobre
    expect(doCanario(await comMigration(corpo(`a.deleted_at IS NULL`)))).toMatch(/alias a, 0 com a denylist canônica/);
    // o alias isento sumiu: o registro mente e reprova
    expect(doCanario(await comMigration(fn('canario_alias', `SELECT count(*) FROM sales_orders a WHERE a.status NOT IN ${DENY} AND a.deleted_at IS NULL`))))
      .toMatch(/alias 't'.*registro órfão/);
  });

  it('a autoridade manda: um 5º status no TS deixa os canônicos de hoje em violação', async () => {
    const aut5 = new Set([...AUT, 'devolvido']);
    const r = julgar(await modelarCedendo(lerMigrations(RAIZ)), REGISTRO_UNIVERSO_PEDIDOS, aut5);
    const acusados = new Set(r.violacoes.map((v) => v.objeto));
    for (const o of CORRIGIDOS) expect(acusados.has(o), o).toBe(true);
  });
});
