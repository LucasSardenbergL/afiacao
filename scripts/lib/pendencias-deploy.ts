/**
 * pendencias-deploy.ts — julga DIVERGÊNCIA DE DEPLOY lendo o que prod já respondeu.
 * ============================================================================================
 *
 * Irmão PASSIVO do `sonda:sql`. Aquele é o caminho ATIVO: gera SQL que o founder cola para
 * disparar as sondas. Este não dispara nada — lê os corpos que o cron (ou uma sondagem
 * anterior) JÁ gravou em `net._http_response` e compara o `fonte` observado com o mapa
 * commitado. Custo zero, ninguém no circuito, e por isso pode virar cron.
 *
 * POR QUE PASSIVO IMPORTA: o ativo depende de alguém lembrar de rodar. Foi assim que o deploy
 * pendente da `omie-vendas-sync` (commit 8c2a8b716) ficou semanas sem dono — nenhuma sessão
 * tinha o item anotado, e o único jeito de descobrir era comparar prod contra a main. Pendência
 * não se lembra; pendência se mede.
 *
 * AS TRÊS ARMADILHAS QUE MOLDARAM O VEREDITO — todas são "silêncio lido como aprovação":
 *
 *   1. NÃO OBSERVADA ≠ CONFERE. Uma edge sem sonda na janela do `pg_net.ttl` (6h) não produziu
 *      dado nenhum. Contá-la como OK é fabricar veredito — o `ausente ≠ zero` do money-path na
 *      sua forma mais barata de cometer. Ela tem estado PRÓPRIO e o relatório a nomeia.
 *
 *   2. `fonte: "nao-mapeada"` é DIVERGÊNCIA, não ausência. É o que o bundle responde quando o
 *      `index.ts` subiu mas o `_shared/sonda-fingerprints.ts` ficou para trás (o prompt de deploy
 *      que nomeia poucos arquivos — `lovable-deploy-verify` Passo 3). O `versao` sai CERTO nesse
 *      caso, então quem julga só pelo marcador lê deploy incompleto como confirmado.
 *
 *   3. ZERO OBSERVAÇÕES é falha de MECÂNICA, nunca "tudo limpo". Query que não devolve linha e
 *      query que devolve só linhas conformes têm a mesma cara num relatório que só lista
 *      problemas. Por isso `julgar` devolve os totais e o CLI trata zero como exit 2.
 */

/** O que prod respondeu para uma edge, extraído de `net._http_response`. */
export interface Observacao {
  edge: string;
  versao: string;
  fonte: string;
  criado: string;
}

export type Estado =
  | 'CONFERE'
  | 'DIVERGE'
  | 'SEM_MAPA_NO_BUNDLE'
  | 'NAO_OBSERVADA'
  | 'FORA_DO_MAPA';

export interface Veredito {
  edge: string;
  estado: Estado;
  esperado: string | null;
  observado: string | null;
  versao: string | null;
  criado: string | null;
}

export interface Relatorio {
  vereditos: Veredito[];
  /** Edges no mapa commitado (universo que este instrumento consegue julgar). */
  totalMapeadas: number;
  /** Edges do mapa que produziram resposta na janela. */
  totalObservadas: number;
  /** Edges que exigem ação: DIVERGE + SEM_MAPA_NO_BUNDLE. */
  totalDivergentes: number;
  /** Linhas da saída do psql que não casaram o formato — ruído é sintoma, não é para engolir. */
  linhasIgnoradas: number;
}

/** O sentinela que `criarRespostaSonda` emite quando o bundle não traz o mapa de fingerprints. */
export const SEM_MAPA = 'nao-mapeada';

const CAMPOS = 4;

/**
 * Chatter do wrapper `psql-ro`, que emite `SET` ao fixar os parâmetros da sessão.
 *
 * Filtrado ANTES da contagem de ruído de propósito: contar o esperado como anomalia faria o aviso
 * de `linhasIgnoradas` disparar em TODA execução, e aviso que toca contra a resposta certa é aviso
 * desarmado no primeiro dia — o operador aprende a ignorá-lo, e então ele cala quando importa.
 */
const CHATTER = new Set(['SET', 'BEGIN', 'COMMIT', 'ROLLBACK']);

/**
 * Faz o parse da saída `psql -A -F'|' -t`.
 *
 * O wrapper `psql-ro` imprime linhas de `SET` antes do resultado, e uma linha malformada não pode
 * virar observação silenciosa: linha que não tem exatamente 4 campos NÃO-VAZIOS é contada como
 * ignorada e o total sobe para o relatório. Engolir ruído aqui produziria "NAO_OBSERVADA" numa
 * edge que na verdade respondeu — ausência fabricada a partir de um parse frouxo.
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

    const campos = linha.split('|');
    if (campos.length !== CAMPOS || campos.some((c) => c.trim() === '')) {
      linhasIgnoradas += 1;
      continue;
    }

    const [edge, versao, fonte, criado] = campos.map((c) => c.trim());
    observacoes.push({ edge, versao, fonte, criado });
  }

  return { observacoes, linhasIgnoradas };
}

/**
 * Cruza o mapa commitado com o observado em prod.
 *
 * `mapaCommitado` é a VERDADE do repo (`lerMapaCommitado`); `observacoes` é o que prod respondeu.
 * Uma edge observada que não está no mapa vira `FORA_DO_MAPA` em vez de ser descartada: significa
 * que prod serve uma edge instrumentada que a main não conhece mais (rename/remoção), e sumir com
 * ela do relatório esconderia justamente a divergência.
 */
export function julgar(
  mapaCommitado: Record<string, string>,
  observacoes: Observacao[],
  linhasIgnoradas = 0,
): Relatorio {
  const porEdge = new Map<string, Observacao>();
  for (const o of observacoes) {
    const anterior = porEdge.get(o.edge);
    // A mais RECENTE ganha: a janela pode conter várias respostas da mesma edge.
    if (!anterior || o.criado > anterior.criado) porEdge.set(o.edge, o);
  }

  const vereditos: Veredito[] = [];

  for (const [edge, esperado] of Object.entries(mapaCommitado)) {
    const obs = porEdge.get(edge);
    if (!obs) {
      vereditos.push({ edge, estado: 'NAO_OBSERVADA', esperado, observado: null, versao: null, criado: null });
      continue;
    }
    const estado: Estado =
      obs.fonte === SEM_MAPA ? 'SEM_MAPA_NO_BUNDLE' : obs.fonte === esperado ? 'CONFERE' : 'DIVERGE';
    vereditos.push({ edge, estado, esperado, observado: obs.fonte, versao: obs.versao, criado: obs.criado });
  }

  for (const [edge, obs] of porEdge) {
    if (edge in mapaCommitado) continue;
    vereditos.push({
      edge,
      estado: 'FORA_DO_MAPA',
      esperado: null,
      observado: obs.fonte,
      versao: obs.versao,
      criado: obs.criado,
    });
  }

  const conta = (e: Estado) => vereditos.filter((v) => v.estado === e).length;

  return {
    vereditos,
    totalMapeadas: Object.keys(mapaCommitado).length,
    totalObservadas: vereditos.filter(
      (v) => v.estado !== 'NAO_OBSERVADA' && v.estado !== 'FORA_DO_MAPA',
    ).length,
    totalDivergentes: conta('DIVERGE') + conta('SEM_MAPA_NO_BUNDLE') + conta('FORA_DO_MAPA'),
    linhasIgnoradas,
  };
}
