// Radar D1 — destino do link do e-mail semanal de leads: /radar/abrir/:envio/:cnpj.
// Grava os DOIS momentos no ledger (radar_lead_aberturas; denominador = leads em e-mails entregues):
//   1. o clique, assim que a página monta;
//   2. a ficha entregue, quando o lead foi LIDO no navegador (a mesma leitura que a ficha do Radar faz). Lead que não
//      veio (não encontrado, erro, demora > 8 s) não conta como ficha: vira falha do sensor no painel do funil.
// Depois segue para a ficha pelo deep link do pacote B5 (/radar?cnpj=). Na lente "Ver como" não grava nem espera
// (inspeção não conta); link malformado vai para o Radar sem registrar nada.
import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { linkFichaRadar, lerLinkDoEmail } from '@/lib/radar/prospectar-hoje';
import { classificarErro } from '@/lib/radar/sensor-empurrado';
import { lerEmpresaRadar } from '@/queries/useRadarConflitosCadastro';
import {
  registrarAberturaEmpurrada,
  registrarFichaEntregue,
  reportarFalhaSensor,
} from '@/queries/useRadarRegistroEmpurrado';

/** Teto da espera pela ficha: passou disso, segue para o Radar (que tenta de novo) e registra a demora. */
const ESPERA_MAX_FICHA_MS = 8000;

export default function RadarAbrirEmail() {
  const { envio, cnpj } = useParams<{ envio: string; cnpj: string }>();
  const { isImpersonating } = useImpersonation();
  const link = lerLinkDoEmail(envio, cnpj);
  const [pronto, setPronto] = useState(!link || isImpersonating);

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

    lerEmpresaRadar(link.cnpj).then(
      (e) => {
        if (resolvido) return;
        resolvido = true;
        if (e) void registrarFichaEntregue(lead);
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
  return <Navigate to={link ? linkFichaRadar(link.cnpj) : '/radar'} replace />;
}
