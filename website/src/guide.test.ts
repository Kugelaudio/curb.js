import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { guideHref, guideLinkText } from './guide-links'
import { GUIDE_GROUPS, GUIDE_PAGES, markdownUrl, neighbours, pagesToBuild, pageUrl } from './guide'

const guide = fileURLToPath(new URL('../../packages/framework/docs/agent-guide', import.meta.url))

describe('the guide table', () => {
  it('lists every guide page, so a new one cannot go unpublished', () => {
    const files = readdirSync(guide).filter((name) => name.endsWith('.md'))
    const pages = GUIDE_PAGES.map((page) => page.file).filter((file) => !file.startsWith('..'))
    expect(pages.sort()).toEqual(files.sort())
  })

  it('keeps each navigation group together, so the pager follows the navigation', () => {
    const order = GUIDE_PAGES.map((page) => page.group).filter((group, index, all) => group !== all[index - 1])
    expect(order).toEqual([...GUIDE_GROUPS])
  })

  it('has no em dashes, outside the requests printed from a real run', () => {
    const lines = readdirSync(guide).flatMap((name) => {
      const text = readFileSync(`${guide}/${name}`, 'utf8').replace(/<!-- request: [\s\S]*?\n```\n/g, '')
      return text.split('\n').filter((line) => line.includes('\u2014')).map((line) => `${name}: ${line}`)
    })
    expect(lines).toEqual([])
  })

  it('serves the overview as the docs home', () => {
    expect(pageUrl('readme')).toBe('/docs/')
    expect(markdownUrl('readme')).toBe('/docs/index.md')
    expect(pageUrl('hosting')).toBe('/docs/hosting/')
    expect(markdownUrl('hosting')).toBe('/docs/hosting.md')
  })

  it('pages through the table', () => {
    expect(neighbours('readme').previous).toBeUndefined()
    expect(neighbours('readme').next?.id).toBe('installation')
    expect(neighbours(GUIDE_PAGES.at(-1)!.id).next).toBeUndefined()
  })

  it('lists the changelog only when curb.js has one', () => {
    expect(pagesToBuild(true).at(-1)?.id).toBe('changelog')
    expect(pagesToBuild(false).at(-1)?.id).toBe('glossary')
  })
})

describe('guideHref', () => {
  it('rewrites links between guide pages and leaves the others', () => {
    expect(guideHref('./tools.md#keys')).toBe('/docs/tools/#keys')
    expect(guideHref('./README.md')).toBe('/docs/')
    expect(guideHref('#local')).toBe('#local')
    expect(guideHref('https://example.com/a.md')).toBe('https://example.com/a.md')
  })

  it('names a link to a guide file by its page title', () => {
    expect(guideLinkText('tools.md')).toBe('Tools')
    expect(guideLinkText('the tools guide')).toBe('the tools guide')
  })
})
