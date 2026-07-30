/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      colors: {
        agensis: {
          bg: '#0c0c0c',
          panel: '#141414',
          border: '#2a2a2a',
          muted: '#8a8a8a',
          text: '#f4f4f4',
          accent: '#4f9cf9',
        },
      },
    },
  },
  plugins: [],
};
