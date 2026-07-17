// Decisões PURAS da publicação diferida de run (reconciliação de PO excluído no Omie). Espelhadas no edge
// omie-sync-pedidos-compra (Deno não importa de src/) entre // MIRROR-START/END — a paridade textual
// NORMALIZADA no CI (edge-money-path-invariants, mirrorBlockNamed) pega a reversão do deploy do Lovable.
// Ver docs/agent/money-path.md.

// MIRROR-START reposicao publicacao-run
export interface RunPublicacaoStatus {
  modo: "incremental" | "completo";
  varreduraCompleta: boolean;
  fornecedorCodigo: number | undefined;
}

// Publica o run SÓ no fim de um completo cuja COLETA foi LIMPA (varreduraCompleta = viu o fim sem
// abort/truncamento/ID-inseguro) e NÃO-filtrado por fornecedor (Codex P1 #1/#2: run filtrado carimbaria um
// subset; run abortado publicaria sinal inválido). NÃO checa summary.erros: um erro de PERSISTÊNCIA do espelho
// (upsert de linha torta) NÃO corrompe idsVistos (coletado ANTES do upsert), e erro de COLETA já vira
// varreduraCompleta=false (abortado/!fim) — gatear por erros travava a publicação num upsert torto (Codex v3.2 P1).
export function devePublicarRun(s: RunPublicacaoStatus): boolean {
  return !s.fornecedorCodigo && s.modo === "completo" && s.varreduraCompleta;
}
// MIRROR-END reposicao publicacao-run
