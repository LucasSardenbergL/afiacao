// Helper PURO do Roteirizador-campo (Sub-PR 3): transforma um alvo (RouteStop) +
// a linha crua do prospect (ProspectRow, quando houver) no view-model do Sheet de
// detalhe. Sem I/O — testável. Reusa os formatadores canônicos de telefone/CNPJ.
//
// Carteira NÃO precisa do raw: o RouteStop já carrega nome/telefone/endereço/
// diasDesdeVisita (ver desvio documentado no plano). Prospect precisa do raw pra
// razão social + telefone2, que o prospectRowToStopDraft colapsa.
import type { RouteStop } from '@/components/rota/planner/types';
import type { ProspectRow } from './prospect-stop';
import { labelProspeccaoStatus } from './prospect-stop';
import { formatBrPhone, isCellphone, whatsappLink } from '@/lib/phone';
import { formatarCnpj } from '@/lib/radar/ui-helpers';

export interface ContatoAlvo {
  rotulo: string;                 // "Telefone 1" | "Telefone 2" | "Telefone"
  telefone: string;               // cru — o BotaoLigar normaliza e escolhe o caminho
  display: string;                // (DD) 9XXXX-XXXX
  whatsappHref: string | null;    // só se celular + link válido (esconde senão)
}

export interface AlvoDetalhe {
  tipo: 'prospect' | 'carteira';
  nome: string;
  subtitulo: string | null;       // razão social (prospect, se != nome)
  cnpjFormatado: string | null;   // prospect
  statusLabel: string | null;     // prospect (a contatar / sem resposta / em conversa)
  recenciaLabel: string | null;   // carteira (Visitado há N dias / Nunca visitado)
  enderecoLinhas: string[];
  contatos: ContatoAlvo[];
}

const t = (v: string | null | undefined): string => (v ?? '').trim();

/** Rótulo humano da recência da carteira a partir dos dias desde a última visita. */
export function recenciaLabel(dias: number | null | undefined): string {
  if (dias == null) return 'Nunca visitado';
  if (dias <= 0) return 'Visitado hoje';
  if (dias === 1) return 'Visitado ontem';
  return `Visitado há ${dias} dias`;
}

function montarContato(rotulo: string, telefone: string | null | undefined): ContatoAlvo | null {
  const raw = t(telefone);
  if (!raw) return null;
  return {
    rotulo,
    telefone: raw,
    display: formatBrPhone(raw),
    // WhatsApp só pra celular (mesmo critério do RadarDetailSheet) — evita link
    // pra fixo. whatsappLink ainda devolve null em número incompleto.
    whatsappHref: isCellphone(raw) ? whatsappLink(raw) : null,
  };
}

function enderecoLinhas(a: RouteStop['address']): string[] {
  const linhas: string[] = [];
  const ruaNum = [t(a.street), t(a.number)].filter(Boolean).join(', ');
  if (ruaNum) linhas.push(ruaNum);
  if (t(a.complement)) linhas.push(t(a.complement));
  if (t(a.neighborhood)) linhas.push(t(a.neighborhood));
  const cidadeUf = [t(a.city), t(a.state)].filter(Boolean).join(' - ');
  if (cidadeUf) linhas.push(cidadeUf);
  if (t(a.zip_code)) linhas.push(`CEP ${t(a.zip_code)}`);
  return linhas;
}

export function montarDetalheAlvo(args: {
  stop: RouteStop;
  prospectRow?: ProspectRow | null;
}): AlvoDetalhe {
  const { stop, prospectRow } = args;
  const endereco = enderecoLinhas(stop.address);

  if (stop.stopType === 'prospect_visit') {
    const razao = t(prospectRow?.razao_social);
    const cnpj = t(prospectRow?.cnpj) || t(stop.radarCnpj);
    const status = t(stop.prospeccaoStatus) || t(prospectRow?.prospeccao_status);
    const contatos = prospectRow
      ? [
          montarContato('Telefone 1', prospectRow.telefone1),
          montarContato('Telefone 2', prospectRow.telefone2),
        ].filter((c): c is ContatoAlvo => c != null)
      : [montarContato('Telefone', stop.phone)].filter((c): c is ContatoAlvo => c != null);
    return {
      tipo: 'prospect',
      nome: stop.customerName,
      subtitulo: razao && razao !== stop.customerName ? razao : null,
      cnpjFormatado: cnpj ? formatarCnpj(cnpj) : null,
      statusLabel: status ? labelProspeccaoStatus(status) : null,
      recenciaLabel: null,
      enderecoLinhas: endereco,
      contatos,
    };
  }

  // Carteira (sales_visit) — só o stop.
  const contatos = [montarContato('Telefone', stop.phone)].filter(
    (c): c is ContatoAlvo => c != null,
  );
  return {
    tipo: 'carteira',
    nome: stop.customerName,
    subtitulo: null,
    cnpjFormatado: null,
    statusLabel: null,
    recenciaLabel: recenciaLabel(stop.diasDesdeVisita),
    enderecoLinhas: endereco,
    contatos,
  };
}
