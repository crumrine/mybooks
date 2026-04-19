/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          bg: '#0a0a0a',
          card: '#171717',
          border: '#262626',
          muted: '#737373',
        },
      },
    },
  },
  plugins: [],
};
