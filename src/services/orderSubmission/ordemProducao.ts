// PR 8.4 (rodada 3 do Novo Pedido): desfecho HONESTO da ordem de produção no envio.
//
// A edge `omie-vendas-sync` (v1.48) responde `criar_ordem_producao` com `{ success, falhas, desfecho[] }`,
// um desfecho por produto (`criada` · `falhou` + tipo + motivo + chave `cCodIntOP`). Antes o envio ignorava a
// resposta e o vendedor via "OP criada" para uma OP que o Omie recusou.
//
// A mensagem segue o TIPO da falha (2ª rodada do Codex):
//   • `invalido`: nem foi ao Omie — corrigir o item; não há OP para procurar;
//   • `sem_registro_local`: a OP EXISTE no Omie — NÃO criar outra, pedir a vinculação;
//   • `indeterminado` (ou tipo ausente/desconhecido, e erro de transporte): pode ser recusa OU timeout depois
//     de o Omie gravar — conferir no Omie as OPs do produto (produto e quantidade) antes de criar outra. A chave
//     `cCodIntOP` não aparece na tela do Omie, então nunca é a instrução de busca.

interface DesfechoOpResposta {
  status?: unknown;
  tipo?: unknown;
  motivo?: unknown;
  descricao?: unknown;
}

interface OpLegada {
  omie_ordem_id?: unknown;
  descricao?: unknown;
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function mensagemIndeterminada(produto: string | null, motivo: string | null): string {
  const nome = produto ?? 'produto';
  return `Ordem de produção de ${nome} não foi confirmada no Omie: ${motivo ?? 'sem detalhe do Omie'}. `
    + `Ela pode já existir: antes de criar outra à mão, confira no Omie as ordens de produção de ${nome} (produto e quantidade).`;
}

function mensagem(tipo: string | null, produto: string | null, motivo: string | null): string {
  const nome = produto ?? 'produto';
  if (tipo === 'invalido') {
    return `Ordem de produção de ${nome} não foi enviada ao Omie: ${motivo ?? 'item inválido'}. Corrija o item antes de criar a OP.`;
  }
  if (tipo === 'sem_registro_local') {
    return `Ordem de produção de ${nome}: ${motivo ?? 'a OP foi criada no Omie, mas não ficou registrada no app'}. `
      + 'Não crie outra — peça a vinculação no app.';
  }
  return mensagemIndeterminada(produto, motivo);
}

/** Mensagens de falha para o resumo do envio, uma por produto que ficou sem OP confirmada. */
export function falhasDaOrdemProducao(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const r = data as { success?: unknown; desfecho?: unknown; production_orders?: unknown };
  if (Array.isArray(r.desfecho)) {
    return (r.desfecho as DesfechoOpResposta[])
      .filter((d) => d && d.status === 'falhou')
      .map((d) => mensagem(texto(d.tipo), texto(d.descricao), texto(d.motivo)));
  }
  // Edge antiga (≤ v1.47): `success` sempre true; a recusa só aparece como OP sem id na lista.
  if (Array.isArray(r.production_orders)) {
    const semId = (r.production_orders as OpLegada[]).filter(
      (o) => !(typeof o?.omie_ordem_id === 'number' && o.omie_ordem_id > 0),
    );
    if (semId.length) return semId.map((o) => mensagemIndeterminada(texto(o?.descricao), null));
  }
  return r.success === false ? [mensagemIndeterminada(null, null)] : [];
}

/** Erro de TRANSPORTE (o invoke falhou ou estourou o tempo): a edge pode ter criado parte das OPs, então
 *  cada produto enviado vira "confira antes de criar outra" — nunca só o erro bruto. */
export function falhasDeTransporteOp(produtos: (string | null | undefined)[], motivo: string): string[] {
  const nomes = produtos.map((p) => texto(p));
  return (nomes.length ? nomes : [null]).map((p) => mensagemIndeterminada(p, motivo));
}
