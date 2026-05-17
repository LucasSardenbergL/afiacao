import { createContext, useContext, useState, ReactNode } from 'react';

export type Company = 'colacor' | 'oben' | 'colacor_sc';
export type CompanySelection = Company | 'all';

interface CompanyInfo {
  id: Company;
  name: string;
  shortName: string;
  regime: 'simples' | 'presumido' | 'real';
}

export const COMPANIES: Record<Company, CompanyInfo> = {
  colacor: { id: 'colacor', name: 'Colacor', shortName: 'Colacor', regime: 'presumido' },
  oben: { id: 'oben', name: 'Oben Comercial', shortName: 'Oben', regime: 'presumido' },
  colacor_sc: { id: 'colacor_sc', name: 'Colacor SC', shortName: 'Colacor SC', regime: 'simples' },
};

export const ALL_COMPANIES: Company[] = ['oben', 'colacor', 'colacor_sc'];

function isValidSelection(v: string | null): v is CompanySelection {
  return v === 'colacor' || v === 'oben' || v === 'colacor_sc' || v === 'all';
}

interface CompanyContextType {
  /** Empresa única ativa (fallback canônico quando seleção = 'all'). */
  activeCompany: Company;
  /** Seleção bruta — pode ser 'all'. Use selection ao invés de activeCompany em consumidores multi-empresa. */
  selection: CompanySelection;
  setSelection: (s: CompanySelection) => void;
  /** Compat: aceita só Company (Selecionar empresa única). */
  setActiveCompany: (company: Company) => void;
  companyInfo: CompanyInfo;
}

const CompanyContext = createContext<CompanyContextType | undefined>(undefined);

export const useCompany = () => {
  const context = useContext(CompanyContext);
  if (!context) {
    throw new Error('useCompany must be used within a CompanyProvider');
  }
  return context;
};

export const CompanyProvider = ({ children }: { children: ReactNode }) => {
  const [selection, setSelectionState] = useState<CompanySelection>(() => {
    const stored = localStorage.getItem('activeCompany');
    return isValidSelection(stored) ? stored : 'colacor';
  });

  const setSelection = (s: CompanySelection) => {
    setSelectionState(s);
    localStorage.setItem('activeCompany', s);
  };

  const setActiveCompany = (company: Company) => setSelection(company);

  // activeCompany é sempre uma Company concreta — para legado, em modo 'all' devolve o último single conhecido.
  const lastSingle: Company =
    selection !== 'all' ? selection : (() => {
      const stored = localStorage.getItem('activeCompanyLastSingle');
      return isValidSelection(stored) && stored !== 'all' ? stored : 'colacor';
    })();

  // Sempre que selection vira single, lembra qual foi (pra resolver fallback em 'all').
  if (selection !== 'all' && typeof window !== 'undefined') {
    localStorage.setItem('activeCompanyLastSingle', selection);
  }

  return (
    <CompanyContext.Provider value={{
      activeCompany: lastSingle,
      selection,
      setSelection,
      setActiveCompany,
      companyInfo: COMPANIES[lastSingle],
    }}>
      {children}
    </CompanyContext.Provider>
  );
};
