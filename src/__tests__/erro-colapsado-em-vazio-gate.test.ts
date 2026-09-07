import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { acharColapsos, contarAutoOcultacao, contarRetornoAfirmativo } from '@/lib/gates/erro-colapsado-em-vazio';

// GATE — "erro colapsado em vazio": a leitura que falha e vira silêncio afirmativo.
//
// A CLASSE (docs/historico/fase-sem-sinal.md; #1859 e a revisão retroativa de 2026-08-22):
// um hook react-query que LANÇA no erro deixa `data === undefined`, que é a MESMA condição
// de "vazio" e de "nunca carregou". Um componente que faz `if (!data) return null` sem ler
// `error` colapsa esses estados numa tela em branco só — e quando a tela é um ALERTA ou um
// painel de SAÚDE, a ausência AFIRMA segurança: "não consegui ler" chega como "está tudo bem".
//
// SÃO DUAS FORMAS FISCALIZADAS, com baselines SEPARADAS:
//   1. auto-ocultação TOTAL (`return null`/ternário guardado pela leitura) — apaga o
//      componente sem deixar rastro. Gateada em 2026-08-22.
//   2. `return-afirmativo` (`return <JSX com texto>` sob a mesma guarda) — em vez de sumir,
//      MENTE com especificidade. Gateada em 2026-09-06
//      (docs/historico/o-check-verde-que-a-falha-acende.md).
//
// A forma `jsx-&&` fica de fora de propósito, e o argumento é ARITMÉTICO: 93 sítios, idioma
// legítimo na maioria, 21 deles INERTES (o hook engole o erro) — a baseline cresceria por
// motivo benigno, que é como um gate morre. A forma 2 são 13 sítios e 13/13 alcançáveis.
// O porquê completo está no cabeçalho de `@/lib/gates/erro-colapsado-em-vazio`.
//
// Por que AST e não texto: a pergunta "o componente trata o erro?" respondida por grep de
// `error` dá FALSO NEGATIVO justamente nos piores casos — `text-status-error` do Tailwind
// casa e o arquivo passa. A pergunta certa é se a DESESTRUTURAÇÃO liga `error`, e só o
// parser responde. De brinde, comentário não é código para o parser: a prosa que DESCREVE o
// defeito (há bastante, nos arquivos corrigidos) não dispara o fiscal — o problema que o
// stripper compartilhado existe para resolver nos gates textuais aqui não existe.

const RAIZ = resolve(__dirname, '../..');
const DIRS = ['src'];
const EXT = /\.(ts|tsx)$/;
const IGNORAR = /(\.test\.|_test\.|\.d\.ts$|__tests__|\.stories\.)/;

function listarFontes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    const abs = resolve(RAIZ, rel);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (nome === 'node_modules' || nome === '.git') continue;
      listarFontes(rel, acc);
    } else if (EXT.test(nome) && !IGNORAR.test(rel)) {
      acc.push(rel);
    }
  }
  return acc;
}

// BASELINE POR CONTAGEM, não por caminho (mesma decisão do gate de paginação artesanal):
// baseline por arquivo aceitaria um 2º sítio no mesmo arquivo em silêncio. A lista só
// ENCOLHE, e encolhe registrada — diminuir também reprova, pedindo a atualização.
//
// DÍVIDA (2026-08-22): estes 44 sítios são a classe medida, não sítios aprovados. A fatia
// de maior dano saiu nesta leva (banner de saúde de dados, alertas de fluxo de caixa,
// painel de saúde da carteira) porque neles a ausência AFIRMA segurança e o dano estava
// medido em prod. O resto sai por domínio, e a ordem é por dano — não por facilidade.
//
// QUITADO nesta leva — o IRMÃO da classe: ausente degradado para VAZIO, em vez de erro
// virando silêncio. Os dois consumidores de `useMyActiveCoverage` que faziam
// `(coverage ?? [])` sem ler `error` passaram a usar `useCarteirasQueEuCubro()`, que
// devolve os ids E o estado da leitura. O gatilho não era dano em prod — `carteira_coverage`
// tem 0 linhas (psql-ro, 2026-08-22) — e sim o PRIMEIRO cadastro de cobertura, a partir do
// qual a carteira coberta sumiria calada de sugestões, scores, plano tático e copilot.
const BASELINE = new Map<string, number>([
  ["src/components/adminPrime/PrimePlanosTab.tsx", 1],
  ["src/components/customer/CustomerProfile360Summary.tsx", 1],
  ["src/components/customerDashboard/RecomendacoesCliente.tsx", 1],
  ["src/components/dashboard/ClosersMtdHero.tsx", 1],
  ["src/components/dashboard/FollowupsSugeridosCard.tsx", 1],
  ["src/components/dashboard/GestorExcecoes.tsx", 1],
  ["src/components/dashboard/MinhasVisitasResultadoCard.tsx", 1],
  ["src/components/farmer/ChamadasPendentesNudge.tsx", 1],
  ["src/components/farmer/copilot/OfertaCruaCard.tsx", 1],
  ["src/components/financeiro/cashflow/EventosOnboarding.tsx", 1],
  ["src/components/knowledge-base/RendimentoCalculator.tsx", 1],
  ["src/components/knowledge-base/VersionHistory.tsx", 1],
  ["src/components/radar/RadarKpis.tsx", 1],
  ["src/components/reposicao/aplicacao/useAplicacaoFila.ts", 2],
  ["src/components/reposicao/cadeiaLogistica/useCadeiaLogistica.ts", 1],
  ["src/components/reposicao/pedidos/useDetalhesModal.ts", 1],
  ["src/components/reposicao/slaFornecedor/useSlaFornecedor.ts", 1],
  ["src/components/skuMapeamento/useSkuMapeamento.ts", 2],
  ["src/components/tarefas/MinhasTarefasCard.tsx", 1],
  ["src/components/tarefas/RecorrentesHojeCard.tsx", 1],
  ["src/components/tintColorSelect/useTintColorSelect.ts", 1],
  ["src/components/unified-order/TierClienteBadge.tsx", 1],
  ["src/components/whatsapp/SlaCardMeuDia.tsx", 1],
  ["src/hooks/useUnifiedOrder.ts", 2],
  ["src/pages/AdminReposicaoAlertas.tsx", 1],
  // 2→1 (fatia #2 do inventário `{data && <X/>}`, 2026-09-06): a query do CICLO passou a
  // desestruturar `status`/`fetchStatus` — chave de CHAVES_DE_ERRO — para alimentar
  // `estadoDeLeitura` + <AvisoLeituraFalhou> nos alertas de pré-disparo. O sítio que sobra é o
  // da fila `atencao`, ainda cega. ⚠️ Este delta de 1 seria IDÊNTICO se eu tivesse trocado a
  // desestruturação por `const q = useQuery(…)`: aí o sítio some porque o detector perde o
  // alias de `data`, sem uma linha de silêncio corrigida (medido no caminho deste PR). O gate
  // não distingue "consertado" de "cegado" — quem encolhe a baseline precisa provar qual dos
  // dois é, e a prova é o `temErro` do sítio.
  ["src/pages/AdminReposicaoPedidos.tsx", 1],
  ["src/pages/FinanceiroMapping.tsx", 1],
  ["src/pages/GovernanceMathParams.tsx", 1],
  ["src/pages/GovernancePermissions.tsx", 1],
  ["src/pages/RotaPropostas.tsx", 1],
  ["src/pages/SalesPrintDashboard.tsx", 6],
  ["src/pages/ToolHistory.tsx", 1],
  ["src/pages/ToolReports.tsx", 1],
  ["src/pages/Training.tsx", 2],
]);

// BASELINE PRÓPRIA da 2ª forma gateada (`return-afirmativo`), medida em 2026-09-06 sobre
// 1.472 fontes: **13 sítios em 13 arquivos** — e 13/13 ALCANÇÁVEIS (todos os hooks fazem
// `if (error) throw error`). Não há a fatia inerte que faria a baseline virar ruído, que é
// o que manteve `jsx-&&` fora do gate.
//
// UNIDADE DIFERENTE DA DE CIMA, de propósito — os dois números NÃO são comparáveis, não
// some nem subtraia: `contarAutoOcultacao` conta BINDINGS de hook que colapsam
// (`Training.tsx` = 2 porque DOIS hooks distintos guardam o mesmo ternário da linha 150);
// `contarRetornoAfirmativo` conta LINHAS distintas, porque um mesmo `return` é taintado por
// N hooks do componente e contar por hook inflaria (`ToolHistory:174` é UM sítio, não dois).
//
// DÍVIDA, em ordem de dano MEDIDO em prod (o doc traz os denominadores):
//   1. `CompletudeSection` — ÚNICO urgente: 116 pendências reais viram ✓ verde de "tudo
//      completo" quando `kb_product_specs` não lê. Afirmação positiva em superfície de saúde.
//   2. os 3 de `.single()` (`kb_documents` 297, `nfe_recebimentos` 47, `promocao_campanha`
//      17): "não encontrado" cobre também "o banco caiu" → ramificar por `PGRST116`.
//   3. os 3 de ferramenta (`user_tools` = 4): o hook JÁ devolve `null` vs `undefined`; o
//      componente só precisa parar de descartar a distinção.
//   4. os 6 de fonte ZERADA hoje: corrigir ANTES da primeira linha. `ProvasParaAuditar` é o
//      mais perigoso quando encher — "Nenhuma prova aguardando auditoria" é afirmação de
//      CONTROLE, e a auditoria some no dia em que a leitura falhar.
//
// Dois eixos vizinhos foram medidos junto e vieram ZERO — medido, não presumido:
// `<EmptyState title="…"/>` (texto por ATRIBUTO, sem JsxText) = 0; ternário cujo ramo do
// colapso é afirmativo = 0 (o único candidato, `Training.tsx:150`, tem ramo `null` — é
// `ternario-null`, JÁ na baseline de cima; contá-lo aqui seria contar o mesmo sítio duas
// vezes). O critério estrito não esconde fatia nenhuma.
const BASELINE_AFIRMATIVO = new Map<string, number>([
  ["src/components/customer/CustomerCallsTab.tsx", 1],
  ["src/components/customer/CustomerVisitsTab.tsx", 1],
  ["src/components/knowledge-base/CompletudeSection.tsx", 1],
  ["src/components/tarefas/ProvasParaAuditar.tsx", 1],
  ["src/pages/AdminKnowledgeBaseDetail.tsx", 1],
  ["src/pages/AdminReposicaoPromocaoDetail.tsx", 1],
  ["src/pages/AdminStandardProcessDetail.tsx", 1],
  ["src/pages/GrupoCliente360.tsx", 1],
  ["src/pages/OrderDetail.tsx", 1],
  ["src/pages/RecebimentoConferencia.tsx", 1],
  ["src/pages/ToolHistory.tsx", 1],
  ["src/pages/ToolPublicHistory.tsx", 1],
  ["src/pages/ToolReports.tsx", 1],
]);

describe('gate: erro colapsado em vazio', () => {
  const fontes = listarFontes(DIRS[0]);

  it('o walker enxerga o repo — varredura vazia seria verde por CEGUEIRA', () => {
    expect(fontes.length, 'walker listou fontes de menos — glob/recursão quebrada').toBeGreaterThan(1000);
    expect(fontes, 'o alvo corrigido sumiu da varredura').toContain('src/components/dataHealth/DataHealthBanner.tsx');
    expect(fontes, 'a raiz de páginas sumiu da varredura').toContain('src/pages/FarmerCalls.tsx');
  });

  it('nenhum sítio NOVO de auto-ocultação, e a baseline não encolhe sem registro', () => {
    const medido = new Map<string, number>();
    for (const rel of fontes) {
      const n = contarAutoOcultacao(readFileSync(resolve(RAIZ, rel), 'utf8'), rel);
      if (n > 0) medido.set(rel, n);
    }

    const reintroducoes: string[] = [];
    for (const [arquivo, n] of medido) {
      const base = BASELINE.get(arquivo) ?? 0;
      if (n > base) reintroducoes.push(`${arquivo} (${base}→${n})`);
    }
    const quitados: string[] = [];
    for (const [arquivo, base] of BASELINE) {
      const n = medido.get(arquivo) ?? 0;
      if (n < base) quitados.push(`${arquivo} (${base}→${n})`);
    }

    expect(
      reintroducoes,
      'Hook cujo `data` é lido SEM o `error` do mesmo hook e vira `return null`: o erro ' +
      'de leitura fica indistinguível do vazio, e numa tela de alerta/saúde a ausência ' +
      'AFIRMA segurança. Use `estadoDeLeitura`/`naoConsegui` de @/lib/leitura e mostre ' +
      '<AvisoLeituraFalhou> nos estados `erro`/`sem-rede`. ' +
      `Arquivos (baseline→medido): ${reintroducoes.join(', ')}`,
    ).toEqual([]);

    expect(
      quitados,
      'Sítio da classe foi corrigido — ATUALIZE a BASELINE deste gate (a lista só ' +
      `encolhe registrada). Arquivos (baseline→medido): ${quitados.join(', ')}`,
    ).toEqual([]);
  });

  it('calibração: a assinatura casa o controle PRÉ-fix do #1859', () => {
    // Verbatim do MixGapCard antes do #1859 (git show 588aa2ad8~1) — reduzido ao miolo.
    const preFix = `
      export function MixGapCard() {
        const { data } = useMyMixGap();
        const totalComGap = data?.totalComGap ?? 0;
        useEffect(() => { if (totalComGap > 0) track('carteira.mixgap_visto', { totalComGap }); }, [totalComGap]);
        if (!data || data.totalComGap === 0) return null;
        return <Card>{data.totalComGap}</Card>;
      }`;
    expect(contarAutoOcultacao(preFix, 'MixGapCard.tsx'), 'a assinatura deixou de casar o defeito original').toBe(1);
  });

  it('calibração: a assinatura NÃO casa o controle PÓS-fix — senão é varredura teatro', () => {
    const posFix = `
      export function MixGapCard() {
        const { data, error, isLoading } = useMyMixGap();
        const semAcesso = !isLoading && !error && data == null;
        if (semAcesso) return null;
        if (error) return <Erro />;
        return <Card>{data!.totalComGap}</Card>;
      }`;
    expect(contarAutoOcultacao(posFix, 'MixGapCard.tsx'), 'falso positivo: o pós-fix lê `error` e ainda assim casou').toBe(0);
  });

  it('o gate lê CÓDIGO, não prosa — o defeito descrito em comentário não conta', () => {
    const soComentario = `
      /**
       * Isto aqui é a descrição do defeito:
       *   const { data } = useMyMixGap();
       *   if (!data) return null;
       */
      export function Card() {
        const { data, error } = useMyMixGap();
        if (error) return <Erro />;
        return <div>{data?.n}</div>;
      }`;
    expect(contarAutoOcultacao(soComentario, 'Card.tsx'), 'o fiscal casou PROSA — trocaram o AST por regex?').toBe(0);
  });

  it('a derivada não escapa: o silêncio pendurado em `const x = data?.find(...)` conta', () => {
    // Foi assim que o DataHealthBanner escapou da 1ª versão da varredura.
    const derivada = `
      export function Banner({ source }: { source: string }) {
        const { data } = useDataHealth();
        const check = data?.find(c => c.source === source);
        if (!check || check.status === 'ok') return null;
        return <div>{check.message}</div>;
      }`;
    expect(contarAutoOcultacao(derivada, 'Banner.tsx'), 'a propagação por derivada regrediu').toBe(1);
  });

  it('`...rest` pode carregar o error — não afirmar o colapso (precisão > recall)', () => {
    const comRest = `
      export function Card() {
        const { data, ...resto } = useX();
        if (!data) return null;
        return <div>{resto.isError}</div>;
      }`;
    expect(contarAutoOcultacao(comRest, 'Card.tsx')).toBe(0);
  });

  it('o card do #1859 não volta para dentro do && de uma query IRMÃ (FarmerCalls)', () => {
    // A revisão retroativa achou o defeito principal FORA do componente: `<MixGapCard />`
    // morava dentro de `{positivacao && (…)}`, e como as duas RPCs saem pelo MESMO
    // PostgREST a falha correlacionada é o caso COMUM — os três estados novos ficavam
    // inacessíveis justamente na situação que os motivou. A lição que isto gateia: um
    // teste de componente ISOLADO não prova o estado que o HOST decide.
    const fonte = readFileSync(resolve(RAIZ, 'src/pages/FarmerCalls.tsx'), 'utf8');
    const presos = acharColapsos(fonte, 'src/pages/FarmerCalls.tsx')
      .filter((s) => s.colapsos.length > 0);
    expect(
      presos.map((s) => `${s.hook}(${s.aliasData}) → ${s.colapsos.map((x) => x.forma).join(',')}`),
      'uma leitura sem `error` voltou a esconder bloco em FarmerCalls — o MixGapCard pode ' +
      'estar preso de novo no && de uma query irmã',
    ).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────
  // 2ª FORMA GATEADA: `return-afirmativo` — o colapso que MENTE em vez de sumir.
  // ─────────────────────────────────────────────────────────────────────────────────────

  it('nenhum sítio NOVO de `return` afirmativo, e a baseline não encolhe sem registro', () => {
    const medido = new Map<string, number>();
    for (const rel of fontes) {
      const n = contarRetornoAfirmativo(readFileSync(resolve(RAIZ, rel), 'utf8'), rel);
      if (n > 0) medido.set(rel, n);
    }

    const reintroducoes: string[] = [];
    for (const [arquivo, n] of medido) {
      const base = BASELINE_AFIRMATIVO.get(arquivo) ?? 0;
      if (n > base) reintroducoes.push(`${arquivo} (${base}→${n})`);
    }
    const quitados: string[] = [];
    for (const [arquivo, base] of BASELINE_AFIRMATIVO) {
      const n = medido.get(arquivo) ?? 0;
      if (n < base) quitados.push(`${arquivo} (${base}→${n})`);
    }

    expect(
      reintroducoes,
      'Hook cujo `data` é lido SEM o `error` do mesmo hook e vira `return <texto>`: a falha ' +
      'de leitura não some — ela AFIRMA. "Não encontrado"/"tudo completo" é o que o usuário ' +
      'lê quando o banco caiu. Leia o `error` do hook e ramifique: `data === null` (não ' +
      'achei ESTE id) ≠ `undefined` + erro (não consegui ler). Use `estadoDeLeitura` de ' +
      `@/lib/leitura e <AvisoLeituraFalhou>. Arquivos (baseline→medido): ${reintroducoes.join(', ')}`,
    ).toEqual([]);

    expect(
      quitados,
      'Sítio da 3ª forma foi corrigido — ATUALIZE a BASELINE_AFIRMATIVO (a lista só encolhe ' +
      `registrada). Arquivos (baseline→medido): ${quitados.join(', ')}`,
    ).toEqual([]);
  });

  it('calibração: casa o pior sítio medido — o ✓ VERDE que a falha acende', () => {
    // Verbatim reduzido de src/components/knowledge-base/CompletudeSection.tsx:24.
    // `useCompletude` faz `if (error) throw error` sobre `kb_product_specs`: quando a leitura
    // falha, `isLoading` é false, `data` é undefined, e a tela afirma saúde com semáforo
    // verde. Medido em prod (2026-09-06): 119 fichas aprovadas, 116 com campo faltando.
    const verdeNaFalha = `
      export function CompletudeSection() {
        const { data, isLoading } = useCompletude();
        if (isLoading) return <Loader2 className="animate-spin" />;
        if (!data || data.length === 0) return (
          <Card>
            <CheckCircle2 className="text-status-success" />
            Todas as fichas aprovadas estão completas nos dados importantes.
          </Card>
        );
        return <ul>{data.map(f => <li key={f.id}>{f.nome}</li>)}</ul>;
      }`;
    expect(
      contarRetornoAfirmativo(verdeNaFalha, 'CompletudeSection.tsx'),
      'a assinatura deixou de casar o pior sítio da classe',
    ).toBe(1);
  });

  it('calibração: NÃO casa o pós-fix que LÊ o erro — senão é varredura teatro', () => {
    const posFix = `
      export function CompletudeSection() {
        const { data, error, isLoading } = useCompletude();
        if (isLoading) return <Loader2 className="animate-spin" />;
        if (error) return <AvisoLeituraFalhou />;
        if (!data || data.length === 0) return <Card>Todas as fichas estão completas.</Card>;
        return <ul>{data.map(f => <li key={f.id}>{f.nome}</li>)}</ul>;
      }`;
    expect(
      contarRetornoAfirmativo(posFix, 'CompletudeSection.tsx'),
      'falso positivo: o pós-fix lê `error` e ainda assim casou',
    ).toBe(0);
  });

  it('o recorte NÃO é "todo return com texto": sem texto visível não conta', () => {
    // A guarda existe para não transformar loading/estrutura legítimos em achado. Um
    // `return <Skeleton/>` sob a mesma condição não AFIRMA nada — não há frase para mentir.
    const semTexto = `
      export function Card() {
        const { data } = useX();
        if (!data) return <PageSkeleton variant="lista" />;
        return <div>{data.n}</div>;
      }`;
    expect(
      contarRetornoAfirmativo(semTexto, 'Card.tsx'),
      'o gate passou a casar JSX sem texto — o recorte virou "todo return", que pega ' +
      'skeleton e empty state legítimo',
    ).toBe(0);
  });

  it('DEDUP por linha: um mesmo `return` taintado por 2 hooks é UM sítio, não dois', () => {
    // Foi a armadilha de contagem da medição: contar por hook inflaria `ToolHistory:174`
    // para 2. A unidade desta baseline é (arquivo, linha) — e é por isso que ela NÃO é
    // comparável com a de auto-ocultação, que conta BINDINGS.
    const doisHooks = `
      export function ToolHistory() {
        const { data: tool } = useUserToolDetail(id);
        const { data: healthMetrics } = useToolHealth(id);
        if (!tool || !healthMetrics) return (<div><p>Ferramenta não encontrada</p></div>);
        return <div>{tool.nome}</div>;
      }`;
    expect(
      contarRetornoAfirmativo(doisHooks, 'ToolHistory.tsx'),
      'a dedup por (arquivo, linha) regrediu — a baseline vai inflar por hook',
    ).toBe(1);
    expect(
      acharColapsos(doisHooks, 'ToolHistory.tsx')
        .flatMap((s) => s.colapsos.filter((c) => c.forma === 'return-afirmativo')).length,
      'o detector precisa CONTINUAR vendo o sítio por cada hook — a dedup é do CONTADOR, ' +
      'não do walker (quem investiga quer saber quais hooks tocam a guarda)',
    ).toBe(2);
  });

  it('as duas baselines são independentes — a forma nova não contamina a antiga', () => {
    const soAfirmativo = `
      export function Card() {
        const { data } = useX();
        if (!data) return <p>Nada encontrado</p>;
        return <div>{data.n}</div>;
      }`;
    expect(contarAutoOcultacao(soAfirmativo, 'Card.tsx'), 'return afirmativo vazou para a baseline de auto-ocultação').toBe(0);
    expect(contarRetornoAfirmativo(soAfirmativo, 'Card.tsx')).toBe(1);

    const soNull = `
      export function Card() {
        const { data } = useX();
        if (!data) return null;
        return <div>{data.n}</div>;
      }`;
    expect(contarAutoOcultacao(soNull, 'Card.tsx')).toBe(1);
    expect(contarRetornoAfirmativo(soNull, 'Card.tsx'), 'auto-ocultação vazou para a baseline afirmativa').toBe(0);
  });

  it('a forma `jsx-&&` é detectada mas NÃO gateada — a distinção é deliberada', () => {
    const host = `
      export function Page() {
        const { data: positivacao } = useMyPositivacao();
        return <div>{positivacao && (<MixGapCard />)}</div>;
      }`;
    expect(contarAutoOcultacao(host, 'Page.tsx'), 'jsx-&& não pode entrar na baseline gateada').toBe(0);
    expect(
      acharColapsos(host, 'Page.tsx')[0]?.colapsos[0]?.forma,
      'o detector precisa CONTINUAR enxergando a forma jsx-&& (ela é o segundo front, medido)',
    ).toBe('jsx-&&');
  });
});
