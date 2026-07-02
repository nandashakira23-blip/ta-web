/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './views/**/*.ejs',
    './public/js/**/*.js'
  ],
  theme: {
    extend: {
      colors: {
        dark: {
          50: '#f8f9fa',
          100: '#e9ecef',
          200: '#dee2e6',
          300: '#ced4da',
          400: '#adb5bd',
          500: '#6c757d',
          600: '#495057',
          700: '#343a40',
          800: '#212529',
          900: '#1a1d20'
        },
        brown: {
          50: '#faf8f5',
          100: '#f0ebe4',
          200: '#e4d5c7',
          300: '#d4bfa6',
          400: '#c4a882',
          500: '#b8956b',
          600: '#a67c52',
          700: '#8b6914',
          800: '#6d4c0f',
          900: '#4a320a'
        },
        coffee: {
          50: '#faf9f7',
          100: '#f0ede8',
          200: '#e0d5c7',
          300: '#d0bfa6',
          400: '#c0a882',
          500: '#a67c52',
          600: '#8b6914',
          700: '#6d4c0f',
          800: '#4a320a',
          900: '#2d1e06'
        }
      }
    }
  },
  plugins: []
};
