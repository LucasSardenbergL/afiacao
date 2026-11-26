// PCO da NCG: de onde vêm folha e tributos (engine v2.7).
//
// Fonte = o mapa CURADO por empresa + código Omie `fin_categoria_fluxo_mapping` (o mesmo do DFC realizado).
// Antes (até a v2.6) tributos eram `categoria_codigo LIKE '3.99%'` e folha era `fin_config_cashflow.folha_categorias_codigos`
// + recorrente `is_folha`: nenhum dos três casa no plano Omie do grupo → a composição saía 0 afirmado (v2.5)
// e depois "não medida" (v2.6). Ver docs/historico/ncg-folha-tributos-fonte-vazia.md.
//
// Regras (decisões do founder em 26/11 + evidência de prod, só contagens):
//   - Tributos a pagar = títulos ABERTOS de `op_impostos` + `op_impostos_lucro` (IRPJ/CSLL), sem janela — o
//     mesmo estoque que `cp_fornecedor` já usa. `op_impostos_parcelamento` NÃO entra: é passivo financeiro e
//     fica onde estava (cp_fornecedor), sem mudar o total.
//   - Folha 30d = títulos ABERTOS de `op_pessoal` com vencimento em [hoje − 30, hoje + 30]: o que vence nos
//     próximos 30 dias MAIS o atrasado de até 30 dias. Limite inferior: na colacor_sc, 393 títulos de folha pagos
//     em 18 meses, NENHUM pago com mais de 19 dias de atraso (0 com > 30). Título de folha vencido há mais de 30
//     dias não tem precedente de pagamento — não é reserva de caixa para os próximos 30 dias: fica em
//     `cp_fornecedor` (o total da NCG não muda) e vira motivo de confiança com a contagem.
//   - Recorrente de folha (`fin_eventos_recorrentes.is_folha`) só conta VIGENTE (início ≤ fim da janela e fim
//     nulo ou ≥ hoje — achado Codex: ignorava `fim`). ERP vence: folha = max(CP na janela, recorrente).
//   - Folha é CENTRALIZADA na colacor_sc: nas outras empresas, sem título na janela, folha é ZERO MEDIDO (desde
//     que o mapa tenha códigos de pessoal para a empresa). Na colacor_sc, sem título nem recorrente = fonte vazia.
//   - Tributos: medido só com ≥ 1 título ABERTO classificado (histórico pago não atesta — achado Codex v2.6).
//   - Cada título cai em UM balde (adiantamento > tributo > folha na janela > fornecedor). Como o mapa é
//     UNIQUE(company, omie_codigo), um código não pode ser folha e tributo ao mesmo tempo.
//   - INSS/IRRF retidos não duplicam o salário: cada título de CP é um desembolso distinto (a guia é paga à
//     parte do líquido). Medido em 26/11: na colacor_sc, 0 título aberto de INSS/IRRF.
import { somarDias } from "../_shared/hoje-sp.ts";

/** Empresa que paga a folha do grupo (decisão do founder, 26/11). */
export const EMPRESA_FOLHA_CENTRAL = "colacor_sc";
/** Horizonte da reserva de folha (dias à frente). */
export const FOLHA_JANELA_DIAS = 30;
/** Atraso máximo de um título de folha que ainda conta como reserva (ver o cabeçalho). */
export const FOLHA_ATRASO_MAX_DIAS = 30;

export const LINHAS_FOLHA = ["op_pessoal"] as const;
export const LINHAS_TRIBUTO = ["op_impostos", "op_impostos_lucro"] as const;
/** Linhas do mapa que a engine lê (o resto do mapa é do DFC). */
export const LINHAS_MAPA_NCG = [...LINHAS_FOLHA, ...LINHAS_TRIBUTO] as const;

export type LinhaMapa = { omie_codigo: string; fluxo_linha: string };
export type TituloCp = {
  saldo: number;
  status_titulo: string;
  categoria_codigo: string | null;
  data_vencimento: string | null;
};
export type RecorrenteFolha = { valor: number; tipo: string; is_folha: boolean; inicio: string; fim: string | null };

export type PcoNcg = {
  cp_fornecedor: number;
  folha_30d: number;
  tributos_a_pagar: number;
  fontes: { folha: boolean; tributos: boolean };
  /** Títulos de folha abertos FORA da janela que ficaram em cp_fornecedor (contagem). */
  folha_fora_da_janela: { vencidos_alem_do_limite: number; a_vencer_depois: number; sem_vencimento: number };
  motivos: string[];
};

export function classificarPcoNcg(entrada: {
  company: string;
  hoje: string;
  cps: TituloCp[];
  mapa: LinhaMapa[];
  adiantamentoCodigos: string[];
  recorrentes: RecorrenteFolha[];
  aberto: (status: string) => boolean;
}): PcoNcg {
  const { company, hoje, cps, adiantamentoCodigos, aberto } = entrada;
  const linhaDe = new Map<string, string>();
  for (const m of entrada.mapa) linhaDe.set(m.omie_codigo, m.fluxo_linha);
  const ehFolha = (linha: string | undefined) => linha != null && (LINHAS_FOLHA as readonly string[]).includes(linha);
  const ehTributo = (linha: string | undefined) => linha != null && (LINHAS_TRIBUTO as readonly string[]).includes(linha);

  const inicioJanela = somarDias(hoje, -FOLHA_ATRASO_MAX_DIAS);
  const fimJanela = somarDias(hoje, FOLHA_JANELA_DIAS);

  let cp_fornecedor = 0;
  let folhaCp = 0;
  let tributos_a_pagar = 0;
  let titulosTributo = 0;
  let titulosFolha = 0;
  const fora = { vencidos_alem_do_limite: 0, a_vencer_depois: 0, sem_vencimento: 0 };

  for (const c of cps) {
    if (!aberto(c.status_titulo) || !(c.saldo > 0)) continue;
    const cod = c.categoria_codigo;
    if (cod && adiantamentoCodigos.includes(cod)) continue; // ACO (ou fora), nunca PCO — como na v2.6
    const linha = cod ? linhaDe.get(cod) : undefined;
    if (ehTributo(linha)) {
      tributos_a_pagar += c.saldo;
      titulosTributo++;
      continue;
    }
    if (ehFolha(linha)) {
      const v = c.data_vencimento;
      if (v != null && v >= inicioJanela && v <= fimJanela) {
        folhaCp += c.saldo;
        titulosFolha++;
        continue;
      }
      if (v == null) fora.sem_vencimento++;
      else if (v < inicioJanela) fora.vencidos_alem_do_limite++;
      else fora.a_vencer_depois++;
    }
    cp_fornecedor += c.saldo;
  }

  const folhaRecorrente = entrada.recorrentes
    .filter((e) => e.is_folha && e.tipo === "saida" && e.inicio <= fimJanela && (e.fim == null || e.fim >= hoje))
    .reduce((s, e) => s + e.valor, 0);
  // ERP vence: com CP de folha na janela, o recorrente só completa (max); os CPs já saíram de cp_fornecedor.
  const folha_30d = folhaCp > 0 ? Math.max(folhaCp, folhaRecorrente) : folhaRecorrente;

  const mapaTemFolha = entrada.mapa.some((m) => ehFolha(m.fluxo_linha));
  const folhaCentralizadaFora = company !== EMPRESA_FOLHA_CENTRAL && mapaTemFolha;
  const fontes = {
    folha: titulosFolha > 0 || folhaRecorrente > 0 || folhaCentralizadaFora,
    tributos: titulosTributo > 0,
  };

  const motivos: string[] = [];
  if (fora.vencidos_alem_do_limite > 0) {
    motivos.push(
      `${fora.vencidos_alem_do_limite} título(s) de folha vencido(s) há mais de ${FOLHA_ATRASO_MAX_DIAS} dias ficam em CP fornecedor, fora da reserva de folha.`,
    );
  }
  if (!fontes.folha) {
    motivos.push("Folha dos próximos 30 dias sem fonte (nenhum título de pessoal na janela nem recorrente): o saldo de tesouraria não desconta folha.");
  }
  if (!fontes.tributos) {
    motivos.push("Tributos a pagar sem fonte (nenhum título aberto de impostos no mapa da empresa).");
  }

  return { cp_fornecedor, folha_30d, tributos_a_pagar, fontes, folha_fora_da_janela: fora, motivos };
}
