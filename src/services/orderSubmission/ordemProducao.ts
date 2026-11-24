// PR 8.4 (rodada 3 do Novo Pedido): desfecho HONESTO da ordem de produção no envio.
//
// A edge `omie-vendas-sync` (v1.48) responde `criar_ordem_producao` com `{ success, falhas, desfecho[] }`,
// um desfecho por produto (`criada` · `ja_existia` · `falhou` + motivo). Antes o envio ignorava a resposta
// e o vendedor via "OP criada" para uma OP que o Omie recusou.

interface DesfechoOpResposta {
  status?: unknown;
  motivo?: unknown;
  descricao?: unknown;
}

/**
 * Mensagens de falha para o resumo do envio, uma por produto que ficou sem OP.
 * Resposta sem o desfecho (edge antiga) com `success: false` → uma falha genérica; sem nada → nenhuma
 * (a edge antiga respondia sempre `success: true` e não há o que dizer além do que ela disse).
 */
export function falhasDaOrdemProducao(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const r = data as { success?: unknown; desfecho?: unknown };
  if (Array.isArray(r.desfecho)) {
    return (r.desfecho as DesfechoOpResposta[])
      .filter((d) => d && d.status === 'falhou')
      .map((d) => {
        const produto = typeof d.descricao === 'string' && d.descricao.trim() ? d.descricao.trim() : 'produto';
        const motivo = typeof d.motivo === 'string' && d.motivo.trim() ? d.motivo.trim() : 'sem detalhe do Omie';
        // Sem prometer reenvio: o PV já existe e o envio fecha com aviso (a OP não segura o pedido).
        return `Ordem de produção de ${produto} NÃO foi criada no Omie: ${motivo}. Crie a OP no Omie ou avise a produção.`;
      });
  }
  return r.success === false ? ['Ordem de produção não foi criada no Omie (sem detalhe).'] : [];
}
