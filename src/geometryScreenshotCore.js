export const EXCLUDED_TIDS = [
  '491790740_grounded',
  'semantic_arc_smoke',
  '9471047bdededfa535720c24e2e85d82',
  'semantic_visual_smoke',
  'circle_arc_grounded',
  'similar_ratio_grounded',
]

export function normalizeTid(value = '') {
  return String(value).trim().replace(/\.json$/i, '')
}

export function buildExcludedTidSet(items = EXCLUDED_TIDS) {
  return new Set(items.map((item) => normalizeTid(item)).filter(Boolean))
}

export function filterAllowedTids(candidates, excludedSet = buildExcludedTidSet()) {
  const seen = new Set()
  const result = []

  for (const candidate of candidates || []) {
    const normalized = normalizeTid(candidate)
    if (!normalized || excludedSet.has(normalized) || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

export function pickTid(candidates, randomValue = Math.random()) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('No allowed tid candidates remain after filtering')
  }

  const bounded = Math.min(0.999999, Math.max(0, Number(randomValue) || 0))
  const index = Math.floor(bounded * candidates.length)
  return candidates[index]
}

export function parseSendToIframeLog(line) {
  const prefix = '[ResponseItem] sendToIframe ->'
  const text = String(line || '')
  if (!text.includes(prefix)) return null

  const tail = text.slice(text.indexOf(prefix) + prefix.length).trim()
  const firstSpace = tail.indexOf(' ')
  if (firstSpace === -1) {
    return { eventName: tail, rawParams: '' }
  }

  return {
    eventName: tail.slice(0, firstSpace),
    rawParams: tail.slice(firstSpace + 1).trim(),
  }
}

export function parseProcessEndLog(line) {
  const match = String(line || '').match(/\[RI\] processEvents: END index=(\d+) total=(\d+)/)
  if (!match) return null

  return {
    index: Number(match[1]),
    total: Number(match[2]),
  }
}

export function sanitizeFileToken(value = '') {
  const token = String(value).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return token || 'event'
}

export function buildScreenshotFileName(sequence, eventName) {
  return `${String(sequence).padStart(3, '0')}-${sanitizeFileToken(eventName)}.png`
}
