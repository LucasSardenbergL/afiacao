/**
 * pendencias-deploy.ts — julga DIVERGÊNCIA DE DEPLOY lendo o que prod já respondeu.
 * ============================================================================================
 *
 * Irmão PASSIVO do `sonda:sql`. Aquele é o caminho ATIVO: gera SQL que o founder cola para
 * sondar uma edge (a 1ª vez, e depois de cada deploy). Este não dispara nada — lê o LEDGER
 * (`public.deploy_atestacoes`, alimentado por cron a partir de `net._http_response`) mais a
 * janela viva, e compara `(versao, fonte)` observados com o que a main espera. Custo zero,
 * ninguém no circuito, e por isso roda como cron.
 *
 * POR QUE O LEDGER (2026-09-05): `pg_net.ttl` apaga `net._http_response` em 6h. Sem memória, cada
 * sessão via 47 de 54 edges "sem sonda na janela" e pedia ao founder para colar o SQL de sonda DE
 * NOVO — o veredito de ontem valia zero hoje. Bundle só muda por deploy explícito, então uma
 * atestação de 30/08 continua verdadeira até o `fonte` da main mudar. Pendência não se lembra;
 * pendência se mede — e medição que evapora não é medição.
 *
 * A REGRA ÚNICA: edge precisa de deploy ⇔ `(versao, fonte)` servido ≠ `(versao, fonte)` da main.
 * "O mapa mudou", "o closure mudou", "o PR X tocou a edge" NÃO são motivo — o mapa é excluído do
 * hash de propósito, e o `fonte` já é o closure inteiro resumido num número. Limite honesto
 * (Codex, 2026-09-05): `fonte` é identidade AUTORRELATADA da FONTE, não hash do bundle — prova o
 * marcador servido sob a hipótese de bundle coerente, não os bytes executados.
 *
 * A MATRIZ DO PAR — os dois marcadores, sempre (afrouxar para um só é regressão do `sonda:sql`):
 *
 *   fonte   versao   estado
 *   =       =        CONFERE
 *   =       ≠        INCOERENTE — impossível num bundle coerente (versao.ts está no closure)
 *   ≠       ≠        DIVERGE_P1 — o autor bumpou = mudança de comportamento declarada; deploy no PR
 *   ≠       =        DIVERGE_P2 se o par observado EXISTIU junto em algum commit da main (prod serve
 *                    um bundle coerente, só velho: o closure andou sem bump — `_shared/` ou
 *                    comentário); INCOERENTE se nunca existiu (deploy PARCIAL: versao.ts novo com o
 *                    mapa velho, ou bundle de branch que nunca entrou na main).
 *
 * P2 é POLÍTICA DE FILA, não veredito técnico (Codex): continua DEPLOY PENDENTE e sai exit 1; a
 * diferença é que o founder pode agrupá-lo numa leva — medido: 22 dos 64 pedidos de deploy em 11
 * dias eram só fan-out de `_shared/`, 18 de UM PR. Quem muda `_shared/` QUERENDO mudar o
 * comportamento da edge X bumpa a X — vira P1. E P2 pendente há mais de `ESCALAR_P2_APOS_DIAS` é
 * ESCALADO a urgente: fila que não escoa não é fila, é buraco.
 *
 * AS ARMADILHAS QUE MOLDARAM O VEREDITO — todas são "silêncio lido como aprovação":
 *
 *   1. NUNCA ATESTADA ≠ CONFERE. Edge sem observação no ledger nem na janela não produziu dado.
 *      É o ÚNICO estado que pede o founder (a 1ª sonda) — e é PENDÊNCIA (exit 1), não aviso: com
 *      um piso de 50%, 27 de 54 nunca atestadas saíam em exit 0 (achado do Codex).
 *
 *   2. `fonte: "nao-mapeada"` é DIVERGÊNCIA, não ausência. É o que o bundle responde quando o
 *      `index.ts` subiu mas `_shared/sonda-fingerprints.ts` ficou para trás. O `versao` sai CERTO
 *      nesse caso, então quem julga só pelo marcador lê deploy incompleto como confirmado.
 *
 *   3. Eco SEM `fonte` (`sem-campo`) não prova o closure: não é CONFERE nem DIVERGE — é "sonde-a".
 *
 *   4. ZERO OBSERVAÇÕES e LINHA IGNORADA são falha de MECÂNICA (exit 2 no CLI). A linha descartada
 *      pode ser justamente a divergência — engolir e avisar é o mesmo que não medir.
 *
 *   5. FORA_DO_MAPA sobre ledger eterno fabricaria "prod serve X" para sempre depois de X ser
 *      removida. Só observação FRESCA (`LIMITE_FORA_DO_MAPA_HORAS`) vira divergência; a histórica
 *      é contada à parte, sem veredito.
 */

/** O que prod respondeu para uma edge — do ledger ou da janela viva de `net._http_response`. */
export interface Observacao {
  edge: string;
  versao: string;
  fonte: string;
  /** `sonda` = respondeu a `{"probe":true}` · `eco` = corpo de execução real que ecoa a versão. */
  via: 'sonda' | 'eco';
  /** Instante da observação, como o psql imprimiu (só para exibição). */
  criado: string;
  /** Idade em horas, calculada pelo banco (`now() - observado_em`). */
  idadeHoras: number;
}

/** O que a main espera de uma edge: o `fonte` do mapa e o `VERSAO` do `versao.ts`. */
export interface Esperado {
  fonte: string;
  versao: string;
}

/**
 * O que a lib precisa saber do REPO e não consegue medir sozinha (git). Injetado pelo CLI;
 * os testes injetam respostas fixas. Erro aqui deve LANÇAR — o CLI converte em exit 2.
 */
export interface Contexto {
  /** O par (versao, fonte) observado existiu JUNTO em algum commit da main? */
  parCoerente(edge: string, versao: string, fonte: string): boolean;
  /** Há quantos dias o `fonte` esperado entrou na main — a idade da pendência. null = não sei. */
  diasPendente(edge: string, fonteEsperado: string): number | null;
}

export type Estado =
  | 'CONFERE'
  | 'DIVERGE_P1'
  | 'DIVERGE_P2'
  | 'INCOERENTE'
  | 'SEM_MAPA_NO_BUNDLE'
  | 'SEM_FONTE_NO_ECO'
  | 'NUNCA_ATESTADA'
  | 'FORA_DO_MAPA';

export interface Veredito {
  edge: string;
  estado: Estado;
  esperado: string | null;
  observado: string | null;
  versaoEsperada: string | null;
  versao: string | null;
  via: 'sonda' | 'eco' | null;
  criado: string | null;
  idadeHoras: number | null;
  /** Dias desde que o `fonte` esperado entrou na main (só nos estados de divergência). */
  diasPendente: number | null;
  /** P2 pendente há mais de `ESCALAR_P2_APOS_DIAS` — conta como urgente. */
  escalada: boolean;
}

export interface Relatorio {
  vereditos: Veredito[];
  /** Edges no mapa commitado (universo que este instrumento consegue julgar). */
  totalMapeadas: number;
  /** Edges do mapa com alguma observação (ledger ou janela). */
  totalObservadas: number;
  /** Exigem deploy AGORA: P1 + INCOERENTE + SEM_MAPA_NO_BUNDLE + FORA_DO_MAPA + P2 escalada. */
  totalUrgentes: number;
  /** Tudo que impede o exit 0: urgentes + P2 + SEM_FONTE_NO_ECO + NUNCA_ATESTADA. */
  totalPendentes: number;
  /** Linhas da saída do psql que não casaram o formato — o CLI trata > 0 como mecânica. */
  linhasIgnoradas: number;
  /** Edges que só existem no ledger (main não mapeia) e cuja última observação já é velha. */
  foraDoMapaHistoricas: string[];
}

/** O sentinela que `criarRespostaSonda` emite quando o bundle não traz o mapa de fingerprints. */
export const SEM_MAPA = 'nao-mapeada';

/** O que o coletor grava quando o eco não traz `fonte` — ausente ≠ zero, então tem nome. */
export const SEM_FONTE = 'sem-campo';

/** P2 mais velha que isto vira urgente: a leva agrupada tem prazo. */
export const ESCALAR_P2_APOS_DIAS = 7;

/** Observação de edge fora do mapa mais velha que isto não é "prod serve" — é história. */
export const LIMITE_FORA_DO_MAPA_HORAS = 24 * 7;

const CAMPOS = 6;

/**
 * Chatter do wrapper `psql-ro`, que emite `SET` ao fixar os parâmetros da sessão.
 *
 * Filtrado ANTES da contagem de ruído de propósito: contar o esperado como anomalia faria a
 * mecânica reprovar em TODA execução, e reprovação que toca contra a resposta certa é reprovação
 * que alguém afrouxa no primeiro dia.
 */
const CHATTER = new Set(['SET', 'BEGIN', 'COMMIT', 'ROLLBACK']);

/**
 * Faz o parse da saída `psql -A -F'|' -t`: `edge|versao|fonte|via|criado|idade_horas`.
 *
 * Linha que não tem exatamente 6 campos não-vazios, `via` fora do vocabulário ou idade não
 * numérica é contada como ignorada — e o CLI trata qualquer ignorada como mecânica (exit 2).
 */
export function parsearObservacoes(saida: string): {
  observacoes: Observacao[];
  linhasIgnoradas: number;
} {
  const observacoes: Observacao[] = [];
  let linhasIgnoradas = 0;

  for (const bruta of saida.split('\n')) {
    const linha = bruta.trim();
    if (linha === '' || CHATTER.has(linha)) continue;

    const campos = linha.split('|').map((c) => c.trim());
    if (campos.length !== CAMPOS || campos.some((c) => c === '')) {
      linhasIgnoradas += 1;
      continue;
    }

    const [edge, versao, fonte, via, criado, idadeBruta] = campos;
    const idadeHoras = Number(idadeBruta);
    if ((via !== 'sonda' && via !== 'eco') || !Number.isFinite(idadeHoras) || idadeHoras < 0) {
      linhasIgnoradas += 1;
      continue;
    }
    observacoes.push({ edge, versao, fonte, via, criado, idadeHoras });
  }

  return { observacoes, linhasIgnoradas };
}

/**
 * Cruza o que a main espera com o que prod respondeu.
 *
 * `esperados` é a VERDADE do repo (mapa de fingerprints + `VERSAO` de cada `versao.ts`);
 * `observacoes` é o que prod respondeu, do ledger e da janela viva; `contexto` responde o que só
 * o git sabe. Uma edge observada que não está no mapa vira `FORA_DO_MAPA` em vez de ser
 * descartada — desde que a observação seja FRESCA (armadilha 5).
 */
export function julgar(
  esperados: Record<string, Esperado>,
  observacoes: Observacao[],
  contexto: Contexto,
  linhasIgnoradas = 0,
): Relatorio {
  const porEdge = new Map<string, Observacao>();
  for (const o of observacoes) {
    const anterior = porEdge.get(o.edge);
    // A mais RECENTE ganha (menor idade): o SQL já faz DISTINCT ON, mas a lib não confia nisso.
    if (!anterior || o.idadeHoras < anterior.idadeHoras) porEdge.set(o.edge, o);
  }

  const vereditos: Veredito[] = [];
  const foraDoMapaHistoricas: string[] = [];

  for (const [edge, esp] of Object.entries(esperados)) {
    const obs = porEdge.get(edge);
    if (!obs) {
      vereditos.push({
        edge,
        estado: 'NUNCA_ATESTADA',
        esperado: esp.fonte,
        observado: null,
        versaoEsperada: esp.versao,
        versao: null,
        via: null,
        criado: null,
        idadeHoras: null,
        diasPendente: null,
        escalada: false,
      });
      continue;
    }

    let estado: Estado;
    let diasPendente: number | null = null;
    let escalada = false;

    if (obs.fonte === SEM_MAPA) {
      estado = 'SEM_MAPA_NO_BUNDLE';
    } else if (obs.fonte === SEM_FONTE) {
      estado = 'SEM_FONTE_NO_ECO';
    } else if (obs.fonte === esp.fonte) {
      estado = obs.versao === esp.versao ? 'CONFERE' : 'INCOERENTE';
    } else if (obs.versao !== esp.versao) {
      estado = 'DIVERGE_P1';
      diasPendente = contexto.diasPendente(edge, esp.fonte);
    } else if (contexto.parCoerente(edge, obs.versao, obs.fonte)) {
      estado = 'DIVERGE_P2';
      diasPendente = contexto.diasPendente(edge, esp.fonte);
      escalada = diasPendente !== null && diasPendente > ESCALAR_P2_APOS_DIAS;
    } else {
      estado = 'INCOERENTE';
    }

    vereditos.push({
      edge,
      estado,
      esperado: esp.fonte,
      observado: obs.fonte,
      versaoEsperada: esp.versao,
      versao: obs.versao,
      via: obs.via,
      criado: obs.criado,
      idadeHoras: obs.idadeHoras,
      diasPendente,
      escalada,
    });
  }

  for (const [edge, obs] of porEdge) {
    if (edge in esperados) continue;
    if (obs.idadeHoras > LIMITE_FORA_DO_MAPA_HORAS) {
      foraDoMapaHistoricas.push(edge);
      continue;
    }
    vereditos.push({
      edge,
      estado: 'FORA_DO_MAPA',
      esperado: null,
      observado: obs.fonte,
      versaoEsperada: null,
      versao: obs.versao,
      via: obs.via,
      criado: obs.criado,
      idadeHoras: obs.idadeHoras,
      diasPendente: null,
      escalada: false,
    });
  }

  const conta = (e: Estado) => vereditos.filter((v) => v.estado === e).length;
  const p2Escaladas = vereditos.filter((v) => v.estado === 'DIVERGE_P2' && v.escalada).length;
  const urgentes =
    conta('DIVERGE_P1') + conta('INCOERENTE') + conta('SEM_MAPA_NO_BUNDLE') + conta('FORA_DO_MAPA') + p2Escaladas;

  return {
    vereditos,
    totalMapeadas: Object.keys(esperados).length,
    totalObservadas: vereditos.filter(
      (v) => v.estado !== 'NUNCA_ATESTADA' && v.estado !== 'FORA_DO_MAPA',
    ).length,
    totalUrgentes: urgentes,
    totalPendentes:
      urgentes + (conta('DIVERGE_P2') - p2Escaladas) + conta('SEM_FONTE_NO_ECO') + conta('NUNCA_ATESTADA'),
    linhasIgnoradas,
    foraDoMapaHistoricas: foraDoMapaHistoricas.sort(),
  };
}

/** As edges que precisam de SONDA humana: nunca atestadas, ou cujo eco não traz `fonte`. */
export function edgesParaSondar(rel: Relatorio): string[] {
  return rel.vereditos
    .filter((v) => v.estado === 'NUNCA_ATESTADA' || v.estado === 'SEM_FONTE_NO_ECO')
    .map((v) => v.edge)
    .sort();
}

/**
 * Lê a válvula `PENDENCIAS_TOLERAR_NUNCA_ATESTADA`, ou LANÇA.
 *
 * Por padrão, edge nunca atestada é PENDÊNCIA (exit 1). A válvula existe para o bootstrap — a
 * primeira leva ainda não sondada — e só aceita `1`/`0`: um valor inesperado que virasse "não
 * tolerar" por omissão ensinaria que a variável funciona quando está sendo ignorada.
 */
export function lerTolerancia(bruto: string | undefined): boolean {
  if (bruto === undefined || bruto.trim() === '') return false;
  const v = bruto.trim();
  if (v === '1') return true;
  if (v === '0') return false;
  throw new Error(
    `PENDENCIAS_TOLERAR_NUNCA_ATESTADA inválido: ${JSON.stringify(bruto)}. Use 1 ou 0.`,
  );
}
