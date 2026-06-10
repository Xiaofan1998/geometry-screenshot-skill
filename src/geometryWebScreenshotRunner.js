import path from 'node:path'
import { chromium } from 'playwright'
import {
  EXCLUDED_TIDS,
  normalizeTid,
  filterAllowedTids,
  pickTid,
  parseSendToIframeLog,
  parseProcessEndLog,
} from './geometryScreenshotCore.js'
import {
  createSessionPaths,
  buildIndexEntry,
  appendIndexEntry,
  writeSummary,
} from './geometryScreenshotArtifacts.js'

export function parseArgs(argv) {
  const options = {
    url: 'http://localhost:5173',
    tid: '',
    outputDir: path.resolve(process.cwd(), 'artifacts/geometry-web-screenshot'),
    headless: true,
    idleTimeoutMs: 30000,
    endSignalTimeoutMs: 30000,
    viewportWidth: 1920,
    viewportHeight: 1400,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--url') options.url = argv[++index]
    else if (arg === '--tid') options.tid = normalizeTid(argv[++index])
    else if (arg === '--output-dir') options.outputDir = argv[++index]
    else if (arg === '--headless') options.headless = argv[++index] !== 'false'
    else if (arg === '--idle-timeout-ms') options.idleTimeoutMs = Number(argv[++index])
    else if (arg === '--end-signal-timeout-ms') options.endSignalTimeoutMs = Number(argv[++index])
    else if (arg === '--viewport-width') options.viewportWidth = Number(argv[++index])
    else if (arg === '--viewport-height') options.viewportHeight = Number(argv[++index])
  }

  return options
}

export function buildExcludedTidsSummary() {
  return [...EXCLUDED_TIDS]
}

export function buildSuccessSummary({
  selectedTid,
  sourceMode,
  totalScreenshots,
  endReason,
  receivedEndSignal,
  fallbackCount,
  allowedTidCount,
  startedAt,
  endedAt,
  outputDir,
  lastEndState,
}) {
  return {
    selectedTid,
    sourceMode,
    excludedTids: buildExcludedTidsSummary(),
    allowedTidCount,
    totalScreenshots,
    endReason,
    receivedEndSignal,
    fallbackCount,
    startedAt,
    endedAt,
    outputDir,
    success: endReason === 'completed_by_end_signal',
    lastEndState,
  }
}

export function createPendingConsoleTaskTracker() {
  const pending = new Set()

  return {
    track(task) {
      const wrapped = Promise.resolve(task).finally(() => {
        pending.delete(wrapped)
      })
      pending.add(wrapped)
      return wrapped
    },
    async waitForIdle() {
      while (pending.size > 0) {
        await Promise.all([...pending])
      }
    },
    size() {
      return pending.size
    },
  }
}

export function shouldCaptureScreenshotEvent(eventName) {
  return eventName === 'showLecture'
}

export function isStreamCompleteLog(line) {
  const endLog = parseProcessEndLog(line)
  return Boolean(endLog && endLog.index === endLog.total && endLog.total > 10)
}

export function decideRunEnd({
  streamCompleted,
  hasSeenConsoleEvent,
  hasCapturedScreenshot,
  now,
  lastConsoleActivityAt,
  idleTimeoutMs,
  deadlineAt,
}) {
  if (streamCompleted) {
    return hasCapturedScreenshot ? 'completed_by_end_signal' : 'no_matching_iframe_events'
  }

  if (now >= deadlineAt) {
    if (hasCapturedScreenshot && now - lastConsoleActivityAt < idleTimeoutMs) return null
    return hasSeenConsoleEvent ? 'timeout_waiting_for_end_signal' : 'no_iframe_events'
  }

  return null
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function resolveConsolePayload(message, parsed = parseSendToIframeLog(message.text())) {
  if (!parsed) return null

  const args = message.args()
  let eventName = parsed.eventName
  let params = null

  if (args.length >= 2) {
    eventName = await args[1].jsonValue()
  }
  if (args.length >= 3) {
    params = await args[2].jsonValue()
  }

  return {
    eventName,
    params,
    rawParams: parsed.rawParams,
  }
}

export function getCaptureSelectorCandidates() {
  return ['#app', 'body']
}

async function resolveCaptureLocator(frame) {
  const selectors = getCaptureSelectorCandidates()

  for (const selector of selectors) {
    const locator = frame.locator(selector).first()
    if (await locator.count()) {
      return { locator, fallbackUsed: selector !== '#app' }
    }
  }

  return {
    locator: frame.locator('body'),
    fallbackUsed: true,
  }
}

async function selectGeometryTid(page, requestedTid) {
  const tidButton = page.locator('.tid-selector .tid-candidate-btn').first()
  await tidButton.click()

  const optionLocator = page.locator('.tid-dropdown .tid-option')
  const allOptions = (await optionLocator.allTextContents()).map((text) => normalizeTid(text))
  const allowedTids = filterAllowedTids(allOptions)
  const selectedTid = requestedTid || pickTid(allowedTids)

  if (!allowedTids.includes(selectedTid)) {
    throw new Error(`Selected tid is not available in the filtered candidate list: ${selectedTid}`)
  }

  await page.locator('.tid-dropdown .tid-option', {
    hasText: new RegExp(`^${escapeRegExp(selectedTid)}$`),
  }).click()

  return {
    selectedTid,
    sourceMode: requestedTid ? 'explicit_tid' : 'auto_selected',
    allowedTidCount: allowedTids.length,
  }
}

export async function runGeometryScreenshotCli(options) {
  const startedAt = new Date().toISOString()
  const browser = await chromium.launch({ headless: options.headless })
  const page = await browser.newPage({
    viewport: {
      width: options.viewportWidth,
      height: options.viewportHeight,
    },
  })

  let selectedTid = options.tid
  let sourceMode = options.tid ? 'explicit_tid' : 'auto_selected'
  let allowedTidCount = 0
  let paths = null
  let receivedEndSignal = false
  let streamCompleted = false
  let endReason = 'failed_before_capture'
  let fallbackCount = 0
  let totalScreenshots = 0
  let lastConsoleActivityAt = Date.now()
  let hasSeenConsoleEvent = false
  let lastEndState = null
  let sequence = 0
  const pendingConsoleTasks = createPendingConsoleTaskTracker()

  try {
    await page.goto(options.url, { waitUntil: 'networkidle' })
    await page.getByText('几何题', { exact: true }).click()

    const selection = await selectGeometryTid(page, options.tid)
    selectedTid = selection.selectedTid
    sourceMode = selection.sourceMode
    allowedTidCount = selection.allowedTidCount
    paths = createSessionPaths({ outputDir: options.outputDir, selectedTid })

    page.on('console', (message) => {
      pendingConsoleTasks.track((async () => {
        lastConsoleActivityAt = Date.now()

        const endLog = parseProcessEndLog(message.text())
        if (endLog) {
          lastEndState = endLog
        }

        if (isStreamCompleteLog(message.text())) {
          streamCompleted = true
          receivedEndSignal = true
          return
        }

        const parsed = parseSendToIframeLog(message.text())
        if (!parsed) return

        hasSeenConsoleEvent = true

        if (!shouldCaptureScreenshotEvent(parsed.eventName)) {
          return
        }

        const payload = await resolveConsolePayload(message, parsed)
        if (!payload) return

        const frame = page.locator('iframe.response-iframe').first().contentFrame()
        if (!frame) return

        sequence += 1
        const target = await resolveCaptureLocator(frame)
        const entry = buildIndexEntry({
          sequence,
          eventName: payload.eventName,
          params: payload.params,
          rawParams: payload.rawParams,
          screenshotsDir: paths.screenshotsDir,
          fallbackUsed: target.fallbackUsed,
        })

        await target.locator.screenshot({ path: entry.screenshotPath })
        appendIndexEntry(paths.indexPath, entry)
        fallbackCount += target.fallbackUsed ? 1 : 0
        totalScreenshots += 1
      })())
    })

    await page.locator('button.send-btn').click()
    await page.locator('iframe.response-iframe').first().waitFor({ timeout: options.endSignalTimeoutMs })

    const deadlineAt = Date.now() + options.endSignalTimeoutMs
    while (true) {
      await page.waitForTimeout(200)
      const now = Date.now()
      const decidedEnd = decideRunEnd({
        streamCompleted,
        hasSeenConsoleEvent,
        hasCapturedScreenshot: totalScreenshots > 0,
        now,
        lastConsoleActivityAt,
        idleTimeoutMs: options.idleTimeoutMs,
        deadlineAt,
      })
      if (decidedEnd) {
        endReason = decidedEnd
        break
      }
    }

    await pendingConsoleTasks.waitForIdle()

    const summary = buildSuccessSummary({
      selectedTid,
      sourceMode,
      totalScreenshots,
      endReason,
      receivedEndSignal,
      fallbackCount,
      allowedTidCount,
      startedAt,
      endedAt: new Date().toISOString(),
      outputDir: paths.sessionDir,
      lastEndState,
    })
    writeSummary(paths.summaryPath, summary)
    return summary
  } finally {
    await browser.close()
  }
}
