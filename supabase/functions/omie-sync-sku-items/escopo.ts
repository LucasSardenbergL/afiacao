// Escopo da fila do `omie-sync-sku-items`: o documento que NUNCA vai para a Omie, por desenho.
// Decisão pura, sem I/O e sem dependência de runtime. Os testes ficam em escopo_test.ts (Deno,
// `--no-remote`).
//
// ── Por que existe ───────────────────────────────────────────────────────────────────────────
// O módulo de recebimento da Omie (`recebimentonfe`) traz NF-e E CT-e na mesma lista, e o
// `ListarRecebimentos` não filtra por modelo. O `omie-sync-nfes-recebidas` grava o CT-e sem pedido
// como linha ÓRFÃ de `purchase_orders_tracking`, igual a uma NF-e, e ele entra na fila desta edge.
// Só que CT-e (modelo 57) é o conhecimento de FRETE. Não tem item de produto: o
// `ConsultarRecebimento` responde sem a chave `itensRecebimento` (motivo `ok_sem_itensRecebimento`).
// O produto que ele transporta já vira leadtime pela NF-e dele.
//
// Medido em 2026-10-05 (psql-ro, OBEN):
//   · 135 linhas modelo 57 no tracking, 0 com leadtime;
//   · a fila do diário das 07:00 era 17 de 17 CT-e, e ~51 das 55 consultas desses runs desde
//     2026-09-24 foram para CT-e, girando no backoff de 72h;
//   · a NF-e (55) tinha cobertura de 45 de 45 na janela de 30 dias.
// Narrativa: docs/historico/sku-items-cte-fora-da-fila.md.
//
// ── O contrato ───────────────────────────────────────────────────────────────────────────────
// DENYLIST, não allowlist. Sai da fila só o modelo PROVADO sem itens (57). Chave ausente, malformada
// ou de modelo desconhecido CONTINUA na fila: a incerteza vira tentativa (o comportamento anterior),
// nunca exclusão silenciosa. Uma allowlist de 55 converteria incerteza em leadtime perdido.
//
// O modelo vem da CHAVE DE ACESSO, a coluna dedicada `nfe_chave_acesso` (layout SEFAZ: posições
// 21–22). Nunca do `raw_data`, que é jsonb multi-writer e polimórfico.
//
// O parser é ESTRITO: exatamente 44 dígitos ASCII, sem trim, sem replace, sem `Number`. Normalizar
// transformaria entrada malformada em evidência positiva (achado do Codex no desenho).
//
// CT-e OS (67) também não tem produto, mas fica fora daqui: não existe na população medida. Estender
// é contrato novo, com teste próprio.

/** O CT-e: o único modelo PROVADO sem item de produto no recebimento (medido, não presumido). */
export const MODELO_CTE = "57";

const CHAVE_DE_ACESSO = /^[0-9]{44}$/;

/**
 * O modelo fiscal do documento, lido das posições 21–22 da chave de acesso. Devolve `null` quando a
 * chave não tem exatamente 44 dígitos: aí não dá para afirmar o modelo, e quem decide tem de tratar
 * o `null` como "não sei" (que mantém o documento na fila).
 */
export function modeloDaChave(chave: unknown): string | null {
  if (typeof chave !== "string" || !CHAVE_DE_ACESSO.test(chave)) return null;
  return chave.slice(20, 22);
}

/** CT-e pela chave de acesso. Na dúvida (chave ilegível) é `false`: o documento continua na fila. */
export function ehCte(chave: unknown): boolean {
  return modeloDaChave(chave) === MODELO_CTE;
}

/**
 * Separa as linhas PENDENTES do run em consultáveis e CT-e, preservando a ordem e a identidade de
 * cada linha.
 *
 * A posição no fluxo é parte do contrato (achado do Codex no desenho):
 * pendentes brutos → AQUI → backoff e ordenação → dedup por `nIdReceb` → consulta.
 *   · ANTES do backoff, para o CT-e não contar em `fila_em_backoff` nem no sensor
 *     `fila_parada_48h` (que recebe a fila elegível antes do dedup);
 *   · ANTES do dedup, para o CT-e nunca ser eleito no lugar de uma NF-e. Nenhum `nIdReceb` mistura
 *     os dois modelos (medido: 0 grupos).
 * O chamador conta os CT-e (`ctes_fora_da_fila`): pendentes brutos = `fila_pendente` +
 * `ctes_fora_da_fila`. Ausente não é zero, e o que sai da fila fica visível em todo run.
 */
export function separarCtes<T extends { nfe_chave_acesso: string | null }>(
  pendentes: readonly T[],
): { consultaveis: T[]; ctes: T[] } {
  const consultaveis: T[] = [];
  const ctes: T[] = [];
  for (const linha of pendentes) {
    if (ehCte(linha.nfe_chave_acesso)) ctes.push(linha);
    else consultaveis.push(linha);
  }
  return { consultaveis, ctes };
}
