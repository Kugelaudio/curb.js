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

  it.each(['README.md', 'packages/framework/README.md', 'packages/create-curb.js/README.md'])(
    'opens %s with the headline and the description',
    (path) => {
      const head = repoFile(path).split('</div>')[0]
      expect(head).toContain(`<p><strong>${SITE_HEADLINE}</strong></p>\n  <p>${SITE_DESCRIPTION}</p>`)
    },
  )

  it.each(['packages/framework/README.md', 'packages/create-curb.js/README.md'])(
    'shows the share image the site serves at the top of %s',
    (path) => {
      expect(repoFile(path).split('\n')[1]).toContain(`src="${new URL(OG_IMAGE_PATH, site).href}"`)
    },
  )

  it('is the description of the framework package', () => {
    expect(packageDescription('packages/framework/package.json')).toBe(`${SITE_HEADLINE} ${SITE_DESCRIPTION}`)
  })

  it('names Curb in the description of the create package', () => {
    expect(packageDescription('packages/create-curb.js/package.json')).toContain('a Curb voice agent')
  })

  it('ends the description of the create package with the headline', () => {
    expect(packageDescription('packages/create-curb.js/package.json').endsWith(SITE_HEADLINE)).toBe(true)
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

// npm shows a shorter page in another order, so packages/framework/README.md is its own file, and
// what it shares with README.md must stay word for word.
describe('the README on npm', () => {
  const repoFile = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
  /** A file as blank-line-separated blocks, each with its line breaks flattened; code stays whole. */
  const blocks = (markdown: string) =>
    (markdown.match(/^```[\s\S]*?^```$|(?:^(?!```).+\n?)+/gm) ?? []).map((block) => block.trim().replace(/\s+/g, ' '))
  const npmOnly = /^<div align="center">|^Curb is licensed under/
  const quickstart = /^```bash npm create curb\.js my-agent/

  it('says the same as the root README, apart from its header and license', () => {
    const root = new Set(blocks(repoFile('README.md')))
    const missing = blocks(repoFile('packages/framework/README.md')).filter((block) => !npmOnly.test(block) && !root.has(block))
    expect(missing).toEqual([])
  })

  it('gives the same quick start on create-curb.js', () => {
    const steps = (path: string) => blocks(repoFile(path)).find((block) => quickstart.test(block))
    expect(steps('README.md')).toBeDefined()
    expect(steps('packages/create-curb.js/README.md')).toBe(steps('README.md'))
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
