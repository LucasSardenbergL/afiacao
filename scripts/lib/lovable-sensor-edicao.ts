/**
 * lovable-sensor-edicao.ts — o agente do Lovable EDITOU algo durante um pedido de deploy?
 *
 * O prompt de deploy (`blocoDeEscopo` em `./prompt-deploy.ts`) proíbe editar qualquer arquivo e
 * exige a linha `No files were edited.`. Proibição em prosa para um LLM não é garantia — nas duas
 * vezes (#2541, #2579) o prompt já dizia "verbatim, do NOT modify" e o agente "consertou" OUTRAS
 * edges pelo `build-errors.log`. Este sensor é o eixo POR FORA da palavra do agente, e tem dois:
 *
 * 1. **A resposta do MCP.** `send_message`/`get_message` trazem `edit_id`/`commit_sha` quando a
 *    rodada produziu edição. Resposta de deploy puro não os traz (ou os traz nulos).
 * 2. **Os commits do bot na `main`.** O sync bidirecional empurra a edição como commit
 *    `gpt-engineer-app[bot]` ("Changes"). O merge "Lovable update" que regenera
 *    `src/integrations/supabase/types.ts` é o efeito colateral CONHECIDO de todo deploy (medido
 *    2026-09-08 e 2026-09-26) — só ele é tolerado; qualquer outro arquivo é alerta.
 *
 * A linha de confirmação é um terceiro sinal, FRACO de propósito: LLM afirma o que quiser, então a
 * presença dela não absolve, e a ausência só pede que alguém leia a resposta.
 *
 * Lógica pura aqui; a borda (argv, git, exits) em `scripts/lovable-sensor-edicao.ts`.
 */

/** Chaves que, com valor não-nulo, provam que a rodada do agente produziu edição. */
const CHAVES_DE_EDICAO: readonly string[] = ['edit_id', 'commit_sha', 'editId', 'commitSha'];

/** A linha exata que o `blocoDeEscopo` exige no fim da resposta. */
const LINHA_DE_CONFIRMACAO = 'No files were edited.';

/**
 * O único arquivo que o bot toca num deploy LIMPO: ele regenera os tipos do banco a cada rodada.
 * Tolerar é decisão medida, não conveniência — e fica numa lista, não num `startsWith('src/')`.
 */
export const ARQUIVOS_TOLERADOS_DO_BOT: readonly string[] = ['src/integrations/supabase/types.ts'];

export interface SinaisDaResposta {
  /** `false` = entrada vazia: sem resposta não há como dizer "sem edição". */
  legivel: boolean;
  /** `chave=valor` de cada chave de edição com valor não-nulo. */
  sinais: string[];
  confirmou: boolean;
}

function valorPresente(v: unknown): v is string | number {
  if (typeof v === 'number') return true;
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t !== '' && t.toLowerCase() !== 'null' && t.toLowerCase() !== 'none';
}

/**
 * Anda pelo JSON atrás das chaves de edição. String com cara de objeto é JSON EMBRULHADO (resultado
 * de tool dentro de resultado de tool) e é re-parseada — sem isso o `edit_id` aninhado escapa.
 */
function varrer(no: unknown, sinais: string[], profundidade: number): void {
  if (profundidade > 32 || no === null) return;
  if (typeof no === 'string') {
    const u = no.trim();
    if ((u.startsWith('{') && u.endsWith('}')) || (u.startsWith('[') && u.endsWith(']'))) {
      try {
        varrer(JSON.parse(u), sinais, profundidade + 1);
      } catch {
        /* texto com cara de JSON que não é: não é chave, não é sinal */
      }
    }
    return;
  }
  if (typeof no !== 'object') return;
  const entradas = Array.isArray(no) ? no.map((v) => ['', v] as const) : Object.entries(no);
  for (const [k, v] of entradas) {
    if (CHAVES_DE_EDICAO.includes(k) && valorPresente(v)) sinais.push(`${k}=${String(v)}`);
    else varrer(v, sinais, profundidade + 1);
  }
}

/**
 * Lê a resposta do MCP — JSON, ou o texto em que o cliente a embrulhou. Tenta o JSON primeiro
 * (estrutural: não casa `edit_id` citado numa frase); se não parsear, cai numa regex que exige a
 * forma `chave: valor` e ignora valor nulo.
 */
export function lerResposta(texto: string): SinaisDaResposta {
  const t = texto.trim();
  if (t === '') return { legivel: false, sinais: [], confirmou: false };
  const confirmou = t.includes(LINHA_DE_CONFIRMACAO);
  const sinais: string[] = [];
  let json: unknown;
  let parseou = true;
  try {
    json = JSON.parse(t);
  } catch {
    parseou = false;
  }
  if (parseou) {
    varrer(json, sinais, 0);
  } else {
    const re = /["']?(edit_id|commit_sha|editId|commitSha)["']?\s*[:=]\s*["']?([A-Za-z0-9_.-]+)/g;
    for (const m of t.matchAll(re)) {
      if (valorPresente(m[2])) sinais.push(`${m[1]}=${m[2]}`);
    }
  }
  return { legivel: true, sinais: [...new Set(sinais)], confirmou };
}

export interface CommitDoBot {
  sha: string;
  assunto: string;
  arquivos: string[];
}

/**
 * Parseia `git log --format=%x1e%H%x09%s --name-only`: um registro por commit, separado pelo
 * RS (0x1e) — assunto de commit pode ter qualquer coisa menos RS.
 */
export function parsearLogDoBot(saida: string): CommitDoBot[] {
  return saida
    .split('\x1e')
    .map((bloco) => bloco.trim())
    .filter((bloco) => bloco !== '')
    .map((bloco) => {
      const [cabeca, ...resto] = bloco.split('\n');
      const tab = cabeca.indexOf('\t');
      return {
        sha: tab < 0 ? cabeca : cabeca.slice(0, tab),
        assunto: tab < 0 ? '' : cabeca.slice(tab + 1),
        arquivos: resto.map((l) => l.trim()).filter((l) => l !== ''),
      };
    });
}

/** Commits do bot que tocaram arquivo fora da tolerância — cada um é uma edição não revisada na `main`. */
export function commitsSuspeitos(commits: readonly CommitDoBot[]): CommitDoBot[] {
  return commits.filter((c) => c.arquivos.some((a) => !ARQUIVOS_TOLERADOS_DO_BOT.includes(a)));
}

export type Veredito = 'SEM_EDICAO' | 'EDICAO_DETECTADA' | 'SEM_CONFIRMACAO' | 'CEDO_DEMAIS' | 'ILEGIVEL';

/**
 * Junta os eixos. Ordem de precedência: edição provada (qualquer eixo) vence tudo; depois a
 * ausência de dado — resposta vazia, ou `main` consultada cedo demais para o sync ter empurrado —
 * que NUNCA vira "sem edição"; só então a confirmação.
 */
export function julgar(r: SinaisDaResposta, suspeitos: readonly CommitDoBot[], assentou: boolean): Veredito {
  if (r.sinais.length > 0 || suspeitos.length > 0) return 'EDICAO_DETECTADA';
  if (!r.legivel) return 'ILEGIVEL';
  if (!assentou) return 'CEDO_DEMAIS';
  if (!r.confirmou) return 'SEM_CONFIRMACAO';
  return 'SEM_EDICAO';
}
