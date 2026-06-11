// src/components/melhorias/MelhoriaThread.tsx
// Thread de um item de melhoria + render das tabelas de dados das ferramentas da IA.
import type { MelhoriaDados, MelhoriaMensagem } from '@/lib/melhorias/types';
import { cn } from '@/lib/utils';

function DadosTabelas({ dados }: { dados: MelhoriaDados }) {
  return (
    <div className="mt-2 space-y-3">
      {dados.tools.map((t, i) => {
        const r = t.resultado as Record<string, unknown> | null;
        if (!r) return null;
        const clientes = Array.isArray(r.clientes)
          ? (r.clientes as Array<Record<string, unknown>>)
          : null;
        const familia = Array.isArray(r.mesma_familia)
          ? (r.mesma_familia as Array<Record<string, unknown>>)
          : null;
        const juntos = Array.isArray(r.comprados_juntos)
          ? (r.comprados_juntos as Array<Record<string, unknown>>)
          : null;

        return (
          <div key={i} className="rounded-md border bg-card p-2 text-xs">
            {clientes && (
              <table className="w-full font-tabular">
                <thead>
                  <tr className="text-muted-foreground text-left">
                    <th className="pr-2 pb-1">Cliente</th>
                    <th className="pr-2 pb-1">Pedidos</th>
                    <th className="pr-2 pb-1">Última compra</th>
                    <th className="pb-1 text-right">Valor 12m</th>
                  </tr>
                </thead>
                <tbody>
                  {clientes.map((c, j) => (
                    <tr key={j} className="border-t">
                      <td className="pr-2 py-1">{String(c.cliente ?? '—')}</td>
                      <td className="pr-2 py-1">{String(c.n_pedidos ?? '—')}</td>
                      <td className="pr-2 py-1">
                        {c.ultima_compra
                          ? new Date(String(c.ultima_compra)).toLocaleDateString('pt-BR')
                          : '—'}
                      </td>
                      <td className="py-1 text-right">
                        {typeof c.valor_12m === 'number'
                          ? c.valor_12m.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
                          : '—'}
                      </td>
                    </tr>
                  ))}
                  {clientes.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-1 text-muted-foreground">
                        Nenhum cliente encontrado.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}

            {(familia || juntos) && (
              <div className="space-y-2">
                {familia && (
                  <div>
                    <p className="text-muted-foreground mb-1">Mesma família:</p>
                    {familia.length === 0 ? (
                      <p className="text-muted-foreground">—</p>
                    ) : (
                      <ul className="list-disc pl-4">
                        {familia.map((p, j) => (
                          <li key={j}>{String(p.descricao ?? '—')}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {juntos && (
                  <div>
                    <p className="text-muted-foreground mb-1">
                      Comprados juntos (associação):
                    </p>
                    {juntos.length === 0 ? (
                      <p className="text-muted-foreground">—</p>
                    ) : (
                      <ul className="list-disc pl-4">
                        {juntos.map((p, j) => (
                          <li key={j}>
                            {String(p.descricao ?? '—')}{' '}
                            <span className="text-muted-foreground">
                              (lift {String(p.lift ?? '—')})
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const PAPEL_LABEL: Record<MelhoriaMensagem['papel'], string> = {
  funcionario: 'Você',
  ia: 'IA',
  founder: 'Lucas',
};

export function MelhoriaThread({
  mensagens,
  papelDe,
}: {
  mensagens: MelhoriaMensagem[];
  papelDe?: (m: MelhoriaMensagem) => string;
}) {
  return (
    <div className="space-y-2">
      {mensagens.map((m) => (
        <div
          key={m.id}
          className={cn(
            'rounded-md p-2 text-sm',
            m.papel === 'funcionario' ? 'bg-muted' : 'border bg-card',
          )}
        >
          <p className="text-xs text-muted-foreground mb-0.5">
            {papelDe ? papelDe(m) : PAPEL_LABEL[m.papel]} ·{' '}
            {new Date(m.created_at).toLocaleString('pt-BR', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
          <p className="whitespace-pre-wrap">{m.conteudo}</p>
          {m.dados && <DadosTabelas dados={m.dados} />}
        </div>
      ))}
    </div>
  );
}
