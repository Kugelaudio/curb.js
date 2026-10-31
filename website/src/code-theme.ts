import type { ShikiTransformer, ThemeRegistration } from 'shiki'

/** Each code colour and the class that carries it: the CSP in Base.astro refuses inline styles. */
const TOKENS = {
  '#e6e6e6': 'code-plain',
  '#8a8a8a': 'code-comment',
  '#9a9a9a': 'code-punctuation',
  '#ff7b54': 'code-keyword',
  '#7ee2a0': 'code-string',
  '#6cb6ff': 'code-function',
  '#5ed8e0': 'code-component',
  '#c8a2ff': 'code-attribute',
  '#ffc66d': 'code-constant',
} as const

export const curbCodeTheme: ThemeRegistration = {
  name: 'curb',
  type: 'dark',
  fg: '#e6e6e6',
  bg: '#000000',
  settings: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#8a8a8a' } },
    { scope: ['punctuation', 'meta.brace', 'keyword.operator'], settings: { foreground: '#9a9a9a' } },
    {
      scope: ['keyword', 'storage', 'punctuation.definition.template-expression', 'keyword.operator.new', 'keyword.operator.expression'],
      settings: { foreground: '#ff7b54' },
    },
    { scope: ['string', 'string punctuation', 'punctuation.definition.string'], settings: { foreground: '#7ee2a0' } },
    { scope: ['constant', 'support.constant', 'variable.language'], settings: { foreground: '#ffc66d' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'], settings: { foreground: '#6cb6ff' } },
    { scope: ['entity.name.tag', 'support.class.component', 'entity.name.type', 'support.type', 'entity.name.class'], settings: { foreground: '#5ed8e0' } },
    { scope: ['entity.other.attribute-name', 'meta.object-literal.key', 'support.type.property-name'], settings: { foreground: '#c8a2ff' } },
  ],
}

/** The class of one line of a printed request or terminal, so plain text blocks read like code too. */
export function textLineClass(text: string): string {
  if (text.startsWith('=== ') || text.startsWith('--- ')) return 'r-section'
  if (/^\s+pass\b/.test(text) || /^\d+ of \d+ scenario/.test(text)) return 'r-plus'
  if (text.startsWith('caller:')) return 'r-user'
  if (text.startsWith('agent:')) return 'r-assistant'
  if (/^(user: )?<\/?current_context/.test(text)) return 'r-tag'
  if (text.startsWith('$ ')) return 'r-command'
  if (text.startsWith('[')) return 'r-note'
  if (text.startsWith('+ ')) return 'r-plus'
  const label = /^(tool|available_skill|active_skill|instruction|content|user|assistant):/.exec(text)?.[1]
  return label ? `r-${label.replace('_skill', '-skill')}` : ''
}

/** Moves Shiki's inline colours onto classes. */
export const codeClasses: ShikiTransformer = {
  name: 'curb-code-classes',
  pre(node) {
    delete node.properties.style
  },
  line(node, line) {
    if (this.options.lang !== 'text') return
    const name = textLineClass(this.source.split('\n')[line - 1] ?? '')
    if (name) this.addClassToHast(node, name)
  },
  span(node) {
    const style = String(node.properties.style ?? '')
    delete node.properties.style
    const colour = /color:\s*(#[0-9a-f]{6})/i.exec(style)?.[1]?.toLowerCase() as keyof typeof TOKENS | undefined
    if (!colour) return
    const name = TOKENS[colour]
    if (!name) throw new Error(`The code theme has no class for ${colour}`)
    this.addClassToHast(node, name)
  },
}

/** Tags lines of a code block with the branch they belong to, for the landing page's story. */
export function branchedLines(branches: (number | null)[]): ShikiTransformer {
  return {
    name: 'curb-branched-lines',
    line(node, line) {
      const branch = branches[line - 1]
      if (branch) node.properties['data-branch'] = String(branch)
    },
  }
}
