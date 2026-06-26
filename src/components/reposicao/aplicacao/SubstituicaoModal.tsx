// Modal "Registrar substituição" da tela de Aplicação no Omie.
// Extraído de src/pages/AdminReposicaoAplicacao.tsx (god-component split).
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { eqInt, ilike, isSearchablePostgrestTerm, orFilter } from "@/lib/postgrest";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  EMPRESA,
  type FilaItem,
  type RegistrarSubstResult,
  type SkuParametroOpcao,
} from "@/components/reposicao/aplicacao/types";

export function SubstituicaoModal({
  item,
  onClose,
  onDone,
}: {
  item: FilaItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const [skuNovo, setSkuNovo] = useState("");
  const [busca, setBusca] = useState("");
  const [acao, setAcao] = useState("transferir");
  const [motivo, setMotivo] = useState("");

  const { data: opcoes } = useQuery({
    queryKey: ["sku-busca", busca],
    queryFn: async () => {
      // só-wildcard (`**`, passa o length>=2) → ilike do `.or()` vira match-all (#1062); busca vazia
      if (!busca || busca.length < 2 || !isSearchablePostgrestTerm(busca)) return [];
      const { data } = await supabase
        .from("sku_parametros")
        .select("sku_codigo_omie, sku_descricao")
        .eq("empresa", EMPRESA)
        .or(orFilter(eqInt("sku_codigo_omie", busca), ilike("sku_descricao", busca)))
        .limit(20);
      return data ?? [];
    },
    enabled: busca.length >= 2,
  });

  const registrar = useMutation({
    mutationFn: async () => {
      if (!skuNovo) throw new Error("Selecione o SKU novo");
      if (!motivo.trim()) throw new Error("Motivo é obrigatório");
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await supabase.rpc("registrar_substituicao_sku" as never, {
        p_empresa: item.empresa,
        p_codigo_antigo: item.sku_codigo_omie,
        p_codigo_novo: skuNovo,
        p_acao_parametros: acao,
        p_motivo: motivo,
        p_usuario: user?.email ?? "sistema",
      } as never);
      if (error) throw error;
      const result = data as unknown as RegistrarSubstResult | null;
      if (result?.error) throw new Error(result.error);
      return data;
    },
    onSuccess: () => {
      toast.success("Substituição registrada");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Registrar substituição</DialogTitle>
          <DialogDescription>
            SKU antigo: <span className="font-mono">{item.sku_codigo_omie}</span> —{" "}
            {item.sku_descricao}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>SKU novo</Label>
            <Input
              placeholder="Buscar por código ou descrição"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            {opcoes && opcoes.length > 0 && (
              <div className="mt-2 border rounded max-h-44 overflow-auto text-sm">
                {(opcoes as SkuParametroOpcao[]).map((o) => (
                  <button
                    key={o.sku_codigo_omie}
                    type="button"
                    onClick={() => {
                      setSkuNovo(String(o.sku_codigo_omie));
                      setBusca(`${o.sku_codigo_omie} — ${o.sku_descricao}`);
                    }}
                    className={`block w-full text-left px-3 py-1.5 hover:bg-muted ${
                      skuNovo === String(o.sku_codigo_omie) ? "bg-muted" : ""
                    }`}
                  >
                    <span className="font-mono">{o.sku_codigo_omie}</span> — {o.sku_descricao}
                  </button>
                ))}
              </div>
            )}
            {skuNovo && (
              <p className="text-xs text-muted-foreground mt-1">Selecionado: {skuNovo}</p>
            )}
          </div>

          <div>
            <Label>Ação sobre parâmetros</Label>
            <RadioGroup value={acao} onValueChange={setAcao} className="mt-2">
              <div className="flex items-start gap-2">
                <RadioGroupItem value="transferir" id="r1" className="mt-1" />
                <Label htmlFor="r1" className="font-normal">
                  <span className="font-medium">Transferir</span> — copia parâmetros do antigo para
                  o novo e aprova o novo.
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem value="recalcular_do_zero" id="r2" className="mt-1" />
                <Label htmlFor="r2" className="font-normal">
                  <span className="font-medium">Recalcular do zero</span> — sistema calcula a
                  partir do histórico do novo SKU.
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem value="manter_ambos" id="r3" className="mt-1" />
                <Label htmlFor="r3" className="font-normal">
                  <span className="font-medium">Manter ambos</span> — registra mas não desativa o
                  antigo.
                </Label>
              </div>
            </RadioGroup>
          </div>

          <div>
            <Label>Motivo *</Label>
            <Textarea
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Ex.: descontinuação do fornecedor, troca de embalagem, etc."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => registrar.mutate()} disabled={registrar.isPending}>
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
