import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { useCobrancaRegistrar, useCobrancaRegua, type Empresa } from '@/hooks/useCobranca';
import { brl, dataBr, mensagemRegua, telefoneWa, urlWa, type ReguaItem } from '@/lib/cobranca/cobranca-helpers';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { track } from '@/lib/analytics';
import { COMPANIES } from '@/contexts/CompanyContext';

/**
 * Régua do dia (Frente B, PR2): D−2 (lembrete PREVENTIVO — a vencer, fora do estoque vencido), D+1 e D+7
 * (vencidos pela MESMA régua da aba Ciclo). O envio é do humano: o botão abre o WhatsApp com a mensagem
 * pronta (`wa.me`) e registra `whatsapp_aberto` no caso — ABRIR não prova envio nem contato; "Contatado"
 * é um botão separado, declarado. Nunca envio automático (LGPD + precisão > recall).
 */

const ROTULO_MARCO: Record<ReguaItem['marco'], string> = { 'D-2': 'Vence em 2 dias (lembrete)', 'D+1': 'Venceu ontem', 'D+7': 'Vencido há 7 dias' };
const TOM_MARCO: Record<ReguaItem['marco'], string> = { 'D-2': 'text-status-info', 'D+1': 'text-status-warning', 'D+7': 'text-status-error' };

export function CobrancaReguaHoje({ company }: { company: Empresa }) {
  const regua = useCobrancaRegua(company);
  const registrar = useCobrancaRegistrar();
  const lente = isLensActive();
  const empresaNome = COMPANIES[company].shortName;

  if (regua.isLoading) return <p className="text-sm text-muted-foreground">Carregando a régua de hoje…</p>;
  if (regua.error) return <p className="text-sm text-status-error" data-testid="cobranca-regua-erro">Não foi possível ler a régua de hoje (erro de leitura).</p>;
  const itens = regua.data ?? [];
  if (itens.length === 0) return <p className="text-sm text-muted-foreground" data-testid="cobranca-regua-vazia">Nenhum título nos marcos D−2, D+1 ou D+7 hoje na sua carteira.</p>;

  const registrarEvento = async (it: ReguaItem, acao: 'whatsapp_aberto' | 'contato') => {
    try {
      await registrar.mutateAsync({
        company, omieCodigoCliente: it.omieCodigoCliente, nomeCliente: it.nomeCliente,
        acao, canal: 'whatsapp', nota: `régua ${it.marco} · título ${it.omieCodigoLancamento}`,
      });
      track('cobranca.regua_acao', { account: company, marco: it.marco.replace(/-/g, '_').replace('+', 'mais'), acao });
    } catch (e) {
      toast.error(mensagemDeErro(e) ?? 'Não foi possível registrar.');
    }
  };

  return (
    <Table data-testid="cobranca-regua">
      <TableHeader><TableRow>
        <TableHead>Marco</TableHead><TableHead>Cliente</TableHead><TableHead>Título</TableHead><TableHead className="text-right">Saldo</TableHead><TableHead>Vencimento</TableHead><TableHead>Ação</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {itens.map((it) => {
          const tel = telefoneWa(it.telefone);
          const url = tel ? urlWa(tel, mensagemRegua(it, empresaNome)) : null;
          const bloqueado = lente || !it.podeAgir || registrar.isPending;
          return (
            <TableRow key={`${it.omieCodigoLancamento}`} data-testid={`cobranca-regua-${it.omieCodigoLancamento}`}>
              <TableCell><Badge variant="outline" className={TOM_MARCO[it.marco]}>{ROTULO_MARCO[it.marco]}</Badge></TableCell>
              <TableCell>{it.nomeCliente ?? `cliente ${it.omieCodigoCliente}`}{it.estado ? <span className="text-xs text-muted-foreground"> · {it.estado}</span> : null}</TableCell>
              <TableCell className="text-xs">{it.numeroDocumento ?? `lanç. ${it.omieCodigoLancamento}`}</TableCell>
              <TableCell className="text-right font-mono">{it.saldo !== null ? brl(it.saldo) : '—'}</TableCell>
              <TableCell className="text-xs">{dataBr(it.dataVencimento)}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1.5">
                  {url ? (
                    <Button asChild size="sm" variant="default" className="h-7 text-xs" aria-disabled={bloqueado}>
                      <a href={url} target="_blank" rel="noopener noreferrer"
                        onClick={(e) => { if (bloqueado) { e.preventDefault(); return; } void registrarEvento(it, 'whatsapp_aberto'); }}>
                        Abrir WhatsApp
                      </a>
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground" data-testid={`cobranca-regua-${it.omieCodigoLancamento}-sem-telefone`}>{it.telefone ? 'telefone inválido no cadastro' : 'sem telefone no cadastro'}</span>
                  )}
                  <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={bloqueado} onClick={() => { void registrarEvento(it, 'contato'); }}>
                    Contatado
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
