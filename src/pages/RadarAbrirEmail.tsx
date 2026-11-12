// Radar D1 — destino do link do e-mail semanal de leads: /radar/abrir/:envio/:cnpj.
// Grava os DOIS momentos no ledger (radar_lead_aberturas; denominador = leads em e-mails entregues):
//   1. o clique, assim que a página monta;
//   2. a ficha entregue — gravada pelo /radar quando a ficha APARECE na tela (revisão 2026-11-11, item 4; antes era
//      gravada aqui, assim que a leitura voltava, antes de existir ficha). Aqui o lead é lido pela MESMA chave da ficha
//      (`buscarEmpresaRadar`): o /radar abre com ele no cache, sem 2ª leitura. Lead que não veio (não encontrado, erro,
//      demora > 8 s) não conta como ficha: vira falha do sensor no painel do funil, e o deep link vai sem `origem`.
// Depois segue para a ficha pelo deep link do pacote B5 (/radar?cnpj=…&origem=email&envio=…). Na lente "Ver como"
// não grava nem espera (inspeção não conta); link malformado vai para o Radar sem registrar nada.
import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { linkFichaRadar, lerLinkDoEmail } from '@/lib/radar/prospectar-hoje';
import { classificarErro } from '@/lib/radar/sensor-empurrado';
import { buscarEmpresaRadar } from '@/queries/useRadarEmpresa';
import { registrarAberturaEmpurrada, reportarFalhaSensor } from '@/queries/useRadarRegistroEmpurrado';

/** Teto da espera pela ficha: passou disso, segue para o Radar (que tenta de novo) e registra a demora. */
const ESPERA_MAX_FICHA_MS = 8000;

export default function RadarAbrirEmail() {
  const { envio, cnpj } = useParams<{ envio: string; cnpj: string }>();
  const { isImpersonating } = useImpersonation();
  const link = lerLinkDoEmail(envio, cnpj);
  const qc = useQueryClient();
  const [pronto, setPronto] = useState(!link || isImpersonating);
  // O lead chegou: o /radar grava a ficha entregue quando ela aparecer (origem=email + envio).
  const [lido, setLido] = useState(false);

  useEffect(() => {
    if (!link || isImpersonating) return;
    let vivo = true;
    let resolvido = false;
    const lead = { origem: 'email' as const, envio: link.envio, cnpj: link.cnpj };
    void registrarAberturaEmpurrada(lead);

    const teto = setTimeout(() => {
      if (resolvido) return;
      resolvido = true;
      reportarFalhaSensor('ficha_email', 'ficha_demorou');
      if (vivo) setPronto(true);
    }, ESPERA_MAX_FICHA_MS);

    buscarEmpresaRadar(qc, link.cnpj).then(
      (e) => {
        if (resolvido) return;
        resolvido = true;
        if (e) { if (vivo) setLido(true); }
        else reportarFalhaSensor('ficha_email', 'lead_nao_encontrado');
      },
      (err) => {
        if (resolvido) return;
        resolvido = true;
        const r = classificarErro(err);
        reportarFalhaSensor('ficha_email', r.ok ? 'desconhecido' : `leitura_${r.motivo}`);
      },
    ).finally(() => {
      clearTimeout(teto);
      if (vivo) setPronto(true);
    });

    return () => {
      vivo = false;
      clearTimeout(teto);
    };
    // Uma vez por montagem: o redirect desmonta a página logo em seguida.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!pronto) return <PageSkeleton variant="detail" />;
  if (!link) return <Navigate to="/radar" replace />;
  return <Navigate to={lido ? linkFichaRadar(link.cnpj, { email: link.envio }) : linkFichaRadar(link.cnpj)} replace />;
}
