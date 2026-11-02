import { posix } from 'node:path'
import { GUIDE_PAGES } from './guide'

/**
 * A link between guide pages as the site serves it: `./tools.md#keys` -> `/docs/tools/#keys`.
 * `from` is the linking file within the guide, since a nested page links with `../`.
 */
export function guideHref(href: string, from = 'README.md'): string {
  const match = /^(\.{1,2}\/[A-Za-z0-9_/.-]+)\.md(#.*)?$/.exec(href)
  if (!match) return href
  const [, target = '', fragment = ''] = match
  const page = posix.join(posix.dirname(from), target)
  if (page.startsWith('..')) return href
  return page === 'README' ? `/docs/${fragment}` : `/docs/${page}/${fragment}`
}

/** The file's path within the guide, from the path the renderer gives it. */
function guideFile(path: string | undefined): string | undefined {
  return path?.split('/docs/agent-guide/')[1]
}

type HastNode = {
  type?: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** The page title for link text that is a guide file name: `tools.md` -> `Tools`. */
export function guideLinkText(text: string): string {
  return GUIDE_PAGES.find((page) => page.file === text)?.title ?? text
}

/** Rehype plugin: the guide's relative links as the site serves them, named by page title. */
export function rehypeGuideLinks() {
  return (root: HastNode, file: { path?: string }): void => {
    const from = guideFile(file.path)
    const visit = (node: HastNode): void => {
      const href = node.properties?.href
      if (node.tagName === 'a' && typeof href === 'string') {
        node.properties!.href = guideHref(href, from)
        for (const child of node.children ?? []) {
          if (child.type === 'text' && child.value) child.value = guideLinkText(child.value)
        }
      }
      node.children?.forEach(visit)
    }
    visit(root)
  }
}
