export const EMPRESA = "OBEN";

export const TIPOS_PARCEIRO = [
  { value: "fabricante", label: "Fabricante" },
  { value: "transportadora_terceira", label: "Transportadora terceira" },
  { value: "transportadora_propria", label: "Transportadora própria" },
  { value: "agente_cambio", label: "Agente câmbio" },
  { value: "outros", label: "Outros" },
];

export function tipoLabel(t: string | null) {
  return TIPOS_PARCEIRO.find((x) => x.value === t)?.label ?? t ?? "—";
}
