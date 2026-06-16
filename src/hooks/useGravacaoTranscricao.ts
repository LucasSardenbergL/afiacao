import { useState, useRef, useEffect, useCallback } from 'react';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';

export function useGravacaoTranscricao() {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcricao, setTranscricao] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  const transcrever = useCallback(async (blob: Blob) => {
    setIsTranscribing(true);
    try {
      let ext = 'webm';
      if (blob.type.includes('mp4')) ext = 'mp4'; else if (blob.type.includes('ogg')) ext = 'ogg';
      const fd = new FormData();
      fd.append('audio', blob, `recording.${ext}`);
      const result = await invokeFunction<{ text?: string }>('elevenlabs-transcribe', fd);
      if (result.text) setTranscricao((prev) => prev + (prev ? ' ' : '') + result.text);
      else toast.error('Nenhum texto detectado no áudio.');
    } catch (e) {
      logger.error('Falha na transcrição da tarefa por voz', { error: e });
      toast.error('Erro na transcrição', { description: e instanceof Error ? e.message : 'Tente novamente.' });
    } finally { setIsTranscribing(false); }
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streamRef.current = stream;
      chunksRef.current = [];
      let mimeType = 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
      else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
      else if (MediaRecorder.isTypeSupported('audio/ogg')) mimeType = 'audio/ogg';
      const rec = new MediaRecorder(stream, { mimeType });
      recorderRef.current = rec;
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (chunksRef.current.length > 0) await transcrever(new Blob(chunksRef.current, { type: mimeType }));
      };
      rec.start(1000);
      setIsRecording(true);
    } catch (e) {
      const err = e as { name?: string };
      toast.error(err.name === 'NotAllowedError' ? 'Permissão de microfone negada' : 'Erro ao acessar o microfone');
    }
  }, [transcrever]);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    setIsRecording(false);
  }, []);

  const toggle = useCallback(() => { if (isRecording) stop(); else start(); }, [isRecording, start, stop]);
  const reset = useCallback(() => { setTranscricao(''); }, []);

  return { isRecording, isTranscribing, transcricao, setTranscricao, toggle, reset };
}
