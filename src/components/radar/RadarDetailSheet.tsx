import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { MapPin, Phone, Mail, MessageSquare } from 'lucide-react';
import { RadarOutcomeMenu } from './RadarOutcomeMenu';
import { RadarAcoesLead } from './RadarAcoesLead';
import { isCellphone, whatsappLink } from '@/lib/phone';
import {
  formatarCnpj,
  formatarCapital,
  rotuloPorte,
  idadeEmAnos,
} from '@/lib/radar/ui-helpers';
import type { RadarEmpresa } from '@/queries/useRadarLista';

function Linha({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function RadarDetailSheet({
  empresa,
  hojeISO,
  onClose,
}: {
  empresa: RadarEmpresa | null;
  hojeISO: string;
  onClose: () => void;
}) {
  if (!empresa) return null;
  const endereco = [
    empresa.logradouro,
    empresa.numero,
    empresa.bairro,
    empresa.municipio_nome,
    empresa.uf,
    empresa.cep,
  ]
    .filter(Boolean)
    .join(', ');
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(endereco || empresa.cnpj)}`;
  const idade = idadeEmAnos(empresa.data_abertura, hojeISO);

  return (
    <Sheet open={!!empresa} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 flex-wrap">
            {empresa.razao_social || empresa.cnpj}
            {empresa.ja_cliente && <Badge variant="secondary">já é cliente</Badge>}
          </SheetTitle>
        </SheetHeader>
        <div className="mt-4 flex justify-end">
          <RadarOutcomeMenu cnpj={empresa.cnpj} />
        </div>
        <div className="mt-3">
          <RadarAcoesLead empresa={empresa} />
        </div>
        <div className="mt-4 divide-y">
          {empresa.nome_fantasia && <Linha label="Fantasia">{empresa.nome_fantasia}</Linha>}
          <Linha label="CNPJ">
            <span className="font-tabular">{formatarCnpj(empresa.cnpj)}</span>
          </Linha>
          <Linha label="CNAE">
            {empresa.cnae_principal}
            {empresa.cnae_descricao ? ` — ${empresa.cnae_descricao}` : ''}
          </Linha>
          <Linha label="Abertura">
            {empresa.data_abertura ?? '—'} {idade != null ? `(${idade} anos)` : ''}
          </Linha>
          <Linha label="Porte">{rotuloPorte(empresa.porte)}</Linha>
          <Linha label="Capital">{formatarCapital(empresa.capital_social)}</Linha>
          <Linha label="Telefone">
            {empresa.telefone1 ? (
              <a
                className="inline-flex items-center gap-1 underline"
                href={`tel:${empresa.telefone1}`}
              >
                <Phone className="w-3 h-3" />
                {empresa.telefone1}
              </a>
            ) : (
              '—'
            )}
            {isCellphone(empresa.telefone1) && whatsappLink(empresa.telefone1) && (
              <a
                className="ml-2 inline-flex items-center gap-1 text-xs text-status-success-bold"
                href={whatsappLink(empresa.telefone1) as string}
                target="_blank"
                rel="noreferrer"
              >
                <MessageSquare className="w-3 h-3" /> WhatsApp
              </a>
            )}
            {empresa.telefone2 ? ` · ${empresa.telefone2}` : ''}
          </Linha>
          <Linha label="E-mail">
            {empresa.email ? (
              <a
                className="inline-flex items-center gap-1 underline truncate"
                href={`mailto:${empresa.email}`}
              >
                <Mail className="w-3 h-3" />
                {empresa.email}
              </a>
            ) : (
              '—'
            )}
          </Linha>
          <Linha label="Endereço">
            {endereco || '—'}
            {endereco && (
              <a
                className="ml-2 inline-flex items-center gap-1 text-xs underline"
                href={mapsUrl}
                target="_blank"
                rel="noreferrer"
              >
                <MapPin className="w-3 h-3" /> mapa
              </a>
            )}
          </Linha>
          {empresa.socios_nomes && <Linha label="Sócios">{empresa.socios_nomes}</Linha>}
          {empresa.descarte_motivo && (
            <Linha label="Motivo descarte">{empresa.descarte_motivo}</Linha>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
