// Mapeamento PURO do cabeçalho do `ConsultarRecebimento` (Omie) → linha de `nfe_recebimentos`.
// Um só mapeamento para os dois caminhos que materializam NF-e: o cron (laço do index.ts) e a
// importação por chave (botão "Importar NF-e"). Testado em cabecalho_test.ts.

export interface OmieCabecRecebimento {
  nIdNfe?: number | string;
  cNumeroNFe?: number | string;
  cSerieNFe?: string | null;
  cCNPJ_CPF?: string;
  cRazaoSocial?: string | null;
  cNome?: string | null;
  dEmissaoNFe?: string | null;
  nValorNFe?: number | string | null;
}

export interface CabecalhoRecebimentoRow {
  warehouse_id: string;
  numero_nfe: string;
  serie_nfe: string | null;
  chave_acesso: string;
  cnpj_emitente: string;
  razao_social_emitente: string | null;
  data_emissao: string | null;
  valor_total: number | null;
  status: "pendente";
  omie_nfe_id: number | null;
  omie_id_receb: number;
}

/** "DD/MM/YYYY" do Omie → "YYYY-MM-DD" do Postgres (outra forma passa como veio). */
export function parseOmieDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const parts = d.split("/");
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return d;
}

export function mapearCabecalho(
  cabec: OmieCabecRecebimento,
  warehouseId: string,
  chaveAcesso: string,
  nIdReceb: number | string,
): CabecalhoRecebimentoRow {
  const valorTotal = cabec.nValorNFe ?? null;
  return {
    warehouse_id: warehouseId,
    numero_nfe: String(cabec.cNumeroNFe ?? ""),
    serie_nfe: cabec.cSerieNFe ?? null,
    chave_acesso: chaveAcesso,
    cnpj_emitente: (cabec.cCNPJ_CPF ?? "").replace(/\D/g, ""),
    razao_social_emitente: cabec.cRazaoSocial ?? cabec.cNome ?? null,
    data_emissao: parseOmieDate(cabec.dEmissaoNFe),
    valor_total: valorTotal ? parseFloat(String(valorTotal)) : null,
    status: "pendente",
    omie_nfe_id: cabec.nIdNfe ? parseInt(String(cabec.nIdNfe)) : null,
    omie_id_receb: parseInt(String(nIdReceb)),
  };
}
