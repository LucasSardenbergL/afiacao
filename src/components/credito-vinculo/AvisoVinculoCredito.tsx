import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { desatualizado, estadoDeLeitura, naoConsegui, type EstadoSemLeitura } from '@/lib/leitura/estado-de-leitura';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { track } from '@/lib/analytics';
import {
  FRASE_AVISO, ROTULO_CONTA, cnpjDoDocumento, evidencia, exibicaoDoAviso, nomeVinculado, rotuloForca, textoNaoVerificado,
  type SuperficieAviso, type VereditoConferencia, type VinculoComVencido,
} from '@/lib/credito-vinculo/aviso';
import { registrarSensorVinculo, useAvisoVinculoCredito } from '@/lib/credito-vinculo/useAvisoVinculoCredito';

/**
 * Aviso de crédito por VÍNCULO com cliente que tem título vencido (migration 20261106205557; passo 2 do "Radar
 * sucessor"). No pedido, no bloco do cliente; na ficha do Radar, antes do cadastro no Omie (a edge cria no Omie
 * ANTES de registrar — o aviso tem de ser leitura prévia). É SÓ aviso: nada bloqueia, nada muda no prazo.
 *
 * Estados (nunca "sem pendência"): carregando → nada · falhou/sem rede → "não consegui verificar" · CPF, fora da
 * base RFB ou vínculo indeterminado → nota neutra "não verificado" · avaliação completa sem evidência → nada ·
 * evidência positiva → card com a frase do aviso, quem (ou "um cliente da carteira"), a evidência e o vencido por conta.
 *
 * Sensor: 'servido' quando o card aparece (1/dia no servidor) e o voto da conferência — gravados pelo escritor
 * validado no servidor; sob a lente "Ver como" nada é gravado e os botões ficam desabilitados.
 */

const formatBRL = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const formatData = (iso: string) => { const [a, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${a}`; };

const VEREDITOS: ReadonlyArray<{ v: VereditoConferencia; rotulo: string }> = [
  { v: 'mesmo_grupo', rotulo: 'É o mesmo dono/grupo' },
  { v: 'sem_relacao', rotulo: 'Não tem relação' },
  { v: 'nao_confirmei', rotulo: 'Não consegui confirmar' },
];
const ROTULO_VEREDITO: Record<VereditoConferencia, string> = {
  mesmo_grupo: 'mesmo dono/grupo', sem_relacao: 'sem relação', nao_confirmei: 'não consegui confirmar',
};

type EstadoVoto = { fase: 'enviando' } | { fase: 'ok'; veredito: VereditoConferencia } | { fase: 'erro' };

export interface AvisoVinculoCreditoProps {
  /** Documento cru do cliente (CNPJ com ou sem máscara; CPF vira "não verificado"). */
  documento: string | null | undefined;
  superficie: SuperficieAviso;
}

export function AvisoVinculoCredito({ documento, superficie }: AvisoVinculoCreditoProps) {
  const cnpj = cnpjDoDocumento(documento);
  const q = useAvisoVinculoCredito(cnpj);
  const estado = estadoDeLeitura(q);
  // Cache em mãos mas a revalidação falhou ou está pausada (offline com cache vencido): `estado` diz 'pronta' — sem
  // isto, um cache negativo velho viraria silêncio (achado Codex P2 do código).
  const velho = desatualizado(q, q.data !== undefined);
  const exibicao = exibicaoDoAviso({
    cnpj,
    carregando: estado === 'carregando',
    falhou: naoConsegui(estado),
    aviso: estado === 'pronta' ? q.data : null,
  });
  // Evidência POSITIVA em cache segue na tela (com o aviso de desatualizado); qualquer outro desfecho velho é "não consegui".
  const exibicaoFinal = velho && exibicao.tipo !== 'aviso' ? ({ tipo: 'nao_consegui' } as const) : exibicao;
  const lente = isLensActive();
  const [votos, setVotos] = useState<Record<string, EstadoVoto>>({});
  const servidoRef = useRef<string | null>(null);
  // Geração do cliente na tela: a resposta de um voto que chega DEPOIS da troca de cliente é descartada (senão o voto
  // pendente de A aparecia como "registrado" em B — achado Codex P2 do código, reproduzido).
  const cnpjNaTela = useRef(cnpj);
  cnpjNaTela.current = cnpj;

  // Cliente trocou → zera os votos da tela.
  useEffect(() => { setVotos({}); }, [cnpj]);

  const temAviso = exibicaoFinal.tipo === 'aviso';
  useEffect(() => {
    if (!temAviso || !cnpj) return;
    const chave = `${superficie}:${cnpj}`;
    if (servidoRef.current === chave) return;
    servidoRef.current = chave;
    track('credito.vinculo_aviso_exibido', { superficie });
    void registrarSensorVinculo({ evento: 'servido', superficie, cnpj });
  }, [temAviso, cnpj, superficie]);

  useEffect(() => {
    // sem hífen nas props do track (convenção do `track`): 'sem-rede' → 'sem_rede'
    if (naoConsegui(estado)) track('credito.vinculo_aviso_falhou', { superficie, estado: estado === 'sem-rede' ? 'sem_rede' : 'erro' });
  }, [estado, superficie]);

  if (exibicaoFinal.tipo === 'nada') return null;
  if (exibicaoFinal.tipo === 'nao_consegui') {
    const estadoFalha: EstadoSemLeitura = velho ?? (estado === 'sem-rede' ? 'sem-rede' : 'erro');
    return (
      <AvisoLeituraFalhou
        oque="a verificação de vínculo com cliente que tem títulos vencidos"
        testId="aviso-vinculo-leitura-falhou"
        estado={estadoFalha}
        className="mb-0"
      />
    );
  }
  if (exibicaoFinal.tipo === 'nao_verificado') {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="aviso-vinculo-nao-verificado" data-motivo={exibicaoFinal.motivo}>
        {textoNaoVerificado(exibicaoFinal.motivo, exibicaoFinal.n)}
      </p>
    );
  }

  const votar = async (v: VinculoComVencido, veredito: VereditoConferencia) => {
    if (!cnpj) return;
    const cnpjDoVoto = cnpj;
    setVotos((s) => ({ ...s, [v.ref]: { fase: 'enviando' } }));
    const r = await registrarSensorVinculo({ evento: 'conferido', superficie, cnpj: cnpjDoVoto, ref: v.ref, veredito });
    if (cnpjNaTela.current !== cnpjDoVoto) return;   // o cliente mudou enquanto o voto ia — não é deste card
    setVotos((s) => ({ ...s, [v.ref]: r.ok && r.registrado ? { fase: 'ok', veredito } : { fase: 'erro' } }));
    track('credito.vinculo_aviso_conferido', { superficie, veredito, gravou: r.ok && r.registrado });
  };

  return (
    <>
    {velho && (
      <AvisoLeituraFalhou oque="a atualização do aviso de vínculo (o que aparece abaixo pode estar desatualizado)"
        estado={velho} testId="aviso-vinculo-desatualizado" className="mb-1" />
    )}
    <div className="bg-status-warning/10 border border-status-warning/30 rounded-md p-2 text-xs" data-testid="aviso-vinculo-credito">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-status-warning flex-shrink-0 mt-0.5" />
        <div className="space-y-2 flex-1">
          <p className="font-semibold text-status-warning">{FRASE_AVISO}</p>
          <p className="text-[11px] text-muted-foreground">É uma pista, não um veredito: nada foi bloqueado nem mudou no prazo.</p>
          <ul className="space-y-2">
            {exibicaoFinal.vinculos.map((v) => {
              const voto = votos[v.ref];
              return (
                <li key={v.ref} className="space-y-1" data-testid={`aviso-vinculo-${v.ref}`}>
                  <p>
                    <span className="mr-1.5 inline-block rounded border px-1.5 py-px text-[11px] leading-4">{rotuloForca(v.forca)}</span>
                    <span className="font-medium">{nomeVinculado(v)}</span>
                  </p>
                  <p className="text-muted-foreground">{evidencia(v)}</p>
                  {v.credoras.map((c) => (
                    <p key={c.company} data-testid={`aviso-vinculo-${v.ref}-${c.company}`}>
                      {ROTULO_CONTA[c.company]}: {formatBRL(c.vencido)} vencido · {c.nTitulos} título{c.nTitulos > 1 ? 's' : ''}
                      {c.diasVencidoMax !== null && <> · até {c.diasVencidoMax} dia{c.diasVencidoMax > 1 ? 's' : ''}</>}
                      {(c.nAmbiguos > 0 || c.nInvalidos > 0) && (
                        <span className="text-muted-foreground"> · {c.nAmbiguos + c.nInvalidos} título{c.nAmbiguos + c.nInvalidos > 1 ? 's' : ''} com dados incertos (não somado{c.nAmbiguos + c.nInvalidos > 1 ? 's' : ''})</span>
                      )}
                      <span className="text-[11px] text-muted-foreground/70">
                        {c.syncEm ? ` · Omie em ${formatData(c.syncEm)}` : ''}
                        {c.qualidade !== 'ok' && <span className="text-status-warning"> · {c.qualidade === 'sem_sync' ? 'sem registro de sync' : 'sync há mais de 24h'}</span>}
                      </span>
                    </p>
                  ))}
                  {v.parcial && (
                    <p className="text-[11px] text-muted-foreground">Parte das contas deste cliente não pôde ser conferida — o vencido pode ser maior.</p>
                  )}
                  {voto?.fase === 'ok' ? (
                    <p className="text-[11px] text-status-success" data-testid={`aviso-vinculo-${v.ref}-registrado`}>
                      Conferência registrada: {ROTULO_VEREDITO[voto.veredito]}.
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      {VEREDITOS.map((x) => (
                        <Button key={x.v} type="button" size="sm" variant="outline" className="h-7 text-xs"
                          disabled={lente || voto?.fase === 'enviando'}
                          title={lente ? 'Indisponível no modo "Ver como"' : undefined}
                          onClick={() => { void votar(v, x.v); }}>
                          {x.rotulo}
                        </Button>
                      ))}
                      {voto?.fase === 'erro' && (
                        <span className="text-[11px] text-status-error" data-testid={`aviso-vinculo-${v.ref}-erro`}>Não consegui registrar — tente de novo.</span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {exibicaoFinal.nIndeterminados > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {textoNaoVerificado('indeterminado', exibicaoFinal.nIndeterminados)}
            </p>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
