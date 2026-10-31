import { getCollection } from 'astro:content'
import { GUIDE_PAGES } from './guide'

/** Every page of the table with its content; a page without content fails the build. */
export async function guideEntries() {
  const [guide, changelog] = await Promise.all([getCollection('guide'), getCollection('changelog')])
  return GUIDE_PAGES.map((page) => {
    const entry = page.id === 'changelog' ? changelog[0] : guide.find((candidate) => candidate.id === page.id)
    if (!entry) throw new Error(`The docs have no page ${page.file}`)
    return { page, entry }
  })
}
