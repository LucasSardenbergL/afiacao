/**
 * Mistura um MP3 de pre-roll (aviso LGPD de gravação) com o áudio do mic em um único MediaStream.
 * Ao iniciar a chamada, o cliente ouve primeiro o aviso, depois o vendedor.
 *
 * @param prerollUrl URL do arquivo MP3 (ex.: /preroll/aviso-gravacao-lgpd.mp3)
 * @param micStream MediaStream do microfone do vendedor (de getUserMedia)
 * @returns Objeto com:
 *   - `stream`: MediaStream mixado, pronto pra passar pro JsSIP.UA.call
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
): Promise<{ stream: MediaStream; close: () => void }> {
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
  prerollSource.start();

  return {
    stream: destination.stream,
    close: () => {
      // ctx.close() retorna Promise — não esperamos pra não bloquear hangUp
      void ctx.close();
    },
  };
}
