/**
 * Mistura um MP3 de pre-roll (aviso LGPD de gravação) com o áudio do mic em um único MediaStream.
 * Ao iniciar a chamada, o cliente ouve primeiro o aviso, depois o vendedor.
 *
 * @param prerollUrl URL do arquivo MP3 (ex.: /preroll/aviso-gravacao-lgpd.mp3)
 * @param micStream MediaStream do microfone do vendedor (de getUserMedia)
 * @returns Objeto com:
 *   - `stream`: MediaStream mixado, pronto pra passar pro JsSIP.UA.call
 *   - `play`: dispara o áudio do pre-roll. **DEVE ser chamado APENAS quando o cliente
 *      atender** (evento `'established'` do SIP). Se chamado antes, o áudio toca pra
 *      ninguém — RTP só flui após o 200 OK, então frames produzidos durante o ringing
 *      são perdidos. Idempotente: chamadas adicionais são noop.
 *   - `close`: callback pra fechar o AudioContext ao final da chamada
 *
 * **Importante**: o caller é responsável por chamar `close()` quando a chamada terminar.
 * Sem isso, o AudioContext fica vivo na thread de áudio do navegador (leak).
 * Adicionalmente, o caller continua dono do `micStream` original — `close()` NÃO para
 * as tracks do micStream, isso é responsabilidade do caller (que pegou via getUserMedia).
 */
export async function mixPrerollWithMic(
  prerollUrl: string,
  micStream: MediaStream
): Promise<{
  stream: MediaStream;
  durationSeconds: number;
  play: () => void;
  close: () => void;
}> {
  const ctx = new AudioContext();

  const micSource = ctx.createMediaStreamSource(micStream);
  const destination = ctx.createMediaStreamDestination();
  micSource.connect(destination);

  const resp = await fetch(prerollUrl);
  const arrayBuffer = await resp.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

  const prerollSource = ctx.createBufferSource();
  prerollSource.buffer = audioBuffer;
  prerollSource.connect(destination);

  let played = false;

  return {
    stream: destination.stream,
    durationSeconds: audioBuffer.duration,
    play: () => {
      if (played) return;
      played = true;
      // iOS/Safari: o AudioContext pode ter suspendido entre o makeCall (gesto do
      // usuário) e o 'established' (segundos depois). resume() reativa antes de tocar
      // — no-op se já estiver running. Sem isso, no iPhone o aviso pode não sair.
      void ctx.resume();
      prerollSource.start();
    },
    close: () => {
      // ctx.close() retorna Promise — não esperamos pra não bloquear hangUp
      void ctx.close();
    },
  };
}
