import { describe, expect, it } from 'vitest'
import { plainText, search, sectionsOf, snippet, type SearchSection } from './search-index'

const body = '# Tools\n\nIntro.\n\n## Keys\n\nUse `.env`.\n\n```bash\n# not a heading\n```\n'
const headings = [
  { depth: 1, slug: 'tools', text: 'Tools' },
  { depth: 2, slug: 'keys', text: 'Keys' },
]

describe('sectionsOf', () => {
  it('splits at headings, ignoring a # inside a code block', () => {
    expect(sectionsOf('Tools', '/docs/tools/', body, headings)).toEqual([
      { page: 'Tools', heading: 'Tools', url: '/docs/tools/', text: 'Intro.' },
      { page: 'Tools', heading: 'Keys', url: '/docs/tools/#keys', text: 'Use .env .' },
    ])
  })

  it('leaves out Next steps, which only link elsewhere', () => {
    const page = '# T\n\n## Next steps\n\n- A\n'
    const found = sectionsOf('T', '/t/', page, [headings[0]!, { depth: 2, slug: 'next-steps', text: 'Next steps' }])
    expect(found.map((section) => section.heading)).toEqual(['T'])
  })

  it('fails when the Markdown and the renderer disagree', () => {
    expect(() => sectionsOf('Tools', '/docs/tools/', body, headings.slice(1))).toThrow('2 headings')
  })
})

describe('plainText', () => {
  it('keeps the words of links and tables, and drops code blocks', () => {
    expect(plainText('A [link](./x.md) | b\n\n```ts\ncode\n```\n')).toBe('A link b')
  })
})

describe('search', () => {
  const sections: SearchSection[] = [
    { page: 'Hooks', heading: 'useSend', url: '/a', text: 'Sends a message.' },
    { page: 'App messages', heading: 'Send a message', url: '/b', text: 'useSend sends to the page.' },
    { page: 'Tools', heading: 'Keys', url: '/c', text: 'Nothing here.' },
  ]

  it('ranks a heading above the text', () => {
    expect(search(sections, 'usesend').map((hit) => hit.url)).toEqual(['/a', '/b'])
  })

  it('needs every word, and finds nothing for an empty query', () => {
    expect(search(sections, 'usesend page').map((hit) => hit.url)).toEqual(['/b'])
    expect(search(sections, '  ')).toEqual([])
  })

  it('shows the text around the word', () => {
    const long = { page: 'P', heading: 'H', url: '/', text: `${'a '.repeat(60)}needle ${'b '.repeat(120)}` }
    expect(snippet(long, 'needle')).toContain('needle')
    expect(snippet(long, 'needle').startsWith('…')).toBe(true)
  })
})
