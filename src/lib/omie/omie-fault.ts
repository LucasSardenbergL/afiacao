// Classificação de faults da API do Omie pra decidir política de retry no callOmie.
//
// ⚠️ ESPELHADO VERBATIM em supabase/functions/omie-financeiro/index.ts (callOmie).
// Qualquer mudança aqui deve refletir lá e vice-versa.
//
// Causa-raiz (28/05/2026): o Omie retorna intermitentemente o fault
// "SOAP-ERROR: Broken response from Application Server (BG)" — falha transitória
// do servidor SOAP. O callOmie só fazia retry em rate-limit e LANÇAVA todo o
// resto na 1ª tentativa, abortando a passada inteira de movimentações e
// disparando alerta urgente do watchdog. Esta classificação distingue:
//   - rate_limit: o Omie pede pra aguardar (requisição em voo / consumo redundante)
//   - transient: falha de infra do Omie (reabsorvível com retry + backoff)
//   - fatal: erro de contrato (parâmetro inválido, sem acesso) — retry não ajuda

export type OmieFaultClass = 'rate_limit' | 'transient' | 'fatal';

export function classifyOmieFault(faultstring: string | null | undefined): OmieFaultClass {
  const fs = faultstring ?? '';

  // Rate-limit: o Omie pede explicitamente pra aguardar e tentar de novo.
  if (
    fs.includes('Já existe uma requisição desse método') ||
    fs.includes('Consumo redundante') ||
    fs.includes('consumo redundante') ||
    fs.includes('REDUNDANT')
  ) {
    return 'rate_limit';
  }

  // Transitório: falha de INFRAESTRUTURA do servidor do Omie (reabsorvível).
  // "SOAP-ERROR: Broken response from Application Server (BG)" foi a causa-raiz
  // observada — casa aqui por "Broken response"/"Application Server".
  // Conservador de propósito: NÃO incluímos o "SOAP-ERROR" genérico, porque um
  // SOAP fault também cobre erro de CONTRATO (ex: SOAP-ENV:Client, validação),
  // que retry nunca resolve. Só sinais inequívocos de instabilidade de servidor.
  if (
    fs.includes('Broken response') ||
    fs.includes('Application Server') ||
    fs.includes('ERROR_INTERNAL') ||
    fs.includes('Internal Server Error') ||
    fs.includes('Service Unavailable') ||
    fs.includes('Service Temporarily Unavailable')
  ) {
    return 'transient';
  }

  // Tudo mais (parâmetro inválido, sem permissão, etc.) → fatal: retry não ajuda.
  return 'fatal';
}
