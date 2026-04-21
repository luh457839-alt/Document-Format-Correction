/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './App.tsx',
    './main.tsx',
    './components/**/*.{ts,tsx}',
    './services/**/*.ts',
    './store/**/*.ts',
    './types/**/*.ts',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};