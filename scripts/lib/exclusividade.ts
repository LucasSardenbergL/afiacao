/**
 * exclusividade.ts — logica PURA da matriz `defeito x gate`.
 * =========================================================
 *
 * ## O buraco que isto tapa
 *
 * O custo de um gate e medido para sempre (segundos no log, a cada PR). O beneficio nao e medido
 * em lugar nenhum. Com um lado da conta visivel e o outro nao, "criar mais um gate" e sempre a
 * escolha barata — e em 3 semanas 15 comandos-gate entraram no `ci.yml`, com o job
 * `gates-e-falsificacao` crescendo 4,4x em 11 dias.
 *
 * A grandeza que faltava e a **contribuicao exclusiva**: dado um corpus de defeitos reais, quais
 * deles SO este gate pega.
 *
 *     gatesQueReprovaram(d) = { g : g fica vermelho com o defeito d aplicado }
 *     exclusivoDe(g)        = { d : gatesQueReprovaram(d) == {g} }
 *
 * ## O que `exclusivoDe(g)` vazio significa — e o que NAO significa
 *
 * Significa **apenas**: *neste corpus de N defeitos, tudo que `g` pega, outro gate tambem pega.*
 *
 * NAO significa "o gate nunca pegou nada". Essa foi a correcao no 1 do parecer do Codex e e a
 * armadilha no 1 do repo: `docs:links` tem dez links quebrados no proprio historico, e mesmo assim
 * nao apareceu numa janela de 80 runs — janela curta nao mede evento raro. Por isso `resumir()`
 * carrega o denominador junto do numero, e nenhuma funcao daqui devolve a string "nao pega nada".
 *
 * ## Fronteira
 *
 * Este arquivo NAO executa gate, nao muta arquivo e nao escreve em disco. Toda a sujeira (aplicar
 * sabotagem, rodar subprocesso, restaurar) vive em `scripts/exclusividade-medir.ts`. E o que faz a
 * derivacao ser testavel em vitest sem rodar um unico gate — e o que permite ao gate barato do CI
 * dar veredito lendo so o JSON.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { parse } from 'yaml';

import { inventarioCI, type GateCI } from '../gates-frescura-check';

export const MATRIZ_PATH = 'scripts/exclusividade-matriz.json';
export const CORPUS_DIR = 'scripts/exclusividade.d';
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Corpus — o formato `.def`
// ---------------------------------------------------------------------------------------------

export interface Defeito {
  id: string;
  /** Arquivo REAL do repo que a sabotagem muta. Raiz sintetica nao serve — ver cabecalho do .def. */
  alvo: string;
  /** Expressao `perl -pe`. Pode conter '|' (alternation) — por isso e sempre o 3o campo, o resto. */
  perl: string;
  arquivo: string;
  linha: number;
  origem: string | null;
  /** Quem o AUTOR acha que pega. NUNCA poda a medicao — so entra no relatorio como declarado x medido. */
  suspeito: string | null;
}

/**
 * Parser do `.def`. Herda do `.mut` o separador '|' e a regra "o 3o campo e o RESTO", porque a
 * expressao perl legitimamente contem '|'. Um split ingenuo em 3 partes truncaria a regex no meio
 * e a sabotagem viraria uma nao-aplicacao silenciosa — que o motor classifica como INVALIDA, mas
 * so depois de ter gasto a execucao de todos os gates.
 */
export function parseDefeitos(texto: string, arquivo: string): Defeito[] {
  const saida: Defeito[] = [];
  let origem: string | null = null;
  let suspeito: string | null = null;

  texto.split('\n').forEach((bruta, i) => {
    const linha = bruta.trim();
    if (!linha) return;
    if (linha.startsWith('#')) {
      const mo = linha.match(/@origem:\s*(.+)$/);
      if (mo) origem = mo[1].trim();
      const ms = linha.match(/@suspeito:\s*(.+)$/);
      if (ms) suspeito = ms[1].trim();
      return;
    }
    const corte1 = linha.indexOf('|');
    if (corte1 < 0) return;
    const corte2 = linha.indexOf('|', corte1 + 1);
    if (corte2 < 0) return;
    const id = linha.slice(0, corte1).trim();
    const alvo = linha.slice(corte1 + 1, corte2).trim();
    const perl = linha.slice(corte2 + 1).trim();
    if (!id || !alvo || !perl) return;
    saida.push({ id, alvo, perl, arquivo, linha: i + 1, origem, suspeito });
  });

  return saida;
}

// ---------------------------------------------------------------------------------------------
// Quais gates existem, e quais de fato BLOQUEIAM um PR
// ---------------------------------------------------------------------------------------------

export interface GateAlvo extends GateCI {
  /** True so se o job dele e alcancavel a partir de `validate.needs` (fecho transitivo). */
  bloqueiaPR: boolean;
}

/**
 * Fecho transitivo de `validate.needs`. Existe porque `inventarioCI` filtra `continue-on-error` no
 * **step** e isso nao ve a outra forma de ser informativo: um JOB inteiro fora de `validate.needs`.
 *
 * E exatamente o caso do `mutation-check` (`ci.yml:921`), deliberadamente informativo e abrindo
 * Issue desde o #2344 — que `inventarioCI` hoje lista junto dos bloqueantes. Derivar do grafo, em
 * vez de manter uma lista de excecoes, e o que impede este censo de envelhecer como envelheceu o
 * censo datado de 15 nomes que originou o `gates:frescura`.
 */
export function jobsBloqueantes(fonteCI: string): Set<string> {
  const doc = parse(fonteCI) as { jobs?: Record<string, { needs?: unknown }> };
  const jobs = doc.jobs ?? {};
  const needsDe = (j: string): string[] => {
    const n = jobs[j]?.needs;
    if (typeof n === 'string') return [n];
    if (Array.isArray(n)) return n.filter((x): x is string => typeof x === 'string');
    return [];
  };
  const vistos = new Set<string>();
  const fila = [...needsDe('validate')];
  while (fila.length) {
    const j = fila.pop()!;
    if (vistos.has(j)) continue;
    vistos.add(j);
    fila.push(...needsDe(j));
  }
  return vistos;
}

export function gatesCandidatos(fonteCI: string): GateAlvo[] {
  const bloq = jobsBloqueantes(fonteCI);
  return inventarioCI(fonteCI).map((g) => ({ ...g, bloqueiaPR: bloq.has(g.job) }));
}

// ---------------------------------------------------------------------------------------------
// Fingerprints — o que faz uma linha da matriz APODRECER
// ---------------------------------------------------------------------------------------------

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

export const fingerprintDefeito = (d: Defeito): string => sha(`${d.alvo} ${d.perl}`);

export interface FonteDoGate {
  comando: string;
  arquivos: string[];
  /** False quando nenhum arquivo do comando pode ser resolvido no disco. */
  resolvida: boolean;
}

/**
 * Arquivos que compoem a fonte de um gate. Resolve o que e literal no comando do `package.json`
 * (`bun scripts/foo.ts`) e expande o laco `for t in a b c; do bash scripts/test-$t.sh` que
 * `test:hooks` e `test:falsificacao` usam — sem essa expansao os dois maiores gates do repo
 * ficariam com fonte vazia.
 *
 * Quando nada resolve, `resolvida: false` — e o eixo "apodreceu?" fica INDISPONIVEL para esse
 * gate, dito em voz alta no relatorio. Alegar frescor que nao se consegue verificar seria a mesma
 * falha aberta de sempre: silencio lido como aprovacao.
 */
export function fonteDoGate(nome: string, scripts: Record<string, string>, raiz = '.'): FonteDoGate {
  const comando = scripts[nome] ?? '';
  const arquivos = new Set<string>();

  // 1) laco `for X in a b c; do ... prefixo-$X-sufixo.sh` -> materializa cada item da lista.
  for (const laco of comando.matchAll(/for\s+(\w+)\s+in\s+([^;]+);\s*do\s+([^;]+)/g)) {
    const [, varNome, listaBruta, corpo] = laco;
    const itens = listaBruta.trim().split(/\s+/);
    const molde = corpo.match(new RegExp(`([\\w./-]*\\$(?:\\{${varNome}\\}|${varNome})[\\w./-]*)`));
    if (!molde) continue;
    for (const item of itens) {
      const p = molde[1].replace(new RegExp(`\\$\\{?${varNome}\\}?`), item);
      if (existsSync(`${raiz}/${p}`)) arquivos.add(p);
    }
  }

  // 2) caminhos literais.
  for (const m of comando.matchAll(/(?:^|[\s'"])([\w.-]+(?:\/[\w.$-]+)+\.(?:ts|sh|mjs|js))/g)) {
    if (m[1].includes('$')) continue;
    if (existsSync(`${raiz}/${m[1]}`)) arquivos.add(m[1]);
  }

  return { comando, arquivos: [...arquivos].sort(), resolvida: arquivos.size > 0 };
}

export function fingerprintGate(f: FonteDoGate, raiz = '.'): string {
  const corpos = f.arquivos.map((a) => {
    try {
      return `${a} ${sha(readFileSync(`${raiz}/${a}`, 'utf8'))}`;
    } catch {
      return `${a} ILEGIVEL`;
    }
  });
  return sha([f.comando, ...corpos].join('\n'));
}

// ---------------------------------------------------------------------------------------------
// A matriz
// ---------------------------------------------------------------------------------------------

export interface ExecucaoGate {
  gate: string;
  reprovou: boolean;
  ms: number;
  fingerprint: string;
  fonteResolvida: boolean;
}

export interface LinhaMatriz {
  defeito: string;
  defeitoFingerprint: string;
  alvo: string;
  suspeito: string | null;
  origem: string | null;
  execucoes: ExecucaoGate[];
  /**
   * True quando a medicao parou no 2o vermelho. Os gates nao rodados ficam DESCONHECIDOS —
   * jamais "nao reprovaram". Para exclusividade isso e seguro (>=2 vermelhos ja refuta), e e por
   * isso que a poda e honesta; mas afirmar o conjunto completo a partir de uma linha podada
   * seria fabricar ausencia, entao `derivar()` se recusa a fazer isso.
   */
  parouCedo: boolean;
  invalido: string | null;
}

export interface BaselineGate {
  gate: string;
  verde: boolean;
  ms: number;
}

export interface Matriz {
  schemaVersion: number;
  medidoEm: string;
  sourceHead: string;
  /**
   * Gates que ja existiam quando a maquina nasceu e ainda nao foram medidos. E DIVIDA DECLARADA,
   * nao isencao: um gate NOVO nao entra aqui sozinho, e acrescentar um nome a lista aparece no
   * diff do PR — que e o ponto, ja que o custo de um gate novo e justamente o que se quer visivel.
   */
  dispensados: { gate: string; desde: string; motivo: string }[];
  baseline: BaselineGate[];
  linhas: LinhaMatriz[];
}

/**
 * Funde a medicao NOVA de um defeito com a que ja estava na matriz, preservando as execucoes de
 * gates que a rodada nova nao incluiu.
 *
 * ## O bug que isto conserta (achado medindo, nao pensando)
 *
 * A fusao era por `defeito`: a linha nova substituia a antiga inteira. Com `--gates`, uma rodada
 * parcial de `indice-orfao` (so os gates de docs) apagou a execucao do `test` medida na rodada
 * anterior — e `docs:indice`, que a medicao com o vitest tinha mostrado CO-PEGADO, reapareceu no
 * relatorio como `[SO ELE]`.
 *
 * Ou seja: a forma mais cara de errar aqui, exclusividade FABRICADA a partir de dado que existia
 * e foi descartado. Fundir por `(defeito, gate)` mantem cada celula medida ate ser re-medida.
 *
 * `parouCedo` propaga por OU: uma linha que parou cedo em qualquer das rodadas nunca vira
 * exclusiva. Conservador de proposito — o erro tolerado e deixar de reconhecer um exclusivo, nunca
 * inventar um.
 */
export function fundirLinhas(antiga: LinhaMatriz | undefined, nova: LinhaMatriz): LinhaMatriz {
  if (!antiga) return nova;
  const porGate = new Map(antiga.execucoes.map((e) => [e.gate, e]));
  for (const e of nova.execucoes) porGate.set(e.gate, e);
  return {
    ...nova,
    execucoes: [...porGate.values()].sort((a, b) => a.gate.localeCompare(b.gate)),
    parouCedo: antiga.parouCedo || nova.parouCedo,
  };
}

export interface Exclusividade {
  gate: string;
  /** Defeitos em que ele foi o UNICO vermelho, com a linha rodada ate o fim. */
  exclusivos: string[];
  pegou: string[];
  naoMedido: string[];
  /**
   * True se ALGUM defeito do corpus declara este gate em `@suspeito` — ou seja, se o corpus
   * chegou a MIRAR nele.
   *
   * Sem esta distincao a ferramenta comete, contra si mesma, a falha que existe para evitar. Na
   * primeira medicao real o `test` (vitest) apareceu com exclusividade zero e foi rotulado
   * "redundante" — quando a verdade e que nenhum dos 6 defeitos do corpus era de codigo de
   * aplicacao. Zero ali nao media redundancia: media um corpus que nunca apontou para ele.
   *
   * `@suspeito` continua sem podar NADA da medicao — todo gate roda contra todo defeito. Ele so
   * decide como o RESULTADO e rotulado, que e a diferenca entre informar e enganar.
   */
  corpusMirou: boolean;
  msTotal: number;
  msMediana: number;
}

export function derivar(m: Matriz): Exclusividade[] {
  const porGate = new Map<string, Exclusividade>();
  const pega = (g: string): Exclusividade => {
    let e = porGate.get(g);
    if (!e) {
      e = {
        gate: g,
        exclusivos: [],
        pegou: [],
        naoMedido: [],
        corpusMirou: m.linhas.some((l) => l.suspeito === g),
        msTotal: 0,
        msMediana: 0,
      };
      porGate.set(g, e);
    }
    return e;
  };
  const duracoes = new Map<string, number[]>();

  // Todo gate do baseline entra no resultado, mesmo que nao apareca em nenhuma linha valida.
  // Sem isto, um gate cujas unicas linhas foram INVALIDADAS simplesmente sumia da derivacao — e
  // sumir do relatorio e a pior forma de exclusividade zero: a que nem se sabe que existe.
  for (const b of m.baseline) pega(b.gate);

  for (const linha of m.linhas) {
    const rodados = new Set(linha.execucoes.map((e) => e.gate));
    for (const b of m.baseline) if (!rodados.has(b.gate)) pega(b.gate).naoMedido.push(linha.defeito);

    if (linha.invalido) continue;
    const vermelhos = linha.execucoes.filter((e) => e.reprovou);
    // Linha podada nunca produz exclusivo: ela so existe porque >=2 gates ja ficaram vermelhos.
    const ehExclusiva = !linha.parouCedo && vermelhos.length === 1;

    for (const exec of linha.execucoes) {
      const e = pega(exec.gate);
      if (!duracoes.has(exec.gate)) duracoes.set(exec.gate, []);
      duracoes.get(exec.gate)!.push(exec.ms);
      e.msTotal += exec.ms;
      if (!exec.reprovou) continue;
      e.pegou.push(linha.defeito);
      if (ehExclusiva) e.exclusivos.push(linha.defeito);
    }
  }

  for (const [g, ds] of duracoes) {
    const ord = [...ds].sort((a, b) => a - b);
    pega(g).msMediana = ord.length ? ord[Math.floor(ord.length / 2)] : 0;
  }

  return [...porGate.values()].sort((a, b) => a.gate.localeCompare(b.gate));
}

// ---------------------------------------------------------------------------------------------
// Veredito (o que o gate barato do CI imprime)
// ---------------------------------------------------------------------------------------------

export type Severidade = 'REPROVA' | 'AVISA' | 'RELATA';

export type CodigoVeredito =
  | 'GATE_NOVO_SEM_EXCLUSIVIDADE'
  | 'MATRIZ_AUSENTE'
  | 'LINHA_PODRE'
  | 'EXCLUSIVIDADE_ZERO'
  | 'CORPUS_NAO_MIROU'
  | 'FRESCOR_INDISPONIVEL';

export interface Veredito {
  severidade: Severidade;
  gate: string;
  codigo: CodigoVeredito;
  motivo: string;
}

/**
 * A tabela de severidade, e por que ela nao e toda REPROVA:
 *
 *   gate NOVO sem linha exclusiva  -> REPROVA. E o objetivo declarado da maquina: quem acrescenta
 *                                    um gate paga a prova de que ele pega algo que ninguem pega.
 *   fonte do gate mudou            -> AVISA. Reprovar apodreceria a cada edicao de gate e viraria
 *                                    friccao que se contorna — sinal que ninguem le e pior que
 *                                    sinal nenhum, porque custa e ainda ensina a ignorar.
 *   exclusividade zero (existente) -> RELATA. Corte e decisao do founder; a ferramenta informa.
 */
export function avaliar(
  m: Matriz | null,
  gates: GateAlvo[],
  fpAtual: Map<string, { fingerprint: string; resolvida: boolean }>,
): Veredito[] {
  const out: Veredito[] = [];
  const candidatos = gates.filter((g) => g.bloqueiaPR);

  if (!m) {
    out.push({
      severidade: 'REPROVA',
      gate: '(todos)',
      codigo: 'MATRIZ_AUSENTE',
      motivo: `${MATRIZ_PATH} ausente ou ilegivel — rode \`bun run exclusividade:medir\`.`,
    });
    return out;
  }

  const dispensados = new Set(m.dispensados.map((d) => d.gate));
  const exclus = new Map(derivar(m).map((e) => [e.gate, e]));

  for (const g of candidatos) {
    const e = exclus.get(g.nome);
    const medido = e !== undefined && e.pegou.length + e.naoMedido.length > 0;

    if (!medido && !dispensados.has(g.nome)) {
      out.push({
        severidade: 'REPROVA',
        gate: g.nome,
        codigo: 'GATE_NOVO_SEM_EXCLUSIVIDADE',
        motivo:
          `gate bloqueante sem NENHUM defeito medido. Um gate custa segundos em todo PR, para ` +
          `sempre; a prova de que ele pega algo que os outros nao pegam e o preco. Escreva um ` +
          `defeito em ${CORPUS_DIR}/ e rode \`bun run exclusividade:medir\`.`,
      });
      continue;
    }
    if (!e) continue;

    const fp = fpAtual.get(g.nome);
    if (fp && !fp.resolvida) {
      out.push({
        severidade: 'AVISA',
        gate: g.nome,
        codigo: 'FRESCOR_INDISPONIVEL',
        motivo: 'nenhum arquivo-fonte resolvido a partir do comando — frescor NAO verificavel.',
      });
    } else if (fp) {
      const antigo = m.linhas.flatMap((l) => l.execucoes).find((x) => x.gate === g.nome)?.fingerprint;
      if (antigo && antigo !== fp.fingerprint) {
        out.push({
          severidade: 'AVISA',
          gate: g.nome,
          codigo: 'LINHA_PODRE',
          motivo: `a fonte mudou desde a medicao (${antigo} -> ${fp.fingerprint}); re-meca quando puder.`,
        });
      }
    }

    if (medido && e.exclusivos.length === 0 && e.pegou.length > 0) {
      // Zero so pode ser lido como REDUNDANCIA se o corpus chegou a mirar neste gate. Se nenhum
      // defeito o declara em `@suspeito`, o zero mede o corpus, nao o gate — e chamar isso de
      // redundancia seria a ferramenta cometendo contra si a falha que ela existe para evitar.
      out.push(
        e.corpusMirou
          ? {
              severidade: 'RELATA',
              gate: g.nome,
              codigo: 'EXCLUSIVIDADE_ZERO',
              motivo:
                `pegou ${e.pegou.length} de ${m.linhas.length} defeito(s) do corpus, e em NENHUM foi o ` +
                `unico — outro gate tambem pegou. Isto NAO e "nao pega nada": e redundancia medida ` +
                `NESTE corpus de ${m.linhas.length}.`,
            }
          : {
              severidade: 'RELATA',
              gate: g.nome,
              codigo: 'CORPUS_NAO_MIROU',
              motivo:
                `pegou ${e.pegou.length} defeito(s) de carona, mas NENHUM dos ${m.linhas.length} do ` +
                `corpus foi escrito mirando nele (@suspeito). Zero aqui mede o CORPUS, nao o gate — ` +
                `escreva um defeito do dominio dele antes de concluir qualquer coisa.`,
            },
      );
    }
  }
  return out;
}

/** Resumo humano. O denominador anda GRUDADO no numero — sem ele, zero le como "inutil". */
export function resumir(m: Matriz): string {
  const linhas = derivar(m)
    .filter((e) => e.pegou.length + e.exclusivos.length > 0 || e.naoMedido.length > 0)
    .map((e) => {
      const excl = e.exclusivos.length;
      const marca =
        excl > 0 ? '[SO ELE]' : !e.corpusMirou ? '[s/ mira]' : e.pegou.length > 0 ? '[redund]' : '[      ]';
      return (
        `${marca.padEnd(9)} ${e.gate.padEnd(34)} exclusivos ${String(excl).padStart(2)}/${m.linhas.length}` +
        ` - pegou ${String(e.pegou.length).padStart(2)} - mediana ${String(e.msMediana).padStart(6)}ms`
      );
    });
  return [
    `matriz de exclusividade — ${m.linhas.length} defeito(s) x ${m.baseline.length} gate(s), medida em ${m.medidoEm}`,
    ...linhas,
    `   [SO ELE]  = ha defeito que SO ele pega`,
    `   [redund]  = o corpus mirou nele e tudo que pega, outro tambem pega (NESTE corpus de ${m.linhas.length})`,
    `   [s/ mira] = nenhum defeito do corpus foi escrito para ele — zero aqui mede o CORPUS, nao o gate`,
  ].join('\n');
}
