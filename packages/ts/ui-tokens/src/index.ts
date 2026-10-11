export const tokens = {
  color: {
    accent: '#2563EB',
    gain: '#00ff88',
    gainSubtle: '#00cc6a',
    loss: '#ff3366',
    lossSubtle: '#e63956',
    bgLight: '#f4f6fa',
    bgDark: '#090c13',
  },
  /** Categorical chart series (validated for CVD on bgDark). */
  chart: {
    call: '#B8862E',
    put: '#3A8AD6',
  },
  font: {
    display: 'Manrope, ui-sans-serif, system-ui, sans-serif',
    body: 'Manrope, ui-sans-serif, system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
  },
} as const;
