import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { acharColapsos, contarAutoOcultacao } from '@/lib/gates/erro-colapsado-em-vazio';

// GATE — "erro colapsado em vazio": a leitura que falha e vira silêncio afirmativo.
//
// A CLASSE (docs/historico/fase-sem-sinal.md; #1859 e a revisão retroativa de 2026-08-22):
// um hook react-query que LANÇA no erro deixa `data === undefined`, que é a MESMA condição
// de "vazio" e de "nunca carregou". Um componente que faz `if (!data) return null` sem ler
// `error` colapsa esses estados numa tela em branco só — e quando a tela é um ALERTA ou um
// painel de SAÚDE, a ausência AFIRMA segurança: "não consegui ler" chega como "está tudo bem".
//
// A FORMA FISCALIZADA é a auto-ocultação TOTAL (`return null`/ternário guardado pela
// leitura), que apaga o componente inteiro sem deixar rastro. A forma `jsx-&&` fica de fora
// de propósito e está MEDIDA em docs/agent/money-path.md — o porquê está no cabeçalho de
// `@/lib/gates/erro-colapsado-em-vazio`.
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
// DÍVIDA (2026-08-22): estes 46 sítios são a classe medida, não sítios aprovados. A fatia
// de maior dano saiu nesta leva (banner de saúde de dados, alertas de fluxo de caixa,
// painel de saúde da carteira) porque neles a ausência AFIRMA segurança e o dano estava
// medido em prod. O resto sai por domínio, e a ordem é por dano — não por facilidade.
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
  ["src/components/farmer/copilot/useFarmerCopilot.ts", 1],
  ["src/components/farmer/tacticalPlan/useFarmerTacticalPlan.ts", 1],
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
  ["src/pages/AdminReposicaoPedidos.tsx", 2],
  ["src/pages/FinanceiroMapping.tsx", 1],
  ["src/pages/GovernanceMathParams.tsx", 1],
  ["src/pages/GovernancePermissions.tsx", 1],
  ["src/pages/RotaPropostas.tsx", 1],
  ["src/pages/SalesPrintDashboard.tsx", 6],
  ["src/pages/ToolHistory.tsx", 1],
  ["src/pages/ToolReports.tsx", 1],
  ["src/pages/Training.tsx", 2],
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
      .filter((s) => s.silencios.length > 0);
    expect(
      presos.map((s) => `${s.hook}(${s.aliasData}) → ${s.silencios.map((x) => x.forma).join(',')}`),
      'uma leitura sem `error` voltou a esconder bloco em FarmerCalls — o MixGapCard pode ' +
      'estar preso de novo no && de uma query irmã',
    ).toEqual([]);
  });

  it('a forma `jsx-&&` é detectada mas NÃO gateada — a distinção é deliberada', () => {
    const host = `
      export function Page() {
        const { data: positivacao } = useMyPositivacao();
        return <div>{positivacao && (<MixGapCard />)}</div>;
      }`;
    expect(contarAutoOcultacao(host, 'Page.tsx'), 'jsx-&& não pode entrar na baseline gateada').toBe(0);
    expect(
      acharColapsos(host, 'Page.tsx')[0]?.silencios[0]?.forma,
      'o detector precisa CONTINUAR enxergando a forma jsx-&& (ela é o segundo front, medido)',
    ).toBe('jsx-&&');
  });
});
