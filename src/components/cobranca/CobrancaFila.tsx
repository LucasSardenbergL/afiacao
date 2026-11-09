import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { useCobrancaFila, useCobrancaRegistrar, type Empresa } from '@/hooks/useCobranca';
import {
  agruparPorFaixa, CANAIS, parseValorBR, proximosEstados, ROTULO_ESTADO, ROTULO_FAIXA, ROTULO_PROMESSA, variacaoCoorte,
  type EstadoCobranca, type FilaItem, brl, dataBr,
} from '@/lib/cobranca/cobranca-helpers';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { track } from '@/lib/analytics';

/**
 * Fila de cobrança (Frente B, PR2): clientes com vencido em aberto (regra da view do Ciclo) ∪ casos
 * abertos, por faixa (recentes primeiro — R$ 125k em ≤45 d antes de envelhecer; >90 d em paralelo),
 * com ESTADO, DONA e PROMESSA. Quem vê: a dona do cliente (carteira) e quem vê a carteira completa —
 * a RPC decide, a tela só mostra. Toda escrita passa pela RPC `cobranca_caso_registrar` (1 writer).
 * Sob a lente "Ver como" as ações ficam desabilitadas (a RPC gravaria como o master).
 */

type Acao = 'contato' | 'promessa' | 'nota' | 'fechar' | null;

function LinhaAcoes({ item, company }: { item: FilaItem; company: Empresa }) {
  const registrar = useCobrancaRegistrar();
  const [acao, setAcao] = useState<Acao>(null);
  const [canal, setCanal] = useState<string>('telefone');
  const [nota, setNota] = useState('');
  const [pData, setPData] = useState('');
  const [pValor, setPValor] = useState('');
  const lente = isLensActive();
  const bloqueado = lente || !item.podeAgir || registrar.isPending;

  const enviar = async (a: Parameters<typeof registrar.mutateAsync>[0]) => {
    try {
      await registrar.mutateAsync(a);
      track('cobranca.acao_registrada', { account: company, acao: a.acao, para: a.paraEstado ?? null, faixa: item.faixa?.replace(/-/g, '_') ?? null });
      setAcao(null); setNota(''); setPData(''); setPValor('');
    } catch (e) {
      toast.error(mensagemDeErro(e) ?? 'Não foi possível registrar a cobrança.');
    }
  };
  const base = { company, omieCodigoCliente: item.omieCodigoCliente, nomeCliente: item.nomeCliente };
  const estadoAtual: EstadoCobranca = item.estado === 'cancelado_gestao' ? 'a_contatar' : item.estado;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Select value={item.estado} disabled={bloqueado}
          onValueChange={(v) => { void enviar({ ...base, acao: 'estado', paraEstado: v, nota: nota || undefined }); }}>
          <SelectTrigger className="h-7 w-[170px] text-xs" aria-label={`Estado de ${item.nomeCliente ?? item.omieCodigoCliente}`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={item.estado} className="text-xs" disabled>{ROTULO_ESTADO[item.estado]}</SelectItem>
            {proximosEstados(estadoAtual).filter((e) => e !== item.estado).map((e: EstadoCobranca) => <SelectItem key={e} value={e} className="text-xs">{ROTULO_ESTADO[e]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={bloqueado} onClick={() => setAcao(acao === 'contato' ? null : 'contato')}>Contato</Button>
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={bloqueado} onClick={() => setAcao(acao === 'promessa' ? null : 'promessa')}>Promessa</Button>
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={bloqueado} onClick={() => setAcao(acao === 'nota' ? null : 'nota')}>Nota</Button>
        {/* Só com EVIDÊNCIA do servidor (pode_quitar): sem aberto/ambíguo, sync fresco, ≥1 recebido. Ausência não é quitação. */}
        {item.podeQuitar && item.casoId && (
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={bloqueado}
            onClick={() => { void enviar({ ...base, acao: 'fechar', fechadoMotivo: 'quitado' }); }}>
            Fechar (quitado)
          </Button>
        )}
      </div>
      {acao === 'contato' && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="cobranca-acao-contato">
          <Select value={canal} onValueChange={setCanal}>
            <SelectTrigger className="h-7 w-[130px] text-xs" aria-label="Canal do contato"><SelectValue /></SelectTrigger>
            <SelectContent>{CANAIS.map((c) => <SelectItem key={c.codigo} value={c.codigo} className="text-xs">{c.rotulo}</SelectItem>)}</SelectContent>
          </Select>
          <Input className="h-7 w-[240px] text-xs" placeholder="O que foi combinado (opcional)" value={nota} onChange={(e) => setNota(e.target.value)} aria-label="Nota do contato" />
          <Button type="button" size="sm" className="h-7 text-xs" disabled={bloqueado} onClick={() => { void enviar({ ...base, acao: 'contato', canal, nota: nota || undefined }); }}>Registrar contato</Button>
        </div>
      )}
      {acao === 'promessa' && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="cobranca-acao-promessa">
          <Input type="date" className="h-7 w-[150px] text-xs" value={pData} onChange={(e) => setPData(e.target.value)} aria-label="Data prometida" />
          <Input inputMode="decimal" className="h-7 w-[120px] text-xs" placeholder="Valor (R$)" value={pValor} onChange={(e) => setPValor(e.target.value)} aria-label="Valor prometido" />
          <Button type="button" size="sm" className="h-7 text-xs" disabled={bloqueado || !pData || !pValor} onClick={() => {
            const v = parseValorBR(pValor);
            if (v === null) { toast.error('Valor da promessa inválido — use 1234,50 ou 1.234,50.'); return; }
            void enviar({ ...base, acao: 'promessa', promessaData: pData, promessaValor: v, nota: nota || undefined });
          }}>Registrar promessa</Button>
        </div>
      )}
      {acao === 'nota' && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="cobranca-acao-nota">
          <Input className="h-7 w-[300px] text-xs" placeholder="Nota" value={nota} onChange={(e) => setNota(e.target.value)} aria-label="Nota" />
          <Button type="button" size="sm" className="h-7 text-xs" disabled={bloqueado || !nota.trim()} onClick={() => { void enviar({ ...base, acao: 'nota', nota }); }}>Salvar nota</Button>
        </div>
      )}
    </div>
  );
}

const TOM_PROMESSA: Record<string, string> = { aberta: 'text-status-info', vencida: 'text-status-error', saldo_caiu: 'text-status-success' };

export function CobrancaFila({ company }: { company: Empresa }) {
  const fila = useCobrancaFila(company);
  if (fila.isLoading) return <p className="text-sm text-muted-foreground">Carregando a fila…</p>;
  if (fila.error) return <p className="text-sm text-status-error" data-testid="cobranca-fila-erro">Não foi possível ler a fila de cobrança (erro de leitura) — nada a mostrar até a leitura voltar.</p>;
  const itens = fila.data ?? [];
  if (itens.length === 0) return <p className="text-sm text-muted-foreground" data-testid="cobranca-fila-vazia">Sem vencido em aberto na sua carteira — nenhum cliente com título vencido (regra da aba Ciclo) e nenhum caso aberto.</p>;

  const grupos = agruparPorFaixa(itens);
  return (
    <div className="space-y-6" data-testid="cobranca-fila">
      {grupos.map((g) => (
        <section key={g.faixa} className="space-y-2">
          <h3 className="text-sm font-medium flex items-center gap-2">
            {g.faixa === 'sem_vencido' ? 'Casos abertos sem vencido na view (conferir quitação)' : ROTULO_FAIXA[g.faixa]}
            <Badge variant="outline">{g.itens.length}</Badge>
            {g.saldo !== null && <span className="text-muted-foreground font-mono text-xs">{brl(g.saldo)}</span>}
          </h3>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Cliente</TableHead><TableHead className="text-right">Vencido</TableHead><TableHead className="text-right">Dias</TableHead>
              <TableHead>Dona</TableHead><TableHead>Promessa</TableHead><TableHead>Coorte</TableHead><TableHead>Último contato</TableHead><TableHead>Ação</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {g.itens.map((it) => {
                const vc = variacaoCoorte(it);
                return (
                  <TableRow key={`${it.company}:${it.omieCodigoCliente}`} data-testid={`cobranca-linha-${it.omieCodigoCliente}`}>
                    <TableCell>
                      <div className="font-medium">{it.nomeCliente ?? `cliente ${it.omieCodigoCliente}`}</div>
                      <div className="text-xs text-muted-foreground">{it.nVencidas !== null ? `${it.nVencidas} parcela${it.nVencidas > 1 ? 's' : ''}` : '—'}{it.notaAtual ? ` · ${it.notaAtual}` : ''}</div>
                    </TableCell>
                    <TableCell className="text-right font-mono">{it.saldoVencido !== null ? brl(it.saldoVencido) : '—'}</TableCell>
                    <TableCell className="text-right font-mono">{it.diasVencidoMax ?? '—'}</TableCell>
                    <TableCell className="text-xs">{it.donaNome ?? (it.donaUserId ? 'sem nome' : <span className="text-status-warning">sem dona (gestão)</span>)}</TableCell>
                    <TableCell className="text-xs">
                      {it.promessaData ? (
                        <span className={TOM_PROMESSA[it.promessaSituacao ?? ''] ?? ''}>
                          {dataBr(it.promessaData)} · {it.promessaValor !== null ? brl(it.promessaValor) : '—'} · {it.promessaSituacao ? ROTULO_PROMESSA[it.promessaSituacao] : '—'}
                        </span>
                      ) : '—'}
                    </TableCell>
                    <TableCell className="text-xs font-mono">
                      {vc ? <span title="saldo dos títulos congelados: inicial → atual (variação; cancelamento e renegociação também baixam)">{brl(vc.inicial)} → {brl(vc.atual)}</span>
                        : it.saldoInicialCoorte !== null ? <span title="título congelado sumiu da fonte: atual desconhecido">{brl(it.saldoInicialCoorte)} → ?</span> : '—'}
                    </TableCell>
                    <TableCell className="text-xs">{it.ultimoContatoEm ? `${dataBr(it.ultimoContatoEm.slice(0, 10))} (${it.nContatos})` : '—'}</TableCell>
                    <TableCell><LinhaAcoes item={it} company={company} /></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </section>
      ))}
    </div>
  );
}
