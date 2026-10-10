import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  mapearHooksComSinal, acharSinaisIgnorados, type HookComSinal,
} from '@/lib/gates/sinal-de-falha-ignorado';

/**
 * Gate estrutural da classe **"o hook expõe a falha e o consumidor não a lê"**.
 *
 * POR QUE ESTE GATE EXISTE, e por que não bastou o vizinho:
 * a classe já tinha TRÊS PRs de instância (#1565 → #1579 → #1697) quando este gate nasceu, e
 * um quarto (este) ainda achou dois consumidores money-path intactos — `CarteiraBoard` (três
 * colunas "Nada aqui" sob falha) e `FarmerLOCC` (`summary` devolvendo `{ avgHealth: 0 }`
 * literal). A meta-regra medida no catálogo de retrabalho do repo: **classe com contramedida
 * textual reincide; classe com gate estrutural para.**
 *
 * O gate vizinho (`erro-colapsado-em-vazio`) NÃO cobre esta forma, e isso é medido, não
 * suposto: o `CHAVES_DE_ERRO` dele não contém `erro` — o campo que o `useFarmerScoring` expõe
 * — e ele só persegue a binding `data` do react-query (`if (prop === "data")`), então um hook
 * de payload próprio (`{ clientScores, agenda, erro }`) é invisível para ele. O CarteiraBoard
 * pré-fix passava LIMPO por aquele gate. Conferido em 2026-10-09.
 *
 * A DÍVIDA é baselinada por CONTAGEM POR ARQUIVO (mesma decisão dos gates irmãos: baseline por
 * presença deixaria um 2º sítio nascer num arquivo já listado sem nada ficar vermelho).
 * Crescer REPROVA (reintrodução); diminuir REPROVA pedindo a atualização da lista — ela só
 * encolhe, e encolhe REGISTRADO.
 *
 * ⚠️ A baseline NÃO é atestado de inofensividade: é a fronteira medida em 2026-10-09. Os sítios
 * money-path dela estão triados no corpo do PR com dono.
 */

const RAIZ = resolve(__dirname, '../..');
const DIRS = ['src'];
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

function lerFontes() {
  const arquivos: { arquivo: string; conteudo: string }[] = [];
  for (const dir of DIRS) {
    for (const arquivo of listarFontes(dir)) {
      arquivos.push({ arquivo, conteudo: readFileSync(resolve(RAIZ, arquivo), 'utf8') });
    }
  }
  return arquivos;
}

function contarPorArquivo(hooks: Map<string, HookComSinal>): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const { arquivo, conteudo } of fontes()) {
    const n = acharSinaisIgnorados(conteudo, arquivo, hooks).length;
    if (n > 0) mapa.set(arquivo, n);
  }
  return mapa;
}

// MEMOIZADO: cada passo custa um parse TS de ~1.1k arquivos. Sem cache os 3 testes pesados
// faziam 5 varreduras da árvore, e o arquivo estourou o `testTimeout: 20000` quando a suíte
// inteira concorre por CPU (medido em 2026-10-10: 2 vermelhos por TIMEOUT, não por lógica).
// A árvore não muda durante a run, então uma leitura serve aos três.
let cacheFontes: ReturnType<typeof lerFontes> | null = null;
const fontes = () => (cacheFontes ??= lerFontes());

let cacheHooks: Map<string, HookComSinal> | null = null;
const hooksDaArvore = () => (cacheHooks ??= mapearHooksComSinal(fontes()));

let cacheContagem: Map<string, number> | null = null;
const contagemDaArvore = () => (cacheContagem ??= contarPorArquivo(hooksDaArvore()));

// Fronteira medida em 2026-10-09 (16 sítios / 15 arquivos), encolhida pela erradicação dos
// money-path: o domínio de reposição saiu em 2026-10-10 (5 sítios / 5 arquivos). Resta 11.
const DIVIDA: ReadonlyMap<string, number> = new Map([
  ['src/components/RequireCaca.tsx', 1],
  ['src/components/dashboard/CommercialDashboard.tsx', 1],
  ['src/components/farmer/locc/OverviewTab.tsx', 1],
  ['src/hooks/useRoutePlanner.ts', 1],
  ['src/pages/FarmerCalls.tsx', 2],
  ['src/pages/FarmerGovernance.tsx', 1],
  ['src/pages/FinanceiroSync.tsx', 1],
  ['src/pages/Index.tsx', 1],
  ['src/pages/SavingsDashboard.tsx', 1],
  ['src/pages/UnifiedOrder.tsx', 1],
]);

/**
 * Sítios JÁ quitados, com o PR que os quitou. A `DIVIDA` acima só encolhe; esta lista é o
 * contrapeso — ela só CRESCE, e cada linha é um controle de regressão na ÁRVORE REAL (os pares
 * inline provam a assinatura; estes provam o fix). Sem eles, um revert silencioso voltaria a
 * caber na baseline antiga sem nada ficar vermelho.
 */
const QUITADOS: ReadonlyArray<[string, string]> = [
  ['src/pages/CarteiraBoard.tsx', '#2894'],
  ['src/pages/FarmerLOCC.tsx', '#2894'],
  ['src/components/reposicao/ReposicaoSessionLayout.tsx', 'reposição'],
  ['src/components/reposicao/EtapasGrid.tsx', 'reposição'],
  ['src/components/reposicao/EtapaChecklist.tsx', 'reposição'],
  ['src/components/reposicao/BaixoGiroBadge.tsx', 'reposição'],
  ['src/pages/AdminReposicaoBaixoGiro.tsx', 'reposição'],
  // Nunca esteve na DIVIDA porque o detector NÃO O VIA: o consumo passava pelo wrapper
  // `useCurrentStep`, cujo `return { ...q, data: … }` com SPREAD não registra campo de sinal
  // (só propriedade NOMEADA entra no mapa). O wrapper foi aposentado e o consumo é direto,
  // então o sítio nasce VIGIADO — e esta linha dá o vermelho nomeado se o fix for desfeito.
  ['src/pages/AdminReposicaoCockpit.tsx', 'reposição (cegueira do spread)'],
];

// ── Controles de calibração ───────────────────────────────────────────────────────────
// A FORMA do CarteiraBoard pré-fix (HEAD~ deste PR). Assinatura que não casa isto é varredura
// teatro: era exatamente o sítio que o gate vizinho deixava passar.
const PRE_FIX_HOOK = `
export const useFarmerScoring = (farmerId?: string) => {
  const [erro, setErro] = useState<string | null>(null);
  return { config, clientScores, agenda, summary, loading, calculating, erro, recalculate };
};
`;
const PRE_FIX_CONSUMIDOR = `
export default function CarteiraBoard() {
  const { agenda, clientScores, loading } = useFarmerScoring();
  return <BoardCarteira colunas={montarColunasBoard(agenda, clientScores, [])} />;
}
`;
const POS_FIX_CONSUMIDOR = `
export default function CarteiraBoard() {
  const { agenda, clientScores, loading, erro, calculating, recalculate } = useFarmerScoring();
  if (erro && clientScores.length === 0) return <Card role="alert">indisponível</Card>;
  return <BoardCarteira colunas={montarColunasBoard(agenda, clientScores, [])} />;
}
`;
// Absolvição deliberada: `...rest` pode carregar o sinal — precisão > recall.
const CONSUMIDOR_COM_REST = `
export default function Tela() {
  const { agenda, ...rest } = useFarmerScoring();
  return <div>{agenda.length}{rest.erro}</div>;
}
`;

const mapaDoControle = () =>
  mapearHooksComSinal([{ arquivo: 'src/hooks/useFarmerScoring.ts', conteudo: PRE_FIX_HOOK }]);

describe('gate: sinal de falha exposto e ignorado', () => {
  it('sentinela: o walker enxerga hooks de verdade na árvore', () => {
    // Sem isto, um bug que fizesse `mapearHooksComSinal` devolver vazio deixaria TODA asserção
    // de ausência abaixo verde por vacuidade — o gate viraria decoração.
    const hooks = hooksDaArvore();
    expect(hooks.size, 'nenhum hook com sinal encontrado — o walker não andou').toBeGreaterThan(10);
    expect(hooks.get('useFarmerScoring')?.campo, 'o hook-mãe da classe tem de ser mapeado').toBe('erro');
  });

  it('calibração: a assinatura CASA a forma pré-fix do CarteiraBoard', () => {
    const achados = acharSinaisIgnorados(PRE_FIX_CONSUMIDOR, 'src/pages/CarteiraBoard.tsx', mapaDoControle());
    expect(achados.length, 'a forma-mãe da classe tem de ser detectada').toBe(1);
    expect(achados[0]?.campo).toBe('erro');
    expect(achados[0]?.hook).toBe('useFarmerScoring');
  });

  it('calibração: NÃO casa a forma pós-fix — senão é varredura teatro', () => {
    const achados = acharSinaisIgnorados(POS_FIX_CONSUMIDOR, 'src/pages/CarteiraBoard.tsx', mapaDoControle());
    expect(achados.length, 'a forma corrigida não pode acusar').toBe(0);
  });

  it('calibração: `...rest` absolve (precisão > recall)', () => {
    const achados = acharSinaisIgnorados(CONSUMIDOR_COM_REST, 'src/pages/Tela.tsx', mapaDoControle());
    expect(achados.length).toBe(0);
  });

  it('o arquivo do próprio hook não acusa a si mesmo', () => {
    const achados = acharSinaisIgnorados(PRE_FIX_CONSUMIDOR, 'src/hooks/useFarmerScoring.ts', mapaDoControle());
    expect(achados.length).toBe(0);
  });

  it('nenhum sítio novo além da dívida baselinada', () => {
    const atual = contagemDaArvore();

    const reintroducoes: string[] = [];
    for (const [arquivo, n] of atual) {
      const base = DIVIDA.get(arquivo) ?? 0;
      if (n > base) reintroducoes.push(`${arquivo}: ${n} (baseline ${base})`);
    }
    const quitacoes: string[] = [];
    for (const [arquivo, base] of DIVIDA) {
      const n = atual.get(arquivo) ?? 0;
      if (n < base) quitacoes.push(`${arquivo}: ${n} (baseline ${base})`);
    }

    expect(
      reintroducoes,
      'sinal de falha ignorado em sítio NOVO — destruture o campo do hook e decida o que a tela ' +
        'faz sob falha (§7 do money-path: indisponível com motivo + retry, ou último dado bom ' +
        'com aviso de stale; nunca zero fabricado)',
    ).toEqual([]);
    expect(
      quitacoes,
      'dívida quitada: ATUALIZE a DIVIDA deste gate (a lista só encolhe, e encolhe registrada)',
    ).toEqual([]);
  });

  it('os consumidores já quitados não voltam para a dívida', () => {
    const atual = contagemDaArvore();
    const regressoes = QUITADOS.filter(([arquivo]) => (atual.get(arquivo) ?? 0) > 0)
      .map(([arquivo, pr]) => `${arquivo} (quitado em ${pr})`);
    expect(
      regressoes,
      'consumidor já quitado voltou a ignorar o sinal do hook — o fix foi desfeito',
    ).toEqual([]);
  });

  it('nenhum arquivo aparece ao mesmo tempo na DIVIDA e nos QUITADOS', () => {
    // Guard da própria contabilidade: um arquivo nos dois lados tornaria o controle de
    // regressão satisfeito pela baseline (sempre verde) e a quitação, inverificável.
    const nosDois = QUITADOS.map(([a]) => a).filter((a) => DIVIDA.has(a));
    expect(nosDois, 'arquivo em DIVIDA e QUITADOS ao mesmo tempo').toEqual([]);
  });
});
