// Status HTTP da resposta da efetivação — o TRANSPORTE carrega o veredito.
//
// Antes (M-01), TODA resposta do fluxo real saía HTTP 200 (`success:false` inclusive), e um caller
// que decidisse pelo transporte (`if (res.error) throw`) comemorava "efetivada" sobre uma falha —
// entrada de estoque e lançamento fiscal que NÃO aconteceram no Omie.
//
// Regra: só `success === true` é 2xx. `throttle` (trégua transitória do Omie, ~60s) sai 429 para
// o caller distinguir "tente de novo em instantes" de falha real; o resto sai 502 (o ERP não
// efetivou). O CORPO não muda — `success`/`modo`/`erro`/`versao` seguem iguais para quem lê JSON.
// O front lê o corpo do ≠2xx via `error.context` (src/lib/recebimento/efetivacao-resposta.ts).
export function statusHttpEfetivacao(body: { success?: boolean; modo?: string }): number {
  if (body.success === true) return 200;
  if (body.modo === "throttle") return 429;
  return 502;
}
