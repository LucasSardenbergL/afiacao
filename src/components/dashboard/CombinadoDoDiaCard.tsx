import { useState } from 'react';
import { toast } from 'sonner';
import { Handshake, Copy, Check, AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import { hojeSP } from '@/lib/dashboard/sp-date';
import { textoCombinado } from '@/lib/dashboard/combinado-dia';
import { useCombinadoDia, registrarCombinado, type CombinadoVendedora } from '@/hooks/dashboard/useCombinadoDia';

const nomeEmpresa = (c: string): string => COMPANIES[c as Company]?.shortName ?? c;

function BlocoVendedora({ v }: { v: CombinadoVendedora }) {
  const [copiado, setCopiado] = useState(false);
  const hoje = hojeSP();

  const copiar = async () => {
    const texto = textoCombinado({
      vendedora: v.nome,
      hoje,
      itens: v.itens,
      nomeEmpresa,
      linkApp: `${window.location.origin}/meu-dia`,
    });
    try {
      await navigator.clipboard.writeText(texto);
    } catch {
      toast.error('Não consegui copiar — selecione o texto à mão.');
      return;
    }
    setCopiado(true);
    toast.success(`Combinado de ${v.nome.split(/\s+/)[0]} copiado — cole no WhatsApp dela.`);
    void registrarCombinado(v.id, v.itens);
  };

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium truncate">{v.nome}</div>
        {v.itens.length > 0 && (
          <Button size="sm" variant={copiado ? 'outline' : 'default'} onClick={copiar} className="shrink-0">
            {copiado ? <Check className="w-3.5 h-3.5 mr-1" /> : <Copy className="w-3.5 h-3.5 mr-1" />}
            {copiado ? 'Copiado' : 'Copiar para WhatsApp'}
          </Button>
        )}
      </div>
      {v.carregando ? (
        <div className="text-2xs text-muted-foreground mt-1">carregando…</div>
      ) : v.itens.length === 0 ? (
        <div className="text-2xs text-muted-foreground mt-1">
          {v.fontesComErro.length > 0
            ? 'Sem itens das fontes que li — e algumas não li (abaixo). Não é "nada a fazer".'
            : 'Nada a combinar hoje: sem cobrança até 45 dias nem recompra atrasada na carteira dela.'}
        </div>
      ) : (
        <ol className="mt-1.5 space-y-1 list-decimal pl-4">
          {v.itens.map((it) => (
            <li key={`${it.tipo}:${it.empresa}:${it.clienteRef}`} className="text-xs leading-snug">
              <span className="font-medium">{it.nome}</span>{' '}
              <span className="text-muted-foreground">({nomeEmpresa(it.empresa)})</span> —{' '}
              <span className={it.tipo === 'cobranca' ? 'text-status-warning' : 'text-status-info'}>{it.detalhe}</span>
            </li>
          ))}
        </ol>
      )}
      {v.fontesComErro.length > 0 && (
        <div className="mt-1 flex items-center gap-1 text-2xs text-status-error">
          <AlertTriangle className="w-3 h-3" /> Não consegui ler: {v.fontesComErro.join(', ')} — a lista pode estar incompleta.
        </div>
      )}
    </div>
  );
}

/**
 * "Combinado do dia" no Meu dia do CEO: até 3 clientes por vendedora (cobrança recente + recompra atrasada) e o
 * texto pronto para encaminhar no WhatsApp. É o mecanismo de adoção: o time vive no Omie/WhatsApp, e o desfecho
 * volta no mesmo fio. Copiar grava a lista datada no ledger `combinado_dia` (sensor + base para medir resultado).
 */
export function CombinadoDoDiaCard() {
  const { vendedoras, erroVendedoras, carregando } = useCombinadoDia();

  if (carregando) return null;
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-1">
        <Handshake className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-base font-medium">Combinado do dia</h2>
      </div>
      <p className="text-2xs text-muted-foreground mb-3">
        Até 3 clientes por vendedora: cobrança de até 45 dias (caixa) e recompra atrasada. Copie e mande no WhatsApp
        dela; amanhã comece pelos retornos.
      </p>
      {erroVendedoras ? (
        <div className="text-xs text-status-error">Não consegui ler a lista de vendedoras — combinado indisponível.</div>
      ) : vendedoras.length === 0 ? (
        <div className="text-xs text-muted-foreground">Nenhuma vendedora com papel comercial cadastrada.</div>
      ) : (
        <div className="divide-y">
          {vendedoras.map((v) => (
            <BlocoVendedora key={v.id} v={v} />
          ))}
        </div>
      )}
    </Card>
  );
}
