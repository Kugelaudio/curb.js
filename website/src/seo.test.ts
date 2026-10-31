import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GUIDE_PAGES } from './guide'
import {
  OG_IMAGE_ALT,
  OG_IMAGE_PATH,
  SITE_DESCRIPTION,
  SITE_HEADLINE,
  SITE_LEDE_HTML,
  SITE_TITLE,
  docsStructuredData,
  docsTitle,
  homeStructuredData,
  jsonLd,
  keywords,
  sitemapPaths,
  sitemapXml,
} from './seo'

const site = new URL('https://curbjs.com')

describe('search metadata', () => {
  it.each(GUIDE_PAGES.map((page) => [page.id, page] as const))('%s fits a search result', (_, page) => {
    expect(docsTitle(page.title).length).toBeLessThanOrEqual(70)
    expect(page.description.length).toBeGreaterThanOrEqual(30)
    expect(page.description.length).toBeLessThanOrEqual(160)
  })

  it('gives every page a description of its own', () => {
    const descriptions = GUIDE_PAGES.map((page) => page.description)
    expect(new Set(descriptions).size).toBe(descriptions.length)
  })

  it('lists a keyword once, the page own first', () => {
    const list = keywords(['LiveKit', 'Testing']).split(', ')
    expect(list.slice(0, 2)).toEqual(['LiveKit', 'Testing'])
    expect(new Set(list).size).toBe(list.length)
  })
})

describe('tagline', () => {
  const repoFile = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
  const packageDescription = (path: string) => (JSON.parse(repoFile(path)) as { description: string }).description
  const tagline = SITE_HEADLINE.slice(0, -1).toLowerCase()

  it('is the README tagline', () => {
    expect(repoFile('README.md')).toContain(`<p><strong>${SITE_HEADLINE}</strong></p>`)
  })

  it('is the description of the framework package', () => {
    expect(packageDescription('packages/framework/package.json')).toBe(`${SITE_HEADLINE} ${SITE_DESCRIPTION}`)
  })

  it('names Curb in the description of the create package', () => {
    expect(packageDescription('packages/create-curb.js/package.json')).toContain('a Curb voice agent')
  })

  it('is the title and the alt text of the share image', () => {
    expect(SITE_TITLE.toLowerCase()).toContain(tagline)
    expect(OG_IMAGE_ALT.toLowerCase()).toContain(tagline)
  })

  it('bolds phrases of the description without changing its words', () => {
    expect(SITE_LEDE_HTML.match(/<strong>/g)).toHaveLength(6)
    expect(SITE_LEDE_HTML.replace(/<\/?strong>/g, '')).toBe(SITE_DESCRIPTION)
  })

  it('points the share image at a file the site serves', () => {
    expect(existsSync(new URL(`../public${new URL(OG_IMAGE_PATH, 'https://curbjs.com').pathname}`, import.meta.url))).toBe(true)
  })
})

describe('structured data', () => {
  it('describes the software on the home page', () => {
    const [website, software] = homeStructuredData(site, 'A framework.')['@graph']
    expect(website).toMatchObject({ '@type': 'WebSite', url: 'https://curbjs.com/' })
    expect(software).toMatchObject({ '@type': 'SoftwareApplication', description: 'A framework.' })
  })

  it('places a docs page under the docs', () => {
    const [article, crumbs] = docsStructuredData(site, 'testing', 'Testing')['@graph']
    expect(article).toMatchObject({ '@type': 'TechArticle', url: 'https://curbjs.com/docs/testing/' })
    expect(crumbs!.itemListElement![1]).toMatchObject({ position: 2, item: 'https://curbjs.com/docs/testing/' })
  })

  it('cannot close its script element', () => {
    expect(jsonLd({ text: '</script>' })).not.toContain('<')
  })
})

describe('the sitemap', () => {
  it('lists the home page and every guide page once, with a trailing slash', () => {
    const paths = sitemapPaths()
    expect(paths).toHaveLength(GUIDE_PAGES.length + 1)
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths.every((path) => path.endsWith('/'))).toBe(true)
  })

  it('writes absolute URLs', () => {
    expect(sitemapXml(site)).toContain('<loc>https://curbjs.com/docs/testing/</loc>')
  })
})
