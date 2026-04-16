import type { ReactNode } from 'react';
import { ThemeContext, useThemeStore } from '../hooks/useTheme';

interface ThemeProviderProps {
  children: ReactNode;
}

const ThemeProvider = ({ children }: ThemeProviderProps) => {
  const themeStore = useThemeStore();

  return (
    <ThemeContext.Provider value={themeStore}>
      {children}
    </ThemeContext.Provider>
  );
};

export default ThemeProvider;
