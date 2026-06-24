/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './frontend/index.html',
    './frontend/src/**/*.{js,jsx,ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#bcdaff',
          300: '#8ec1ff',
          400: '#599dff',
          500: '#3479fa',
          600: '#1e5ce0',
          700: '#1948b4',
          800: '#173e90',
          900: '#173771',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
