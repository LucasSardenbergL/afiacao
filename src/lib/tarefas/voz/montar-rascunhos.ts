// src/lib/tarefas/voz/montar-rascunhos.ts
import type { ExtracaoVozIA, RascunhoVoz, CtxMontarRascunhos } from './types';
import { resolverDataPtBr } from './date-parser';
import { casarVendedora } from './match';

export function montarRascunhos(
  extracao: ExtracaoVozIA,
  ctx: CtxMontarRascunhos,
): RascunhoVoz[] {
  return extracao.tarefas.map((t) => ({
    evidence_text: t.evidence_text,
    descricao: t.descricao,
    categoria: t.categoria_palpite ?? 'outro',
    cliente_nome_falado: t.cliente_nome_falado,
    cliente: null, // resolvido async na UI (busca Omie + casarCliente)
    vendedora: casarVendedora(t.vendedora_nome_falado, ctx.vendedoras),
    data: resolverDataPtBr(t.raw_date_text, ctx.hojeSP),
    target_texto: t.target_texto,
    empresa: ctx.empresaPadrao,
  }));
}
