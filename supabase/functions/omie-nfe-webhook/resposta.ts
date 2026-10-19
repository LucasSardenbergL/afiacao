// Desfecho da RPC `importar_nfe_recebimento` → resposta HTTP ao Omie. PURO, testado em
// resposta_test.ts (`deno test --no-remote`).
//
// A régua é o que o 2xx significa para o Omie: "pode descartar o evento". Então 2xx só sai quando
// os itens estão de fato gravados (importada/reparada/ja_importada); cabeçalho sem itens que não se
// pode completar (bloqueada) ou itens diferentes (divergente) são 409 — o Omie tenta 3× e manda à
// DLQ por 5 dias, onde o evento fica reprocessável em vez de sumir. Erro de DADO (NFE0x, tipo que
// não cabe) é 422; 409 e 422 têm registro durável em `nfe_importacao_falhas` (`tentativas_registradas`
// no corpo; null = o ledger não gravou): reenviar o mesmo payload não conserta, e o log sozinho não é
// recuperação. RPC ausente é 500 com o motivo escrito: deploy da
// edge antes da migration — fail-closed e barulhento, nunca o caminho antigo em silêncio.
import type { DesfechoImportacao } from "../_shared/nfe-importacao.ts";

export interface RespostaWebhook {
  status: number;
  corpo: Record<string, unknown>;
  /** Linha de log (sem dado pessoal: só ids, contagens e motivo). */
  log: { nivel: "log" | "error"; texto: string };
}

export function responderDesfecho(d: DesfechoImportacao, chave: string, tentativas: number | null = null): RespostaWebhook {
  switch (d.tipo) {
    case "importada":
      return {
        status: 200,
        corpo: { success: true, nfe_recebimento_id: d.id, itens_count: d.itens },
        log: { nivel: "log", texto: `NF-e importada. ID: ${d.id}, ${d.itens} itens.` },
      };
    case "reparada":
      return {
        status: 200,
        corpo: { success: true, reparado: true, nfe_recebimento_id: d.id, itens_count: d.itens },
        log: { nivel: "log", texto: `NF-e estava sem itens; completada. ID: ${d.id}, ${d.itens} itens.` },
      };
    case "ja_importada":
      return {
        status: 200,
        corpo: { message: "já importada", id: d.id, itens_count: d.itens },
        log: { nivel: "log", texto: `NF-e já importada: ${chave}, ${d.itens} itens` },
      };
    case "bloqueada":
      return {
        status: 409,
        corpo: { error: "NF-e já cadastrada sem itens e não reparável — reenvie", nfe_recebimento_id: d.id, details: d.motivo, tentativas_registradas: tentativas },
        log: { nivel: "error", texto: `Recebimento sem itens e não reparável: ${d.id} (${d.motivo})` },
      };
    case "divergente":
      return {
        status: 409,
        corpo: {
          error: "NF-e já cadastrada com itens diferentes do payload",
          nfe_recebimento_id: d.id,
          itens_count: d.itens,
          itens_payload: d.esperados,
          details: d.motivo,
          tentativas_registradas: tentativas,
        },
        log: { nivel: "error", texto: `Itens divergentes para ${chave}: ${d.itens} gravados, ${d.esperados} no payload (${d.motivo})` },
      };
    case "erro":
      switch (d.classe) {
        case "dado":
          return {
            status: 422,
            corpo: {
              error: "payload rejeitado pelo banco — reenviar o mesmo payload não conserta",
              code: d.code,
              details: d.mensagem,
              tentativas_registradas: tentativas,
            },
            log: { nivel: "error", texto: `Payload rejeitado (${d.code}) para ${chave}: ${d.mensagem} — tentativas registradas: ${tentativas ?? "NÃO registrou"}` },
          };
        case "rpc_ausente":
          return {
            status: 500,
            corpo: {
              error: "RPC importar_nfe_recebimento indisponível — migration db/2026-10-18-importar-nfe-recebimento-rpc.sql não aplicada (ou cache do PostgREST não recarregado)",
              details: d.mensagem,
            },
            log: { nivel: "error", texto: `RPC ausente (${d.code ?? "sem código"}): edge implantada ANTES da migration — ${d.mensagem}` },
          };
        default:
          return {
            status: 500,
            corpo: { error: "Erro ao gravar NF-e — o reenvio repete a importação inteira", code: d.code, details: d.mensagem },
            log: { nivel: "error", texto: `Erro ao gravar ${chave} (${d.code ?? "sem código"}): ${d.mensagem}` },
          };
      }
  }
}
