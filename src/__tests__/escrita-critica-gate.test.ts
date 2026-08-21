import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Gate estrutural da classe "escrita Supabase que falha CALADA".
//
// A classe: o supabase-js NÃO lança em erro de banco — resolve normalmente com `error`
// preenchido. Logo `await supabase.from(t).insert(...)` que ignora o retorno devolve
// sucesso ao caller sem ter gravado nada, e nenhuma camada acima consegue distinguir
// "gravou" de "não gravou". É o espelho, no eixo da ESCRITA, do furo de contrato que a
// classe da paginação fechou na LEITURA (money-path §6/§9): lá a falha virava lista
// vazia, aqui vira um HTTP 200 mentiroso.
//
// Instância que originou o gate: fin-cashflow-engine/calcular() gravava o snapshot
// autoritativo de projeção de caixa (cron diário, 3 empresas × 3 cenários) sem checar
// nenhuma das 4 escritas. Medido em prod 2026-07-28: 8 dos 9 snapshots do dia entraram,
// faltou oben/pessimista, ninguém foi notificado — e o rastro HTTP (net._http_response,
// retenção de horas) já havia sido purgado quando fui investigar. Irmã imediata do #1594
// (gravação de bundle que falhava calada) e do #1574.
//
// Por que TEXTUAL (readFileSync, padrão paginacao-artesanal-gate/edge-parse-parity):
// a maioria dos sites vive em edges Deno que o vitest não executa e o tsc do app não
// checa — um teste que lê FONTE cobre as duas metades num contrato só, no CI `validate`.

const RAIZ = resolve(__dirname, '../..');
const DIRS = ['src', 'supabase/functions', 'scripts'];
const EXT = /\.(ts|tsx)$/;
const IGNORAR = /(\.test\.|_test\.|\.d\.ts$|__tests__|\.stories\.)/;

function listarFontes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    const st = statSync(resolve(RAIZ, rel));
    if (st.isDirectory()) {
      if (nome === 'node_modules' || nome === '.git') continue;
      listarFontes(rel, acc);
    } else if (EXT.test(nome) && !IGNORAR.test(rel)) {
      acc.push(rel);
    }
  }
  return acc;
}

// Comentários removidos ANTES de medir. Sem isso o gate mede a prosa que DESCREVE o
// defeito e reprova código íntegro: o cabeçalho de _shared/escrita-critica.ts cita
// `await supabase.from(x).insert(...)` de propósito, e foi exatamente esse falso
// positivo que apareceu ao medir (lição #1472/#1488 — assert sobre fonte roda com
// comentário removido; o fiscal não pode medir a explicação do bug).
// O stripper é COMPARTILHADO (`@/lib/gates/limpeza-fonte`) e entende string/template/regex:
// a cópia local aqui limpava bloco com regex, e um `/*` dentro de string pareava com o `*/`
// seguinte apagando o miolo do arquivo ANTES de o fiscal olhar (classe medida em 2026-08-20).

// ── E1: escrita cujo `error` não tem COMO ser lido ────────────────────────────────────
// Ancorada em statement que começa com `await`/`void`: se o error fosse capturado, a
// linha começaria com `const { error } = await …`. A delegação ao contrato
// (`await escritaCritica('alvo', supabase.from(…).insert(…))`) não casa, porque depois
// do `await` vem o nome do helper e um `(`, não `.from(`.
const E1 =
  /^[ \t]*(?:await|void)\s+[\w$]+(?:\s*\.\s*[\w$]+)*\s*\.\s*from\s*\([^;]{0,700}?\.\s*(?:insert|upsert|update|delete)\s*\(/gm;

function contarE1(fonte: string): number {
  return [...removerComentarios(fonte).matchAll(E1)].length;
}

function contarPorArquivo(): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const dir of DIRS) {
    for (const arquivo of listarFontes(dir)) {
      const n = contarE1(readFileSync(resolve(RAIZ, arquivo), 'utf8'));
      if (n > 0) mapa.set(arquivo, n);
    }
  }
  return mapa;
}

// DÍVIDA baselinada por CONTAGEM (não por caminho — achado Codex no gate irmão: baseline
// por-arquivo deixaria uma 2ª escrita cega nascer num arquivo já listado sem nada ficar
// vermelho). Crescer REPROVA (reintrodução); diminuir REPROVA pedindo a atualização da
// lista — ela só encolhe, e encolhe REGISTRADO.
//
// ⚠️ Esta lista NÃO é um atestado de que os 150 sites são inofensivos: é a fronteira
// medida em 2026-07-28, para que a classe pare de CRESCER enquanto a erradicação por
// domínio acontece. Vários são money-path (disparar-pedidos-aprovados,
// enviar-pedido-portal-sayerlack, omie-vendas-sync, omie-financeiro) e têm chip próprio.
const E1_DIVIDA: ReadonlyMap<string, number> = new Map([
  ['src/components/reposicao/cadeiaLogistica/useCadeiaLogistica.ts', 2],
  ['src/components/salesOrders/soft-delete.ts', 1],
  ['src/components/salesOrders/useSalesOrders.ts', 1],
  ['src/contexts/AuthContext.tsx', 2],
  // useBundleArguments.ts QUITADO: o `.update()` que persistia o argumento gerado pela LLM
  // passou a capturar `{ data, error }`. Era o sítio que a migration 20260814223445 tornou
  // perigoso — desde que o recálculo APOSENTA a geração anterior (`status='expirado'`), o
  // `.eq('id', …)` cru gravava numa linha que nenhum leitor mostra, e o `await` solto
  // reportava sucesso. Guard em bundle-argumento-gravacao-calada.test.tsx.
  ['src/hooks/useCopilotEngine.ts', 4],
  // useCrossSellEngine.ts QUITADO no FU4-F fase 3: o `.upsert` das recomendações passou a
  // capturar `{ error }`. Era o sítio que a coluna nova `affinity_score` tornaria perigoso —
  // publicar o front antes da migration 20260725121000 devolve 42703/PGRST204, e o `await` solto
  // reportava sucesso sem ter gravado nada, com a lista calculada na tela.
  ['src/hooks/useCustomerContacts.ts', 1],
  ['src/hooks/useCustomerProcess.ts', 1],
  ['src/hooks/useDepartmentsAdmin.ts', 1],
  ['src/hooks/useDiagnosticQuestions.ts', 1],
  ['src/hooks/useFarmerExperiments.ts', 4],
  ['src/hooks/useFarmerGovernance.ts', 6],
  ['src/hooks/useFarmerMetrics.ts', 1],
  ['src/hooks/useFarmerPerformance.ts', 1],
  ['src/hooks/useGamificationScore.ts', 1],
  ['src/hooks/useLastVisit.ts', 1],
  ['src/lib/reposicao.ts', 1],
  ['src/pages/Addresses.tsx', 2],
  ['src/pages/AdminApprovals.tsx', 1],
  ['src/pages/Auth.tsx', 3],
  ['src/pages/FinanceiroConciliacao.tsx', 1],
  ['src/pages/GovernanceMathParams.tsx', 3],
  ['src/pages/GovernancePermissions.tsx', 1],
  ['src/pages/GovernanceUsers.tsx', 1],
  ['src/pages/ProductionOrders.tsx', 1],
  ['src/pages/RecebimentoConferencia.tsx', 1],
  ['src/services/financeiroV2Service.ts', 2],
  ['supabase/functions/biometric-auth/index.ts', 3],
  ['supabase/functions/conciliar-pedido-portal/index.ts', 1],
  ['supabase/functions/disparar-pedidos-aprovados/index.ts', 8],
  ['supabase/functions/enviar-pedido-portal-sayerlack/index.ts', 10],
  ['supabase/functions/extrair-sinais-ligacao/index.ts', 1],
  ['supabase/functions/fin-ic-reconcile/index.ts', 1],
  ['supabase/functions/gerar-pedidos-diario/index.ts', 2],
  ['supabase/functions/gmail-webhook-receiver/index.ts', 5],
  ['supabase/functions/kb-extract-specs/index.ts', 2],
  ['supabase/functions/kb-ingest-document/index.ts', 1],
  ['supabase/functions/melhoria-triagem/index.ts', 1],
  ['supabase/functions/nvoip-calls/index.ts', 2],
  ['supabase/functions/omie-analytics-sync/index.ts', 3],
  ['supabase/functions/omie-aplicar-parametros/index.ts', 2],
  ['supabase/functions/omie-financeiro/index.ts', 1],
  ['supabase/functions/omie-malha-sync/index.ts', 2],
  ['supabase/functions/omie-nfe-recebimento/index.ts', 4],
  ['supabase/functions/omie-nfe-reconcile/index.ts', 1],
  ['supabase/functions/omie-sync-metadados/index.ts', 1],
  ['supabase/functions/omie-sync-status-produtos/index.ts', 4],
  ['supabase/functions/omie-sync/index.ts', 14],
  ['supabase/functions/omie-vendas-sync/index.ts', 4],
  ['supabase/functions/omie-webhook/index.ts', 2],
  ['supabase/functions/pedido-programado-enviar/index.ts', 2],
  ['supabase/functions/pedido-programado-extrair/index.ts', 1],
  ['supabase/functions/process-recurring-orders/index.ts', 1],
  ['supabase/functions/radar-ingest/index.ts', 1],
  ['supabase/functions/rag-reindex/index.ts', 3],
  ['supabase/functions/recommend/index.ts', 2],
  ['supabase/functions/sayerlack-captura-precos/index.ts', 1],
  ['supabase/functions/scoring-recalc-client/index.ts', 1],
  ['supabase/functions/sync-reprocess/index.ts', 1],
  ['supabase/functions/tint-sync-agent/index.ts', 6],
  ['supabase/functions/verify-employee/index.ts', 2],
  ['supabase/functions/visit-score-recalc-client/index.ts', 1],
  ['supabase/functions/whatsapp-inbound/index.ts', 4],
  ['supabase/functions/whatsapp-send-template/index.ts', 2],
]);

function desvios(medido: Map<string, number>, baseline: ReadonlyMap<string, number>) {
  const reintroducoes: string[] = [];
  const quitacoes: string[] = [];
  for (const [arquivo, n] of medido) {
    const base = baseline.get(arquivo) ?? 0;
    if (n > base) reintroducoes.push(`${arquivo} (${base}→${n})`);
    else if (n < base) quitacoes.push(`${arquivo} (${base}→${n})`);
  }
  for (const [arquivo, base] of baseline) {
    if (!medido.has(arquivo)) quitacoes.push(`${arquivo} (${base}→0)`);
  }
  return { reintroducoes, quitacoes };
}

const ALVO = 'supabase/functions/fin-cashflow-engine/index.ts';

describe('gate estrutural: escrita Supabase que falha calada (classe #1574/#1594 → fin-cashflow)', () => {
  // Ausência de sinal NÃO é aprovação: se o walker parar de achar arquivos (glob quebrado,
  // DIRS renomeado), tudo fica verde para sempre. Este é o denominador do gate.
  it('sentinela: o walker anda de verdade', () => {
    const fontes = DIRS.flatMap((d) => listarFontes(d));
    expect(fontes.length).toBeGreaterThan(500);
    expect(fontes).toContain(ALVO);
  });

  it('E1: nenhuma escrita com `error` inalcançável além da dívida baselinada', () => {
    const { reintroducoes, quitacoes } = desvios(contarPorArquivo(), E1_DIVIDA);
    expect(
      reintroducoes,
      'escrita nova que descarta o error do supabase-js — use escritaCritica() ' +
        '(supabase/functions/_shared/escrita-critica.ts) ou capture `error` e trate',
    ).toEqual([]);
    expect(
      quitacoes,
      'dívida quitada: ATUALIZE E1_DIVIDA (a lista só encolhe, e encolhe registrada)',
    ).toEqual([]);
  });

  // Calibração: um detector precisa provar que enxerga a forma que ele deve barrar E que
  // NÃO barra a forma corrigida — senão "não achou nada" e "está quebrado" são o mesmo
  // output (lição do detector que comparava catálogo com string literal, #1488).
  it('E1 (controle de calibração): casa a forma pré-fix e não casa a delegação ao contrato', () => {
    const preFix = `
      await supabase.from('fin_alertas').update({
        severidade: a.severidade,
      }).eq('id', existente.id);
    `;
    const preFixMultilinha = `
      await supabase
        .from('fin_projecao_snapshots')
        .insert({ company, cenario });
    `;
    const posFix = `
      await escritaCritica(
        'fin_alertas.update',
        supabase.from('fin_alertas').update({ severidade: a.severidade }).eq('id', id),
      );
    `;
    const comCaptura = `
      const { error } = await supabase.from('fin_alertas').insert({ company });
      if (error) throw error;
    `;
    expect(contarE1(preFix), 'a forma-mãe da classe tem de ser detectada').toBe(1);
    expect(contarE1(preFixMultilinha), 'quebra de linha não pode escapar do gate').toBe(1);
    expect(contarE1(posFix), 'delegar ao contrato não pode acusar').toBe(0);
    expect(contarE1(comCaptura), 'capturar o error não pode acusar').toBe(0);
  });

  it('E2: o alvo que originou a classe não volta a escrever fora do contrato', () => {
    const fonte = readFileSync(resolve(RAIZ, ALVO), 'utf8');
    expect(contarE1(fonte), `${ALVO} voltou a escrever sem checar error`).toBe(0);
    // As 4 escritas continuam existindo — o gate acima ficaria verde se alguém apagasse
    // a persistência inteira, e "não escreve nada" não é o contrato que queremos pinar.
    const semCom = removerComentarios(fonte);
    expect(
      [...semCom.matchAll(/escritaCritica\(/g)].length,
      'as 4 escritas de calcular() passam pelo contrato',
    ).toBe(4);
  });

  it('E3: o snapshot autoritativo grava ANTES dos alertas (ordem é a defesa do residual)', () => {
    const fonte = removerComentarios(readFileSync(resolve(RAIZ, ALVO), 'utf8'));
    const posSnapshot = fonte.indexOf("'fin_projecao_snapshots.insert'");
    const posAlerta = fonte.search(/'fin_alertas\.(update|insert)'/);
    expect(posSnapshot, 'o insert do snapshot precisa passar pelo contrato').toBeGreaterThan(-1);
    expect(posAlerta, 'as escritas de alerta precisam passar pelo contrato').toBeGreaterThan(-1);
    expect(
      posSnapshot,
      'snapshot tem de gravar ANTES dos alertas: invertido, uma falha deixa alerta ' +
        'dismissado com snapshot ausente, e o consumidor latest-wins serve o de ontem',
    ).toBeLessThan(posAlerta);
  });

  it('E4: o contrato LANÇA — nunca engole nem devolve booleano', () => {
    const helper = removerComentarios(
      readFileSync(resolve(RAIZ, 'supabase/functions/_shared/escrita-critica.ts'), 'utf8'),
    );
    expect(helper).toMatch(/throw new EscritaCriticaError\(/);
    // Um `return` no ramo de erro devolveria o guard-que-mente do money-path §8: o caller
    // recebe sucesso e a escrita não aconteceu.
    expect(helper).not.toMatch(/if\s*\(\s*error\s*\)\s*return/);
  });
});
