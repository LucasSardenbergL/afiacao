import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';

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

  const setSelection = useCallback((s: CompanySelection) => {
    setSelectionState(s);
    localStorage.setItem('activeCompany', s);
  }, []);

  const setActiveCompany = useCallback((company: Company) => setSelection(company), [setSelection]);

  // Sempre que selection vira single, lembra qual foi (pra resolver fallback em 'all').
  useEffect(() => {
    if (selection !== 'all') {
      localStorage.setItem('activeCompanyLastSingle', selection);
    }
  }, [selection]);

  // value memoizado: sem isto, cada render do provider recriava o objeto e
  // re-renderizava TODOS os consumidores (o provider envolve a árvore inteira).
  const value = useMemo<CompanyContextType>(() => {
    // activeCompany é sempre uma Company concreta — para legado, em modo 'all' devolve o último single conhecido.
    const lastSingle: Company =
      selection !== 'all' ? selection : (() => {
        const stored = localStorage.getItem('activeCompanyLastSingle');
        return isValidSelection(stored) && stored !== 'all' ? stored : 'colacor';
      })();
    return {
      activeCompany: lastSingle,
      selection,
      setSelection,
      setActiveCompany,
      companyInfo: COMPANIES[lastSingle],
    };
  }, [selection, setSelection, setActiveCompany]);

  return (
    <CompanyContext.Provider value={value}>
      {children}
    </CompanyContext.Provider>
  );
};
