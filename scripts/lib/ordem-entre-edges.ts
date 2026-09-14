/**
 * ordem-entre-edges.ts — a ordem ENTRE edges da mesma leva vira GATE (lógica pura, sem fs/git/psql).
 *
 * ## Por que existe
 *
 * O gate de ordem que o `pendencias:pacote` já tinha é BANCO → EDGE (#2285, #2369, #2428): a colagem
 * não sai enquanto prod não tem a RPC. Entre DUAS edges não havia ordem nenhuma — o Passo 2 era UMA
 * mensagem ("Deploy all of them") e o agente do Lovable deploya a lista do sandbox, sem sequência nem
 * prova entre uma e outra.
 *
 * Medido em 2026-09-14 (#2469, money-path: o total do pedido passou de BRUTO a LÍQUIDO): o corpo do
 * PR exigia `sync-reprocess` → `omie-vendas-sync` — na ordem inversa, o reprocess velho reescreveria
 * de volta para bruto os pedidos novos da janela dele — e o pacote `2a52229c0e39` saiu com as duas
 * numa mensagem só. Não houve dano porque OUTRA sessão leu o PR e mandou `sync-reprocess` antes:
 * sorte, não processo. Quem segue o fecho ao pé da letra cola o Passo 2 verbatim.
 *
 * ## O desenho (parecer do Codex de 2026-09-14 no corpo do PR)
 *
 * · A ordem é declarada num ARTEFATO junto da edge DEPENDENTE — `supabase/functions/<B>/deploy-ordem.json`
 *   — e nunca na prosa do PR. Varridos 400 PRs mergeados: 30 parágrafos com "≥2 edges + palavra de
 *   ordem", UMA declaração real. Prosa não é canal de máquina.
 * · Ordem vira ONDAS: B só é LIBERADA (ganha colagem) quando cada predecessora A está PROVADA em prod.
 *   Estar na mesma leva não prova nada — mensagens separadas em ordem arbitrária erram igual a uma só.
 * · A prova é refeita contra a REF@sha do pacote, não lida do rótulo do ledger: o par `(versao, fonte)`
 *   observado de A tem de ser o que a REF espera, e a observação tem de ter idade REAL (idade no
 *   ledger + idade do JSON) entre `ASSENTAR_MIN` e `FRESCOR_MAX_H`.
 * · Sem inércia automática: a declaração vale até um PR a retirar. Inércia por VERSAO liberaria
 *   justamente o deploy INCOERENTE — B servindo a VERSAO nova com o `fonte` velho (P1 do Codex).
 */

import { RAIZ_EDGES } from '../sonda-fingerprint';

export const FORMATO_MANIFESTO = 'deploy-ordem/1';
export const NOME_MANIFESTO = 'deploy-ordem.json';

/**
 * Idade MÍNIMA da prova de A para liberar B, em minutos.
 *
 * A sonda responde ANTES do fluxo de escrita, então "A nova respondeu" não prova que a invocação do
 * bundle VELHO terminou: ela pode estar no meio das páginas e seguir escrevendo com a regra velha
 * depois de B subir (P1 do Codex). O teto de wall-clock de uma edge é 400 s no plano pago
 * (supabase.com/docs/guides/functions/limits, conferido em 2026-09-14); 10 min cobre a cauda de UMA
 * invocação com folga. NÃO cobre fila própria nem invocação que se re-agenda — isso é do runtime.
 */
export const ASSENTAR_MIN = 10;

/** Idade MÁXIMA da prova de A, em horas. O cron de sonda passa a cada 2 h; 6 h toleram 2 ticks perdidos. */
export const FRESCOR_MAX_H = 6;

/** Idade máxima do JSON do ledger quando há ordem a provar, em minutos: veredito velho não libera onda. */
export const JSON_MAX_MIN = 30;

/** Motivo curto demais não diz a quem retira a declaração o que ela protege. */
const MOTIVO_MIN = 20;

const SLUG_EDGE = /^[a-z0-9][a-z0-9-]*$/;

interface Exigencia {
  /** A predecessora: tem de estar PROVADA em prod antes de a dependente ganhar colagem. */
  edge: string;
  motivo: string;
  /** O PR que introduziu a exigência — quem a retira precisa saber de onde ela veio. */
  pr: number;
}

export interface Manifesto {
  /** A edge dependente (B). Vem do DIRETÓRIO onde o manifesto mora, não de um campo do JSON. */
  edge: string;
  depoisDe: Exigencia[];
}

/** O par que a REF@sha espera de uma edge: `fonte` do mapa de sondas e `VERSAO` do `versao.ts`. */
export interface ParAlvo {
  fonte: string;
  versao: string;
}

export interface EntradaPlano {
  /** As edges que o ledger selecionou para deploy (ou que foram nomeadas). */
  leva: readonly string[];
  /** Só as edges da leva que TÊM manifesto, lido da REF@sha. */
  manifestos: ReadonlyMap<string, Manifesto>;
  /**
   * O JSON do ledger INTEIRO — `null` quando a leva veio por nome. Os vereditos chegam crus
   * (`unknown`) e só os das predecessoras são validados: a leva sem ordem não passa a depender de
   * campo que ela nunca leu.
   */
  ledger: { vereditos: readonly unknown[]; geradoEm: Date | null } | null;
  /** O par da REF@sha de cada predecessora que o chamador conseguiu ler; ausente = não há par. */
  alvos: ReadonlyMap<string, ParAlvo>;
  agora: Date;
}

interface Retida {
  edge: string;
  /**
   * `ADIADA` sai sozinha numa próxima execução (a predecessora sobe nesta onda, ou só falta o tempo
   * de assentar). `BLOQUEADA` exige AÇÃO: medir o ledger de novo, sondar, consertar a declaração.
   */
  tipo: 'ADIADA' | 'BLOQUEADA';
  espera: string[];
  motivos: string[];
}

export interface PlanoDeOndas {
  liberadas: string[];
  retidas: Retida[];
  /** As exigências que pesaram nesta leva — entram no SHA do pacote. */
  regras: { edge: string; depoisDe: string[] }[];
  /** O par exigido de cada predecessora (null = a REF não o dá) — entra no SHA do pacote. */
  exigidos: { edge: string; fonte: string | null; versao: string | null }[];
}

const porNome = (a: string, b: string): number => a.localeCompare(b, 'en');

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Chaves EXATAS. Campo desconhecido não é ignorado: `"antesDe"` inventado por alguém, ou um
 * `"depoisde"` digitado errado ao lado do certo, seria uma ordem DECLARADA que o gate não vê.
 */
function exigirChaves(obj: Record<string, unknown>, chaves: readonly string[], onde: string): void {
  const tem = Object.keys(obj).sort(porNome);
  const quer = [...chaves].sort(porNome);
  if (tem.length !== quer.length || tem.some((c, i) => c !== quer[i])) {
    throw new Error(`${onde}: chaves ${JSON.stringify(tem)} — o contrato é exatamente ${JSON.stringify(quer)}`);
  }
}

export function caminhoDoManifesto(edge: string): string {
  return `${RAIZ_EDGES}/${edge}/${NOME_MANIFESTO}`;
}

/** Lê o manifesto de `edge`. Parse ESTRITO: qualquer desvio LANÇA, e quem chama converte em exit 2. */
export function lerManifesto(edge: string, texto: string): Manifesto {
  const onde = caminhoDoManifesto(edge);
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch (e) {
    throw new Error(`${onde}: não é JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!ehObjeto(bruto)) throw new Error(`${onde}: a raiz tem de ser um objeto`);
  exigirChaves(bruto, ['formato', 'depoisDe'], onde);
  if (bruto.formato !== FORMATO_MANIFESTO) {
    throw new Error(`${onde}: formato ${JSON.stringify(bruto.formato)} (esperado ${FORMATO_MANIFESTO})`);
  }
  if (!Array.isArray(bruto.depoisDe) || bruto.depoisDe.length === 0) {
    throw new Error(`${onde}: \`depoisDe\` vazio ou ausente — manifesto sem exigência é ruído; apague o arquivo`);
  }
  const vistas = new Set<string>();
  const depoisDe = bruto.depoisDe.map((item: unknown, i: number): Exigencia => {
    const aqui = `${onde} depoisDe[${i}]`;
    if (!ehObjeto(item)) throw new Error(`${aqui}: tem de ser um objeto`);
    exigirChaves(item, ['edge', 'motivo', 'pr'], aqui);
    const { edge: predecessora, motivo, pr } = item;
    if (typeof predecessora !== 'string' || !SLUG_EDGE.test(predecessora)) {
      throw new Error(`${aqui}: \`edge\` fora do formato de slug: ${JSON.stringify(predecessora)}`);
    }
    if (predecessora === edge) throw new Error(`${aqui}: a edge não pode esperar por ela mesma`);
    if (vistas.has(predecessora)) throw new Error(`${aqui}: \`${predecessora}\` repetida`);
    vistas.add(predecessora);
    if (typeof motivo !== 'string' || motivo.trim().length < MOTIVO_MIN) {
      throw new Error(`${aqui}: \`motivo\` com menos de ${MOTIVO_MIN} caracteres — diga o que quebra na ordem inversa`);
    }
    if (typeof pr !== 'number' || !Number.isInteger(pr) || pr <= 0) {
      throw new Error(`${aqui}: \`pr\` tem de ser o número inteiro do PR que introduziu a exigência`);
    }
    return { edge: predecessora, motivo: motivo.trim(), pr };
  });
  return { edge, depoisDe };
}

/**
 * Um ciclo entre as edges de `nos` — `[a, b, a]` —, ou `null`. Só conta a exigência cuja
 * predecessora também está em `nos`: fora dela a espera é prova de prod, não ordem entre ondas.
 */
export function acharCiclo(
  nos: Iterable<string>,
  manifestos: ReadonlyMap<string, Manifesto>,
): string[] | null {
  const dentro = new Set(nos);
  const estado = new Map<string, 'visitando' | 'feito'>();
  const pilha: string[] = [];

  const visitar = (no: string): string[] | null => {
    estado.set(no, 'visitando');
    pilha.push(no);
    const predecessoras = (manifestos.get(no)?.depoisDe ?? [])
      .map((x) => x.edge)
      .filter((p) => dentro.has(p))
      .sort(porNome);
    for (const p of predecessoras) {
      if (estado.get(p) === 'visitando') return [...pilha.slice(pilha.indexOf(p)), p];
      if (estado.get(p) === undefined) {
        const achado = visitar(p);
        if (achado) return achado;
      }
    }
    pilha.pop();
    estado.set(no, 'feito');
    return null;
  };

  for (const no of [...dentro].sort(porNome)) {
    if (estado.get(no) === undefined) {
      const achado = visitar(no);
      if (achado) return achado;
    }
  }
  return null;
}

/** Os caminhos de um fecho de imports que são manifestos — o manifesto NÃO pode entrar no `fonte`. */
export function manifestosNoFecho(fecho: readonly string[]): string[] {
  return fecho.filter((c) => c === NOME_MANIFESTO || c.endsWith(`/${NOME_MANIFESTO}`));
}

interface Observacao {
  estado: string;
  observado: string | null;
  versao: string | null;
  idadeHoras: number | null;
}

/**
 * A observação de `edge` no JSON do ledger, validada campo a campo — ou `undefined` se ela não está
 * lá. Duas entradas para a mesma edge LANÇAM: escolher uma seria adivinhar qual é a de prod.
 */
function observacaoDe(vereditos: readonly unknown[], edge: string): Observacao | undefined {
  const achadas = vereditos.filter((v) => ehObjeto(v) && v.edge === edge);
  if (achadas.length > 1) throw new Error(`o ledger traz ${achadas.length} vereditos para ${edge} — não adivinho qual vale`);
  const v = achadas[0] as Record<string, unknown> | undefined;
  if (v === undefined) return undefined;
  const { estado, observado, versao, idadeHoras } = v;
  const textoOuNulo = (x: unknown) => x === null || typeof x === 'string';
  if (
    typeof estado !== 'string' ||
    !textoOuNulo(observado) ||
    !textoOuNulo(versao) ||
    !(idadeHoras === null || (typeof idadeHoras === 'number' && Number.isFinite(idadeHoras)))
  ) {
    throw new Error(`veredito de ${edge} fora do contrato do pendencias:deploy (estado/observado/versao/idadeHoras)`);
  }
  return {
    estado,
    observado: observado as string | null,
    versao: versao as string | null,
    idadeHoras: idadeHoras as number | null,
  };
}

type Prova = { ok: true } | { ok: false; bloqueia: boolean; motivo: string };

const curto = (fonte: string | null): string => (fonte === null ? '∅' : `${fonte.slice(0, 12)}…`);

function provar(predecessora: string, e: EntradaPlano, naLeva: ReadonlySet<string>): Prova {
  const bloqueia = (motivo: string): Prova => ({ ok: false, bloqueia: true, motivo });
  const adia = (motivo: string): Prova => ({ ok: false, bloqueia: false, motivo });

  // Estar na leva é o ledger dizendo que prod NÃO serve a versão da REF — o contrário de prova.
  if (naLeva.has(predecessora)) {
    return adia('está NESTA leva: sobe nesta onda, e a prova só vem da próxima medição do ledger');
  }
  if (e.ledger === null) {
    return bloqueia(
      'leva por NOME, sem o veredito do ledger — não há como provar a predecessora; rode ' +
        '`pendencias:deploy --json | pendencias:pacote -`',
    );
  }
  if (e.ledger.geradoEm === null) {
    return bloqueia(
      'o JSON do ledger não traz `geradoEm` (produtor anterior a este gate) — meça de novo com o ' +
        '`pendencias:deploy` da main',
    );
  }
  const idadeJsonMin = (e.agora.getTime() - e.ledger.geradoEm.getTime()) / 60_000;
  if (idadeJsonMin < -1) {
    return bloqueia(`o JSON do ledger diz ter nascido ${Math.round(-idadeJsonMin)} min no FUTURO — relógio incoerente, meça de novo`);
  }
  if (idadeJsonMin > JSON_MAX_MIN) {
    return bloqueia(`o veredito do ledger tem ${Math.round(idadeJsonMin)} min (teto ${JSON_MAX_MIN}) — meça de novo`);
  }
  const alvo = e.alvos.get(predecessora);
  if (alvo === undefined) {
    return bloqueia(
      'a REF não dá o par (versao, fonte) dela — fora do mapa de sondas, sem `VERSAO` legível ou ' +
        'inexistente; a prova é impossível, conserte a declaração',
    );
  }
  const obs = observacaoDe(e.ledger.vereditos, predecessora);
  if (obs === undefined) return bloqueia('ausente do veredito do ledger');
  // O PAR, e não só o `fonte`: bundle com `fonte` certo e `VERSAO` errada é deploy incoerente.
  if (obs.observado !== alvo.fonte || obs.versao !== alvo.versao) {
    return bloqueia(
      `prod serve (versao ${obs.versao ?? '∅'}, fonte ${curto(obs.observado)}) e a REF espera ` +
        `(versao ${alvo.versao}, fonte ${curto(alvo.fonte)}) — estado ${obs.estado}; meça de novo e, ` +
        `se seguir assim, deploye ou sonde a predecessora (\`bun run sonda:sql ${predecessora}\`)`,
    );
  }
  if (obs.idadeHoras === null) return bloqueia('observação sem idade — não dá para julgar frescor nem assentamento');
  const idadeMin = obs.idadeHoras * 60 + Math.max(0, idadeJsonMin);
  if (idadeMin > FRESCOR_MAX_H * 60) {
    return bloqueia(
      `a prova tem ${(idadeMin / 60).toFixed(1)} h (teto ${FRESCOR_MAX_H} h) — sonde a predecessora ` +
        `(\`bun run sonda:sql ${predecessora}\`) e meça de novo`,
    );
  }
  if (idadeMin < ASSENTAR_MIN) {
    return adia(
      `provada há ${Math.floor(idadeMin)} min — aguarde ${Math.ceil(ASSENTAR_MIN - idadeMin)} min ` +
        '(a invocação em voo do bundle velho) e meça de novo',
    );
  }
  return { ok: true };
}

/**
 * Parte a leva em LIBERADAS (ganham colagem nesta execução) e RETIDAS (não ganham, e o pacote diz
 * por quê). LANÇA em ciclo e em entrada incoerente — o chamador converte em exit 2.
 */
export function planejarOndas(e: EntradaPlano): PlanoDeOndas {
  const naLeva = new Set(e.leva);
  for (const [dono, m] of e.manifestos) {
    if (!naLeva.has(dono) || m.edge !== dono) {
      throw new Error(`manifesto de ${m.edge} entregue como ${dono}, fora da leva — o chamador leu a coisa errada`);
    }
  }
  const ciclo = acharCiclo(e.leva, e.manifestos);
  if (ciclo) {
    throw new Error(`ciclo de ordem na leva: ${ciclo.join(' → ')} — nenhuma onda consegue começar; conserte os manifestos`);
  }

  const liberadas: string[] = [];
  const retidas: Retida[] = [];
  for (const edge of [...e.leva].sort(porNome)) {
    const m = e.manifestos.get(edge);
    if (m === undefined) {
      liberadas.push(edge);
      continue;
    }
    const espera: string[] = [];
    const motivos: string[] = [];
    let bloqueada = false;
    for (const x of m.depoisDe) {
      const p = provar(x.edge, e, naLeva);
      if (p.ok) continue;
      espera.push(x.edge);
      motivos.push(`\`${x.edge}\`: ${p.motivo} (exigência do #${x.pr})`);
      if (p.bloqueia) bloqueada = true;
    }
    if (espera.length === 0) liberadas.push(edge);
    else retidas.push({ edge, tipo: bloqueada ? 'BLOQUEADA' : 'ADIADA', espera: espera.sort(porNome), motivos });
  }

  const regras = [...e.manifestos.values()]
    .map((m) => ({ edge: m.edge, depoisDe: m.depoisDe.map((x) => x.edge).sort(porNome) }))
    .sort((a, b) => porNome(a.edge, b.edge));
  const exigidos = [...new Set(regras.flatMap((r) => r.depoisDe))].sort(porNome).map((edge) => {
    const alvo = e.alvos.get(edge);
    return { edge, fonte: alvo?.fonte ?? null, versao: alvo?.versao ?? null };
  });
  return { liberadas, retidas, regras, exigidos };
}
