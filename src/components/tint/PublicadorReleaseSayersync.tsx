import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileUp, PackageCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMutationComRegistro } from "@/components/execucoes/useMutationComRegistro";
import { UltimaExecucao } from "@/components/execucoes/UltimaExecucao";
import { supabase } from "@/integrations/supabase/client";
import { track } from "@/lib/analytics";
import {
  comoOctetStream,
  BUCKET_RELEASES,
  CAMINHO_MANIFEST,
  URL_MANIFEST,
  BASE_PUBLICA_SAYERSYNC,
  lerManifestPublicado,
  nomeExe,
  publicarRelease,
  sha256Hex,
  validarVersao,
  versaoDoNomeDoArquivo,
  type DepsPublicacao,
  type ResultadoUpload,
} from "@/lib/tint/release-sayersync";

const ACAO = "tint.publicar_release_sayersync";
const QK_MANIFEST = ["sayersync-manifest-publicado"];

function resultadoDoStorage(error: { message: string; statusCode?: string } | null): ResultadoUpload {
  if (!error) return { ok: true };
  const jaExiste = error.statusCode === "409" || /already exists|duplicate/i.test(error.message);
  return { ok: false, jaExiste, mensagem: error.message };
}

const deps: DepsPublicacao = {
  lerManifest: () => lerManifestPublicado(),
  enviarExe: async (caminho, arquivo) => {
    // upsert=false: binário publicado é imutável (e o bucket não tem policy de DELETE).
    const { error } = await supabase.storage.from(BUCKET_RELEASES).upload(caminho, comoOctetStream(arquivo), {
      contentType: "application/octet-stream",
      cacheControl: "31536000",
      upsert: false,
    });
    return resultadoDoStorage(error as { message: string; statusCode?: string } | null);
  },
  shaDoExePublicado: async (versao) => {
    const resp = await fetch(`${BASE_PUBLICA_SAYERSYNC}/${nomeExe(versao)}?t=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`não consegui baixar o .exe já publicado (HTTP ${resp.status})`);
    return sha256Hex(await resp.arrayBuffer());
  },
  gravarManifest: async (manifest) => {
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    // Cache curto: o conector lê sem cache-buster e não pode ficar 1h preso no manifest velho.
    const { error } = await supabase.storage.from(BUCKET_RELEASES).upload(CAMINHO_MANIFEST, blob, {
      contentType: "application/json",
      cacheControl: "60",
      upsert: true,
    });
    return resultadoDoStorage(error as { message: string; statusCode?: string } | null);
  },
};

interface Preparado {
  arquivo: File;
  sha256: string;
}

export default function PublicadorReleaseSayersync() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preparado, setPreparado] = useState<Preparado | null>(null);
  const [calculando, setCalculando] = useState(false);
  const [versao, setVersao] = useState("");
  const [arrastando, setArrastando] = useState(false);

  const manifestQ = useQuery({ queryKey: QK_MANIFEST, queryFn: () => lerManifestPublicado(), staleTime: 0 });

  const publicar = useMutationComRegistro({
    acao: ACAO,
    mutationFn: (p: Preparado & { versao: string }) =>
      publicarRelease(deps, { versao: p.versao, arquivo: p.arquivo, sha256: p.sha256 }),
    detalhes: (r) => ({ versao: r.manifest.version, sha256: r.manifest.sha256, exe_retomado: r.exeRetomado }),
    onSuccess: (r) => {
      track("tint.release_sayersync_publicado", { versao: r.manifest.version, retomado: r.exeRetomado });
      toast.success(`Versão ${r.manifest.version} publicada. A loja pega na próxima checagem diária.`);
      setPreparado(null);
      setVersao("");
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: QK_MANIFEST }),
  });

  async function escolher(arquivo: File | undefined) {
    if (!arquivo) return;
    if (!/\.exe$/i.test(arquivo.name)) {
      toast.error("Escolha o arquivo .exe gerado pelo release.sh.");
      return;
    }
    setCalculando(true);
    try {
      const sha256 = await sha256Hex(await arquivo.arrayBuffer());
      setPreparado({ arquivo, sha256 });
      const sugerida = versaoDoNomeDoArquivo(arquivo.name);
      if (sugerida) setVersao(sugerida);
    } catch (e) {
      toast.error(`Não consegui calcular o sha256: ${(e as Error).message}`);
    } finally {
      setCalculando(false);
    }
  }

  const manifest = manifestQ.data ?? null;
  // Sem ler o manifest no ar não dá para checar downgrade → não deixa publicar.
  const erroVersao = manifestQ.isSuccess && versao ? validarVersao(versao, manifest) : null;
  const podePublicar =
    !!preparado && manifestQ.isSuccess && !!versao && !erroVersao && !publicar.isPending && !calculando;

  return (
    <div className="space-y-4">
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <PackageCheck className="h-4 w-4" /> Versão no ar do conector SayerSync
          </CardTitle>
          <CardDescription>
            O conector da loja confere este endereço uma vez por dia e se atualiza sozinho quando há versão maior.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {manifestQ.isLoading && <p className="text-muted-foreground">Lendo…</p>}
          {manifestQ.isError && (
            <p className="text-status-error">
              Não consegui ler a versão no ar ({(manifestQ.error as Error).message}). Publicação bloqueada até ler.
            </p>
          )}
          {manifestQ.isSuccess && !manifest && <p className="text-muted-foreground">Nenhuma versão publicada ainda.</p>}
          {manifest && (
            <>
              <p>
                Versão <span className="font-mono font-semibold">{manifest.version}</span>
              </p>
              <p className="font-mono text-xs text-muted-foreground break-all">sha256 {manifest.sha256}</p>
            </>
          )}
          <p className="font-mono text-xs text-muted-foreground break-all">{URL_MANIFEST}</p>
        </CardContent>
      </Card>

      <Card className="border-border">
        <CardHeader>
          <CardTitle className="text-base">Publicar nova versão</CardTitle>
          <CardDescription>
            Arraste o <span className="font-mono">sayersync-X.Y.Z.exe</span> gerado pelo{" "}
            <span className="font-mono">release.sh</span>. O app sobe o .exe e só depois aponta a loja para ele.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setArrastando(true);
            }}
            onDragLeave={() => setArrastando(false)}
            onDrop={(e) => {
              e.preventDefault();
              setArrastando(false);
              void escolher(e.dataTransfer.files[0]);
            }}
            className={`flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-6 text-sm cursor-pointer ${
              arrastando ? "border-primary bg-muted" : "border-border"
            }`}
          >
            <FileUp className="h-6 w-6 text-muted-foreground" />
            {calculando && <span>Calculando sha256…</span>}
            {!calculando && !preparado && <span className="text-muted-foreground">Solte o .exe aqui ou clique</span>}
            {!calculando && preparado && (
              <div className="text-center space-y-1">
                <div className="font-mono">{preparado.arquivo.name}</div>
                <div className="text-xs text-muted-foreground">
                  {preparado.arquivo.size.toLocaleString("pt-BR")} bytes
                </div>
                <div className="font-mono text-xs text-muted-foreground break-all">sha256 {preparado.sha256}</div>
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              accept=".exe"
              className="hidden"
              onChange={(e) => {
                void escolher(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>

          <div className="space-y-1 max-w-xs">
            <Label htmlFor="sayersync-versao">Versão</Label>
            <Input
              id="sayersync-versao"
              placeholder="0.2.1"
              value={versao}
              onChange={(e) => setVersao(e.target.value.trim())}
              className="font-mono"
            />
            {erroVersao && <p className="text-xs text-status-error">{erroVersao}</p>}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={!podePublicar}
              onClick={() => preparado && publicar.mutate({ ...preparado, versao })}
            >
              {publicar.isPending ? "Publicando…" : "Publicar"}
            </Button>
            <UltimaExecucao acao={ACAO} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
