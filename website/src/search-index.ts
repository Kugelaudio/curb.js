/** One heading of the docs and the text under it, which is what search finds. */
export type SearchSection = { page: string; heading: string; url: string; text: string }

type Heading = { depth: number; slug: string; text: string }

/** Markdown as plain words: no code blocks, tables' pipes, link targets or marks. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*|]/g, ' ')
    .replace(/^[-: ]+$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Splits a page at its headings. `headings` come from the renderer, which owns the slugs. */
export function sectionsOf(page: string, url: string, body: string, headings: readonly Heading[]): SearchSection[] {
  const sections: SearchSection[] = []
  const parts: string[][] = [[]]
  let fence = false
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (!fence && /^#{1,6} /.test(line)) parts.push([])
    else parts[parts.length - 1]!.push(line)
  }
  if (parts.length - 1 !== headings.length) {
    throw new Error(`${page}: ${parts.length - 1} headings in the Markdown, ${headings.length} rendered`)
  }
  headings.forEach((heading, index) => {
    if (heading.text === 'Next steps') return
    const text = plainText(parts[index + 1]!.join('\n'))
    sections.push({
      page,
      heading: heading.depth === 1 ? page : heading.text,
      url: heading.depth === 1 ? url : `${url}#${heading.slug}`,
      text,
    })
  })
  return sections
}

const score = (section: SearchSection, word: string): number => {
  const heading = section.heading.toLowerCase()
  if (heading === word) return 12
  if (heading.includes(word)) return 8
  if (section.page.toLowerCase().includes(word)) return 4
  return section.text.toLowerCase().includes(word) ? 1 : 0
}

/** The sections holding every word of the query, best first. */
export function search(sections: readonly SearchSection[], query: string, limit = 10): SearchSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  return sections
    .map((section) => ({ section, scores: words.map((word) => score(section, word)) }))
    .filter(({ scores }) => scores.every((value) => value > 0))
    .map(({ section, scores }) => ({ section, total: scores.reduce((sum, value) => sum + value, 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map(({ section }) => section)
}

/** A line of the section around the first word of the query. */
export function snippet(section: SearchSection, query: string, width = 110): string {
  const word = query.toLowerCase().split(/\s+/).filter(Boolean)[0] ?? ''
  const at = Math.max(section.text.toLowerCase().indexOf(word), 0)
  const start = Math.max(at - 30, 0)
  const line = section.text.slice(start, start + width).trim()
  return `${start > 0 ? '…' : ''}${line}${start + width < section.text.length ? '…' : ''}`
}
