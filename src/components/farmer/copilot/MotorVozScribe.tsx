// Motor de voz do copiloto (ElevenLabs Scribe) — componente HEADLESS (retorna null).
// Existe como componente separado para o code-split tirar o SDK @elevenlabs/react
// (~119KB gzip) do chunk da página FarmerCopilot: useScribe é hook (não pode ser
// condicional), então o corte é montar/desmontar ESTE componente. A página monta
// via React.lazy apenas quando há sessão de voz; o unmount desconecta (cleanup).
// A UI da sessão NÃO vive aqui de propósito: ela é compartilhada com o modo texto
// (fallback quando a voz falha) e não pode depender do chunk do SDK de voz.
import { useCallback, useEffect, useRef } from 'react';
import { useScribe, CommitStrategy } from '@elevenlabs/react';

export interface MotorVozScribeProps {
  /** Imutável por instância: o call-site monta com key={token} — trocar o token
   *  REMONTA o componente (1 instância = 1 conexão; guards nunca são
   *  compartilhados entre conexões diferentes). */
  token: string;
  onPartialTranscript: (text: string) => void;
  onCommittedTranscript: (text: string) => void;
  onConnected: () => void;
  onError: (err: unknown) => void;
}

export default function MotorVozScribe({
  token,
  onPartialTranscript,
  onCommittedTranscript,
  onConnected,
  onError,
}: MotorVozScribeProps) {
  // Refs "latest": o effect de conexão não pode re-rodar quando os callbacks
  // trocam de identidade a cada render — conexão é 1x por montagem/token.
  const callbacksRef = useRef({ onConnected, onError });
  callbacksRef.current = { onConnected, onError };

  // Fallback de erro dispara UMA vez por conexão: o connect() rejeitado e o
  // evento onError do SDK podem reportar o MESMO erro — sem o guard, o toast
  // e a troca voz→texto duplicariam. O cleanup "queima" o guard para eventos
  // emitidos pelo teardown do disconnect() não dispararem fallback espúrio.
  const erroJaDisparadoRef = useRef(false);
  const dispararErro = useCallback((err: unknown) => {
    if (erroJaDisparadoRef.current) return;
    erroJaDisparadoRef.current = true;
    callbacksRef.current.onError(err);
  }, []);

  // Sucesso é sinalizado pelo EVENTO do SDK (abertura/sessão REAL), nunca pelo
  // connect() resolvido: no 0.14.0 o connect() pode resolver antes do OPEN —
  // sinalizar ali geraria "Copiloto ativado" seguido do erro de auth quando o
  // token é recusado pós-open. onConnect e onSessionStarted apontam ambos pra
  // cá; o guard single-fire deixa passar só o primeiro.
  const conexaoJaSinalizadaRef = useRef(false);
  const sinalizarConectado = useCallback(() => {
    if (conexaoJaSinalizadaRef.current || erroJaDisparadoRef.current) return;
    conexaoJaSinalizadaRef.current = true;
    callbacksRef.current.onConnected();
  }, []);

  const scribe = useScribe({
    modelId: 'scribe_v2_realtime',
    commitStrategy: CommitStrategy.VAD,
    onPartialTranscript: (data) => {
      if (data.text) onPartialTranscript(data.text);
    },
    onCommittedTranscript: (data) => {
      if (data.text) onCommittedTranscript(data.text);
    },
    onConnect: () => sinalizarConectado(),
    onSessionStarted: () => sinalizarConectado(),
    // Erros FATAIS que chegam por EVENTO depois do connect() resolver (token
    // recusado pós-open, quota, termos, limite de sessão, recursos esgotados):
    // sem estes handlers a sessão fica em modo voz "surda", sem cair pro texto.
    // O agregador onError do SDK NÃO serve aqui — dispara também para erros
    // transientes (commit throttled, silêncio prolongado) que não podem
    // derrubar a sessão de voz.
    onAuthError: (data) => dispararErro(new Error(data.error)),
    onQuotaExceededError: (data) => dispararErro(new Error(data.error)),
    onUnacceptedTermsError: (data) => dispararErro(new Error(data.error)),
    onSessionTimeLimitExceededError: (data) => dispararErro(new Error(data.error)),
    onResourceExhaustedError: (data) => dispararErro(new Error(data.error)),
  });
  const scribeRef = useRef(scribe);
  scribeRef.current = scribe;

  useEffect(() => {
    // Re-arma os guards a cada (re)conexão.
    erroJaDisparadoRef.current = false;
    conexaoJaSinalizadaRef.current = false;
    (async () => {
      try {
        await scribeRef.current.connect({
          token,
          microphone: {
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        // Sucesso NÃO é sinalizado aqui — só pelo evento (onConnect/onSessionStarted).
      } catch (err) {
        dispararErro(err);
      }
    })();
    return () => {
      // Queima os guards: eventos emitidos pelo teardown do disconnect() (ou
      // atrasados, pós-unmount) não disparam toast/fallback espúrios.
      erroJaDisparadoRef.current = true;
      conexaoJaSinalizadaRef.current = true;
      scribeRef.current.disconnect();
    };
  }, [token, dispararErro]);

  return null;
}
