// Linha de argumentação IA (ícone + label + texto).
// Extraído verbatim de src/pages/FarmerBundles.tsx (god-component split).

export const ArgLine = ({ icon, label, text }: { icon: string; label: string; text: string }) => (
  <div className="flex items-start gap-1.5">
    <span className="text-[10px] shrink-0">{icon}</span>
    <div>
      <span className="text-[8px] font-semibold text-muted-foreground uppercase">{label}</span>
      <p className="text-[10px] leading-tight">{text}</p>
    </div>
  </div>
);
