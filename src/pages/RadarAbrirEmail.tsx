// Radar D1 — destino do link do e-mail semanal de leads: /radar/abrir/:envio/:cnpj.
// Grava a abertura no LEDGER (radar_lead_aberturas: o numerador do sensor; denominador = e-mails enviados) e segue
// para a ficha pelo deep link do pacote B5 (/radar?cnpj=). Sem tela própria: o vendedor cai direto no lead.
// Na lente "Ver como" não grava (inspeção não conta); link malformado vai para o Radar sem registrar nada.
import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { linkFichaRadar, lerLinkDoEmail } from '@/lib/radar/prospectar-hoje';
import { registrarAberturaEmpurrada } from '@/queries/useRadarRegistroEmpurrado';

export default function RadarAbrirEmail() {
  const { envio, cnpj } = useParams<{ envio: string; cnpj: string }>();
  const { isImpersonating } = useImpersonation();
  const link = lerLinkDoEmail(envio, cnpj);

  useEffect(() => {
    if (!link || isImpersonating) return;
    void registrarAberturaEmpurrada({ origem: 'email', envio: link.envio, cnpj: link.cnpj });
    // Uma vez por montagem: o redirect desmonta a página logo em seguida.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Navigate to={link ? linkFichaRadar(link.cnpj) : '/radar'} replace />;
}
