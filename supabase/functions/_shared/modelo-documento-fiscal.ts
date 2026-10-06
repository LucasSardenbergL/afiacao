// O modelo fiscal do documento que a Omie lista no módulo de recebimento. Decisão pura, sem I/O e
// sem dependência de runtime. Os testes ficam em modelo-documento-fiscal_test.ts (Deno, `--no-remote`).
//
// ── Por que existe ───────────────────────────────────────────────────────────────────────────
// O `recebimentonfe` da Omie traz NF-e (55) E CT-e (57) na mesma lista, e o `ListarRecebimentos`
// não filtra por modelo. CT-e é o conhecimento de FRETE: não tem item de produto, e o produto que
// ele transporta já vira leadtime pela NF-e dele. Medido em 2026-10-05 (psql-ro, OBEN): 135 linhas
// modelo 57 no rastreio, todas órfãs e nenhuma com leadtime.
// Narrativa: docs/historico/sku-items-cte-fora-da-fila.md (parte A) e
// docs/historico/cte-fora-do-rastreio.md (parte B).
//
// Quem usa:
//   · `omie-sync-nfes-recebidas` (parte B): pula o CT-e na resposta do `ListarRecebimentos`, antes
//     de qualquer consulta ou escrita — `classificarModeloRecebimento`;
//   · `omie-sync-ctes-recebidos` (parte B): tira a linha 57 das candidatas do casamento de frete.
// O `omie-sync-sku-items` (parte A) ainda tem a SUA cópia de `modeloDaChave`/`ehCte` no `escopo.ts`.
// A convergência para reexport ficou para depois do #2801, que reescreve aquela edge e sobe o
// marcador dela no mesmo dia (revisão adversarial da parte B, P2-1). Até lá, o _test.ts deste módulo
// compara os veredictos das duas cópias no mesmo corpus: divergiu, fica vermelho.
//
// ⚠️ Mudança AQUI muda o bundle servido de cada edge que o importa, e o `sonda:bump` NÃO cobra o
// bump: `_shared/` fica fora do gate de propósito (`scripts/sonda-versao-bump-gate.ts`). Ao mudar
// este arquivo, bumpe à mão o `VERSAO` de cada consumidor da lista acima.
//
// ── O contrato ───────────────────────────────────────────────────────────────────────────────
// DENYLIST, não allowlist. Sai só o modelo PROVADO sem itens (57). Chave ausente, malformada ou de
// modelo desconhecido CONTINUA no fluxo de hoje: a incerteza vira tentativa, nunca exclusão
// silenciosa.
//
// Os parsers são ESTRITOS: chave com exatamente 44 dígitos ASCII, modelo do cabeçalho com
// exatamente 2 dígitos ASCII numa string — sem trim, sem replace, sem `Number`. Normalizar
// transformaria entrada malformada em evidência positiva (achado do Codex no desenho da parte A).
//
// CT-e OS (67) também não tem produto, mas fica fora daqui: não existe na população medida. Estender
// é contrato novo, com teste próprio.

/** O CT-e: o único modelo PROVADO sem item de produto no recebimento (medido, não presumido). */
export const MODELO_CTE = "57";

const CHAVE_DE_ACESSO = /^[0-9]{44}$/;

/**
 * O modelo fiscal do documento, lido das posições 21–22 da chave de acesso. Devolve `null` quando a
 * chave não tem exatamente 44 dígitos: aí não dá para afirmar o modelo, e quem decide tem de tratar
 * o `null` como "não sei" (que mantém o documento no fluxo de hoje).
 */
export function modeloDaChave(chave: unknown): string | null {
  if (typeof chave !== "string" || !CHAVE_DE_ACESSO.test(chave)) return null;
  return chave.slice(20, 22);
}

/** CT-e pela chave de acesso. Na dúvida (chave ilegível) é `false`: o documento segue o fluxo de hoje. */
export function ehCte(chave: unknown): boolean {
  return modeloDaChave(chave) === MODELO_CTE;
}

const MODELO_DO_CABECALHO = /^[0-9]{2}$/;

/**
 * O modelo declarado no `cabec.cModeloNFe` do recebimento. Só string de exatamente 2 dígitos ASCII
 * (medido: string JSON "55"/"57" em 210 de 210 órfãs). Número, espaço ou zero à esquerda devolvem
 * `null` — "não sei" — para a regra nunca agir sobre um campo que mudou de forma sem ninguém ver.
 */
export function modeloDoCabecalho(cModeloNFe: unknown): string | null {
  if (typeof cModeloNFe !== "string" || !MODELO_DO_CABECALHO.test(cModeloNFe)) return null;
  return cModeloNFe;
}

/**
 * O que a fonte faz com um documento da lista do `ListarRecebimentos`:
 *   · `cte`        — a chave E o cabeçalho dizem 57: o documento não entra no rastreio;
 *   · `outro`      — os dois concordam num modelo que não é 57: segue o fluxo de hoje;
 *   · `divergente` — os dois são legíveis e discordam: segue o fluxo de hoje, contado à parte;
 *   · `ausente`    — algum dos dois é ilegível ou falta: segue o fluxo de hoje, contado à parte.
 */
export type ModeloRecebimento =
  | { tipo: "cte" }
  | { tipo: "outro"; modelo: string }
  | { tipo: "divergente"; daChave: string; doCabecalho: string }
  | { tipo: "ausente"; daChave: string | null; doCabecalho: string | null };

/**
 * Classifica o documento pelos DOIS sinais do cabeçalho do recebimento: a chave de acesso CRUA
 * (`cChaveNFe`, ou `cChaveNfe` na falta dela — a mesma escolha do writer) e o `cModeloNFe`.
 *
 * A chave entra como veio da Omie, e não a gravada no rastreio: o writer a normaliza com
 * `replace(/\D/g, "").slice(0, 44)`, e uma chave formatada viraria evidência que ela não é. Recebe
 * o cabeçalho inteiro, e não os dois valores soltos, para a escolha do campo morar aqui, testada.
 */
export function classificarModeloRecebimento(cabec: unknown): ModeloRecebimento {
  const c = typeof cabec === "object" && cabec !== null ? (cabec as Record<string, unknown>) : {};
  const daChave = modeloDaChave(c.cChaveNFe ?? c.cChaveNfe);
  const doCabecalho = modeloDoCabecalho(c.cModeloNFe);
  if (daChave === null || doCabecalho === null) return { tipo: "ausente", daChave, doCabecalho };
  if (daChave !== doCabecalho) return { tipo: "divergente", daChave, doCabecalho };
  if (daChave === MODELO_CTE) return { tipo: "cte" };
  return { tipo: "outro", modelo: daChave };
}
