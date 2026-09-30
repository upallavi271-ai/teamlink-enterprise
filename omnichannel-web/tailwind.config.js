/** @type {import('tailwindcss').Config} */
// Colors are bound to the CSS custom properties in src/styles/globals.css —
// the single source of truth ported verbatim from the Green Start prototype.
// Components use these aliases (bg-surface, text-ink, ...) and never raw hex.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        line: 'var(--line)',
        green: { DEFAULT: 'var(--green)', 2: 'var(--green-2)', 3: 'var(--green-3)' },
        lime: 'var(--lime)',
        orange: 'var(--orange)',
        blue: 'var(--blue)',
        red: 'var(--red)',
        violet: 'var(--violet)',
        accent: { DEFAULT: 'var(--accent)', 2: 'var(--accent-2)', soft: 'var(--accent-soft)', tint: 'var(--accent-tint)' },
      },
      borderRadius: { DEFAULT: 'var(--r)', card: 'var(--r)' },
      boxShadow: { card: 'var(--shadow)', sm: 'var(--shadow-sm)' },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['Space Grotesk', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
