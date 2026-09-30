/**
 * Word error rate, and how many of a reference's names came through.
 *
 * Both sides are normalised the same way first, so a transcript is not
 * charged for style: case, punctuation, fillers ("um", "uh", which AMI
 * writes and most models drop), spelled numbers against digits, and an
 * identifier written joined ("useAgentVoice") against spoken apart.
 */

const FILLERS = new Set(['um', 'uh', 'mm', 'hmm', 'mhm', 'mm-hmm', 'uh-huh', 'ah', 'er', 'erm', 'eh', 'oh'])
const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
}
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
const SPELLINGS: Record<string, string> = { percent: '%', okay: 'ok', gonna: 'going to', wanna: 'want to', cause: 'because' }

export function normalize(text: string): string[] {
  const split = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/%/g, ' percent ')
    .replace(/(\d),(\d)/g, '$1$2')
    .replace(/(\d)\.(\d)/g, '$1 point $2')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/'(?!(s|t|re|ve|ll|d|m)\b)/g, ' ')
  const tokens: string[] = []
  for (const raw of split.split(/\s+/)) {
    if (!raw || FILLERS.has(raw)) continue
    const word = SPELLINGS[raw] ?? raw
    for (const piece of word.split(' ')) tokens.push(piece)
  }
  // Spelled numbers to digits: "thirty six" is 36, "five point six" is 5.6.
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token in TENS) {
      const next = tokens[i + 1]
      if (next && next in UNITS && UNITS[next]! < 10) {
        out.push(String(TENS[token]! + UNITS[next]!))
        i++
      } else out.push(String(TENS[token]))
    } else if (token in UNITS) out.push(String(UNITS[token]))
    else out.push(token)
  }
  const joined: string[] = []
  for (let i = 0; i < out.length; i++) {
    if (out[i] === 'point' && /^\d+$/.test(joined.at(-1) ?? '') && /^\d+$/.test(out[i + 1] ?? '')) {
      joined[joined.length - 1] += `.${out[++i]}`
    } else joined.push(out[i]!)
  }
  return joined
}

export function editDistance(a: string[], b: string[]): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]!
}

/**
 * The words in a reference a transcript has to get right to be useful:
 * names (capitalised, not starting a sentence) and numbers. Only meaningful
 * for a cased reference; AMI is all capitals and has none.
 */
export function namesIn(reference: string): string[] {
  if (reference === reference.toUpperCase()) return []
  const names: string[] = []
  for (const sentence of reference.split(/(?<=[.!?])\s+/)) {
    sentence.split(/\s+/).forEach((word, index) => {
      const clean = word.replace(/^[^A-Za-z0-9$]+|[^A-Za-z0-9%]+$/g, '')
      if (!clean || clean === 'I' || /^I'/.test(clean)) return
      if (/\d/.test(clean) || (index > 0 && /^[A-Z]/.test(clean))) names.push(clean)
    })
  }
  return names
}

export function nameHit(name: string, hypothesis: string): boolean {
  const key = normalize(name).join('')
  return key.length > 0 && normalize(hypothesis).join('').includes(key)
}
