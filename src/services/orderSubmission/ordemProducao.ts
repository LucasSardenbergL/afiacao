// PR 8.4 (rodada 3 do Novo Pedido): desfecho HONESTO da ordem de produção no envio.
//
// A edge `omie-vendas-sync` (v1.48) responde `criar_ordem_producao` com `{ success, falhas, desfecho[] }`,
// um desfecho por produto (`criada` · `falhou` + motivo + chave `cCodIntOP`). Antes o envio ignorava a
// resposta e o vendedor via "OP criada" para uma OP que o Omie recusou.
//
// "Falhou" pode ser recusa OU resultado indeterminado (timeout depois de o Omie gravar): a mensagem nunca
// manda criar à mão — manda PROCURAR pela chave antes, senão a produção sai em dobro.

interface DesfechoOpResposta {
  status?: unknown;
  motivo?: unknown;
  descricao?: unknown;
  chave?: unknown;
}

interface OpLegada {
  omie_ordem_id?: unknown;
  descricao?: unknown;
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function mensagem(produto: string | null, motivo: string | null, chave: string | null): string {
  const busca = chave ? `procure no Omie pela chave de integração ${chave}` : 'procure no Omie';
  return `Ordem de produção de ${produto ?? 'produto'} não foi confirmada no Omie: ${motivo ?? 'sem detalhe do Omie'}. `
    + `Antes de criar outra à mão, ${busca} — ela pode já existir.`;
}

/** Mensagens de falha para o resumo do envio, uma por produto que ficou sem OP confirmada. */
export function falhasDaOrdemProducao(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const r = data as { success?: unknown; desfecho?: unknown; production_orders?: unknown };
  if (Array.isArray(r.desfecho)) {
    return (r.desfecho as DesfechoOpResposta[])
      .filter((d) => d && d.status === 'falhou')
      .map((d) => mensagem(texto(d.descricao), texto(d.motivo), texto(d.chave)));
  }
  // Edge antiga (≤ v1.47): `success` sempre true; a recusa só aparece como OP sem id na lista.
  if (Array.isArray(r.production_orders)) {
    const semId = (r.production_orders as OpLegada[]).filter(
      (o) => !(typeof o?.omie_ordem_id === 'number' && o.omie_ordem_id > 0),
    );
    if (semId.length) return semId.map((o) => mensagem(texto(o?.descricao), null, null));
  }
  return r.success === false ? [mensagem(null, null, null)] : [];
}
