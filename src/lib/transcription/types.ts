export type Speaker = 'vendedor' | 'cliente';

export interface TranscriptTurn {
  /** Identificador único do turno (gerado client-side) */
  id: string;
  speaker: Speaker;
  /** Texto do turno (pode crescer enquanto interim, congela no final) */
  text: string;
  /** True se ainda é interim (parcial); false após Deepgram confirmar como final */
  isFinal: boolean;
  /** Timestamp (Date.now()) do primeiro chunk recebido */
  startedAt: number;
  /** Timestamp do final do turno; null se ainda interim */
  endedAt: number | null;
}

export type TranscriptionStatus = 'idle' | 'connecting' | 'active' | 'error';

export interface DeepgramConfig {
  /** Key temporária do Deepgram (vinda da edge function) */
  apiKey: string;
  /** WebSocket endpoint (default: wss://api.deepgram.com/v1/listen) */
  endpoint?: string;
  /** Modelo Deepgram (default: nova-3) */
  model?: string;
  /** Idioma (default: pt-BR) */
  language?: string;
  /** Endpointing em ms (default: 300 — Deepgram emite final após 300ms de silêncio) */
  endpointingMs?: number;
  /** Encoding dos chunks de áudio (default: audio/webm;codecs=opus) */
  encoding?: string;
}
