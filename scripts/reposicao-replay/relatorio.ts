// Relatório do replay TSB (plano, Task 9). Vai SÓ para $REPLAY_DADOS/relatorio.md (tem R$ absolutos): NUNCA no
// repositório. Sem nome nem CNPJ de cliente (só código de SKU). Título com o nome obrigatório da métrica (spec §5.7).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CenarioLT } from './aleatorio';
import type { ResultadoCalibracao } from './calibracao';
import type { Criterio } from './estatistica';
import type { Formula, ParamsFormula, RelatorioParidade } from './formulas';
import type { GradeCusto } from './metricas';
import type { DiagnosticoEstadoInicial } from './reconstrucao';
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
    gate: { es: number | null; pp: number | null; max: number | null; valor: number | null; decisao: { n: number; de: number }; estado: { n: number; de: number } };
    gatePassa: boolean;
  };
  calibracao: { alvo: Record<Classe, number | null>; fillF0: Record<Classe, number | null>; resultados: ResultadoCalibracao[]; candidata: Formula | 'NENHUMA' };
  fronteira: { formula: Formula; params: ParamsFormula; fill: Record<Classe | 'total', number | null>; reducao: number }[];
  excluidosDados: { sku: string; motivo: string }[];
  avisos: AvisoDados[];
  parados: Parado[];
  negativos: { sku: string; data: Data; valor: number }[];
  estadoInicial: DiagnosticoEstadoInicial;
  congelado: { candidata: Formula; params: ParamsFormula } | null;
  veredito: { veredito: VereditoReplay; motivos: string[] };
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
    capital: { cenario: CenarioR; estoqueF0: number; estoqueAlt: number; reducao: IntervaloPorBloco }[];
    terminal: { cenario: CenarioR; f0: Pick<SomasSemanais, 'terminal' | 'balanco'>; alt: Pick<SomasSemanais, 'terminal' | 'balanco'> }[];
    equilibrio: { falta: Falta; valor: number | null }[];
    dio: { f0: number; alt: number; linhasSemCmc: number } | null;
    suaves: { n: number; f0: { linhas: number; fill: number | null }; fnPura: { linhas: number; fill: number | null } };
    nulos: { cenario: string; item: string; nulos: Record<4 | 8, number> }[];
    skusSemCmc: string[];
    excluidosSimulacao: { sku: string; motivo: string }[];
    linhasIgnoradas: number;
  } | null;
  tempos: Record<string, number>;
  segundos: number;
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

/** Limitações a DECLARAR (spec §10 + rulings do controlador). */
export const LIMITES: readonly string[] = [
  '**12 meses de histórico** (spec §10): 6 meses de avaliação, poucos blocos longos; intervalos largos → INCONCLUSIVO é desfecho legítimo.',
  '**Demanda censurada** (spec §10): a métrica é o atendimento das linhas FATURADAS; espera, substituição e venda perdida originais não aparecem.',
  '**Estado inicial** (spec §5.2/§10): parte dos SKUs não fecha a reconstrução; o veredito é recomputado com `piso_zero` (linha "Estado inicial").',
  '**Seleção retrospectiva da coorte** (spec §5.1.1): o flag de reposição automática é o de hoje; a conclusão vale para a coorte habilitada hoje e não é confirmatória. "Todos os ativos" é sensibilidade (R11: definição composta do motor, menor que a contagem frouxa da spec).',
  '**R19** — a paridade primária do F0 é contra a VIEW de produção no instante da extração (fórmula × fórmula); o gravado em `sku_parametros` é paridade secundária (defasagem da passada das ~01:15, cold start e fusível = estado irredutível).',
  '**R21** — paridade da DECISÃO de compra 8/8 com o PP/máximo gravados; a paridade de ESTADO é 7/8: o SKU 8689783095 teve edição humana (edicao_manual 2026-05-15, aprovacao_humana 05-22/05-27), fora da fórmula. Afeta igualmente os dois braços.',
  '**R22** — galões não ativos ficam fora da simulação; "com substituição" é exata na coorte e a posição do grupo só soma os membros simulados (grupos = 3,12% do estoque). A métrica de substituição tem pouca informação.',
  '**R23** — viés de LT por censura à direita (só documentos com t4 ≤ fim da janela perto de 30/04) e o aquecimento (out–dez/25) sorteia documentos de jan/26: LT levemente otimista no fim da calibração, igual nos dois braços.',
  '**R24** — cancelada sem CMC: margem desconhecida limitada a [0, valor] e custo no PIOR CASO PARA A ALTERNATIVA (margem = valor na alternativa, 0 no F0); o piso 0 do F0 supõe margem ≥ 0. A fração limitada aparece em % nas linhas do critério 5.',
  '**Terminal constante no bootstrap** (Task 7): o custo terminal (backlog do fim custeado como emergencial + atraso) entra uma vez, não é reamostrado — estreita levemente o IC do custo.',
  '**R25** — critério 3 (capital) e a redução do estresse avaliados nos TRÊS cenários de falta; qualquer FALHA → NO-GO.',
  '**R26** — critério 5 no gate só com a taxa de 25% a.a. (grade 3×3 × 3 cenários); 20% e 30% são sensibilidade (tabela à parte).',
  '**Capital da avaliação a CMC de hoje** como numerário constante (na calibração, o último cmcLinha ≤ 30/04); SKU sem CMC fica fora do capital (listado).',
  '**LT exógeno**: as fórmulas aprendem LT só de recebimentos históricos com t4 < d, nunca de chegadas simuladas (permite pré-computar os níveis).',
  '**Sem feriados** no calendário de LT/revisão (como `dias_uteis_entre` da produção).',
  '**O replay não mede a operação real** (spec §10): separação, aceitação de troca — cabe à sombra e ao piloto. Um GO autoriza sombra/piloto, não a troca do motor.',
  '**Duplicatas de LT** (spec §10): o motor de produção deduplica por NFe/tracking (`v_sku_leadtime_efetivo`, verificado na Task 5) — sem item separado.',
];

export function montarRelatorio(r: Rodada): string {
  const out: string[] = [];
  const s = (x: string) => out.push(x, '');
  s(`# Replay TSB — ${r.nomeMetrica} (Sayerlack, OBEN)`);
  s(`Gerado em ${r.geradoEm}. Arquivo LOCAL (contém R$ absolutos): não copiar para o repositório.`);

  // 1. veredito
  s(`## 1. Veredito: **${r.veredito.veredito}**`);
  if (r.congelado) s(`Candidata congelada na calibração: **${r.congelado.candidata}** — \`${JSON.stringify(r.congelado.params)}\`.`);
  s(`Gate de paridade do F0: **${r.paridade.gatePassa ? 'PASSA' : 'FALHA'}** (detalhe na seção 7).`);
  if (r.veredito.motivos.length > 0) s(['Motivos (FALHAs, ou INCERTOs se não há FALHA):', ...r.veredito.motivos.map((m) => `- ${m}`)].join('\n'));
  if (r.avaliacao) {
    const cont = { PASSA: 0, FALHA: 0, INCERTO: 0 };
    for (const c of r.avaliacao.criterios) cont[c.estado]++;
    s(`Critérios: ${cont.PASSA} PASSA · ${cont.FALHA} FALHA · ${cont.INCERTO} INCERTO.`);
    s(tabela(['Critério', 'Estado', 'Motivo'], r.avaliacao.criterios.map((c) => [c.criterio, c.estado, c.motivo.replace(/\|/g, '/')])));
  }

  // calibração
  s('### Calibração (janela 2026-02-01→04-30, 50 reps, LT empírico, espera)');
  s(`Alvo por classe = max(piso, fill F0 − 0,25 p.p.): ${(['A', 'B', 'C'] as const).map((c) => `${c} ${pct(r.calibracao.alvo[c])} (F0 ${pct(r.calibracao.fillF0[c])})`).join(' · ')}.`);
  s(
    tabela(
      ['Fórmula', 'Variante', 'Quantis A/B/C', 'Inviável', 'Fill A/B/C', 'Redução de estoque vs F0', 'Trios avaliados'],
      r.calibracao.resultados.flatMap((x) =>
        x.tentativas.map((t) => [
          x.formula,
          t.params.beta !== undefined ? `β ${t.params.beta}` : t.params.janelaDias !== undefined ? `janela ${t.params.janelaDias} du` : '—',
          `${t.params.quantil.A} / ${t.params.quantil.B} / ${t.params.quantil.C}`,
          t.inviavel ? 'sim' : 'não',
          `${pct(t.fill.A)} / ${pct(t.fill.B)} / ${pct(t.fill.C)}`,
          pct(1 - t.estoqueMedio / x.estoqueF0),
          String(t.avaliacoes),
        ]),
      ),
    ),
  );
  s(`Escolhida: **${r.calibracao.candidata}** (menor estoque viável; uma mais simples, F1 < F3 < F2, a ≤ 1 p.p. de capital fica com a vaga).`);

  // 3. fronteira (sempre: vem da calibração)
  const secaoFronteira = (): void => {
    s('## 3. Fronteira capital × fill rate (informativa; janela de calibração, quantil uniforme nas 3 classes, 50 reps)');
    s('Varre o MESMO quantil nas três classes (0,90 a 0,999) com o β/janela calibrados; NÃO é a recalibração por alvo de fill de 90% a 99,5% da spec §5.3 (aproximação declarada).');
    s(
      tabela(
        ['Fórmula', 'Variante', 'Quantil', 'Fill total', 'Fill A', 'Fill B', 'Fill C', 'Redução de estoque vs F0'],
        r.fronteira.map((f) => [
          f.formula, f.params.beta !== undefined ? `β ${f.params.beta}` : `janela ${f.params.janelaDias ?? '—'} du`, String(f.params.quantil.A),
          pct(f.fill.total), pct(f.fill.A), pct(f.fill.B), pct(f.fill.C), pct(f.reducao),
        ]),
      ),
    );
  };

  const a = r.avaliacao;
  if (a) {
    // 2. células
    s(`## 2. Células × fórmula × cenário (ponto | LI | LS; LI = min(LI4, LI8), LS = max(LS4, LS8))`);
    s(`Replicações: ${a.reps}. Fill = Σ linhas integralmente atendidas no dia ÷ Σ linhas (nunca média de % por SKU).`);
    s(
      tabela(
        ['Cenário', 'Célula', 'Linhas', 'F0 ponto', 'F0 LI', 'F0 LS', 'Cand. ponto', 'Cand. LI', 'Cand. LS', 'Δ ponto', 'Δ LI', 'Δ LS'],
        a.celulas.map((c) => [rotCen(c.cenario), c.celula, String(c.linhas), ivPct(c.f0), ivPct(c.alt), ivPp(c.delta === null ? null : comb(c.delta))]),
      ),
    );
    s('### Capital (estoque físico médio a CMC, ponderado por dias corridos)');
    s(
      tabela(
        ['Cenário', 'Estoque médio F0', 'Estoque médio cand.', 'Redução ponto', 'LI', 'LS'],
        a.capital.map((c) => [rotCen(c.cenario), brl(c.estoqueF0), brl(c.estoqueAlt), ivPct(comb(c.reducao))]),
      ),
    );
    if (a.dio) s(`DIO Sayerlack (reconstruído/empírico/espera, CMV = Σ cmcLinha × qtd da coorte na avaliação): F0 ${num(a.dio.f0, 1)} dias · candidata ${num(a.dio.alt, 1)} dias (${a.dio.linhasSemCmc} linhas sem cmc fora do CMV).`);

    secaoFronteira();

    // 4. custo
    s('## 4. Grade de custo (economia líquida, positivo = candidata vantajosa) e custo de falta de equilíbrio');
    s('Gate (critério 5, R26): taxa 25% a.a.; emergencial 5/10/20% × atraso 0/0,5/1% por linha-dia; cenários espera, cancelamento e misto (60/30/10).');
    s(
      tabela(
        ['Falta', 'Emergencial', 'Atraso/dia', 'Custo ponto', 'LI', 'LS', 'Linhas com margem limitada (R24)', 'Valor com margem limitada'],
        a.blocos.economia.map((e) => {
          const lin = e.linhasDemandadas ? e.linhasMargemLimitada / e.linhasDemandadas : null;
          const val = e.valorDemandado ? e.valorMargemLimitada / e.valorDemandado : null;
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
    s('## 5. Balanço terminal e fechamento (média das reps)');
    s('O fechamento por SKU (demanda = imediata + tardia + emergencial + cancelada + backlog; estoque inicial + recebido − entregue = final) é verificado em CADA simulação (fail-closed): a rodada não termina se violar.');
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
    s('## 6. Sensibilidades');
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
    s('Substituição de embalagem (reconstruído/empírico; R22: pouca informação):');
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
    s('## 2. Células × fórmula × cenário');
    s(naoAval);
    secaoFronteira();
    for (const t of ['4. Grade de custo e custo de falta de equilíbrio', '5. Balanço terminal e fechamento', '6. Sensibilidades']) {
      s(`## ${t}`);
      s(naoAval);
    }
  }

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
    s(`Fora da simulação: ${a.excluidosSimulacao.map((e) => `${e.sku} ${e.motivo}`).join(', ') || 'nenhum'}. SKUs sem CMC (fora do capital): ${a.skusSemCmc.join(', ') || 'nenhum'}. Linhas com quantidade ≤ 0 ignoradas: ${a.linhasIgnoradas}.`);
  }
  s(`Avisos da carga: ${r.avisos.map((x) => `${x.codigo} ${x.n}`).join(' · ') || 'nenhum'}.`);
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
