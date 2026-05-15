/**
 * Mistura um MP3 de pre-roll (aviso LGPD de gravação) com o áudio do mic em um único MediaStream.
 * Ao iniciar a chamada, o cliente ouve primeiro o aviso, depois o vendedor.
 *
 * @param prerollUrl URL do arquivo MP3 (ex.: /preroll/aviso-gravacao-lgpd.mp3)
 * @param micStream MediaStream do microfone do vendedor (de getUserMedia)
 * @returns MediaStream com o áudio mixado, pronto pra passar pro JsSIP.UA.call
 */
export async function mixPrerollWithMic(
  prerollUrl: string,
  micStream: MediaStream
): Promise<MediaStream> {
  const ctx = new AudioContext();

  // Mic source — sempre conectado
  const micSource = ctx.createMediaStreamSource(micStream);
  const destination = ctx.createMediaStreamDestination();
  micSource.connect(destination);

  // Pre-roll buffer
  const resp = await fetch(prerollUrl);
  const arrayBuffer = await resp.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

  const prerollSource = ctx.createBufferSource();
  prerollSource.buffer = audioBuffer;
  prerollSource.connect(destination);
  prerollSource.start();

  return destination.stream;
}
