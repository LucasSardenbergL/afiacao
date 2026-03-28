import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export type Company = 'colacor' | 'oben' | 'colacor_sc';

interface CompanyInfo {
  id: Company;
  name: string;
  shortName: string;
  regime: 'simples' | 'presumido' | 'real';
}

export const COMPANIES: Record<Company, CompanyInfo> = {
  colacor: { id: 'colacor', name: 'Afiação Colacor', shortName: 'Colacor', regime: 'presumido' },
  oben: { id: 'oben', name: 'Oben Comercial', shortName: 'Oben', regime: 'presumido' },
  colacor_sc: { id: 'colacor_sc', name: 'Colacor SC', shortName: 'Colacor SC', regime: 'simples' },
};

export const ALL_COMPANIES: Company[] = ['oben', 'colacor', 'colacor_sc'];

interface CompanyContextType {
  activeCompany: Company;
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
  const [activeCompany, setActiveCompanyState] = useState<Company>(() => {
    const stored = localStorage.getItem('activeCompany');
    return (stored === 'colacor' || stored === 'oben' || stored === 'colacor_sc') ? stored : 'colacor';
  });

  const setActiveCompany = (company: Company) => {
    setActiveCompanyState(company);
    localStorage.setItem('activeCompany', company);
  };

  return (
    <CompanyContext.Provider value={{
      activeCompany,
      setActiveCompany,
      companyInfo: COMPANIES[activeCompany],
    }}>
      {children}
    </CompanyContext.Provider>
  );
};
