import { GUIDE_PAGES } from './guide'

/** A link between guide pages as the site serves it: `./tools.md#keys` -> `/docs/tools/#keys`. */
export function guideHref(href: string): string {
  const match = /^\.\/([A-Za-z0-9_-]+)\.md(#.*)?$/.exec(href)
  if (!match) return href
  const [, page, fragment = ''] = match
  return page === 'README' ? `/docs/${fragment}` : `/docs/${page}/${fragment}`
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
  const visit = (node: HastNode): void => {
    const href = node.properties?.href
    if (node.tagName === 'a' && typeof href === 'string') {
      node.properties!.href = guideHref(href)
      for (const child of node.children ?? []) {
        if (child.type === 'text' && child.value) child.value = guideLinkText(child.value)
      }
    }
    node.children?.forEach(visit)
  }
  return visit
}
