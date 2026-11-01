// Relatório do replay TSB (plano, Task 9). Vai SÓ para $REPLAY_DADOS/relatorio.md (tem R$ absolutos): NUNCA no
// repositório. Sem nome nem CNPJ de cliente (só código de SKU). Título com o nome obrigatório da métrica (spec §5.7).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CenarioLT } from './aleatorio';
import { CENARIOS_FALTA, PISOS_SERVICO } from './config';
import { reducaoRelativa, type ResultadoCalibracao } from './calibracao';
import type { Criterio } from './estatistica';
import type { Formula, ParamsFormula, RelatorioParidade } from './formulas';
import type { GradeCusto } from './metricas';
import type { DiagnosticoEstadoInicial } from './reconstrucao';
import type { ValidacaoClasse } from './classe';
import type { DivergenciaPermitida, GateParidade, ModoAncora } from './rodar';
import type { Celula, Falta, ParidadeQuantidade, SomasSemanais } from './simulador';
import type { AvisoDados, Classe, Data, Evidencia, Intervalo, IntervaloPorBloco, Parado, VereditoReplay } from './tipos';

interface CenarioR {
  pop: 'coorte' | 'todos';
  inicial: 'reconstruido' | 'piso_zero';
  lt: CenarioLT;
  falta: Falta;
  sub: boolean;
}

export interface Rodada {
  geradoEm: string;
  nomeMetrica: string;
  chave: Record<string, unknown>;
  coorte: { populacao: number; alterados: number; todos: number; excluidosInsumo: { sku: string; shareInsumo: number }[] };
  paridade: {
    f0: RelatorioParidade;
    quantidade: ParidadeQuantidade;
    gate: GateParidade;
    gatePassa: boolean;
    /** Achado 8: a allowlist nomeada da divergência de estado, com a justificativa (o texto da R21 sai daqui, não fixo). */
    allowlistEstado: Readonly<Record<string, DivergenciaPermitida>>;
  };
  /** R30: 'oficial' (âncora Omie) ou o modo legado do saldo de hoje, só com --informativo-saldo-hoje (NÃO OFICIAL). */
  modoAncora: ModoAncora;
  /** Achado 14 (§5.1.1): classe recalculada × classe de hoje, ponderada por valor (a rodada para acima de 5% do valor A). */
  validacaoClasse: ValidacaoClasse;
  calibracao: { alvo: Record<Classe, number | null>; fillF0: Record<Classe, number | null>; resultados: ResultadoCalibracao[]; candidata: Formula | 'NENHUMA' | 'INDETERMINADA';
    /** R44: frações do capital do F0 na calibração por fonte de preço e SKUs sem preço / pelo preco_compra_real. */
    capitalF0?: { fontes: FontesCapital | null; skusSemPreco: number; skusCompraReal: number; skusCmcOmie: number };
  };
  fronteira: { formula: Formula; params: ParamsFormula; fill: Record<Classe | 'total', number | null>; reducao: number | null }[];
  excluidosDados: { sku: string; motivo: string }[];
  avisos: AvisoDados[];
  parados: Parado[];
  negativos: { sku: string; data: Data; valor: number }[];
  estadoInicial: DiagnosticoEstadoInicial;
  congelado: { candidata: Formula; params: ParamsFormula } | null;
  /** I1: `modo` (R30) — 'oficial' ou o legado NÃO OFICIAL; ausente só no bloco informativo (R27, sempre não oficial). */
  veredito: { veredito: VereditoReplay; motivos: string[]; modo?: ModoAncora };
  avaliacao: {
    reps: number;
    meiaLarguraServico: number | null;
    meiaLarguraEstoque: number | null;
    criterios: Criterio[];
    vereditoPorEstado: { rotulo: string; veredito: VereditoReplay; motivos: string[] }[];
    todosAtivos: { veredito: VereditoReplay; motivos: string[] };
    sensibilidadeTaxa: { falta: Falta; grade: GradeCusto; custo: Intervalo }[];
    /** Evidência do estado reconstruído (para a sensibilidade de blocos 4 × 8 e a grade de custo). */
    blocos: Evidencia;
    celulas: { cenario: CenarioR; celula: Celula; linhas: number; f0: Intervalo | null; alt: Intervalo | null; delta: IntervaloPorBloco | null }[];
    capital: {
      cenario: CenarioR; estoqueF0: number; estoqueAlt: number; reducao: IntervaloPorBloco;
      /** Achado 10: fração das unidades × dias sem CMC (null = sem unidade). */
      naoValorado: { f0: number | null; alt: number | null };
      /** R37: fração do capital nos grupos de embalagem (null = sem capital valorado). */
      grupos: { f0: number | null; alt: number | null };
      /** R44: frações das unidades × dias por fonte do preço de capital. */
      fontes: { f0: FontesCapital | null; alt: FontesCapital | null };
      /** N7: serviço das linhas do galão extra (informativo, fora das células); null = sem linha. Ausente em rodadas antigas. */
      galao?: { f0: { linhas: number; fill: number | null } | null; alt: { linhas: number; fill: number | null } | null };
    }[];
    terminal: { cenario: CenarioR; f0: Pick<SomasSemanais, 'terminal' | 'balanco'>; alt: Pick<SomasSemanais, 'terminal' | 'balanco'> }[];
    equilibrio: { falta: Falta; valor: number | null }[];
    dio: { f0: number; alt: number; linhasSemCmc: number } | null;
    suaves: { n: number; f0: { linhas: number; fill: number | null }; fnPura: { linhas: number; fill: number | null } };
    nulos: { cenario: string; item: string; nulos: Record<4 | 8, number> }[];
    /** SKUs sem preço de capital (nem cmc nem preco_compra_real, R44). */
    skusSemCmc: string[];
    /** R44: SKUs valorados pelo preco_compra_real. */
    skusCompraReal: string[];
    /** R45: SKUs valorados pelo nCMC da posição Omie datada. */
    skusCmcOmie: string[];
    /** R53: SKUs sem saldo na abertura que só existem a partir do 1º evento real (recebimento ou venda); desde null = nunca. */
    existenciaTardia: { sku: string; desde: string | null; via: 'recebimento' | 'venda' | null }[];
    excluidosSimulacao: { sku: string; motivo: string }[];
    linhasIgnoradas: number;
  } | null;
  /** Diagnóstico de plausibilidade da calibração (R27). null = não medido. */
  diagnostico: Diagnostico | null;
  /** Rodada INFORMATIVA NÃO OFICIAL (R27): alvo e tabela nas células *_alt. null = não rodada. */
  informativo: Pick<Rodada, 'veredito' | 'congelado' | 'calibracao' | 'fronteira' | 'avaliacao'> | null;
  /** Mensagem da exceção da rodada informativa (M-1): não afeta o veredito oficial. null = sem erro. */
  informativoErro: string | null;
  tempos: Record<string, number>;
  segundos: number;
}

/** R44: frações das unidades × dias de estoque por fonte do preço de capital. */
export interface FontesCapital {
  cmc: number;
  /** R45: nCMC da posição datada do Omie ("cmc Omie datado"). */
  cmcOmie: number;
  compraReal: number;
  semPreco: number;
}
const textoFontes = (f: FontesCapital | null | undefined): string =>
  f ? `cmc ${pct(f.cmc)} · cmc Omie datado ${pct(f.cmcOmie)} · preco_compra_real ${pct(f.compraReal)} · sem preço ${pct(f.semPreco)}` : 'n/d';

export interface Diagnostico {
  /** F0 na calibração (50 reps, LT empírico, espera): fill de A, A-alterados e A-suaves, com as linhas observadas. */
  fillF0A: { total: number | null; alterados: number | null; suaves: number | null; linhasAlterados: number; linhasSuaves: number };
  /** Fill de A do F0 por semana da calibração. */
  semanalA: { semana: Data; fill: number | null }[];
  /** Unidades vendidas por mês da calibração nos SKUs de A da coorte. */
  demandaA: { mes: string; unidades: number }[];
  /** LT (du) realizado nos pedidos de A do F0 (rep 0) a partir de `desde` × LT do parâmetro F0 no dia do pedido. */
  lt: { desde: Data; pedidos: number; sorteadoMedio: number | null; parametroMedio: number | null };
  /** Operação real × F0 simulado na calibração (R$ só aqui, local): estoque médio (mesma valoração) e unidades recebidas até 30/04. */
  real: { estoqueReal: number | null; estoqueF0: number | null; recebidoReal: number; recebidoF0: number };
}

// ── formatação ────────────────────────────────────────────────────────────────────────────────────────────────────
const num = (x: number, casas: number) => x.toFixed(casas).replace('.', ',');
export const pct = (x: number | null | undefined, casas = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? 'n/d' : `${num(x * 100, casas)}%`);
const pp = (x: number | null | undefined, casas = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? 'n/d' : `${x >= 0 ? '+' : ''}${num(x * 100, casas)} p.p.`);
const brl = (x: number | null | undefined): string =>
  x === null || x === undefined || !Number.isFinite(x) ? 'n/d' : `R$ ${x.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const comb = (p: IntervaloPorBloco): Intervalo => ({
  ponto: p[4].ponto ?? p[8].ponto,
  li: p[4].li === null || p[8].li === null ? null : Math.min(p[4].li, p[8].li),
  ls: p[4].ls === null || p[8].ls === null ? null : Math.max(p[4].ls, p[8].ls),
});
const ivPct = (iv: Intervalo | null) => (iv === null ? 'n/d | n/d | n/d' : `${pct(iv.ponto)} | ${pct(iv.li)} | ${pct(iv.ls)}`);
const ivPp = (iv: Intervalo | null) => (iv === null ? 'n/d | n/d | n/d' : `${pp(iv.ponto)} | ${pp(iv.li)} | ${pp(iv.ls)}`);
const ivBrl = (iv: Intervalo) => `${brl(iv.ponto)} | ${brl(iv.li)} | ${brl(iv.ls)}`;
const rotCen = (c: CenarioR) => `${c.pop === 'todos' ? 'todos-ativos ' : ''}${c.inicial}/${c.lt}/${c.falta}${c.sub ? '/com-substituição' : ''}`;
const tabela = (cab: string[], linhas: string[][]): string =>
  [`| ${cab.join(' | ')} |`, `|${cab.map(() => '---').join('|')}|`, ...linhas.map((l) => `| ${l.join(' | ')} |`)].join('\n');

const pc0 = (x: number) => `${Math.round(x * 100)}%`;
/** Texto do gate do critério 5 (o misto vem de config, com nomes explícitos — spec §6). */
export const TEXTO_GATE_ECONOMIA =
  `Gate (critério 5, R26): taxa 25% a.a.; emergencial 5/10/20% × atraso 0/0,5/1% por linha-dia; cenários espera, cancelamento e misto ` +
  `(${pc0(CENARIOS_FALTA.misto.espera)} espera, ${pc0(CENARIOS_FALTA.misto.emergencial)} compra emergencial, ${pc0(CENARIOS_FALTA.misto.cancelamento)} cancelamento).`;

/** O limiar da paridade (rodar.ts PARIDADE_MINIMA), repetido aqui só para o texto (relatorio.ts não importa rodar.ts). */
const PARIDADE_MINIMA_RELATORIO = 0.95;

/** Limitações a DECLARAR (spec §10 + rulings do controlador). */
export const LIMITES: readonly string[] = [
  '**12 meses de histórico** (spec §10): 6 meses de avaliação, poucos blocos longos; intervalos largos → INCONCLUSIVO é desfecho legítimo.',
  '**Demanda censurada** (spec §10): a métrica é o atendimento das linhas FATURADAS; espera, substituição e venda perdida originais não aparecem.',
  '**Estado inicial** (spec §5.2/§10): o veredito é recomputado com `piso_zero` (linha "Estado inicial").',
  '**Seleção retrospectiva da coorte** (spec §5.1.1): o flag de reposição automática é o de hoje; a conclusão vale para a coorte habilitada hoje e não é confirmatória. "Todos os ativos" é sensibilidade (R11: definição composta do motor, menor que a contagem frouxa da spec).',
  '**R19** — a paridade primária do F0 é contra a VIEW de produção no instante da extração (fórmula × fórmula); o gravado em `sku_parametros` é paridade secundária (defasagem da passada das ~01:15, cold start e fusível = estado irredutível).',
  '**Gate de paridade (achado 8)** — exige decisão E estado (os parâmetros do replay, os mesmos do mapa que o baseline simula), status OK e presença na view ≥ 95%, e todas as linhas de sugestao_hoje comparáveis. Divergência de estado só passa na allowlist nomeada da seção 7 (justificativa por SKU), nunca por limiar. **N5:** o estado cobre TODOS os donos da população simulada, com ou sem sugestão positiva — ES/PP/máximo do replay × gravado e × view ≥ 95% (os limiares da paridade), o que põe no gate também os donos cuja decisão foi NÃO comprar. A posição do motor não é gravada para quem não compra: quantas dessas decisões ficam PROVADAS (PP do replay < gravado, ou PP igual e máximo na tolerância da paridade; `tipo ≠ F0` não conta) sai à parte, informativo (R48), com a contagem de "PP do replay > gravado" visível.',
  '**R10 (revogada pelo achado 1)** — a âncora oficial é a posição datada do Omie (R31); o modo legado (saldo de hoje) só roda com `--informativo-saldo-hoje` e sai NÃO OFICIAL (R30).',
  '**R47 (revoga R29/R34 no que usavam o estado de hoje sem data)** — o encerramento no Omie só fecha o item com a DATA dele: o parcial encerrado fecha no último t4, mas só é conhecido a partir de `encerrado_omie_em` (antes disso estava aberto; na calibração só entra se encerrado até 30/04); o sem-t4 encerrado sai da amostra (`SEM_T4_ENCERRADO_OMIE`). Status RECEBIDO sem t4 (estado de hoje, sem data) NÃO prova recebimento: o item fica na amostra como aberto (`SEM_T4_STATUS_RECEBIDO`, contado). Resíduo: a quantidade do pedido vem do `raw_data` ATUAL do pedido (sem histórico de versões).',
  '**R46 (revoga a R35 no sorteio)** — o pedido casa em ~1/4 das linhas; as demais são o item gravado sob o tracking de OUTRO pedido da mesma NF (writer antigo), com quantidade pedida da NF (`PEDIDA_DA_NF`): saem da amostra do SORTEIO de LT (falta evidência de que fecharam); a contagem e a sensibilidade com elas dentro aparecem na seção 8 e nas linhas `empirico_com_nf`. O LT do F0 usa a amostra da produção (`v_sku_leadtime_efetivo`, R43), que não muda; as fórmulas alternativas aprendem LT dos itens documentais, com elas (igual nos dois braços).',
  '**R23** — viés de LT por censura à direita (só documentos com t4 ≤ fim da janela perto de 30/04) e o aquecimento (out–dez/25) sorteia documentos de jan/26: LT levemente otimista no fim da calibração, igual nos dois braços.',
  '**R36** — a elegibilidade de catálogo e portal do galão (escolha de embalagem, achado 9) é a de HOJE (não há histórico desses filtros).',
  '**R37** — o estoque do galão extra (membro de grupo fora da coorte) entra no capital das duas políticas; a fração dos grupos no capital sai à parte na tabela de capital.',
  '**R39** — a posição do grupo segue a produção: físico + a caminho dos membros, SEM descontar o comprometido (`embalagem-motor-rpc.sql`, "[COMPROMETIDO] só sem grupo"). O galão extra entra na posição do grupo desde o início do aquecimento (estoque de abertura dele).',
  '**Paridade do galão (M3 da revisão B)** — a escolha de embalagem na paridade de quantidade vê as capturas de preço-app até a extração; a execução gravada em sugestao_hoje pode ser anterior (efeito hoje nulo: a última captura é de 14/07).',
  '**R38** — LT e preço de compra só com `origem_compra = normal` (como `v_sku_leadtime_history_normal`); outra origem PARA a carga (hoje 100% normal).',
  '**Margem desconhecida (achado 11; R24 revogada)** — cancelada sem CMC tem margem sem limite inferior comprovado: em qualquer braço, a economia daquela célula vira INCERTO (null). A fração aparece em % nas linhas do critério 5.',
  '**Terminal nas somas semanais (achado 12)** — o custo terminal (backlog do fim custeado como emergencial + atraso) é soma da ÚLTIMA semana: só entra na reamostragem que a sorteia.',
  '**R25** — critério 3 (capital) e a redução do estresse avaliados nos TRÊS cenários de falta; qualquer FALHA → NO-GO.',
  '**R26** — critério 5 no gate só com a taxa de 25% a.a. (grade 3×3 × 3 cenários); 20% e 30% são sensibilidade (tabela à parte).',
  '**Capital pelo preço DO DIA (N2)** — o estoque de cada dia é valorado com o que se sabia nele: o cmcLinha da última venda ANTERIOR ao dia → o nCMC (CMC contábil do ERP, R45) da posição datada do Omie mais recente com data ≤ o dia (20/10, 31/01, 30/04) → o preco_compra_real dos documentos coerentes (origem normal) consolidados no corte do dia (R44, N3) → sem preço; nunca o cmc de hoje nem um cmc fixo da janela, e sem a venda × 0,55. Preço de compra ≠ CMC contábil, igual nos dois braços; a fração do capital por fonte aparece. O que segue sem preço NÃO some (achado 10): capital, estresse e economia daquele recorte viram INCERTO, e o diagnóstico "operação real × F0" sai n/d. A margem da cancelada sem CMC (achado 11) não muda: margem não é capital.',
  '**Consolidação de cópias no corte temporal (N3)** — o preco_compra_real e o LT do F0 (cópias cruas de `v_sku_leadtime_history_normal`, regra de `v_sku_leadtime_efetivo` refeita em TS) consideram, em cada dia, só as cópias do documento com t4 anterior a ele: uma cópia futura não apaga nem adia uma observação passada. Resíduo: uma linha inserida ou corrigida depois do dia (sync atrasado) ainda entra como se fosse conhecida nele (não há histórico de versões das tabelas).',
  '**Galão extra na conta econômica (N7)** — o membro de grupo fora da coorte entra no capital (R37) E no fechamento econômico dos dois braços (emergencial, cancelamento, entrega tardia/atraso, herdadas e backlog terminal); só as células de serviço o excluem (o denominador da coorte não muda) — o serviço dele aparece à parte, informativo, na tabela de capital.',
  '**Recebimentos do mesmo documento (P2a)** — cópia idêntica (mesmo t4 e quantidade) sob outro tracking é o mesmo recebimento; datas diferentes são recebimentos distintos, cada um na sua data. Dois pedidos da mesma NF com a mesma quantidade no mesmo dia são indistinguíveis de cópias (viram 1).',
  '**Preço-app (P2b)** — as capturas são ordenadas pelo instante (hora de SP), e a escolha de embalagem no dia d usa a mais recente com data < d.',
  '**LT exógeno**: as fórmulas aprendem LT só de recebimentos históricos com t4 < d, nunca de chegadas simuladas (permite pré-computar os níveis).',
  '**Sem feriados** no calendário de LT/revisão (como `dias_uteis_entre` da produção).',
  '**O replay não mede a operação real** (spec §10): separação, aceitação de troca — cabe à sombra e ao piloto. Um GO autoriza sombra/piloto, não a troca do motor.',
  '**R11** — "ativo" e "habilitado" seguem a definição composta do motor: 312/238 (ativos/habilitados), contra 373/276 da contagem frouxa da spec; a coorte é menor e fiel ao escopo real do motor.',
  '**R17** — LT com t1 "fabricado" (t1 = t2) sai da amostra (T1_FABRICADO), aproximando o lt_bruto NULL da produção: 14 legítimos caem e 36 órfãos ficam (aproximação declarada).',
  '**Estado de partida — compras abertas no início do aquecimento**: o conjunto é VAZIO no dado real (o 1º recebimento é de 2026-01-28); o estado inicial não tem pedidos em trânsito.',
  '**Duplicatas de LT** (spec §10): dedup pela identidade documental, como `v_sku_leadtime_efetivo` (achado 6) — sem item separado.',
];

/** R30: rótulo do modo legado (âncora no saldo de hoje) nos títulos. */
export const ROTULO_R30 = 'R30, âncora no saldo de hoje';

/** R30: linhas do aviso de rodada NÃO OFICIAL (modo legado do saldo de hoje); vazio na rodada oficial. */
export function avisoAncora(modo: ModoAncora): string[] {
  if (modo === 'oficial') return [];
  return [
    '**RODADA NÃO OFICIAL (R30)** — sem a posição datada do Omie, a abertura foi ancorada no saldo de HOJE (modo legado, `--informativo-saldo-hoje`): o estado inicial depende da avaliação (§5.9 não atendida). Nenhum veredito desta rodada vale como oficial.',
  ];
}

/** O bloco que se repete entre a rodada oficial e a informativa (R27): veredito, calibração, células, fronteira, custo, terminal e sensibilidades. */
type BlocoRodada = Pick<Rodada, 'veredito' | 'congelado' | 'calibracao' | 'fronteira' | 'avaliacao'>;
function secoesDoBloco(
  r: Rodada, b: BlocoRodada, s: (x: string) => void,
  o: { h: '##' | '###'; prefixo: string; oficial: boolean; rotuloNaoOficial?: string; extrasVeredito?: string[] },
): void {
  const H2 = `${o.h} ${o.prefixo}`;
  const H3 = `${o.h}# `;
  // 1. veredito
  s(`${H2}${tituloVeredito(b.veredito.veredito, o.oficial, o.rotuloNaoOficial)}`);
  if (b.congelado) s(`Candidata congelada na calibração: **${b.congelado.candidata}** — \`${JSON.stringify(b.congelado.params)}\`.`);
  if (o.h === '##') {
    const fora = r.paridade.gate.estadoForaDaPopulacao;
    s(`Gate de paridade do F0: **${r.paridade.gatePassa ? 'PASSA' : 'FALHA'}** (detalhe na seção 7). Estado nos donos FORA da população simulada (R42, informativo): ${fora.n}/${fora.de}.`);
  }
  for (const x of o.extrasVeredito ?? []) s(x);
  if (b.veredito.motivos.length > 0) s(['Motivos (FALHAs, ou INCERTOs se não há FALHA):', ...b.veredito.motivos.map((m) => `- ${m}`)].join('\n'));
  if (b.avaliacao) {
    const cont = { PASSA: 0, FALHA: 0, INCERTO: 0 };
    for (const c of b.avaliacao.criterios) cont[c.estado]++;
    s(`Critérios: ${cont.PASSA} PASSA · ${cont.FALHA} FALHA · ${cont.INCERTO} INCERTO.`);
    s(tabela(['Critério', 'Estado', 'Motivo'], b.avaliacao.criterios.map((c) => [c.criterio, c.estado, c.motivo.replace(/\|/g, '/')])));
  }

  // calibração
  s(H3 + 'Calibração (janela 2026-02-01→04-30, 50 reps, LT empírico, espera)');
  s(`Alvo por classe = max(piso, fill F0 − 0,25 p.p.): ${(['A', 'B', 'C'] as const).map((c) => `${c} ${pct(b.calibracao.alvo[c])} (F0 ${pct(b.calibracao.fillF0[c])})`).join(' · ')}.`);
  s(
    tabela(
      ['Fórmula', 'Variante', 'Quantis A/B/C', 'Inviável', 'Fill A/B/C', 'Redução de estoque vs F0', 'Trios avaliados'],
      b.calibracao.resultados.flatMap((x) =>
        x.tentativas.map((t) => [
          x.formula,
          t.params.beta !== undefined ? `β ${t.params.beta}` : t.params.janelaDias !== undefined ? `janela ${t.params.janelaDias} du` : '—',
          `${t.params.quantil.A} / ${t.params.quantil.B} / ${t.params.quantil.C}`,
          t.inviavel ? 'sim' : 'não',
          `${pct(t.fill.A)} / ${pct(t.fill.B)} / ${pct(t.fill.C)}`,
          pct(reducaoRelativa(t.estoqueMedio, x.estoqueF0)),
          String(t.avaliacoes),
        ]),
      ),
    ),
  );
  const cf = b.calibracao.capitalF0;
  if (cf) s(`Capital do F0 na calibração por fonte do preço (R44; unidades × dias): ${textoFontes(cf.fontes)}. SKUs pelo cmc Omie datado: ${cf.skusCmcOmie}; SKUs pelo preco_compra_real: ${cf.skusCompraReal}; SKUs sem preço em algum dia: ${cf.skusSemPreco} (com estoque sem preço, a calibração fica INCONCLUSIVA — I2).`);
  s(`Escolhida: **${b.calibracao.candidata}** (menor estoque viável; uma mais simples, F1 < F3 < F2, a ≤ 1 p.p. de capital fica com a vaga).`);

  // 3. fronteira (sempre: vem da calibração)
  const secaoFronteira = (): void => {
    s(H2 + '3. Fronteira capital × fill rate (informativa; janela de calibração, quantil uniforme nas 3 classes, 50 reps)');
    s('Varre o MESMO quantil nas três classes (0,90 a 0,999) com o β/janela calibrados; NÃO é a recalibração por alvo de fill de 90% a 99,5% da spec §5.3 (aproximação declarada).');
    s(
      tabela(
        ['Fórmula', 'Variante', 'Quantil', 'Fill total', 'Fill A', 'Fill B', 'Fill C', 'Redução de estoque vs F0'],
        b.fronteira.map((f) => [
          f.formula, f.params.beta !== undefined ? `β ${f.params.beta}` : `janela ${f.params.janelaDias ?? '—'} du`, String(f.params.quantil.A),
          pct(f.fill.total), pct(f.fill.A), pct(f.fill.B), pct(f.fill.C), pct(f.reducao),
        ]),
      ),
    );
  };

  const a = b.avaliacao;
  if (a) {
    // 2. células
    s(`${H2}2. Células × fórmula × cenário (ponto | LI | LS; LI = min(LI4, LI8), LS = max(LS4, LS8))`);
    s(`Replicações: ${a.reps}. Fill = Σ linhas integralmente atendidas no dia ÷ Σ linhas (nunca média de % por SKU).`);
    s(
      tabela(
        ['Cenário', 'Célula', 'Linhas', 'F0 ponto', 'F0 LI', 'F0 LS', 'Cand. ponto', 'Cand. LI', 'Cand. LS', 'Δ ponto', 'Δ LI', 'Δ LS'],
        a.celulas.map((c) => [rotCen(c.cenario), c.celula, String(c.linhas), ivPct(c.f0), ivPct(c.alt), ivPp(c.delta === null ? null : comb(c.delta))]),
      ),
    );
    s(H3 + 'Capital (estoque físico médio a CMC, ponderado por dias corridos)');
    s(
      tabela(
        ['Cenário', 'Estoque médio F0 (só o valorado)', 'Estoque médio cand. (só o valorado)', 'Redução ponto', 'LI', 'LS', 'Não valorado F0 / cand. (achado 10)', 'Grupos no capital F0 / cand. (R37)', 'Fonte do preço, unid.×dias F0 (R44)', 'Fonte do preço, unid.×dias cand. (R44)', 'Serviço do galão extra F0 / cand. (N7, informativo)'],
        a.capital.map((c) => [
          rotCen(c.cenario), brl(c.estoqueF0), brl(c.estoqueAlt), ivPct(comb(c.reducao)),
          `${pct(c.naoValorado.f0)} / ${pct(c.naoValorado.alt)}`, `${pct(c.grupos.f0)} / ${pct(c.grupos.alt)}`,
          textoFontes(c.fontes.f0), textoFontes(c.fontes.alt),
          c.galao ? `${c.galao.f0 ? `${pct(c.galao.f0.fill)} (${num(c.galao.f0.linhas, 0)} linhas)` : 'sem linha'} / ${c.galao.alt ? pct(c.galao.alt.fill) : 'sem linha'}` : 'n/d',
        ]),
      ),
    );
    if (a.dio) s(`DIO Sayerlack (reconstruído/empírico/espera, CMV = Σ cmcLinha × qtd da coorte na avaliação): F0 ${num(a.dio.f0, 1)} dias · candidata ${num(a.dio.alt, 1)} dias (${a.dio.linhasSemCmc} linhas sem cmc fora do CMV).`);

    secaoFronteira();

    // 4. custo
    s(H2 + '4. Grade de custo (economia líquida, positivo = candidata vantajosa) e custo de falta de equilíbrio');
    s(TEXTO_GATE_ECONOMIA);
    s(
      tabela(
        ['Falta', 'Emergencial', 'Atraso/dia', 'Custo ponto', 'LI', 'LS', 'Linhas com margem desconhecida (achado 11)', 'Valor com margem desconhecida'],
        a.blocos.economia.map((e) => {
          const lin = e.linhasDemandadas ? e.linhasMargemDesconhecida / e.linhasDemandadas : null;
          const val = e.valorDemandado ? e.valorMargemDesconhecida / e.valorDemandado : null;
          return [e.falta, pct(e.grade.emergencialPerc, 1), pct(e.grade.atrasoPerc, 1), ivBrl(comb(e.custo)), pct(lin), pct(val)];
        }),
      ),
    );
    s('Sensibilidade da taxa de capital (fora do gate): 20% e 30% a.a.');
    s(
      tabela(
        ['Falta', 'Taxa', 'Emergencial', 'Atraso/dia', 'Custo ponto', 'LI', 'LS'],
        a.sensibilidadeTaxa.map((e) => [e.falta, pct(e.grade.taxa, 0), pct(e.grade.emergencialPerc, 1), pct(e.grade.atrasoPerc, 1), ivBrl(e.custo)]),
      ),
    );
    s(
      tabela(
        ['Falta', 'Custo de falta de equilíbrio (R$ por falta adicional, taxa 25%)'],
        a.equilibrio.map((e) => [e.falta, e.valor === null ? 'sem falta adicional (n/a)' : brl(e.valor)]),
      ),
    );

    // 5. terminal
    s(H2 + '5. Balanço terminal e fechamento (média das reps)');
    s('O fechamento por SKU (demanda medida = imediata + tardia + emergencial + cancelada + backlog, em UNIDADES das linhas originadas na janela; estoque inicial + recebido − entregue = final) é verificado em CADA simulação (fail-closed): a rodada não termina se violar. As obrigações herdadas de antes da janela (achado 13) fecham à parte (abertura = entregue tarde + backlog terminal) e entram nos VALORES de tardia, atraso e backlog abaixo — por isso, em valor, a soma não reproduz a demanda da janela.');
    s(
      tabela(
        ['Cenário', 'Fórmula', 'Estoque final', 'Compras abertas', 'Backlog (valor)', 'Unid. inicial', 'Unid. recebidas', 'Unid. entregues', 'Unid. finais'],
        a.terminal
          .filter((t) => !t.cenario.sub)
          .flatMap((t) =>
            (['f0', 'alt'] as const).map((k) => [
              rotCen(t.cenario), k === 'f0' ? 'F0' : 'cand.', brl(t[k].terminal.estoqueCmc), brl(t[k].terminal.abertasCmc), brl(t[k].terminal.backlogValor),
              num(t[k].balanco.inicial, 1), num(t[k].balanco.recebido, 1), num(t[k].balanco.entregue, 1), num(t[k].balanco.final, 1),
            ]),
          ),
      ),
    );

    // 6. sensibilidades
    s(H2 + '6. Sensibilidades');
    s(tabela(['Estado inicial', 'Veredito (sem a linha "Estado inicial")'], a.vereditoPorEstado.map((e) => [e.rotulo, e.veredito])));
    s(`Coorte "todos os ativos" (${r.coorte.todos} SKUs): **${a.todosAtivos.veredito}**.`);
    if (a.todosAtivos.motivos.length > 0) s(a.todosAtivos.motivos.slice(0, 30).map((m) => `- ${m}`).join('\n'));
    s('Blocos de 4 × 8 semanas (LI/LS por bloco; a tabela usa o mais desfavorável):');
    const linhaBloco = (nome: string, p: IntervaloPorBloco, f: (x: number | null) => string) => [nome, f(p[4].ponto), f(p[4].li), f(p[4].ls), f(p[8].li), f(p[8].ls)];
    s(
      tabela(
        ['Item', 'Ponto', 'LI4', 'LS4', 'LI8', 'LS8'],
        [
          ...a.blocos.servico.flatMap((sv) => [
            ...sv.pisos.map((p) => linhaBloco(`fill ${p.classe} [${sv.falta}]`, p.fill, (x) => pct(x))),
            ...sv.naoInferioridade.map((n) => linhaBloco(`Δ ${n.celula} [${sv.falta}]`, n.delta, (x) => pp(x))),
          ]),
          ...a.blocos.capital.map((c) => linhaBloco(`redução de capital [${c.falta}]`, c.reducao, (x) => pct(x))),
          ...a.blocos.estresse.capital.map((c) => linhaBloco(`estresse: redução [${c.falta}]`, c.reducao, (x) => pct(x))),
        ],
      ),
    );
    const subs = a.celulas.filter((c) => c.cenario.sub);
    s('Substituição de embalagem (reconstruído/empírico; pouca informação):');
    s(
      tabela(
        ['Falta', 'Célula', 'F0 exato', 'F0 com subst.', 'Cand. exato', 'Cand. com subst.'],
        subs.map((c) => {
          const ex = a.celulas.find((x) => !x.cenario.sub && x.cenario.pop === 'coorte' && x.cenario.inicial === 'reconstruido' && x.cenario.lt === 'empirico' && x.cenario.falta === c.cenario.falta && x.celula === c.celula);
          return [c.cenario.falta, c.celula, pct(ex?.f0?.ponto), pct(c.f0?.ponto), pct(ex?.alt?.ponto), pct(c.alt?.ponto)];
        }),
      ),
    );
    s(`Fórmula candidata aplicada também aos ${a.suaves.n} suaves/erráticos (informativo, 50 reps, empírico/espera): fill dos suaves F0 ${pct(a.suaves.f0.fill)} × candidata pura ${pct(a.suaves.fnPura.fill)} (${a.suaves.f0.linhas} linhas).`);
  } else {
    const naoAval = 'Não avaliado: sem candidata viável na calibração (o veredito sai na calibração).';
    s(H2 + '2. Células × fórmula × cenário');
    s(naoAval);
    secaoFronteira();
    for (const t of ['4. Grade de custo e custo de falta de equilíbrio', '5. Balanço terminal e fechamento', '6. Sensibilidades']) {
      s(`${H2}${t}`);
      s(naoAval);
    }
  }
}

/** Título da seção 11 (R27), com o veredito OFICIAL real. */
export function tituloSecaoInformativa(principal: VereditoReplay, modo: ModoAncora = 'oficial'): string {
  // R30 (I1): no modo legado nada nesta página é veredito oficial
  if (modo !== 'oficial') return `11. RODADA INFORMATIVA — NÃO OFICIAL (R27); o veredito da rodada principal, também NÃO OFICIAL (${ROTULO_R30}), é o ${principal} acima`;
  return `11. RODADA INFORMATIVA — NÃO OFICIAL (R27); o veredito oficial é o ${principal} acima`;
}

/** Título do veredito do bloco; o da rodada informativa diz NÃO OFICIAL (R27). */
export function tituloVeredito(v: VereditoReplay, oficial: boolean, rotuloNaoOficial = 'R27'): string {
  return oficial ? `1. Veredito: **${v}**` : `1. Veredito NÃO OFICIAL (${rotuloNaoOficial}): **${v}**`;
}

/**
 * Linhas da causa do veredito oficial (R27). Só atribui o NO-GO à régua se os suaves de A (presos no F0) ficam abaixo do
 * piso de A; senão o texto é neutro (a inviabilidade não se explica pelos suaves).
 */
export function causaOficial(r: Pick<Rodada, 'veredito' | 'diagnostico'>): string[] {
  const d = r.diagnostico;
  if (!d || !r.veredito.motivos.includes('INVIAVEL_NA_CALIBRACAO')) return [];
  const piso = PISOS_SERVICO.A;
  const fills = `na calibração, o próprio F0 atende ${pct(d.fillF0A.total)} das linhas de A (piso ${pct(piso, 0)}); os SKUs SUAVES de A, que ficam no F0 em todas as variantes (spec §5.3), atendem ${pct(d.fillF0A.suaves)} (${d.fillF0A.linhasSuaves} linhas); os alterados de A, ${pct(d.fillF0A.alterados)} (${d.fillF0A.linhasAlterados} linhas).`;
  if (d.fillF0A.suaves !== null && d.fillF0A.suaves < piso) {
    return [
      `**Causa (R27):** ${fills} Nenhum quantil mexe nos suaves, então nenhuma fórmula leva a célula A ao piso: o NO-GO decorre da régua (piso na célula da classe), não de uma comparação TSB × F0. Diagnóstico e rodada informativa na seção 11.`,
    ];
  }
  return [`**Contexto (R27):** ${fills} O motivo do veredito é INVIAVEL_NA_CALIBRACAO (nenhum trio atingiu o alvo nas três classes). Diagnóstico e rodada informativa na seção 11.`];
}

export function montarRelatorio(r: Rodada): string {
  const out: string[] = [];
  const s = (x: string) => out.push(x, '');
  s(`# Replay TSB — ${r.nomeMetrica} (Sayerlack, OBEN)${r.modoAncora === 'oficial' ? '' : ' — NÃO OFICIAL (saldo de hoje)'}`);
  s(`Gerado em ${r.geradoEm}. Arquivo LOCAL (contém R$ absolutos): não copiar para o repositório.`);
  for (const x of avisoAncora(r.modoAncora)) s(x);

  const principalOficial = r.modoAncora === 'oficial';
  secoesDoBloco(r, r, s, {
    h: '##', prefixo: '', oficial: principalOficial, rotuloNaoOficial: ROTULO_R30,
    extrasVeredito: [...avisoAncora(r.modoAncora), ...causaOficial(r)],
  });

  const a = r.avaliacao;

  // 7. paridade
  const g = r.paridade.gate;
  const p1 = r.paridade.f0.primaria;
  const p2 = r.paridade.f0.secundaria;
  s('## 7. Paridade do F0');
  s(
    `Primária (R19, view de produção no instante da extração): ES ${pct(g.es, 1)} · PP ${pct(g.pp, 1)} · máximo ${pct(g.max, 1)} (n = ${p1.skusComparaveis}); ` +
      `valor de máximo divergente ${pct(g.valor, 2)} do máximo total (${brl(p1.valorDeltaMaximoDivergente)} de ${brl(p1.valorMaximoTotal)}); status OK ${p1.statusConcorda?.n ?? 'n/d'}/${p1.statusConcorda?.de ?? 'n/d'}. ` +
      `Secundária (gravado): ES ${pct(p2.comparados.es ? p2.dentro.es / p2.comparados.es : null, 1)} · PP ${pct(p2.comparados.pp ? p2.dentro.pp / p2.comparados.pp : null, 1)} · máximo ${pct(p2.comparados.max ? p2.dentro.max / p2.comparados.max : null, 1)}; valor ${pct(p2.valorMaximoTotal > 0 ? p2.valorDeltaMaximoDivergente / p2.valorMaximoTotal : null)}.`,
  );
  s(`Quantidade (R21): decisão com PP/máximo gravados ${g.decisao.n}/${g.decisao.de}; com o estado do replay ${g.estado.n}/${g.estado.de}.`);
  const ep = g.estadoPopulacao;
  const fr = (x: { n: number; de: number }) => `${x.n}/${x.de}`;
  s(
    `Estado da população simulada (N5, ${ep.donos} donos, com ou sem sugestão positiva; limiar ${pct(PARIDADE_MINIMA_RELATORIO, 0)}): replay × gravado ES ${fr(ep.gravado.es)} · PP ${fr(ep.gravado.pp)} · máximo ${fr(ep.gravado.max)} ` +
      `(sem estado gravado, fora do denominador — M3: ES ${ep.semGravado?.es ?? 'n/d'} · PP ${ep.semGravado?.pp ?? 'n/d'} · máximo ${ep.semGravado?.max ?? 'n/d'}); ` +
      `sugestão do replay × view ES ${fr(ep.view.es)} · PP ${fr(ep.view.pp)} · máximo ${fr(ep.view.max)}. Decisões de NÃO comprar provadas sem a posição do motor (informativo, R48; PP do replay < gravado, ou PP igual e máximo na tolerância da paridade): ${fr(g.naoComprar)} — ` +
      `**PP do replay > gravado entre os que não compram (o caso que pode virar compra que a produção não fez): ${g.naoComprar.ppAcima ?? 'n/d'}** · sem PP gravado ${g.naoComprar.semGravado ?? 'n/d'} · não F0 ${g.naoComprar.naoF0 ?? 'n/d'}` +
      (g.naoComprar.divergentes.length === 0 ? '.' : ` — divergentes: ${g.naoComprar.divergentes.map((d) => `${d.sku} (replay ${d.estado ? `${d.estado.pp}/${d.estado.max}` : 'n/d'} × gravado ${d.gravado.pp ?? 'n/d'}/${d.gravado.max ?? 'n/d'})`).join(', ')}.`),
  );
  s(
    `Gate (achado 8): status OK ${g.status ? `${g.status.n}/${g.status.de}` : 'n/d'} · presença na view replay × produção ${g.cobertura.view.n}/${g.cobertura.view.de} · ` +
      `linhas de sugestao_hoje comparáveis ${g.cobertura.decisao.n}/${g.cobertura.decisao.de} · parâmetros do gate = os do mapa do baseline ${g.paramsBaseline.n}/${g.paramsBaseline.de}.`,
  );
  const linhaDiv = (d: GateParidade['estado']['divergentes'][number]) =>
    `- ${d.sku}${d.dono !== d.sku ? ` (dono ${d.dono})` : ''}: replay ${d.replay ?? 'n/d'} × prod ${d.qtdeFinal}; PP/máx do replay ${d.estado ? `${d.estado.pp}/${d.estado.max}` : 'n/d'} × gravados ${d.gravado.pp ?? 'n/d'}/${d.gravado.max ?? 'n/d'}`;
  s(
    g.estado.divergentes.length === 0
      ? 'Divergência de estado (donos na população simulada): nenhuma.'
      : [
          'Divergência de estado (donos na população simulada; só passa a divergência PROVADA da allowlist — M2):',
          ...g.estado.divergentes.map((d) => {
            const p = r.paridade.allowlistEstado[d.sku];
            return `${linhaDiv(d)} — ${p ? `allowlist: ${p.justificativa}` : '**FORA DA ALLOWLIST**'}`;
          }),
        ].join('\n'),
  );
  const fora = g.estadoForaDaPopulacao;
  s(
    `Estado nos donos FORA da população simulada (R42, informativo; o baseline não usa esses parâmetros): ${fora.n}/${fora.de}` +
      (fora.divergentes.length === 0 ? '.' : ['; divergentes:', ...fora.divergentes.map(linhaDiv)].join('\n')),
  );
  s('Parâmetros do gate (M3): o preComputar do F0 do baseline estendido até a data da decisão (a da extração, dia de SP — R40); a coluna "parâmetros do baseline" confere que ele é idêntico ao mapa simulado em todos os dias úteis da avaliação.');
  s(
    tabela(
      ['Bloco', 'SKU', 'Campo', 'Referência', 'Calculado', 'Impacto (R$)', 'Causa'],
      [...p1.divergencias.map((d) => ['primária', d]), ...p2.divergencias.map((d) => ['secundária', d])].map(([b, d]) => {
        const x = d as RelatorioParidade['primaria']['divergencias'][number];
        return [b as string, x.sku, x.campo, String(x.referencia), String(x.calculado ?? 'n/d'), brl(x.impactoValor), x.causa];
      }),
    ),
  );
  s(tabela(['SKU', 'Posição', 'qtde_final prod', 'Replay (estado)', 'Gravado (decisão)', 'Fora'], r.paridade.quantidade.linhas.map((l) => [l.sku, String(l.posicao), String(l.qtdeFinal), String(l.replay ?? 'n/d'), String(l.gravado ?? 'n/d'), l.fora ?? '—'])));

  // 8. excluídos
  s('## 8. Excluídos, parados e negativos');
  s(`Coorte: ${r.coorte.populacao} SKUs (${r.coorte.alterados} alterados); todos os ativos: ${r.coorte.todos}.`);
  const porMotivo = new Map<string, number>();
  for (const e of r.excluidosDados) porMotivo.set(e.motivo, (porMotivo.get(e.motivo) ?? 0) + 1);
  s(`Fora do contrato de unidade/dados: ${[...porMotivo].map(([m, n]) => `${m} ${n}`).join(' · ') || 'nenhum'}.`);
  s(`Demanda via insumo (R16): ${r.coorte.excluidosInsumo.map((e) => `${e.sku} (${pct(e.shareInsumo, 0)})`).join(', ') || 'nenhum'}.`);
  if (a) {
    const et = a.existenciaTardia;
    s(`SKUs que só existem a partir do 1º evento real (R53): ${et.length} — pelo recebimento ${et.filter((x) => x.via === 'recebimento').length}, pela venda ${et.filter((x) => x.via === 'venda').length}, nunca ${et.filter((x) => x.via === null).length}.`);
    s(`Fora da simulação: ${a.excluidosSimulacao.map((e) => `${e.sku} ${e.motivo}`).join(', ') || 'nenhum'}. SKUs sem preço de capital em algum dia (nem cmc, nem cmc Omie datado, nem preco_compra_real; R44/R45): ${a.skusSemCmc.join(', ') || 'nenhum'}. SKUs valorados pelo cmc Omie datado (R45): ${a.skusCmcOmie.length}; pelo preco_compra_real (R44): ${a.skusCompraReal.length}. Linhas com quantidade ≤ 0 ignoradas: ${a.linhasIgnoradas}.`);
  }
  s(`Avisos da carga: ${r.avisos.map((x) => `${x.codigo} ${x.n}`).join(' · ') || 'nenhum'}.`);
  const nf = r.avisos.find((x) => x.codigo === 'PEDIDA_DA_NF')?.n ?? 0;
  s(`**R46** — ${nf} item(ns) de LT sem a quantidade do pedido de compra (\`PEDIDA_DA_NF\`) ficam FORA da amostra do sorteio de LT da simulação (falta evidência de que fecharam); a sensibilidade com eles DENTRO são as linhas \`…/empirico_com_nf/…\` das tabelas de células e de capital (fora do veredito). O LT do F0 (view, R43) não muda.`);
  {
    // achado 14 (§5.1.1): a rodada só chega aqui com a divergência ≤ 5% do valor A
    const vc = r.validacaoClasse;
    s(
      `Validação de classe (§5.1.1, efetiva recalculada na extração × classe de hoje, ponderada pelo valor de 90 dias): A ${pct(vc.porClasse.A === null ? null : vc.porClasse.A / 100)} · B ${pct(vc.porClasse.B === null ? null : vc.porClasse.B / 100)} · C ${pct(vc.porClasse.C === null ? null : vc.porClasse.C / 100)} do valor diverge; ` +
        `valor A divergente ${pct(vc.valorADivergente === null ? null : vc.valorADivergente / 100)} (máximo 5%). ${vc.detalhe.skusDivergentes}/${vc.detalhe.skusComparados} SKUs divergentes (${vc.detalhe.skusDivergentesNaClasseA} envolvendo A); ${vc.detalhe.skusSemClasseReconstruida} sem classe reconstruída.`,
    );
  }
  {
    // Âncora do estado inicial (R31, revisão M3): de onde vem a abertura e a conferência 31/01 → 30/04 contra o Omie.
    const ei = r.estadoInicial;
    s(
      ei.ancora === 'posicao_omie'
        ? 'Âncora do estado inicial: posição datada do Omie na véspera do aquecimento (medida, sem ajuste; R31).'
        : 'Âncora do estado inicial: **saldo de hoje (modo legado)** — a abertura DEPENDE da avaliação (§5.9 não atendida); falta a posição datada do Omie.',
    );
    const c = ei.conferencia;
    s(
      c === null
        ? 'Conferência da reconstrução contra o Omie: sem as posições de 31/01 e 30/04 (não medida).'
        : `Conferência ${c.de} → ${c.ate} (posição Omie + eventos contra posição Omie): ${c.batem}/${c.total} SKUs batem (${pct(c.pctBatem, 1)}); ${c.divergentes.length} divergentes.`,
    );
  }
  s(`Estado inicial: ${r.estadoInicial.fecham}/${r.estadoInicial.total} fecham (${pct(r.estadoInicial.pctFecham, 1)}); ${r.estadoInicial.ajustes.length} com ajuste da calibração; ${r.estadoInicial.semSaldo.length} sem saldo.`);
  s(`Parados (${r.parados.length}; ${r.parados.filter((x) => x.compradoUltimos90d).length} comprados nos 90 dias antes do corte):`);
  s(
    tabela(
      ['SKU', 'Semanas com venda', 'Última venda', 'Última compra', 'Comprado 90d', 'Habilitado', 'Classe', 'Estoque a CMC (hoje)'],
      r.parados.map((x) => [x.sku, String(x.semanasComVenda), x.ultimaVenda ?? '—', x.ultimaCompra ?? '—', x.compradoUltimos90d ? 'sim' : 'não', x.habilitado ? 'sim' : 'não', x.classe ?? '—', brl(x.estoqueCmc)]),
    ),
  );
  s(`Negativos na avaliação (reportados, nunca ajustados): ${r.negativos.length}.`);
  if (r.negativos.length > 0) s(tabela(['SKU', 'Pior dia', 'Saldo (unid.)'], r.negativos.map((n) => [n.sku, n.data, num(n.valor, 2)])));

  // 9. chave e precisão
  s('## 9. Chave de cache e precisão');
  s('```json\n' + JSON.stringify(r.chave, null, 2) + '\n```');
  if (a) {
    s(`Replicações: ${a.reps} (teto 1.000). Meia largura MC (Δ pareado, pior célula/cenário): serviço ${pp(a.meiaLarguraServico, 3)} (alvo 0,1 p.p.), estoque ${pp(a.meiaLarguraEstoque, 3)} (alvo 1 p.p.).`);
    const comNulo = a.nulos.filter((n) => n.nulos[4] > 0 || n.nulos[8] > 0);
    s(`Reamostragens null do bootstrap (de 2.000 por bloco): ${comNulo.length === 0 ? 'nenhuma em nenhuma célula' : ''}`);
    s(tabela(['Cenário', 'Item', 'Null (bloco 4)', 'Null (bloco 8)'], a.nulos.map((n) => [n.cenario, n.item, String(n.nulos[4]), String(n.nulos[8])])));
  }
  s(`Tempo total: ${num(r.segundos, 1)} s. Etapas: ${Object.entries(r.tempos).map(([k, v]) => `${k} ${num(v, 1)} s`).join(' · ')}.`);

  // 10. limites
  s('## 10. Limites (spec §10 e rulings)');
  s(LIMITES.map((l) => `- ${l}`).join('\n'));

  // 11. rodada informativa (R27)
  s(`## ${tituloSecaoInformativa(r.veredito.veredito, r.modoAncora)}`);
  s(`Alvo e tabela §6.1 SÓ nas células *_alt (alvo_alt = max(piso, fill do F0 em X_alt − 0,25 p.p.)): a simulação contém só a população ALTERADA (os intermitentes que trocam de fórmula), então as células A/B/C coincidem com A_alt/B_alt/C_alt e capital, estresse e economia são medidos nessa população. Mesma grade, descida, validação conjunta, regra de escolha, reps até a precisão e bootstrap 4/8. Não substitui nem relativiza o veredito ${principalOficial ? 'oficial' : 'da rodada principal'}.`);
  const d = r.diagnostico;
  if (d) {
    s('### 11.0 Diagnóstico de plausibilidade (calibração, F0)');
    s(`Fill de A: total ${pct(d.fillF0A.total)} · alterados ${pct(d.fillF0A.alterados)} (${d.fillF0A.linhasAlterados} linhas) · suaves ${pct(d.fillF0A.suaves)} (${d.fillF0A.linhasSuaves} linhas).`);
    s(`Fill semanal de A: ${d.semanalA.map((w) => `${w.semana.slice(5)} ${pct(w.fill, 1)}`).join(' · ')}.`);
    const base = d.demandaA[0]?.unidades ?? 0;
    s(`Demanda de A por mês (unidades; razão contra o 1º mês): ${d.demandaA.map((m) => `${m.mes} ${num(m.unidades, 0)}${base > 0 ? ` (${num(m.unidades / base, 2)}×)` : ''}`).join(' · ')}. A média de 90 dias do F0 demora a acompanhar a alta.`);
    s(`LT nos pedidos de A desde ${d.lt.desde} (F0, rep 0, ${d.lt.pedidos} pedidos): sorteado médio ${d.lt.sorteadoMedio === null ? 'n/d' : num(d.lt.sorteadoMedio, 1)} du × parâmetro médio do F0 ${d.lt.parametroMedio === null ? 'n/d' : num(d.lt.parametroMedio, 1)} du.`);
    s(`Operação real × F0 simulado (calibração): estoque médio real ${d.real.estoqueReal === null ? 'n/d (estoque sem preço na calibração — nunca o subtotal valorado)' : brl(d.real.estoqueReal)} × F0 ${d.real.estoqueF0 === null ? 'n/d (estoque sem CMC na calibração)' : `${brl(d.real.estoqueF0)}${d.real.estoqueReal === null ? '' : ` (${num(d.real.estoqueReal / d.real.estoqueF0, 2)}×)`}`}; recebido real ${num(d.real.recebidoReal, 0)} × F0 ${num(d.real.recebidoF0, 0)} unidades (${num(d.real.recebidoReal / d.real.recebidoF0, 2)}×). A operação compra acima da sugestão do motor (a paridade de ES/PP/máximo passa), então o F0 simulado é o motor ao pé da letra, não a operação.`);
  }
  if (r.informativoErro) s(`**A rodada informativa falhou** (o veredito ${principalOficial ? 'oficial' : 'da rodada principal'} acima não é afetado): ${r.informativoErro}`);
  if (r.informativo) secoesDoBloco(r, r.informativo, s, { h: '###', prefixo: '11.', oficial: false, extrasVeredito: ['**NÃO OFICIAL (R27)** — alvo e critérios nas células *_alt; população simulada = só os alterados.'] });
  else if (!r.informativoErro) s('Rodada informativa não executada.');
  return out.join('\n');
}

const RAIZ_REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '../..'));

/** Grava o relatório. Recusa caminho dentro do repositório (repo público; o relatório tem R$ absolutos). */
export function escreverRelatorio(r: Rodada, arquivo: string): void {
  const rel = relative(RAIZ_REPO, resolve(arquivo));
  if (!rel.startsWith('..') && !rel.startsWith('/')) throw new Error(`RELATORIO_DENTRO_DO_REPO:${arquivo}`);
  mkdirSync(dirname(arquivo), { recursive: true });
  writeFileSync(arquivo, montarRelatorio(r));
}
