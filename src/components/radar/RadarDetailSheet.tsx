import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { MapPin, Mail, MessageSquare, ChevronRight, History } from 'lucide-react';
import { RadarOutcomeMenu } from './RadarOutcomeMenu';
import { RadarAcoesLead } from './RadarAcoesLead';
import { isCellphone, whatsappLink } from '@/lib/phone';
import { BotaoLigar } from '@/components/call/BotaoLigar';
import { cn } from '@/lib/utils';
import { estadoDeLeitura, naoConsegui, desatualizado } from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { useRadarContatos, LIMITE_HISTORICO_RADAR } from '@/queries/useRadarContatos';
import {
  formatarCnpj, formatarCapital, rotuloPorte, idadeEmAnos, rotuloStatus, tomStatus, CLASSE_TOM, scoreUI,
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

function Telefone({ numero, nome }: { numero: string; nome: string }) {
  const wa = isCellphone(numero) ? whatsappLink(numero) : null;
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <span className="font-tabular">{numero}</span>
      <BotaoLigar telefone={numero} nomeCliente={nome} variant="icon" />
      {wa && (
        <a className="inline-flex items-center gap-1 text-xs text-status-success-bold" href={wa} target="_blank" rel="noreferrer">
          <MessageSquare className="w-3 h-3" /> WhatsApp
        </a>
      )}
    </span>
  );
}

/** Histórico de contatos: distingue erro de vazio (erro colapsado em vazio é a classe que o Radar já pagou). */
function Historico({ cnpj }: { cnpj: string }) {
  const q = useRadarContatos(cnpj);
  const estado = estadoDeLeitura(q);
  const velho = desatualizado(q, Boolean(q.data));
  return (
    <div className="mt-4">
      <div className="flex items-center gap-1 text-sm font-medium mb-1">
        <History className="w-4 h-4" /> Histórico
        <span className="text-xs text-muted-foreground font-normal">(últimos {LIMITE_HISTORICO_RADAR})</span>
      </div>
      {estado === 'carregando' ? (
        <div className="space-y-1">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-6" />)}</div>
      ) : naoConsegui(estado) && !q.data ? (
        <AvisoLeituraFalhou oque="o histórico de contatos" estado={estado} className="mb-0" />
      ) : !q.data || q.data.length === 0 ? (
        <>
          <p className="text-xs text-muted-foreground">Nenhum contato registrado ainda.</p>
          {velho && <AvisoLeituraFalhou oque="a leitura mais recente do histórico" estado={velho} className="mt-1" />}
        </>
      ) : (
        <ul className="divide-y text-sm">
          {q.data.map((c) => (
            <li key={c.id} className="py-1.5 flex items-start gap-2">
              <span className={cn('shrink-0 rounded border px-1.5 py-px text-[11px] leading-4', CLASSE_TOM[tomStatus(c.acao)])}>
                {rotuloStatus(c.acao)}
              </span>
              <div className="min-w-0 flex-1">
                {c.nota && <div className="truncate">{c.nota}</div>}
                <div className="text-xs text-muted-foreground">
                  {new Date(c.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                  {c.status_anterior ? ` · antes: ${rotuloStatus(c.status_anterior)}` : ''}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {velho && q.data && q.data.length > 0 && <AvisoLeituraFalhou oque="a leitura mais recente do histórico" estado={velho} className="mt-1" />}
    </div>
  );
}

export function RadarDetailSheet({
  empresa,
  hojeISO,
  onClose,
  onProximo,
}: {
  empresa: RadarEmpresa | null;
  hojeISO: string;
  onClose: () => void;
  /** Avança para o próximo lead da lista (registrar desfecho → próximo, sem fechar a ficha). */
  onProximo?: () => void;
}) {
  if (!empresa) return null;
  const endereco = [empresa.logradouro, empresa.numero, empresa.bairro, empresa.municipio_nome, empresa.uf, empresa.cep]
    .filter(Boolean)
    .join(', ');
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(endereco || empresa.cnpj)}`;
  const idade = idadeEmAnos(empresa.data_abertura, hojeISO);
  const nome = empresa.razao_social || empresa.cnpj;
  const score = scoreUI(empresa.score, empresa.score_motivos);

  return (
    <Sheet open={!!empresa} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 flex-wrap">
            {nome}
            <span className={cn('rounded border px-1.5 py-px text-[11px] leading-4 font-normal', CLASSE_TOM[tomStatus(empresa.prospeccao_status)])}>
              {rotuloStatus(empresa.prospeccao_status)}
            </span>
            {empresa.ja_cliente && <Badge variant="secondary">já é cliente</Badge>}
          </SheetTitle>
        </SheetHeader>
        <div className="mt-4 flex items-center justify-between gap-2">
          {onProximo ? (
            <Button variant="ghost" size="sm" onClick={onProximo} title="Pular para o próximo lead da lista">
              Próximo <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          ) : <span />}
          <RadarOutcomeMenu cnpj={empresa.cnpj} onRegistrado={() => onProximo?.()} />
        </div>
        <div className="mt-3">
          <RadarAcoesLead empresa={empresa} />
        </div>
        <div className="mt-4 divide-y">
          <Linha label="Score">
            <span className={cn('inline-block rounded border px-1.5 py-px text-[11px] leading-4 font-tabular', CLASSE_TOM[score.tom])} data-testid="radar-score-ficha">
              {score.texto}{empresa.score != null ? ' / 100' : ''}
            </span>
            {empresa.score != null && empresa.score_motivos && empresa.score_motivos.length > 0 ? (
              <ul className="mt-1 text-xs text-muted-foreground list-disc pl-4">
                {empresa.score_motivos.map((m) => <li key={m}>{m}</li>)}
              </ul>
            ) : (
              <span className="ml-2 text-xs text-muted-foreground">{score.detalhe}</span>
            )}
          </Linha>
          {empresa.nome_fantasia && <Linha label="Fantasia">{empresa.nome_fantasia}</Linha>}
          <Linha label="CNPJ"><span className="font-tabular">{formatarCnpj(empresa.cnpj)}</span></Linha>
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
            {empresa.telefone1 ? <Telefone numero={empresa.telefone1} nome={nome} /> : '—'}
          </Linha>
          {empresa.telefone2 && (
            <Linha label="Telefone 2"><Telefone numero={empresa.telefone2} nome={nome} /></Linha>
          )}
          <Linha label="E-mail">
            {empresa.email ? (
              <a className="inline-flex items-center gap-1 underline truncate" href={`mailto:${empresa.email}`}>
                <Mail className="w-3 h-3" />{empresa.email}
              </a>
            ) : '—'}
          </Linha>
          <Linha label="Endereço">
            {endereco || '—'}
            {endereco && (
              <a className="ml-2 inline-flex items-center gap-1 text-xs underline" href={mapsUrl} target="_blank" rel="noreferrer">
                <MapPin className="w-3 h-3" /> mapa
              </a>
            )}
          </Linha>
          {empresa.socios_nomes && <Linha label="Sócios">{empresa.socios_nomes}</Linha>}
          {empresa.omie_codigo_cliente && (
            <Linha label="Omie (Oben)">
              cód. <span className="font-tabular">{empresa.omie_codigo_cliente}</span>
              {empresa.omie_cadastrado_em
                ? ` · ${new Date(empresa.omie_cadastrado_em).toLocaleDateString('pt-BR')}`
                : ''}
            </Linha>
          )}
          {empresa.descarte_motivo && <Linha label="Motivo descarte">{empresa.descarte_motivo}</Linha>}
        </div>
        <Historico cnpj={empresa.cnpj} />
      </SheetContent>
    </Sheet>
  );
}
