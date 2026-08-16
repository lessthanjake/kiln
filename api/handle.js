// networked.art routes a token as /{artist handle}/{collection}/{tokenId}.
// The handle is not on chain and their API sends no Access-Control-Allow-Origin
// header, so a browser cannot read it directly — the fetch rejects and Kiln
// falls back to the site root, which is what shipped and was wrong.
//
// This is the whole workaround: a same-origin GET that forwards one public,
// read-only request. No key, no state, nothing user-supplied reaches a shell.
//
// Kiln still works without it. Running locally there is no /api route, the
// fetch 404s, and the link degrades to networked.art's home page rather than
// pointing at a token that may not exist.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export default async function handler(req, res) {
  const { collection } = req.query
  if (!ADDRESS.test(collection ?? '')) {
    return res.status(400).json({ error: 'collection must be a 20-byte hex address' })
  }

  try {
    const upstream = await fetch(`https://api.networked.art/collections/${collection}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!upstream.ok) return res.status(404).json({ handle: null })

    const handle = (await upstream.json())?.collection?.attribution_handle ?? null
    // The handle changes about never, and a stale one costs a page load.
    res.setHeader('cache-control', 'public, max-age=3600, s-maxage=86400')
    return res.status(200).json({ handle })
  } catch {
    return res.status(502).json({ handle: null })
  }
}
