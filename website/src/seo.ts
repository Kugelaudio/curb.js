import { GUIDE_PAGES, pageUrl, type GuidePageId } from './guide'

export const SITE_NAME = 'Curb'

export const OG_IMAGE_ALT = 'Curb: the React framework for voice agents'

const KEYWORDS = [
  'voice agents',
  'voice agent framework',
  'AI voice agent',
  'React voice agents',
  'TypeScript voice agents',
  'LiveKit',
  'phone agents',
  'conversational AI',
]

export function keywords(extra: string[] = []): string {
  return [...new Set([...extra, ...KEYWORDS])].join(', ')
}

/** The docs page's title in a search result, where the page name alone says nothing. */
export function docsTitle(title: string): string {
  return `${title} | Curb voice agent framework`
}

const publisher = { '@type': 'Organization', name: 'KugelAudio', url: 'https://kugelaudio.com' }

/** JSON-LD of the home page: what the site is and what the software does. */
export function homeStructuredData(site: URL, description: string) {
  const url = new URL('/', site).href
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: SITE_NAME, url, description, inLanguage: 'en', publisher },
      {
        '@type': 'SoftwareApplication',
        name: SITE_NAME,
        url,
        description,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Linux, macOS',
        softwareRequirements: 'Node.js 22.12 or newer',
        license: 'https://www.apache.org/licenses/LICENSE-2.0',
        image: new URL('/og.png', site).href,
        publisher,
      },
    ],
  }
}

/** JSON-LD of a docs page: the article and where it sits. */
export function docsStructuredData(site: URL, id: GuidePageId, title: string) {
  const url = new URL(pageUrl(id), site).href
  const { description, group } = GUIDE_PAGES.find((page) => page.id === id)!
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        headline: title,
        description,
        url,
        inLanguage: 'en',
        articleSection: group,
        image: new URL('/og.png', site).href,
        publisher,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Docs', item: new URL('/docs/', site).href },
          { '@type': 'ListItem', position: 2, name: title, item: url },
        ],
      },
    ],
  }
}

/** Safe inside a script element: a `<` in the data can never close it. */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data).replaceAll('<', '\\u003c')
}

/** Every indexable page, once. */
export function sitemapPaths(): string[] {
  return ['/', ...GUIDE_PAGES.map((page) => pageUrl(page.id))]
}

export function sitemapXml(site: URL): string {
  const urls = sitemapPaths().map((path) => `  <url><loc>${new URL(path, site).href}</loc></url>`)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n')
}
