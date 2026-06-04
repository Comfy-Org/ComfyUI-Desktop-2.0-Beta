// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001B\u009B][#();?[]*(?:\d{1,4}(?:;\d{0,4})*)?[\d<=>A-ORZcf-nqry]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

export function lastNLines(text: string, n: number): string {
  return text.split('\n').slice(-n).join('\n')
}
