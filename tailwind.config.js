/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['SF Mono', 'Fira Code', 'Cascadia Code', 'monospace'],
      },
      colors: {
        brand: {
          DEFAULT: '#ff9e18',
          50: '#FFF8ED',
          100: '#FFEEDB',
          200: '#FFC382',
          300: '#FFA94D',
          400: '#ff9e18',
          500: '#E07B10',
          600: '#B04200',
          700: '#8C3500',
          800: '#6B2900',
          900: '#4A1D00',
          cream: '#FFEEDB',
        },
        accent: {
          blue: '#3B82F6',
          cyan: '#06B6D4',
          purple: '#8B5CF6',
          green: '#22C55E',
          amber: '#F59E0B',
          red: '#EF4444',
          orange: '#ff9e18',
        },
        surface: {
          DEFAULT: 'var(--color-surface)',
          secondary: 'var(--color-surface-secondary)',
          tertiary: 'var(--color-surface-tertiary)',
        },
        border: {
          DEFAULT: 'var(--color-border)',
          strong: 'var(--color-border-strong)',
          accent: 'var(--color-border-accent)',
        },
      },
      backgroundColor: {
        base: 'var(--color-bg)',
        'surface': 'var(--color-surface)',
        'surface-secondary': 'var(--color-surface-secondary)',
        'surface-tertiary': 'var(--color-surface-tertiary)',
        'hover': 'var(--color-hover)',
      },
      borderColor: {
        DEFAULT: 'var(--color-border)',
        strong: 'var(--color-border-strong)',
        accent: 'var(--color-border-accent)',
      },
      textColor: {
        primary: 'var(--color-text-primary)',
        secondary: 'var(--color-text-secondary)',
        muted: 'var(--color-text-muted)',
        tertiary: 'var(--color-text-tertiary)',
      },
      boxShadow: {
        'sm': 'var(--shadow-sm)',
        'md': 'var(--shadow-md)',
        'lg': 'var(--shadow-lg)',
      },
      borderRadius: {
        '2xl': '1rem',
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-down': 'slideDown 0.3s ease-out',
        'scale-in': 'scaleIn 0.15s ease-out',
        'shimmer': 'shimmer 2s infinite',
        'pulse-live': 'pulseLive 2s ease-in-out infinite',
        'count-up': 'countUp 0.6s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.97)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        pulseLive: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        countUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      backgroundImage: {
        'gradient-brand': 'linear-gradient(135deg, #ff9e18 0%, #B04200 100%)',
      },
      maxWidth: {
        'container': '1440px',
      },
    },
  },
  plugins: [],
}
