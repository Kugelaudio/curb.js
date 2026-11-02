import { readdirSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { guideHref, guideLinkText } from './guide-links'
import { GUIDE_GROUPS, GUIDE_PAGES, markdownUrl, neighbours, pagesToBuild, pageUrl } from './guide'

const guide = fileURLToPath(new URL('../../packages/framework/docs/agent-guide', import.meta.url))
const guideFiles = () =>
  readdirSync(guide, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.md'))

describe('the guide table', () => {
  it('lists every guide page, so a new one cannot go unpublished', () => {
    const files = guideFiles()
    const pages = GUIDE_PAGES.map((page) => page.file).filter((file) => !file.startsWith('..'))
    expect(pages.sort()).toEqual(files.sort())
  })

  it('keeps each navigation group together, so the pager follows the navigation', () => {
    const order = GUIDE_PAGES.map((page) => page.group).filter((group, index, all) => group !== all[index - 1])
    expect(order).toEqual([...GUIDE_GROUPS])
  })

  it('has no em dashes, outside the requests printed from a real run', () => {
    const lines = guideFiles().flatMap((name) => {
      const text = readFileSync(`${guide}/${name}`, 'utf8').replace(/<!-- request: [\s\S]*?\n```\n/g, '')
      return text.split('\n').filter((line) => line.includes('\u2014')).map((line) => `${name}: ${line}`)
    })
    expect(lines).toEqual([])
  })

  it('links only to guide pages, so no link leaves the site for a file it does not serve', () => {
    const files = new Set(guideFiles())
    const broken = guideFiles().flatMap((name) =>
      [...readFileSync(`${guide}/${name}`, 'utf8').matchAll(/\]\(([^)#\s]+)[^)]*\)/g)]
        .map((match) => match[1])
        .filter((href) => !/^([a-z]+:|\/)/.test(href))
        .filter((href) => !files.has(posix.join(posix.dirname(name), href)))
        .map((href) => `${name}: ${href}`),
    )
    expect(broken).toEqual([])
  })

  // The docs server pairs llms-full.txt's sections with llms.txt's entries by position.
  it('keeps llms.txt and llms-full.txt in the same order, one section per entry', () => {
    const indexed = GUIDE_GROUPS.flatMap((group) => GUIDE_PAGES.filter((page) => page.group === group))
    expect(indexed.map((page) => page.id)).toEqual(GUIDE_PAGES.map((page) => page.id))

    const changelog = fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url))
    const files = [...guideFiles().map((name) => `${guide}/${name}`), changelog]
    const splitting = files.filter((file) => readFileSync(file, 'utf8').includes('\n\n---\n\n'))
    expect(splitting).toEqual([])
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

  it('resolves a link from a nested page', () => {
    expect(guideHref('./skill.md', 'components/tool.md')).toBe('/docs/components/skill/')
    expect(guideHref('../state.md#locks', 'components/tool.md')).toBe('/docs/state/#locks')
    expect(guideHref('./components/tool.md')).toBe('/docs/components/tool/')
  })

  it('names a link to a guide file by its page title', () => {
    expect(guideLinkText('tools.md')).toBe('Tools')
    expect(guideLinkText('the tools guide')).toBe('the tools guide')
  })
})
