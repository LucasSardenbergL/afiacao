import { useState } from 'react';
import { PackageX, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  mensagemErroRepasse,
  useNomesCompradores,
  useRepasseCandidatos,
  useRevogarRepasse,
} from '@/hooks/useVendaPainel';
import {
  formatarPreco,
  formatarReais,
  type CandidatoRepasse,
} from '@/lib/venda-cliente/painel';
import { DialogAprovarRepasse } from './DialogAprovarRepasse';

function chave(c: CandidatoRepasse) {
  return `${c.comprador_id}:${c.omie_codigo_produto}`;
}

function dataCurta(iso: string) {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a.slice(2)}`;
}

/** Grupos da aba pela situação de compra (20261031233000), na ordem da RPC. */
const GRUPOS = [
  {
    chave: 'comprando',
    titulo: 'Segue comprando',
    descricao: 'O cliente ainda compra o SKU na cadência — aqui o repasse faz sentido.',
    pertence: (c: CandidatoRepasse) => c.situacao_compra === 'comprando',
  },
  {
    chave: 'parado',
    titulo: 'Parou de comprar',
    descricao: 'Passou de 2× a cadência sem compra e nenhum substituto entrou: pode ser recompra perdida.',
    pertence: (c: CandidatoRepasse) => c.situacao_compra === 'parado',
  },
  {
    chave: 'substituido',
    titulo: 'Substituído — não é repasse',
    descricao: 'O cliente parou este SKU e passou a comprar outro da mesma função. Sem preço sugerido.',
    pertence: (c: CandidatoRepasse) => c.situacao_compra === 'substituido',
  },
  {
    chave: 'sem-cadencia',
    titulo: 'Sem cadência',
    descricao: 'Sem cadência de compra para dizer se o cliente ainda compra o SKU.',
    pertence: (c: CandidatoRepasse) => c.situacao_compra === null,
  },
] as const;

/**
 * Aba Repasses (spec Fase 4): candidatos com defasagem/abaixo do piso → o founder aprova o preço
 * alvo (≥ último preço, com validade) ou revoga. Agrupados pela situação de compra: SUBSTITUÍDO
 * (o cliente trocou por outro SKU da mesma função) não oferece Aprovar — só Revogar um vigente. `disponivel=false` = a migration da Task 6 ainda
 * não está no banco: a aba diz isso, não mostra lista vazia.
 */
export function AbaRepasses({ disponivel, hoje }: { disponivel: boolean; hoje: string }) {
  const candidatos = useRepasseCandidatos(disponivel);
  const nomes = useNomesCompradores((candidatos.data ?? []).map((c) => c.comprador_id));
  const revogar = useRevogarRepasse();
  const [aprovando, setAprovando] = useState<CandidatoRepasse | null>(null);

  if (!disponivel) {
    return (
      <EmptyState
        icon={PackageX}
        title="Repasse ainda não instalado no banco"
        description="A lista de candidatos depende da migration de repasse (Task 6). Assim que ela for aplicada, os candidatos aparecem aqui sem novo Publish."
      />
    );
  }
  if (candidatos.isLoading) return <PageSkeleton variant="list" />;
  if (candidatos.isError) {
    const msg = mensagemErroRepasse(candidatos.error);
    const semCapacidade = msg.includes('capacidade de custo') || msg.includes('42501') || msg.includes('master');
    return (
      <EmptyState
        icon={ShieldAlert}
        title={semCapacidade ? 'Sem acesso aos candidatos' : 'Não consegui carregar os candidatos'}
        description={
          semCapacidade
            ? 'A lista de repasse exige master com a capacidade de ler custo.'
            : `Erro ao ler venda_repasse_candidatos: ${msg}`
        }
        actionLabel="Tentar de novo"
        onAction={() => void candidatos.refetch()}
      />
    );
  }
  const lista = candidatos.data ?? [];
  if (lista.length === 0) {
    return (
      <EmptyState
        icon={PackageX}
        title="Nenhum candidato a repasse"
        description="Nenhum comprador × SKU da Oben (sem tinta) com preço defasado ou abaixo do piso na recompra de hoje."
      />
    );
  }

  const nomeDe = (id: string) => nomes.data?.get(id) ?? 'Comprador sem nome no cadastro';

  return (
    <>
      {GRUPOS.map((g) => {
        const doGrupo = lista.filter(g.pertence);
        if (doGrupo.length === 0) return null;
        return (
          <section key={g.chave} className="space-y-2 pb-6">
            <div>
              <h3 className="text-sm font-medium">
                {g.titulo} <span className="text-muted-foreground tabular-nums">({doGrupo.length})</span>
              </h3>
              <p className="text-xs text-muted-foreground">{g.descricao}</p>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Comprador</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Último preço</TableHead>
                    <TableHead className="text-right">Sugerido</TableHead>
                    <TableHead className="text-right" title="Alta do custo desde a última compra">Alta do custo</TableHead>
                    <TableHead className="text-right" title="Valor anual recuperável se o sugerido for praticado">Recuperável/ano</TableHead>
                    <TableHead>Repasse</TableHead>
                    <TableHead className="w-28" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {doGrupo.map((c) => {
                    const vigente = c.repasse_atual?.vigente ? c.repasse_atual : null;
                    const substituido = c.situacao_compra === 'substituido';
                    return (
                      <TableRow key={chave(c)}>
                        <TableCell className="max-w-[14rem] truncate font-medium" title={nomeDe(c.comprador_id)}>
                          {nomeDe(c.comprador_id)}
                        </TableCell>
                        <TableCell className="max-w-[16rem]">
                          <span className="block truncate" title={c.descricao ?? undefined}>
                            {c.descricao ?? `SKU ${c.omie_codigo_produto}`}
                          </span>
                          <span className="flex gap-1 pt-0.5">
                            {c.status_defasagem === 'defasado' && <Badge variant="outline" className="text-[10px]">defasado</Badge>}
                            {c.abaixo_piso && <Badge variant="outline" className="border-status-error/40 text-[10px] text-status-error">abaixo do piso</Badge>}
                            {c.situacao_compra !== 'comprando' && c.dias_sem_comprar !== null && (
                              <Badge variant="outline" className="text-[10px]">sem comprar há {c.dias_sem_comprar} d</Badge>
                            )}
                          </span>
                          {c.substituto && (
                            <span className="block truncate pt-0.5 text-xs text-muted-foreground" title={c.substituto.descricao ?? undefined}>
                              → {c.substituto.descricao ?? `SKU ${c.substituto.omie_codigo_produto}`} desde{' '}
                              {dataCurta(c.substituto.primeira_compra)} ({c.substituto.dias_com_compra}{' '}
                              {c.substituto.dias_com_compra === 1 ? 'compra' : 'compras'})
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatarPreco(c.ultimo_preco)}
                          {c.data_ultima_compra && (
                            <span className="block text-xs text-muted-foreground">{dataCurta(c.data_ultima_compra)}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatarPreco(c.preco_sugerido)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.alta_custo_perc === null ? '—' : `${c.alta_custo_perc.toLocaleString('pt-BR')}%`}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatarReais(c.valor_anual_recuperavel)}</TableCell>
                        <TableCell className="text-sm">
                          {vigente ? (
                            <span className="tabular-nums">
                              {formatarPreco(vigente.preco_alvo)}
                              <span className="block text-xs text-muted-foreground">até {dataCurta(vigente.valido_ate)}</span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            {!substituido && (
                              <Button size="sm" variant={vigente ? 'outline' : 'default'} onClick={() => setAprovando(c)}>
                                {vigente ? 'Alterar' : 'Aprovar'}
                              </Button>
                            )}
                            {vigente && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={revogar.isPending}
                                onClick={() =>
                                  revogar.mutate(vigente.id, {
                                    onSuccess: () => toast.success('Repasse revogado'),
                                    onError: (e) => toast.error('Não revogou', { description: mensagemErroRepasse(e) }),
                                  })
                                }
                              >
                                Revogar
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </section>
        );
      })}
      {aprovando && (
        <DialogAprovarRepasse
          key={chave(aprovando)}
          candidato={aprovando}
          nomeComprador={nomeDe(aprovando.comprador_id)}
          hoje={hoje}
          aberto
          onAbertoChange={(a) => !a && setAprovando(null)}
        />
      )}
    </>
  );
}
