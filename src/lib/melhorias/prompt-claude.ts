// src/lib/melhorias/prompt-claude.ts
// Monta o bloco copiável que o founder cola no Claude Code pra atacar um item.
// 100% determinístico (montado client-side da thread atual — nunca persiste stale).
import type { MelhoriaItem, MelhoriaMensagem } from './types';

function fmtData(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso; // fallback: exibe a string crua
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function montarPromptClaudeCode(
  item: MelhoriaItem,
  mensagens: MelhoriaMensagem[],
  autorNome: string,
): string {
  const idCurto = item.id.slice(0, 8);
  const thread = mensagens
    .map((m) => {
      const tools = m.dados?.tools?.map((t) => t.tool) ?? [];
      const tag = m.papel === 'ia' && tools.length > 0 ? `[ia — consultou ${tools.join(', ')}]` : `[${m.papel}]`;
      return `${tag} ${m.conteudo}`;
    })
    .join('\n');

  return `## Melhoria reportada no app — item ${idCurto}

- **Reportado por:** ${autorNome} em ${fmtData(item.created_at)}
- **Tela de origem:** ${item.rota_origem ?? 'não informada'} · **Empresa ativa:** ${item.empresa}
- **Tipo (triagem IA):** ${item.tipo ?? 'não triado'} · **Urgência:** ${item.urgencia ?? '—'} · **Módulo:** ${item.modulo ?? '—'}
- **Título (IA):** ${item.titulo ?? '—'}

### Relato (thread completa)
${thread}

### Avaliação técnica da IA
${item.avaliacao_founder || '(triagem indisponível)'}

### Pedido
Investigue e resolva o item acima no app Afiação. Comece reproduzindo na tela \`${item.rota_origem ?? '(rota não informada)'}\`. Se for bug, ache a causa raiz antes de corrigir; se for sugestão, avalie e proponha o design antes de implementar. Ao final, me diga o que foi feito pra eu responder ao funcionário.`;
}
