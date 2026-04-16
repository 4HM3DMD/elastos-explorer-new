import { createContext, useContext } from 'react';

export type Theme = 'dark';

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  cycleTheme: () => void;
}

const staticValue: ThemeContextValue = {
  theme: 'dark',
  setTheme: () => {},
  cycleTheme: () => {},
};

export const ThemeContext = createContext<ThemeContextValue>(staticValue);

export function useThemeStore() {
  return staticValue;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
