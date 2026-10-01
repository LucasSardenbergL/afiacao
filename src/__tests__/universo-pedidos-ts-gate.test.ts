import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';
import {
  classificar,
  detectarConstantesParalelas,
  detectarSitios,
  type Classe,
  type SitioPedidos,
} from '@/lib/gates/universo-pedidos-ts';
import {
  CONSTANTES_DIVIDA,
  REGISTRO,
  TETO_CONSTANTES_DIVIDA,
  TETO_DIVIDA,
} from '@/lib/gates/universo-pedidos-ts-registro';
import { STATUS_NAO_VENDA } from '@/lib/farmer/universo-pedidos';

// GATE da classe "ler sales_orders como VENDA com OUTRO universo" — a metade TS/edges
// (docs/historico/universo-pedidos-classe-ts.md; a metade SQL é scripts/universo-pedidos-sql-gate.test.ts).
//
// A regra: toda leitura de `sales_orders` aplica `.not('status', 'in', STATUS_NAO_VENDA_POSTGREST)` +
// `.is('deleted_at', null)` — ou lê o COMPLEMENTO pela lista da autoridade (as duas metades no mesmo
// arquivo) — ou está no REGISTRO (`src/lib/gates/universo-pedidos-ts-registro.ts`) com categoria e
// motivo. E nenhum arquivo além das duas autoridades guarda uma CÓPIA da lista de status.
//
// Por que TEXTUAL (readFileSync + AST do compilador TS, padrão do hoje-utc-gate): as edges são Deno e o
// vitest não as executa — mas o parser as lê como qualquer TS.

const RAIZ = resolve(__dirname, '../..');
const DIRS = ['src', 'supabase/functions', 'scripts'];
const EXT = /\.(ts|tsx)$/;
const IGNORAR = /(\.test\.|_test\.|\.d\.ts$|__tests__|\.stories\.)/;
/** Gerado pelo Supabase: só tipos (`Tables<'sales_orders'>`), nenhuma leitura — e 20k linhas de parse. */
const GERADO = 'src/integrations/supabase/types.ts';
const AUTORIDADES = new Set([
  'src/lib/farmer/universo-pedidos.ts',
  'supabase/functions/_shared/universo-pedidos.ts',
]);

function listarFontes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    if (nome === 'node_modules') continue;
    const rel = join(dir, nome);
    if (statSync(resolve(RAIZ, rel)).isDirectory()) listarFontes(rel, acc);
    else if (EXT.test(nome) && !IGNORAR.test(rel) && rel !== GERADO) acc.push(rel);
  }
  return acc;
}

const FONTES = DIRS.flatMap((d) => listarFontes(d)).map((arquivo) => ({
  arquivo,
  fonte: readFileSync(resolve(RAIZ, arquivo), 'utf8'),
}));

/**
 * O complemento só vale INTEIRO: quem lê o conjunto de exclusão por status e não lê o dos apagados
 * (ou o inverso) exclui metade e deixa a outra contar como venda. Sítio de complemento sem o par no
 * mesmo arquivo é julgado `fora`.
 */
function classificarComPar(sitios: readonly SitioPedidos[]): Array<{ s: SitioPedidos; classe: Classe }> {
  const parPorArquivo = new Map<string, { status: boolean; deleted: boolean }>();
  for (const s of sitios) {
    if (classificar(s) !== 'complemento') continue;
    const p = parPorArquivo.get(s.arquivo) ?? { status: false, deleted: false };
    p.status ||= s.complementoStatus;
    p.deleted ||= s.complementoDeleted;
    parPorArquivo.set(s.arquivo, p);
  }
  return sitios.map((s) => {
    const classe = classificar(s);
    if (classe !== 'complemento') return { s, classe };
    const p = parPorArquivo.get(s.arquivo)!;
    return { s, classe: p.status && p.deleted ? 'complemento' : 'fora' };
  });
}

const SITIOS = FONTES.flatMap(({ arquivo, fonte }) => detectarSitios(arquivo, fonte));
const JULGADOS = classificarComPar(SITIOS);
const chave = (arquivo: string, forma: string) => `${arquivo} · ${forma}`;

describe('gate: universo de pedidos de venda no TypeScript e nas edges', () => {
  it('sentinela: o walker anda e o detector acha leitores (denominador zero = leitura quebrada, não repo limpo)', () => {
    expect(FONTES.length, 'walker listou fontes de menos — glob/recursão quebrada').toBeGreaterThan(500);
    // 61 em 2026-10-01. Piso folgado: o que ele pega é o detector cego (0), não a erradicação.
    expect(SITIOS.length, 'o detector quase não achou sítios — a assinatura quebrou').toBeGreaterThan(40);
  });

  it('cru × casado: todo `.from(…"sales_orders")` do texto é um sítio do detector', () => {
    // A contagem CRUA (regex sobre o código sem comentário) e a CASADA (AST) têm de bater: se o grep
    // vê uma leitura que o AST não vê, é uma forma nova escapando — o tell do §9 do money-path. A regex
    // tolera cast, genérico e quebra de linha entre o `.from` e o nome.
    const cru = FONTES.reduce((n, { fonte }) => {
      const sem = removerComentarios(fonte);
      return n + (sem.match(/\.\s*from\b[^;'"`]{0,80}?\(\s*['"`]sales_orders['"`]/g)?.length ?? 0);
    }, 0);
    const casado = SITIOS.filter((s) => s.via === 'from').length;
    expect({ cru, casado }).toEqual({ cru: casado, casado });
  });

  it('G1: leitura fora do universo canônico está no registro (lookup, sincronização, propósito ou dívida)', () => {
    const esperado = new Map<string, number>();
    for (const e of REGISTRO) esperado.set(chave(e.arquivo, e.forma), e.n ?? 1);
    const achado = new Map<string, number>();
    for (const { s, classe } of JULGADOS) {
      if (classe !== 'fora') continue;
      achado.set(chave(s.arquivo, s.forma), (achado.get(chave(s.arquivo, s.forma)) ?? 0) + 1);
    }
    const novos = [...achado]
      .filter(([k, n]) => n > (esperado.get(k) ?? 0))
      .map(([k, n]) => `${k} (${n}× no arquivo, registro ${esperado.get(k) ?? 0})`);
    expect(
      novos.join('\n'),
      'leitura de sales_orders sem o universo de venda: aplique .not("status","in",STATUS_NAO_VENDA_POSTGREST) + ' +
        '.is("deleted_at", null) — ou, se NÃO é pergunta de venda de propósito, registre em ' +
        'src/lib/gates/universo-pedidos-ts-registro.ts com categoria e motivo',
    ).toBe('');
  });

  it('G2: o registro só encolhe — entrada sem sítio (sumiu, virou canônico ou mudou de forma) reprova', () => {
    const achado = new Map<string, number>();
    for (const { s, classe } of JULGADOS) {
      if (classe !== 'fora') continue;
      achado.set(chave(s.arquivo, s.forma), (achado.get(chave(s.arquivo, s.forma)) ?? 0) + 1);
    }
    const orfas = REGISTRO.filter((e) => (achado.get(chave(e.arquivo, e.forma)) ?? 0) < (e.n ?? 1)).map(
      (e) => `${chave(e.arquivo, e.forma)} (${e.categoria})`,
    );
    expect(orfas.join('\n'), 'entrada quitada ou mudou de forma: remova-a do registro (ou reclassifique a forma nova)').toBe('');
  });

  it('G3: feed de propósito esconde o pedido apagado (ou diz por que não)', () => {
    const porChave = new Map(JULGADOS.map(({ s }) => [chave(s.arquivo, s.forma), s]));
    const semFiltro = REGISTRO.filter(
      (e) => e.categoria === 'proposito' && !e.incluiApagado && !porChave.get(chave(e.arquivo, e.forma))?.deletedAt,
    ).map((e) => chave(e.arquivo, e.forma));
    expect(semFiltro.join('\n'), 'feed de propósito sem .is("deleted_at", null) e sem `incluiApagado` no registro').toBe('');
  });

  it('G4: a dívida só desce, e toda entrada de dívida nomeia o domínio que a quita', () => {
    const divida = REGISTRO.filter((e) => e.categoria === 'divida');
    expect(divida.length, 'dívida acima do teto: a classe reabriu').toBeLessThanOrEqual(TETO_DIVIDA);
    expect(divida.filter((e) => !e.dominio).map((e) => e.arquivo)).toEqual([]);
    expect(REGISTRO.filter((e) => e.categoria !== 'divida' && e.dominio).map((e) => e.arquivo)).toEqual([]);
  });

  it('G5: nenhuma cópia da lista de status fora das autoridades (a dívida só encolhe)', () => {
    const achadas = FONTES.filter(({ arquivo }) => !AUTORIDADES.has(arquivo)).flatMap(({ arquivo, fonte }) =>
      detectarConstantesParalelas(arquivo, fonte, STATUS_NAO_VENDA),
    );
    const k = (arquivo: string, membros: string) => `${arquivo} · [${membros}]`;
    const conhecidas = new Set(CONSTANTES_DIVIDA.map((c) => k(c.arquivo, c.membros)));
    const vistas = new Set(achadas.map((c) => k(c.arquivo, c.membros.join(','))));
    expect(
      achadas.filter((c) => !conhecidas.has(k(c.arquivo, c.membros.join(',')))).map((c) => `${c.arquivo}:${c.linha} [${c.membros.join(',')}]`).join('\n'),
      'cópia da lista de status de venda: importe STATUS_NAO_VENDA de @/lib/farmer/universo-pedidos ' +
        '(edge: ./_shared/universo-pedidos.ts) em vez de copiá-la',
    ).toBe('');
    expect(
      CONSTANTES_DIVIDA.filter((c) => !vistas.has(k(c.arquivo, c.membros))).map((c) => k(c.arquivo, c.membros)),
      'constante quitada: remova-a de CONSTANTES_DIVIDA',
    ).toEqual([]);
    expect(CONSTANTES_DIVIDA.length).toBeLessThanOrEqual(TETO_CONSTANTES_DIVIDA);
  });

  it('G6: as duas autoridades seguem sendo achadas pelo detector de cópia (senão o G5 é cego)', () => {
    // Controle positivo do G5 no código REAL: a lista da autoridade tem os 4 membros e tem de casar.
    for (const arquivo of AUTORIDADES) {
      const fonte = FONTES.find((f) => f.arquivo === arquivo)?.fonte ?? '';
      expect(detectarConstantesParalelas(arquivo, fonte, STATUS_NAO_VENDA).map((c) => c.membros), arquivo).toEqual([
        [...STATUS_NAO_VENDA].sort(),
      ]);
    }
  });
});

// ── Calibração: a assinatura casa as formas REAIS da classe e não casa as certas ─────────────────
// Fixtures transcritos do código (não resumos): o pré-fix do useFarmerScoring (2025c0808~1), o
// canônico de hoje dos 3 hooks e o do edge por variável, o `.neq` da impressão, o filtro pós-limit
// da munição, o literal PostgREST que o mapas-paginados tinha.

const classeDe = (fonte: string, arquivo = 'fixture.ts'): Classe[] =>
  classificarComPar(detectarSitios(arquivo, fonte)).map((j) => j.classe);

describe('calibração do detector do universo', () => {
  it('casa o PRÉ-fix real (allowlist que escondia 10.281 pedidos) e não casa o pós-fix', () => {
    const preFix = `
      const salesOrders = await fetchAllPages<SalesOrderRow>((de, ate) =>
        supabase
          .from('sales_orders')
          .select('id, customer_user_id, items, total, created_at, order_date_kpi, status')
          .in('status', ['confirmado', 'faturado', 'entregue'])
          .order('id', { ascending: true })
          .range(de, ate) as unknown as PromiseLike<{ data: SalesOrderRow[] | null; error: unknown }>,
        'sales_orders/scoring',
      );`;
    const posFix = `
      const salesOrders = await fetchAllPages<SalesOrderRow>((de, ate) =>
        supabase
          .from('sales_orders')
          .select('id, customer_user_id, items, total, created_at, order_date_kpi, status')
          .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
          .is('deleted_at', null)
          .order('id', { ascending: true })
          .range(de, ate) as unknown as PromiseLike<{ data: SalesOrderRow[] | null; error: unknown }>,
        'sales_orders/scoring',
      );`;
    expect(classeDe(preFix)).toEqual(['fora']);
    expect(classeDe(posFix)).toEqual(['canonico']);
  });

  it('metade do contrato não basta: sem deleted_at, ou com o status canônico MAIS outro filtro de status', () => {
    expect(classeDe(`db.from('sales_orders').select('id').not('status', 'in', STATUS_NAO_VENDA_POSTGREST)`)).toEqual(['fora']);
    expect(classeDe(`db.from('sales_orders').select('id').is('deleted_at', null)`)).toEqual(['fora']);
    expect(
      classeDe(`db.from('sales_orders').select('id').not('status','in',STATUS_NAO_VENDA_POSTGREST).is('deleted_at',null).eq('status','faturado')`),
    ).toEqual(['fora']);
    // a lista literal no lugar da constante é cópia, não autoridade
    expect(classeDe(`db.from('sales_orders').select('id').not('status','in','("cancelado","rascunho","pendente","orcamento")').is('deleted_at',null)`)).toEqual(['fora']);
  });

  it('formas reais de escrever o from: cast, genérico, quebra de linha e o nome com cast', () => {
    const canon = `.select('id').not('status', 'in', STATUS_NAO_VENDA_POSTGREST).is('deleted_at', null)`;
    expect(classeDe(`(supabase.from as AnyFrom)('sales_orders')${canon}`)).toEqual(['canonico']);
    expect(classeDe(`db.from<Linha>("sales_orders")${canon}`)).toEqual(['canonico']);
    expect(classeDe(`supabase\n  .from(\n    'sales_orders'\n  )${canon}`)).toEqual(['canonico']);
    expect(classeDe(`supabase.from('sales_orders' as never)${canon}`)).toEqual(['canonico']);
    expect(classeDe(`(supabase.from as AnyFrom)('sales_orders').select('id')`)).toEqual(['fora']);
  });

  it('segue a VARIÁVEL reatribuída (o canônico do mapas-paginados) e a quebra dela', () => {
    const porVariavel = `
      async function f(db, cursor) {
        let q = db.from<LinhaComCursor>("sales_orders")
          .select("id, customer_user_id, total, order_date_kpi")
          .not("status", "in", STATUS_NAO_VENDA_POSTGREST)
          .is("deleted_at", null);
        if (cursor !== null) q = q.gt("id", cursor);
        return await q.order("id", { ascending: true }).limit(500);
      }`;
    expect(classeDe(porVariavel)).toEqual(['canonico']);
    // o par posto na variável DEPOIS também conta…
    expect(classeDe(`let q = db.from('sales_orders').select('id'); q = q.not('status','in',STATUS_NAO_VENDA_POSTGREST); q = q.is('deleted_at', null);`)).toEqual(['canonico']);
    // …mas a variável de OUTRA função não
    expect(classeDe(`function a(){ let q = db.from('sales_orders').select('id'); return q } function b(q){ return q.not('status','in',STATUS_NAO_VENDA_POSTGREST).is('deleted_at',null) }`)).toEqual(['fora']);
  });

  it('o filtro DEPOIS da query (o padrão da munição e do team-kpis) não conta como universo', () => {
    const munição = `
      const { data: pedidos, error } = await supabase
        .from('sales_orders')
        .select('order_date_kpi, created_at, total, status')
        .eq('customer_user_id', customerUserId!)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(16);
      const validos = (pedidos ?? []).filter((p) => !STATUS_INVALIDOS.has(p.status as string)).slice(0, 8);`;
    expect(classeDe(munição)).toEqual(['fora']);
  });

  it('as formas de status paralelo que existiam: neq, in literal, eq', () => {
    expect(classeDe(`supabase.from('sales_orders').select('*').neq('status', 'cancelado').is('deleted_at', null)`)).toEqual(['fora']);
    expect(classeDe(`supabase.from('sales_orders').select('id').neq('status', 'orcamento')`)).toEqual(['fora']);
    expect(classeDe(`supabase.from('sales_orders').select('id').in('status', ['cancelado', 'orcamento'])`)).toEqual(['fora']);
  });

  it('embed: o pai embedado precisa do par com o prefixo sales_orders.', () => {
    expect(classeDe(`db.from('order_items').select('id, sales_orders!inner(account, order_date_kpi)').eq('sales_orders.account', a)`)).toEqual(['fora']);
    expect(
      classeDe(`db.from('order_items').select('id, sales_orders!inner(status)').not('sales_orders.status','in',STATUS_NAO_VENDA_POSTGREST).is('sales_orders.deleted_at', null)`),
    ).toEqual(['canonico']);
  });

  it('complemento: as DUAS metades no arquivo passam; uma só é fora', () => {
    const status = `fetchAll((f, t) => supabase.from('sales_orders').select('id').in('status', [...STATUS_NAO_VENDA]).order('id').range(f, t));`;
    const apagados = `fetchAll((f, t) => supabase.from('sales_orders').select('id').not('deleted_at', 'is', null).order('id').range(f, t));`;
    expect(classeDe(status + apagados)).toEqual(['complemento', 'complemento']);
    expect(classeDe(apagados)).toEqual(['fora']);
    expect(classeDe(status)).toEqual(['fora']);
    // lista literal no complemento é cópia
    expect(classeDe(apagados + `supabase.from('sales_orders').select('id').in('status', ['cancelado','orcamento'])`)).toEqual(['fora', 'fora']);
  });

  it('escrita é escrita (o universo é pergunta de leitura) e comentário/string não são sítio', () => {
    expect(classeDe(`supabase.from('sales_orders').update({ status: 'cancelado' }).eq('id', id)`)).toEqual(['escrita']);
    expect(classeDe(`// supabase.from('sales_orders').select('*')\nconst x = "db.from('sales_orders').select('*')";`)).toEqual([]);
  });

  it('constante paralela: as formas reais casam, vocabulário de outro domínio não', () => {
    const c = (fonte: string) => detectarConstantesParalelas('f.ts', fonte, STATUS_NAO_VENDA).map((x) => x.membros);
    expect(c(`const ORDER_STATUS_INVALIDOS: string[] = ['cancelado', 'rascunho'];`)).toEqual([['cancelado', 'rascunho']]);
    expect(c(`const STATUS_INVALIDOS = new Set(['rascunho', 'orcamento', 'cancelado', 'cancelado_humano']);`)).toEqual([['cancelado', 'orcamento', 'rascunho']]);
    expect(c(`.not("status", "in", "(cancelado,rascunho,pendente)")`)).toEqual([['cancelado', 'pendente', 'rascunho']]);
    expect(c(`const X = ['CANCELADO', 'Orçamento'];`)).toEqual([['cancelado', 'orcamento']]);
    // um membro só é vocabulário de muitos domínios — o limite declarado no detector
    expect(c(`const STATUS_TITULO_NAO_FATURAVEL = ['CANCELADO'];`)).toEqual([]);
    expect(c(`const FINAL = ['cancelado', 'entregue', 'faturado'];`)).toEqual([]);
    expect(c(`const R = ['cancelado', 'cancelado_humano', 'expirado_sem_aprovacao'];`)).toEqual([]);
  });
});
