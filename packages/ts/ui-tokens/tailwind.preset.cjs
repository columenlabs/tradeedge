/** Tailwind preset — shared across landing, dashboard, admin, docs, ui. */
module.exports = {
  theme: {
    extend: {
      colors: {
        accent: '#C5975B',
        gain: { DEFAULT: '#00ff88', subtle: '#00cc6a' },
        loss: { DEFAULT: '#ff3366', subtle: '#e63956' },
        bg: { light: '#f8f7f4', dark: '#0a0a0f' },
      },
      fontFamily: {
        display: ['Satoshi', 'ui-sans-serif', 'system-ui'],
        body: ['Geist', 'ui-sans-serif', 'system-ui'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular'],
      },
    },
  },
};
