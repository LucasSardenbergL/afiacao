// Onda D, fatia 4b-3: o `sync_order` aceitava o `customerUserId` do cliente A junto com o código Omie do
// cliente B — a OS ia para a Omie no cadastro de B com o titular local A (e o endereço/documento de um
// vazavam no documento do outro). Agora o código só vale se for DESTE cliente, antes de qualquer efeito.
//
// Ordem da prova (conta colacor_sc, a que o `callOmieApi` desta edge usa):
//  1. mapa FRESCO (`omie_customer_account_map_fresco`): o código tem dono → vale só se o dono é o titular;
//  2. código sem linha no mapa (cliente recém-criado na Afiação, antes do próximo sync): o `cnpj_cpf` da
//     Omie para ESTE código casa, em forma estrita, com o documento do perfil do titular.
// Qualquer leitura com erro ou ponta ausente → indeterminado (recusa). Ausente ≠ casou.

import { pedidoEDesteCadastro } from "../_shared/pii-carteira.ts";

type Leitura<T> = { erro: true } | ({ erro: false } & T);

export type DesfechoVinculoOS =
  | { ok: true; via: "mapa" | "documento" }
  | { ok: false; motivo: "codigo_de_outro_cliente" | "documento_divergente" | "indeterminado" };

export function decidirVinculoOS(p: {
  customerUserId: string;
  /** Donos do código no mapa fresco colacor_sc (UNIQUE: 0 ou 1). */
  mapa: Leitura<{ userIds: string[] }>;
  /** Só consultados quando o mapa não tem o código. */
  omie?: Leitura<{ codigo: number | null; cnpjCpf: string | null }>;
  perfil?: Leitura<{ document: string | null; cnpj: string | null }>;
  codigo: number;
}): DesfechoVinculoOS {
  if (!p.customerUserId || p.mapa.erro) return { ok: false, motivo: "indeterminado" };
  if (p.mapa.userIds.length > 0) {
    return p.mapa.userIds.includes(p.customerUserId)
      ? { ok: true, via: "mapa" }
      : { ok: false, motivo: "codigo_de_outro_cliente" };
  }
  if (!p.omie || p.omie.erro || !p.perfil || p.perfil.erro) return { ok: false, motivo: "indeterminado" };
  if (p.omie.codigo !== p.codigo) return { ok: false, motivo: "indeterminado" };
  const casa = pedidoEDesteCadastro(
    [{ customer_user_id: p.customerUserId, document: p.perfil.document, cnpj: p.perfil.cnpj }],
    p.omie.cnpjCpf,
    new Set([p.customerUserId]),
  );
  return casa ? { ok: true, via: "documento" } : { ok: false, motivo: "documento_divergente" };
}

/** Mensagem ao vendedor (sem documento nem nome: vai ao navegador e ao log). */
export function mensagemVinculoOS(motivo: Extract<DesfechoVinculoOS, { ok: false }>["motivo"]): string {
  switch (motivo) {
    case "codigo_de_outro_cliente":
      return "O código Omie (Afiação) enviado é de OUTRO cliente: selecione o cliente de novo antes de enviar a OS.";
    case "documento_divergente":
      return "O cadastro Omie (Afiação) não confere com o documento deste cliente: selecione o cliente de novo ou peça à gestão.";
    case "indeterminado":
      return "Não consegui conferir o cliente da OS agora. Nada foi enviado à Omie; tente de novo em instantes.";
  }
}
