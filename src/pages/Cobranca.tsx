import { useEffect } from 'react';
import { ListChecks } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useUrlState } from '@/hooks/useUrlState';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import { CobrancaFila } from '@/components/cobranca/CobrancaFila';
import { CobrancaReguaHoje } from '@/components/cobranca/CobrancaReguaHoje';
import type { Empresa } from '@/hooks/useCobranca';
import { track } from '@/lib/analytics';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { useCobrancaFila } from '@/hooks/useCobranca';
import { dataBr } from '@/lib/cobranca/cobranca-helpers';

/**
 * /cobranca — fila de cobrança com estado e dona + régua do dia (Frente B do plano Oben PME/PMR, PR2).
 * Staff: a vendedora vê a SUA carteira (a RPC filtra por dona); gestão/master vê tudo. Contas de pedido:
 * oben e colacor (colacor_sc não vende produto, mas tem CR — fica disponível).
 */
const EMPRESAS: Empresa[] = ['oben', 'colacor', 'colacor_sc'];

export default function Cobranca() {
  const [filtros, setFiltros] = useUrlState({ empresa: 'oben' });
  const empresa = (EMPRESAS as string[]).includes(filtros.empresa) ? (filtros.empresa as Empresa) : 'oben';

  useEffect(() => { track('cobranca.fila_aberta', { account: empresa }); }, [empresa]);
  const fila = useCobrancaFila(empresa);
  const corteEm = fila.data?.find((i) => i.coorteCorteEm)?.coorteCorteEm ?? null;

  // Sob a lente "Ver como" as RPCs novas são bloqueadas pelo write-guard (não estão na allowlist de leitura) e o
  // cache poderia mostrar a fila do MASTER: a tela se declara indisponível em vez de fingir.
  if (isLensActive()) {
    return (
      <div className="container mx-auto p-4 sm:p-6 max-w-7xl">
        <p className="text-sm text-muted-foreground" data-testid="cobranca-lente">A cobrança não está disponível sob a lente "Ver como" — saia da lente para ver a fila da sua carteira.</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 max-w-7xl">
      <header className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div className="flex items-center gap-3">
          <ListChecks className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-display font-bold">Cobrança</h1>
            <p className="text-sm text-muted-foreground">
              Clientes com título vencido (mesma régua da aba Ciclo), por faixa de atraso, com estado, dona e promessa.
              Recentes primeiro: o que venceu há até 45 dias recupera antes de envelhecer.
            </p>
          </div>
        </div>
        <Select value={empresa} onValueChange={(v) => setFiltros({ empresa: v })}>
          <SelectTrigger className="w-40" aria-label="Empresa"><SelectValue /></SelectTrigger>
          <SelectContent>
            {EMPRESAS.map((c) => <SelectItem key={c} value={c}>{COMPANIES[c as Company].shortName}</SelectItem>)}
          </SelectContent>
        </Select>
      </header>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Régua de hoje — D−2 (lembrete), D+1 e D+7</CardTitle>
          <p className="text-xs text-muted-foreground">
            O botão abre o WhatsApp com a mensagem pronta; o envio é seu. Abrir não vale como contato — marque "Contatado" quando falar com o cliente.
          </p>
        </CardHeader>
        <CardContent><CobrancaReguaHoje company={empresa} /></CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Fila de cobrança</CardTitle>
          <p className="text-xs text-muted-foreground">
            Estado por cliente (a contatar → contatado → promessa → pago informado / negociado / disputa). "Quitado" só fecha quando o Omie
            não mostra mais vencido. Coorte = saldo dos títulos congelados {corteEm ? `em ${dataBr(corteEm)}` : '(sem coorte selada para esta empresa)'} → atual pelos mesmos títulos (variação, não "recuperado").
          </p>
        </CardHeader>
        <CardContent><CobrancaFila company={empresa} /></CardContent>
      </Card>
    </div>
  );
}
