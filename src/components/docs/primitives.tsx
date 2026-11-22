// Primitivos de apresentação da Documentação Técnica.
// Extraídos de src/pages/TechnicalDocs.tsx (god-component split).
import type { ReactNode } from 'react';

export const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <section id={id} className="mb-12">
    <h2 className="text-2xl font-black mb-4 border-b-2 pb-2 border-primary/20">{title}</h2>
    {children}
  </section>
);

export const Module = ({ name, desc, audience, deps }: { name: string; desc: string; audience: string; deps: string }) => (
  <div className="mb-6 pl-4 border-l-2 border-primary/30">
    <h4 className="font-bold text-base mb-1">{name}</h4>
    <p className="text-sm mb-2">{desc}</p>
    <p className="text-xs text-muted-foreground"><strong>Público:</strong> {audience}</p>
    <p className="text-xs text-muted-foreground"><strong>Dependências:</strong> {deps}</p>
  </div>
);

export const TableRow = ({ label, value }: { label: string; value: string }) => (
  <tr className="border-b">
    <td className="p-2 font-semibold w-40">{label}</td>
    <td className="p-2">{value}</td>
  </tr>
);
