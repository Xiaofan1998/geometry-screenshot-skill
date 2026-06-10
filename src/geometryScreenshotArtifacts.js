import fs from 'node:fs'
import path from 'node:path'
import { buildScreenshotFileName, normalizeTid } from './geometryScreenshotCore.js'

export function createSessionPaths({ outputDir, selectedTid, now = new Date() }) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const normalizedTid = normalizeTid(selectedTid) || 'auto'
  const sessionId = `${stamp}-${normalizedTid}`
  const sessionDir = path.resolve(outputDir, sessionId)
  const screenshotsDir = path.join(sessionDir, 'screenshots')
  const indexPath = path.join(sessionDir, 'index.jsonl')
  const summaryPath = path.join(sessionDir, 'summary.json')

  fs.mkdirSync(screenshotsDir, { recursive: true })

  return {
    sessionId,
    sessionDir,
    screenshotsDir,
    indexPath,
    summaryPath,
  }
}

export function buildIndexEntry({
  sequence,
  eventName,
  params,
  rawParams,
  screenshotsDir,
  fallbackUsed = false,
  timestamp = new Date().toISOString(),
}) {
  return {
    sequence,
    eventName,
    params,
    rawParams,
    screenshotPath: path.join(screenshotsDir, buildScreenshotFileName(sequence, eventName)),
    timestamp,
    fallbackUsed,
  }
}

export function appendIndexEntry(indexPath, entry) {
  fs.appendFileSync(indexPath, `${JSON.stringify(entry)}\n`, 'utf8')
}

export function writeSummary(summaryPath, summary) {
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
}