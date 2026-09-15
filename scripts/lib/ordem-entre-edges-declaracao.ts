/**
 * ordem-entre-edges-declaracao.ts — a declaração de ordem entre edges no CORPO do PR (lógica pura,
 * sem fs/git/rede; a fiação é `scripts/ordem-entre-edges-declaracao.ts`).
 *
 * ## Por que existe
 *
 * O #2501 fez da ordem entre edges um ARTEFATO (`supabase/functions/<B>/deploy-ordem.json`), e o
 * `pendencias:pacote` passou a soltar a leva em ondas. Faltava o outro lado: quem escreve a ordem só
 * na prosa do PR e esquece o manifesto não via vermelho nenhum — foi o #2469. E prosa não serve de
 * bloqueio: em 400 PRs, 30 parágrafos com "≥2 edges + palavra de ordem" e UMA declaração real.
 *
 * ## A regra
 *
 * · EXIGIDA quando o PR muda o corpo de ≥2 edges (`contaComoCorpo`, o predicado do `sonda:bump`) ou
 *   toca um manifesto. `_shared/` fica fora, salvo `FATIAS_EM_SHARED`: contar o fan-out triplicaria a
 *   população (16 → 51 em 400 PRs) com a mesma uma declaração real.
 * · A declaração é UMA linha crua, fora de bloco cercado: `Ordem entre edges: nenhuma` ou
 *   `Ordem entre edges: a → b` (pares separados por `;` ou `,`; `a → b → c` é cadeia). Caixa fixa e
 *   sem decoração: a linha que só PARECE a declaração vira dica na mensagem, nunca declaração.
 * · Todo par declarado tem de estar no manifesto de `b` NO HEAD, e todo par que um manifesto GANHA no
 *   PR tem de estar declarado. Base ilegível conta tudo como novo: sem saber o que havia, vale a
 *   leitura mais exigente, nunca a que aprova por falta de dado.
 * · Duplicada e inválida reprovam mesmo fora da população: linha que a máquina não lê não fica no
 *   corpo com cara de declaração.
 *
 * Histórico, opções pesadas e residuais: `docs/historico/ordem-entre-edges-declaracao-no-pr.md`.
 */

import { contaComoCorpo, FATIAS_EM_SHARED, RAIZ_EDGES } from '../sonda-versao-bump-gate';

import { removerCercas } from './markdown-codigo';
import { caminhoDoManifesto, FORMATO_MANIFESTO, SLUG_EDGE } from './ordem-entre-edges';

/** O nome do job no workflow É o contexto que a branch protection exige: renomear um sem o outro solta o gate. */
export const CONTEXTO_OBRIGATORIO = 'ordem-entre-edges';
export const CAMINHO_WORKFLOW = '.github/workflows/ordem-entre-edges.yml';

interface Par {
  /** a predecessora: sobe e se prova antes */
  antes: string;
  /** a dependente: é no manifesto DELA que o par mora */
  depois: string;
}

type Declaracao = { tipo: 'nenhuma' } | { tipo: 'pares'; pares: Par[] };

type ValorLido = { ok: true; declaracao: Declaracao } | { ok: false; motivo: string };

/** Linha que parece a declaração e não é — só entra na mensagem, como dica. */
interface QuaseAcerto {
  linha: number;
  texto: string;
}

type Extracao =
  | { estado: 'ausente'; quaseAcertos: QuaseAcerto[]; cercaAbertaNaLinha: number | null }
  | { estado: 'duplicada'; linhas: number[] }
  | { estado: 'invalida'; linha: number; motivo: string }
  | { estado: 'valida'; linha: number; declaracao: Declaracao };

interface Populacao {
  edgesComCorpo: string[];
  manifestosTocados: string[];
  exigida: boolean;
}

export interface EntradaJulgamento {
  corpo: string;
  /** caminhos do diff base..HEAD, apagados inclusive */
  tocados: readonly string[];
  /** pastas com `index.ts` no HEAD */
  edgesNoHead: ReadonlySet<string>;
  /** edge dependente → predecessoras do manifesto legível */
  paresNoHead: ReadonlyMap<string, ReadonlySet<string>>;
  paresNaBase: ReadonlyMap<string, ReadonlySet<string>>;
  /** edge dependente → erro de `lerManifesto` */
  ilegiveisNoHead: ReadonlyMap<string, string>;
  ilegiveisNaBase: ReadonlyMap<string, string>;
}

type MarcaReprova =
  | 'ORDEM_DECLARACAO_AUSENTE'
  | 'ORDEM_DECLARACAO_DUPLICADA'
  | 'ORDEM_DECLARACAO_INVALIDA'
  | 'ORDEM_EDGE_INEXISTENTE'
  | 'ORDEM_MANIFESTO_AUSENTE'
  | 'ORDEM_MANIFESTO_SEM_PAR'
  | 'ORDEM_MANIFESTO_ILEGIVEL'
  | 'ORDEM_PAR_NAO_DECLARADO';

type MarcaAprova = 'ORDEM_NAO_EXIGIDA' | 'ORDEM_DECLARADA_NENHUMA' | 'ORDEM_DECLARADA_PARES';

interface Achado {
  marca: MarcaReprova;
  mensagem: string;
}

type Veredito =
  | { aprovado: true; marca: MarcaAprova; populacao: Populacao; notas: string[] }
  | { aprovado: false; achados: Achado[]; populacao: Populacao; notas: string[] };

/** Começa na coluna 1, com esta caixa; o valor é o resto da linha. */
const LINHA_DECLARACAO = /^Ordem entre edges:([\s\S]*)$/;
const SETA = /\s*(?:→|->)\s*/;

const FORMAS =
  'Formas aceitas: `Ordem entre edges: nenhuma` · `Ordem entre edges: a → b` (pares separados por `;`; `a → b → c` é cadeia).';

/** Ordem por código, não por locale: a saída é a mesma em `LC_ALL=C` e em `pt_BR.UTF-8`. */
const porCodigo = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const entreCrases = (xs: readonly string[]): string => xs.map((x) => `\`${x}\``).join(', ');
const chaveDoPar = (antes: string, depois: string): string => `${antes} → ${depois}`;

function semCrases(no: string): string {
  const m = /^`([^`]*)`$/.exec(no);
  return m ? m[1].trim() : no;
}

/** Lê o que vem depois de `Ordem entre edges:`. */
export function lerValor(valor: string): ValorLido {
  const v = valor.trim();
  if (v === '') return { ok: false, motivo: 'o valor está vazio' };
  if (v === 'nenhuma') return { ok: true, declaracao: { tipo: 'nenhuma' } };
  if (v.toLowerCase() === 'nenhuma') return { ok: false, motivo: `\`${v}\` — escreva \`nenhuma\`, em minúsculas` };

  const pares: Par[] = [];
  const vistos = new Set<string>();
  for (const trecho of v.split(/[;,]/).map((t) => t.trim())) {
    if (trecho === 'nenhuma') return { ok: false, motivo: '`nenhuma` não se mistura com pares' };
    const nos = trecho.split(SETA).map(semCrases);
    if (nos.length < 2 || nos.includes('')) {
      return { ok: false, motivo: `${JSON.stringify(trecho)} não é um par \`a → b\`` };
    }
    const torto = nos.find((n) => !SLUG_EDGE.test(n));
    if (torto !== undefined) {
      return { ok: false, motivo: `${JSON.stringify(torto)} não é nome de edge (slug: minúsculas, dígitos e hífen)` };
    }
    for (let i = 1; i < nos.length; i++) {
      const [antes, depois] = [nos[i - 1], nos[i]];
      if (antes === depois) return { ok: false, motivo: `\`${antes}\` não pode vir antes dela mesma` };
      if (vistos.has(chaveDoPar(antes, depois))) continue;
      vistos.add(chaveDoPar(antes, depois));
      pares.push({ antes, depois });
    }
  }
  return { ok: true, declaracao: { tipo: 'pares', pares } };
}

/**
 * A linha PARECE a declaração e não é: decorada, indentada ou com outra caixa. Aceitar a variação
 * abriria a porta para a que ninguém enumerou; apontá-la poupa o autor de adivinhar.
 */
function pareceDeclaracao(linha: string): boolean {
  const nua = linha
    .replace(/[*_`>#]/g, '')
    .replace(/^\s*(?:[-+]|\d+[.)])\s+/, '')
    .trim()
    .toLowerCase();
  return /^ordem entre edges\s*:/.test(nua);
}

/**
 * Acha a declaração no corpo. Passa pelo stripper COMPARTILHADO de cerca (`removerCercas`): exemplo
 * em bloco de código é exibição, não afirmação — o PR que documenta a gramática precisa citá-la. O
 * `\r` do corpo editado pela web fica no fim da linha e sai no `trim` do valor.
 */
export function extrairDeclaracao(corpo: string): Extracao {
  const { texto, cercaAberta } = removerCercas(corpo);
  const declaracoes: { linha: number; valor: string }[] = [];
  const quaseAcertos: QuaseAcerto[] = [];
  texto.split('\n').forEach((l, i) => {
    const m = LINHA_DECLARACAO.exec(l);
    if (m) declaracoes.push({ linha: i + 1, valor: m[1] });
    else if (pareceDeclaracao(l)) quaseAcertos.push({ linha: i + 1, texto: l.trim() });
  });

  if (declaracoes.length > 1) return { estado: 'duplicada', linhas: declaracoes.map((d) => d.linha) };
  if (declaracoes.length === 1) {
    const [{ linha, valor }] = declaracoes;
    const lido = lerValor(valor);
    return lido.ok ? { estado: 'valida', linha, declaracao: lido.declaracao } : { estado: 'invalida', linha, motivo: lido.motivo };
  }
  return { estado: 'ausente', quaseAcertos, cercaAbertaNaLinha: cercaAberta?.linha ?? null };
}

/** Quem precisa declarar: corpo de ≥2 edges que existem no HEAD, ou manifesto tocado. */
export function medirPopulacao(tocados: readonly string[], edgesNoHead: ReadonlySet<string>): Populacao {
  const comCorpo = new Set<string>();
  const manifestos = new Set<string>();
  const prefixo = `${RAIZ_EDGES}/`;
  for (const caminho of tocados) {
    for (const f of FATIAS_EM_SHARED) {
      if (f.arquivo === caminho && edgesNoHead.has(f.edge)) comCorpo.add(f.edge);
    }
    if (!caminho.startsWith(prefixo)) continue;
    const edge = caminho.slice(prefixo.length).split('/')[0];
    if (caminho === caminhoDoManifesto(edge)) manifestos.add(edge);
    if (edgesNoHead.has(edge) && contaComoCorpo(caminho, edge)) comCorpo.add(edge);
  }
  const edgesComCorpo = [...comCorpo].sort(porCodigo);
  const manifestosTocados = [...manifestos].sort(porCodigo);
  return { edgesComCorpo, manifestosTocados, exigida: edgesComCorpo.length >= 2 || manifestosTocados.length > 0 };
}

function mensagemAusente(p: Populacao, quase: readonly QuaseAcerto[], cercaAberta: number | null): string {
  const porque: string[] = [];
  if (p.edgesComCorpo.length >= 2) porque.push(`muda o corpo de ${p.edgesComCorpo.length} edges (${entreCrases(p.edgesComCorpo)})`);
  if (p.manifestosTocados.length > 0) porque.push(`toca o manifesto de ordem de ${entreCrases(p.manifestosTocados)}`);
  const linhas = [
    `este PR ${porque.join(' e ')}, e o corpo dele não declara a ordem entre edges.`,
    '  Acrescente ao corpo do PR UMA linha crua (sem lista, negrito, crase, citação ou título, fora de bloco de código):',
    '    Ordem entre edges: nenhuma',
    '    Ordem entre edges: A → B',
    `  A 2ª forma exige ${caminhoDoManifesto('B')} com A em \`depoisDe\` (docs/agent/deploy.md §"Ordem ENTRE edges"); vários pares vão separados por \`;\`.`,
    '  Editar o corpo reroda este check em segundos — não precisa de push.',
  ];
  for (const q of quase) linhas.push(`  Parecida, na linha ${q.linha}: "${q.texto}" — só vale a linha crua, com esta caixa.`);
  if (cercaAberta !== null) {
    linhas.push(`  O bloco de código aberto na linha ${cercaAberta} nunca fecha: tudo depois dele ficou invisível para o gate.`);
  }
  return linhas.join('\n');
}

/** A declaração contra o artefato. */
export function julgar(e: EntradaJulgamento): Veredito {
  const populacao = medirPopulacao(e.tocados, e.edgesNoHead);
  const notas: string[] = [];
  const reprova = (achados: Achado[]): Veredito => ({ aprovado: false, achados, populacao, notas });
  const x = extrairDeclaracao(e.corpo);

  if (x.estado === 'duplicada') {
    return reprova([
      {
        marca: 'ORDEM_DECLARACAO_DUPLICADA',
        mensagem: `o corpo tem ${x.linhas.length} linhas de declaração (linhas ${x.linhas.join(', ')}); não dá para saber qual vale — deixe UMA.`,
      },
    ]);
  }
  if (x.estado === 'invalida') {
    return reprova([{ marca: 'ORDEM_DECLARACAO_INVALIDA', mensagem: `a linha ${x.linha} não se lê: ${x.motivo}.\n  ${FORMAS}` }]);
  }
  if (x.estado === 'ausente') {
    if (!populacao.exigida) return { aprovado: true, marca: 'ORDEM_NAO_EXIGIDA', populacao, notas };
    return reprova([
      { marca: 'ORDEM_DECLARACAO_AUSENTE', mensagem: mensagemAusente(populacao, x.quaseAcertos, x.cercaAbertaNaLinha) },
    ]);
  }

  const achados: Achado[] = [];
  const ilegivelDito = new Set<string>();
  const ilegivel = (edge: string, erro: string): void => {
    if (ilegivelDito.has(edge)) return;
    ilegivelDito.add(edge);
    achados.push({ marca: 'ORDEM_MANIFESTO_ILEGIVEL', mensagem: `${caminhoDoManifesto(edge)} não se lê: ${erro}` });
  };

  const declarados = x.declaracao.tipo === 'pares' ? x.declaracao.pares : [];
  for (const { antes, depois } of declarados) {
    const par = `o par \`${antes}\` → \`${depois}\``;
    const fora = [antes, depois].filter((edge) => !e.edgesNoHead.has(edge));
    if (fora.length > 0) {
      achados.push({
        marca: 'ORDEM_EDGE_INEXISTENTE',
        mensagem: `${par} cita ${entreCrases(fora)}, que não é edge neste commit (sem ${RAIZ_EDGES}/<edge>/index.ts).`,
      });
      continue;
    }
    const erro = e.ilegiveisNoHead.get(depois);
    if (erro !== undefined) {
      ilegivel(depois, erro);
      continue;
    }
    const noHead = e.paresNoHead.get(depois);
    if (noHead === undefined) {
      achados.push({
        marca: 'ORDEM_MANIFESTO_AUSENTE',
        mensagem:
          `${par} foi declarado, mas ${caminhoDoManifesto(depois)} não existe neste commit. Crie-o:\n` +
          `  {"formato": "${FORMATO_MANIFESTO}", "depoisDe": [{"edge": "${antes}", "motivo": "<o que quebra na ordem inversa>", "pr": <nº deste PR>}]}`,
      });
    } else if (!noHead.has(antes)) {
      achados.push({
        marca: 'ORDEM_MANIFESTO_SEM_PAR',
        mensagem: `${par} foi declarado, mas o manifesto de \`${depois}\` não tem \`${antes}\` em \`depoisDe\` (tem ${entreCrases([...noHead].sort(porCodigo))}).`,
      });
    }
  }

  // O manifesto não muda calado: todo par que ele GANHA na fatia tem de estar na declaração.
  const declarado = new Set(declarados.map((p) => chaveDoPar(p.antes, p.depois)));
  for (const b of populacao.manifestosTocados) {
    const erro = e.ilegiveisNoHead.get(b);
    if (erro !== undefined) {
      ilegivel(b, erro);
      continue;
    }
    const erroNaBase = e.ilegiveisNaBase.get(b);
    if (erroNaBase !== undefined) {
      notas.push(`o manifesto de \`${b}\` na base não se lê (${erroNaBase}): todo par dele no HEAD conta como novo.`);
    }
    const naBase = erroNaBase === undefined ? (e.paresNaBase.get(b) ?? new Set<string>()) : new Set<string>();
    for (const a of [...(e.paresNoHead.get(b) ?? [])].sort(porCodigo)) {
      if (naBase.has(a) || declarado.has(chaveDoPar(a, b))) continue;
      achados.push({
        marca: 'ORDEM_PAR_NAO_DECLARADO',
        mensagem:
          `o manifesto de \`${b}\` ganha \`${a}\` em \`depoisDe\` neste PR, e o corpo não declara \`${a}\` → \`${b}\`.\n` +
          `  Declare: Ordem entre edges: ${a} → ${b} (com os demais pares, separados por \`;\`).`,
      });
    }
  }

  if (achados.length > 0) return reprova(achados);
  return {
    aprovado: true,
    marca: x.declaracao.tipo === 'nenhuma' ? 'ORDEM_DECLARADA_NENHUMA' : 'ORDEM_DECLARADA_PARES',
    populacao,
    notas,
  };
}

const RESUMO: Record<MarcaAprova, string> = {
  ORDEM_NAO_EXIGIDA: 'o PR não muda o corpo de ≥2 edges nem toca manifesto de ordem; nada a declarar.',
  ORDEM_DECLARADA_NENHUMA: 'declarado `nenhuma`, e nenhum manifesto ganhou par sem declaração.',
  ORDEM_DECLARADA_PARES: 'cada par declarado está no manifesto da edge que espera, e nenhum par novo ficou sem declaração.',
};

/** O log do CI: cada linha que começa por marca é um veredito; o resto é contexto indentado. */
export function formatarVeredito(v: Veredito): string {
  const p = v.populacao;
  const linhas = v.aprovado ? [`${v.marca}: ${RESUMO[v.marca]}`] : v.achados.map((a) => `${a.marca}: ${a.mensagem}`);
  linhas.push(
    `  corpo de edge: ${p.edgesComCorpo.length > 0 ? entreCrases(p.edgesComCorpo) : '(nenhum)'} · ` +
      `manifesto tocado: ${p.manifestosTocados.length > 0 ? entreCrases(p.manifestosTocados) : '(nenhum)'}`,
  );
  for (const n of v.notas) linhas.push(`  nota: ${n}`);
  return linhas.join('\n');
}
