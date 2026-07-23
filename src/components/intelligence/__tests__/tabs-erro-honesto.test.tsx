import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard money-path — falha de carga NÃO pode virar KPI zerado.
 *
 * O helper `fetchAllPages` passou a LANÇAR quando uma página falha (antes devolvia o prefixo
 * parcial em silêncio). Isso conserta a mentira do NÚMERO, mas não a da TELA: com a query em
 * erro, `allScores` fica `undefined` e os KPIs caem nos `|| 0` espalhados pelos dois tabs.
 * "Total Clientes: 0", "LTV Projetado: R$ 0", "Concentração Top 20%: 0.0%" — cada um é uma
 * afirmação sobre o negócio produzida por uma falha de transporte nossa.
 *
 * Pior no StrategicTab, onde o `isLoading` do skeleton vem de `marginAudit` — OUTRA query. A de
 * scores podia falhar com a tela inteira renderizada como se estivesse tudo certo.
 *
 * O contrato desta suíte: sob falha, a tela diz que não sabe. Nunca zero, nunca skeleton eterno.
 */

type Resposta = { data: unknown; error: unknown };
let falharScores = false;
let scoresRevenueAusente = false;
/** Scores em VOO (a promessa nunca resolve) — o estado que o gate do skeleton ignorava. */
let scoresPendentes = false;
let scoresGerencial = false;
let falharAudit = false;
let falharReco = false;
let recoComDesfecho = false;

/** Métodos do query-builder por chamada — discrimina `.limit(500)` solto de paginação ordenada. */
type Chamada = { table: string; metodos: string[] };
let chamadas: Chamada[] = [];

const ERRO_PG = { message: 'canceling statement due to statement timeout', code: '57014' };

// Leitura OK, mas revenue_potential ausente (a coluna órfã real de prod: sem produtor server-side).
// A Concentração não tem potencial pra concentrar → "—" (potencial não medido), nunca 0,0%.
const SCORES_SEM_REVENUE = [
  { customer_user_id: 'c1', gross_margin_pct: null, avg_monthly_spend_180d: 1000, avg_repurchase_interval: 5, revenue_potential: null },
  { customer_user_id: 'c2', gross_margin_pct: null, avg_monthly_spend_180d: 2000, avg_repurchase_interval: 8, revenue_potential: null },
];

// Dois clientes do MESMO vendedor: a tabela do gerencial precisa de ao menos uma linha para
// que a coluna "Adoção Reco" exista e possa ser inspecionada.
const SCORES_GERENCIAL = [
  { customer_user_id: 'c1', farmer_id: 'f1', health_score: 70, health_class: 'estavel', gross_margin_pct: null, category_count: 3, sales_history_status: 'ok' },
  { customer_user_id: 'c2', farmer_id: 'f1', health_score: 40, health_class: 'critico', gross_margin_pct: null, category_count: 1, sales_history_status: 'ok' },
];

// `aceito` é o único rótulo de aceitação que a tabela permite — o CHECK de
// `farmer_recommendations.status` é ('pendente','ofertado','aceito','rejeitado','expirado').
const RECO_COM_DESFECHO = [
  { farmer_id: 'f1', status: 'aceito' },
  { farmer_id: 'f1', status: 'pendente' },
];

function resposta(table: string): Resposta {
  if (table === 'farmer_client_scores') {
    if (falharScores) return { data: null, error: ERRO_PG };
    if (scoresRevenueAusente) return { data: SCORES_SEM_REVENUE, error: null };
    if (scoresGerencial) return { data: SCORES_GERENCIAL, error: null };
    return { data: [], error: null };
  }
  if (table === 'margin_audit_log' && falharAudit) return { data: null, error: ERRO_PG };
  if (table === 'farmer_recommendations') {
    if (falharReco) return { data: null, error: ERRO_PG };
    if (recoComDesfecho) return { data: RECO_COM_DESFECHO, error: null };
  }
  return { data: [], error: null };
}

function chain(table: string): unknown {
  const registro: Chamada = { table, metodos: [] };
  chamadas.push(registro);
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'neq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order',
    'limit', 'range', 'or', 'filter', 'contains', 'single', 'maybeSingle',
  ]) c[m] = () => { registro.metodos.push(m); return c; };
  c.then = (resolve: (v: unknown) => void) => {
    // Promessa PENDENTE: nem resolve nem rejeita. É o estado "ainda em voo", distinto de
    // erro — e o que o gate do skeleton do StrategicTab não enxergava.
    if (table === 'farmer_client_scores' && scoresPendentes) return undefined;
    return resolve(resposta(table));
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { IntelligenceManagerialTab } from '../IntelligenceManagerialTab';
import { IntelligenceStrategicTab } from '../IntelligenceStrategicTab';

// `retry: false` — o retry limitado é config global (App.tsx: retry 2 + backoff); aqui só
// interessa o ESTADO FINAL de erro, não a política de tentativa.
const renderWithClient = (ui: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { qc, ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>) };
};

/** Texto do card do KPI (o título e o valor são irmãos dentro do mesmo bloco). */
const cardDo = (titulo: string): string => {
  const el = screen.getByText(titulo);
  return el.closest('div')?.parentElement?.textContent ?? '';
};

/**
 * Skeletons na tela. A classe é `animate-shimmer` (o `<Skeleton>` do projeto usa shimmer
 * gradient, não o pulse genérico do shadcn) — o assert original media `animate-pulse`, que
 * NUNCA existe: passava sempre, inclusive sob skeleton eterno. Um detector que não enxerga o
 * objeto vivo não distingue "não tem" de "está quebrado", então há um teste-DETECTOR abaixo
 * provando que este seletor casa um skeleton de verdade.
 */
const skeletons = (c: HTMLElement) => c.querySelectorAll('[class*="animate-shimmer"]');

beforeEach(() => {
  falharScores = true;
  scoresRevenueAusente = false;
  scoresPendentes = false;
  scoresGerencial = false;
  falharAudit = false;
  falharReco = false;
  recoComDesfecho = false;
  chamadas = [];
  vi.clearAllMocks();
});

describe('IntelligenceManagerialTab — falha de carga não vira "0 clientes"', () => {
  it('anuncia indisponibilidade em vez de renderizar os KPIs zerados', async () => {
    renderWithClient(<IntelligenceManagerialTab />);

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/indispon/i);
  });

  it('NÃO exibe "0" como total de clientes sob falha', async () => {
    renderWithClient(<IntelligenceManagerialTab />);
    await screen.findByRole('alert');

    // O KPI "Total Clientes" com `|| 0` afirmaria que a base tem zero cliente.
    const total = screen.queryByText('Total Clientes');
    if (total) {
      const card = total.closest('div')?.parentElement;
      expect(card?.textContent).not.toMatch(/\b0\b/);
    }
  });

  it('não fica em skeleton eterno (o erro resolve o carregamento)', async () => {
    const { container } = renderWithClient(<IntelligenceManagerialTab />);
    await screen.findByRole('alert');

    await waitFor(() => {
      expect(skeletons(container).length).toBe(0);
    });
  });

  it('DETECTOR: o seletor de skeleton casa um skeleton vivo', async () => {
    // Sem este par, o assert acima ("0 skeletons") passa mesmo com a tela travada em
    // carregamento — foi o que aconteceu enquanto ele media `animate-pulse`, classe que o
    // `<Skeleton>` deste projeto não usa.
    scoresPendentes = true;

    const { container } = renderWithClient(<IntelligenceManagerialTab />);

    await waitFor(() => { expect(skeletons(container).length).toBeGreaterThan(0); });
  });
});

describe('IntelligenceStrategicTab — falha de carga não vira LTV/CAC/Concentração zerados', () => {
  it('anuncia indisponibilidade dos KPIs derivados da base de scores', async () => {
    renderWithClient(<IntelligenceStrategicTab />);

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/indispon/i);
  });

  it('LTV, CAC e Concentração mostram "—", não R$ 0 / 0.0%', async () => {
    renderWithClient(<IntelligenceStrategicTab />);
    await screen.findByRole('alert');

    // Estes três derivam SÓ de `allScores`. Com a query em erro, o valor honesto é "—".
    for (const titulo of ['LTV Projetado (3a)', 'CAC Estimado', 'Concentração Top 20%']) {
      const el = screen.queryByText(titulo);
      expect(el, `KPI "${titulo}" sumiu da tela`).toBeTruthy();
      const card = el!.closest('div')?.parentElement;
      expect(card?.textContent, `KPI "${titulo}" exibiu zero fabricado`).toMatch(/—/);
    }
  });
});

/**
 * Guard money-path — coluna ÓRFÃ (leitura OK, dado inexistente) ≠ erro de transporte.
 *
 * revenue_potential não tem produtor server-side: em prod é 0/null para toda a base. A leitura
 * SUCEDE (nenhum alerta de indisponibilidade), mas o KPI de Concentração calcularia 0/0. Exibir
 * "0,0%" afirmaria "carteira nada concentrada" — um número fabricado de um dado que não existe.
 * Contrato: nesse caso o KPI diz "—" com o motivo "potencial não medido" (distinto de "base
 * indisponível", que é o caso de erro acima).
 */
describe('IntelligenceStrategicTab — Concentração sob revenue_potential órfão', () => {
  beforeEach(() => { falharScores = false; scoresRevenueAusente = true; });

  it('mostra "—" (potencial não medido), não 0,0%, quando a leitura foi OK mas o potencial é ausente', async () => {
    renderWithClient(<IntelligenceStrategicTab />);

    const el = await screen.findByText('Concentração Top 20%');
    const card = el.closest('div')?.parentElement;
    // "—" com o motivo do órfão — e SEM alerta de "indisponível" (a base foi lida com sucesso).
    expect(card?.textContent, 'Concentração exibiu 0,0% fabricado').toMatch(/—/);
    expect(card?.textContent, 'faltou o motivo "potencial não medido"').toMatch(/não medido/);
    expect(screen.queryByRole('alert'), 'não devia anunciar indisponibilidade: a leitura sucedeu').toBeNull();
  });
});

/**
 * Guard money-path — o gate do skeleton pertencia à query ERRADA (residual do #1550).
 *
 * O #1550 cobriu o estado de ERRO dos scores. Sobrou a JANELA anterior a ele: `isLoading` vinha
 * de `margin_audit_log`, então bastava a auditoria resolver — os scores ainda em voo — para a
 * tela renderizar INTEIRA, com LTV/CAC/Market Share em zero. É a mesma fabricação do caso de
 * erro, num estado que nem erro é: "ainda não chegou" apresentado como "medi e deu zero".
 *
 * E "—" não serve aqui: "—" é o estado FINAL de indisponibilidade. Carregar não é indisponível,
 * então o honesto é continuar carregando — o skeleton tem de esperar TODA fonte que a tela
 * apresenta como número.
 */
describe('IntelligenceStrategicTab — base de scores em voo não vira KPI zerado', () => {
  beforeEach(() => { falharScores = false; scoresPendentes = true; });

  it('não renderiza os KPIs de carteira antes da base chegar', async () => {
    const { qc, container } = renderWithClient(<IntelligenceStrategicTab />);

    // Ponto de decisão: a auditoria RESOLVE (os scores não). É exatamente aqui que o
    // `isLoading` da query errada virava false e a tela renderizava com os zeros.
    await waitFor(() => {
      expect(qc.getQueryState(['intel-margin-audit'])?.status, 'a auditoria nem resolveu').toBe('success');
    });

    expect(screen.queryByText('LTV Projetado (3a)'), 'KPI de carteira renderizou sem a base').toBeNull();
    expect(screen.queryByText('Market Share Est.'), 'KPI de carteira renderizou sem a base').toBeNull();
    expect(
      skeletons(container).length,
      'sem skeleton e sem KPI: a tela não está dizendo nada',
    ).toBeGreaterThan(0);
  });

  it('DETECTOR: com a base resolvida os KPIs de carteira aparecem', async () => {
    // Prova que o seletor do assert acima ENXERGA o objeto vivo — sem isto, "não renderizou o
    // KPI" e "o seletor está quebrado" seriam indistinguíveis.
    scoresPendentes = false;

    renderWithClient(<IntelligenceStrategicTab />);

    expect(await screen.findByText('LTV Projetado (3a)')).toBeTruthy();
    expect(await screen.findByText('Market Share Est.')).toBeTruthy();
  });
});

/**
 * Guard money-path — a falha da auditoria de margem virava `[]` EXPLICITAMENTE.
 *
 * A queryFn fazia `if (error) { console.error(error); return []; }` — falha convertida em "não
 * há registro". Os quatro KPIs monetários do bloco do Algoritmo A somam sobre esse array, então
 * uma leitura que falhou era apresentada como "Margem Real R$ 0 · Gap R$ 0 · 0/0 clientes com
 * custo". Zero de vazamento de preço é a leitura mais tranquilizadora possível — e era fabricada.
 *
 * Mesmo tratamento que o #1550 deu aos scores: falha → último dado bom + aviso de stale; sem
 * cache → "—" com o motivo.
 */
describe('IntelligenceStrategicTab — falha da auditoria de margem não vira R$ 0', () => {
  beforeEach(() => { falharScores = false; falharAudit = true; });

  it('anuncia a indisponibilidade da auditoria', async () => {
    renderWithClient(<IntelligenceStrategicTab />);

    const avisos = await screen.findAllByRole('alert');
    expect(
      avisos.some((a) => /auditoria/i.test(a.textContent ?? '')),
      'nenhum alerta menciona a auditoria de margem',
    ).toBe(true);
  });

  it('Margem Real, Potencial, Gap e Margem Global mostram "—", não R$ 0', async () => {
    renderWithClient(<IntelligenceStrategicTab />);
    await screen.findAllByRole('alert');

    for (const titulo of ['Margem Real', 'Margem Potencial', 'Gap de Margem', 'Margem Global']) {
      const texto = cardDo(titulo);
      expect(texto, `KPI "${titulo}" exibiu R$ 0 fabricado`).not.toMatch(/R\$\s*0\b/);
      expect(texto, `KPI "${titulo}" devia mostrar "—"`).toMatch(/—/);
    }
  });

  it('o contador de Registros não afirma "0" sob falha', async () => {
    renderWithClient(<IntelligenceStrategicTab />);
    await screen.findAllByRole('alert');

    // "Registros: 0" afirma que a auditoria rodou e não achou nada.
    expect(cardDo('Registros'), 'Registros exibiu 0 fabricado').toMatch(/—/);
  });

  it('DETECTOR: com a auditoria lida os KPIs monetários aparecem sem alerta', async () => {
    falharAudit = false;

    renderWithClient(<IntelligenceStrategicTab />);

    await screen.findByText('Margem Real');
    expect(
      screen.queryAllByRole('alert').some((a) => /auditoria/i.test(a.textContent ?? '')),
      'alertou auditoria indisponível com a leitura OK',
    ).toBe(false);
  });
});

/**
 * Guard money-path — adoção de recomendações: falha virava 0%, e o recorte era não-determinístico.
 *
 * Dois defeitos na mesma query:
 *  (a) a falha caía em `recommendations === undefined` → `adoptionPct = 0` → a coluna "Adoção
 *      Reco" afirmava que o vendedor não seguiu NENHUMA recomendação. Num comparativo ENTRE
 *      vendedores, isso é uma acusação fabricada por uma falha de transporte nossa.
 *  (b) `.limit(500)` SEM `.order()` sobre 3.659 linhas: o Postgres não garante ordem sem ORDER
 *      BY, então a fatia de 13,7% mudava entre carregamentos — dois pedidos idênticos podiam
 *      render taxas diferentes, sem nada na tela indicando que o denominador era amostral.
 */
describe('IntelligenceManagerialTab — adoção de recomendações honesta', () => {
  beforeEach(() => { falharScores = false; scoresGerencial = true; });

  it('lê farmer_recommendations paginado e com ordem estável, sem recorte de 500', async () => {
    renderWithClient(<IntelligenceManagerialTab />);
    await screen.findByText('Comparativo por Vendedor');

    const reco = chamadas.filter((c) => c.table === 'farmer_recommendations');
    expect(reco.length, 'a query de recomendações nem foi disparada').toBeGreaterThan(0);
    for (const c of reco) {
      expect(c.metodos, 'sem .order() a paginação repete e pula linha entre páginas').toContain('order');
      expect(c.metodos, 'sem .range() a leitura para na capa de 1.000 do PostgREST').toContain('range');
      expect(c.metodos, '.limit() recorta a base — eram 500 de 3.659 linhas').not.toContain('limit');
    }
  });

  it('a coluna "Adoção Reco" mostra "—", não 0%, quando a leitura falha', async () => {
    falharReco = true;

    renderWithClient(<IntelligenceManagerialTab />);
    await screen.findByText('Comparativo por Vendedor');

    const linha = screen.getByText(/^f1/).closest('tr');
    expect(linha, 'a linha do vendedor sumiu da tabela').toBeTruthy();
    expect(linha!.textContent, 'adoção exibiu 0% fabricado sob falha de leitura').not.toMatch(/0%/);
    expect(linha!.textContent, 'adoção devia mostrar "—"').toMatch(/—/);
  });

  it('anuncia a indisponibilidade da adoção', async () => {
    falharReco = true;

    renderWithClient(<IntelligenceManagerialTab />);

    const avisos = await screen.findAllByRole('alert');
    expect(
      avisos.some((a) => /ado(ç|c)(ã|a)o/i.test(a.textContent ?? '')),
      'nenhum alerta menciona a adoção de recomendações',
    ).toBe(true);
  });

  it('sem NENHUMA recomendação o vendedor mostra "—", não 0% (0/0 não é taxa)', async () => {
    // Leitura OK e vazia: não há o que adotar. "0%" afirmaria "ignorou tudo que sugerimos".
    renderWithClient(<IntelligenceManagerialTab />);
    await screen.findByText('Comparativo por Vendedor');

    const linha = screen.getByText(/^f1/).closest('tr');
    expect(linha!.textContent, 'denominador zero virou taxa 0%').not.toMatch(/0%/);
    expect(linha!.textContent, 'adoção devia mostrar "—"').toMatch(/—/);
  });

  it('conta o desfecho "aceito" — o único rótulo que o CHECK da tabela permite', async () => {
    // O código comparava `status === 'aceita'`, valor que o CHECK de farmer_recommendations
    // REJEITA ('pendente','ofertado','aceito','rejeitado','expirado'). O predicado nunca casava:
    // a taxa era estruturalmente 0%, medisse o que medisse. Hoje as 3.659 linhas de prod são
    // 100% `pendente` (nenhum writer registra desfecho), então a defesa é do FUTURO — mas é o
    // dia em que o loop de feedback existir que a coluna passaria a mentir em silêncio.
    recoComDesfecho = true;

    renderWithClient(<IntelligenceManagerialTab />);
    await screen.findByText('Comparativo por Vendedor');

    const linha = screen.getByText(/^f1/).closest('tr');
    expect(linha!.textContent, '1 aceito de 2 recomendações = 50%').toMatch(/50%/);
  });
});
