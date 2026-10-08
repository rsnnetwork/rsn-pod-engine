/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Sora"', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['"Sora"', 'Inter', 'system-ui', 'sans-serif'],
        reason: ['Inter', 'ui-sans-serif', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Arial', 'sans-serif'],
      },
      colors: {
        'rsn-red': {
          DEFAULT: '#DE322E',
          hover: '#C52B28',
          light: '#FEF2F2',
          50: '#FEF2F2',
          100: '#FEE2E2',
          200: '#FECACA',
          300: '#F9A8A8',
          500: '#DE322E',
          600: '#DE322E',
          700: '#C52B28',
        },
        brand: {
          50: '#FEF2F2', 100: '#FEE2E2', 200: '#FECACA', 300: '#F9A8A8',
          400: '#E8524E', 500: '#DE322E', 600: '#DE322E', 700: '#C52B28',
          800: '#A12220', 900: '#7F1D1D', 950: '#450A0A',
        },
        surface: {
          50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1',
          400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155',
          800: '#1e293b', 900: '#0f172a', 950: '#020617',
        },
        // REASON milestone 1: Stefan's v4 prototype palette. The red is the
        // existing brand red (#ef3f35 fails AA with white text).
        reason: {
          ink: '#11131a', muted: '#6d7380', line: '#e8e9ec', soft: '#f7f7f8', warm: '#fbfaf7',
          red: '#DE322E', 'red-hover': '#C52B28', pink: '#fff1ef', green: '#18a86b', amber: '#c77a14',
          // The same green, darkened for a fill that carries a white label: green itself is 3.07:1 under white,
          // green-fill 4.60:1 and its hover 5.80:1.
          'green-fill': '#138655', 'green-fill-hover': '#11744a',
        },
      },
      animation: {
        'fadeIn': 'fadeIn 0.3s ease-out',
        'fade-in': 'fadeIn 0.5s ease-out both',
        'fade-in-up': 'fadeInUp 0.6s ease-out both',
        'fade-in-down': 'fadeInDown 0.5s ease-out both',
        'slide-up': 'slideUp 0.4s ease-out both',
        'slide-in-left': 'slideInLeft 0.4s ease-out both',
        'slide-in-right': 'slideInRight 0.4s ease-out both',
        'scale-in': 'scaleIn 0.3s ease-out both',
        'pulse-slow': 'pulseSlow 3s ease-in-out infinite',
        'pulse-soft': 'pulseSoft 2s infinite',
        'shimmer': 'shimmer 2s linear infinite',
        'bounce-subtle': 'bounceSubtle 2s ease-in-out infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
        'marquee': 'marquee 30s linear infinite',
        'marquee-reverse': 'marquee 30s linear infinite reverse',
        'float-up': 'floatUp 2.5s ease-out forwards',
      },
      keyframes: {
        floatUp: { '0%': { opacity: '1', transform: 'translateY(0)' }, '70%': { opacity: '1' }, '100%': { opacity: '0', transform: 'translateY(-120px)' } },
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        fadeInUp: { '0%': { opacity: '0', transform: 'translateY(20px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        fadeInDown: { '0%': { opacity: '0', transform: 'translateY(-20px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        slideUp: { '0%': { opacity: '0', transform: 'translateY(10px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        slideInLeft: { '0%': { opacity: '0', transform: 'translateX(-20px)' }, '100%': { opacity: '1', transform: 'translateX(0)' } },
        slideInRight: { '0%': { opacity: '0', transform: 'translateX(20px)' }, '100%': { opacity: '1', transform: 'translateX(0)' } },
        scaleIn: { '0%': { opacity: '0', transform: 'scale(0.95)' }, '100%': { opacity: '1', transform: 'scale(1)' } },
        pulseSlow: { '0%, 100%': { transform: 'scale(1)', opacity: '1' }, '50%': { transform: 'scale(1.05)', opacity: '0.8' } },
        pulseSoft: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.7' } },
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
        bounceSubtle: { '0%, 100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-5px)' } },
        glow: { '0%': { boxShadow: '0 0 5px rgba(222, 50, 46, 0.2)' }, '100%': { boxShadow: '0 0 20px rgba(222, 50, 46, 0.4)' } },
        marquee: { '0%': { transform: 'translateX(0%)' }, '100%': { transform: 'translateX(-50%)' } },
      },
    },
  },
  plugins: [],
};
