import { Building2, MapPin, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { SELO_CONTABIL, textoMotivo, type CampoContato, type ContatoContabil } from '@/lib/radar/contato-contabil';
import { useCorrigirContatoContabil } from '@/queries/useRadarContatoContabil';
import { Selo } from './Selo';

/**
 * Selo e correção de UM contato (telefone1, telefone2 ou e-mail) — migration 20261109140000.
 *
 * - efetivo true  → selo "Contato provável da contabilidade — prefira visita", o motivo e "Não é da contabilidade";
 * - efetivo false → só "É da contabilidade?" (discreto); se foi o vendedor que disse "não é", diz isso e deixa desfazer;
 * - efetivo null  → nada: o sinal ainda não foi calculado (ausente ≠ "contato direto").
 * A correção vai para o ledger (RPC `radar_contato_contabil_corrigir`) com a versão vista; sob a lente, desligada.
 */
export function RadarContatoContabil({ cnpj, campo, contato }: {
  cnpj: string;
  campo: CampoContato;
  contato: ContatoContabil | null | undefined;
}) {
  const corrigir = useCorrigirContatoContabil();
  if (!contato || contato.efetivo === null) return null;
  const lente = isLensActive();
  const ocupado = corrigir.isPending && corrigir.variables?.campo === campo && corrigir.variables?.cnpj === cnpj;
  const enviar = (veredito: boolean | null) => corrigir.mutate({
    cnpj, campo, veredito, correcaoVista: contato.correcaoId, automatico: contato.automatico,
  });
  const titleLente = lente ? 'Indisponível em modo Ver como' : undefined;

  if (contato.efetivo) {
    return (
      <span className="basis-full mt-0.5 flex flex-col gap-1" data-testid={`radar-contabil-${campo}`}>
        <span className="flex items-center gap-1.5 flex-wrap">
          <Selo tom="warning" className="font-normal" data-testid="radar-selo-contabil">
            <Building2 className="w-3 h-3 mr-1 inline" />{SELO_CONTABIL}
          </Selo>
        </span>
        <span className="text-xs text-muted-foreground" data-testid="radar-contabil-motivo">{textoMotivo(contato)}</span>
        <span className="flex items-center gap-1 flex-wrap">
          {contato.veredito === true ? (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={lente || ocupado} title={titleLente}
              onClick={() => enviar(null)}>
              <Undo2 className="w-3 h-3 mr-1" /> Desfazer (marcado por vendedor)
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={lente || ocupado} title={titleLente}
              onClick={() => enviar(false)} data-testid="radar-contabil-nao-e">
              Não é da contabilidade
            </Button>
          )}
        </span>
      </span>
    );
  }

  return (
    <span className="basis-full flex items-center gap-1 flex-wrap" data-testid={`radar-contabil-${campo}`}>
      {contato.veredito === false && (
        <span className="text-xs text-muted-foreground">Um vendedor marcou como contato da empresa.</span>
      )}
      {contato.veredito === false ? (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={lente || ocupado} title={titleLente}
          onClick={() => enviar(null)}>
          <Undo2 className="w-3 h-3 mr-1" /> Desfazer
        </Button>
      ) : (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" disabled={lente || ocupado}
          title={titleLente ?? 'Marque se este contato for do escritório de contabilidade, não da empresa'}
          onClick={() => enviar(true)} data-testid="radar-contabil-e">
          É da contabilidade?
        </Button>
      )}
    </span>
  );
}

/** O endereço em destaque quando o contato é (ou parece ser) da contabilidade: a próxima ação é a visita. */
export function RadarPrefiraVisita({ endereco, mapsUrl, mapsEmpresaUrl, todos, onAbrir }: {
  endereco: string;
  mapsUrl: string | null;
  mapsEmpresaUrl: string | null;
  todos: boolean;
  onAbrir?: (link: 'endereco' | 'empresa') => void;
}) {
  return (
    <div className="rounded-md border border-status-warning/40 bg-status-warning/5 p-2.5 text-sm" data-testid="radar-prefira-visita">
      <p className="font-medium flex items-center gap-1.5">
        <MapPin className="w-4 h-4 text-status-warning" /> Prefira a visita
      </p>
      <p className="text-xs text-muted-foreground mt-0.5">
        {todos
          ? 'O telefone e o e-mail que a Receita tem parecem ser da contabilidade da empresa. Vá direto ao endereço.'
          : 'Um dos telefones parece ser da contabilidade da empresa. Se não houver outro contato direto, vá ao endereço.'}
      </p>
      <p className="mt-1">{endereco}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {mapsUrl && (
          <Button asChild size="sm">
            <a href={mapsUrl} target="_blank" rel="noreferrer" onClick={() => onAbrir?.('endereco')}>
              <MapPin className="w-4 h-4 mr-1" /> Abrir no mapa
            </a>
          </Button>
        )}
        {mapsEmpresaUrl && (
          <Button asChild size="sm" variant="outline">
            <a href={mapsEmpresaUrl} target="_blank" rel="noreferrer" onClick={() => onAbrir?.('empresa')}>
              Procurar a empresa no Maps
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
