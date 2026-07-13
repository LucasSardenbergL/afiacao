// Decisões PURAS da publicação diferida de run (reconciliação de PO excluído no Omie). Espelhadas VERBATIM
// no edge omie-sync-pedidos-compra (Deno não importa de src/) entre // MIRROR-START/END — a paridade textual
// no CI (edge-money-path-invariants) pega a reversão do deploy do Lovable. Ver docs/agent/money-path.md.

// MIRROR-START reposicao publicacao-run
export interface RunPublicacaoStatus {
  modo: "incremental" | "completo";
  erros: number;
  varreduraCompleta: boolean;
  fornecedorCodigo: number | undefined;
}

// Publica o run SÓ no fim de um completo LIMPO (erros=0 + viu o fim, sem abort/truncamento) e NÃO-filtrado
// por fornecedor (Codex P1 #1/#2: run filtrado carimbaria um subset; run abortado publicaria sinal inválido).
export function devePublicarRun(s: RunPublicacaoStatus): boolean {
  return !s.fornecedorCodigo && s.modo === "completo" && s.erros === 0 && s.varreduraCompleta;
}

// A cadência do completo (marcarCompletoOk) só avança quando a RPC devolve volume_ok=TRUE (run VÁLIDO).
// Bootstrap (null) e truncado (false) NÃO avançam → o próximo ciclo re-tenta o completo até conseguir um
// válido (Codex P1 #3: "publicou sem erro" != "run válido"; senão o cron pula ~20h sem marcador válido).
export function cadenciaPodeAvancar(volumeOk: boolean | null): boolean {
  return volumeOk === true;
}
// MIRROR-END reposicao publicacao-run
