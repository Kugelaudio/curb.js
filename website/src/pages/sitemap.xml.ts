import type { APIRoute } from 'astro'
import { sitemapXml } from '../seo'

export const GET: APIRoute = ({ site }) =>
  new Response(sitemapXml(site!), { headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
