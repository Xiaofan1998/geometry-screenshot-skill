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
    stableAfterEndMs: 2500,
    interrupt: false,
    interruptTimes: [],
    interruptContents: [],
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
    else if (arg === '--stable-after-end-ms') options.stableAfterEndMs = Number(argv[++index])
    else if (arg === '--interrupt') options.interrupt = argv[++index] === 'true'
    else if (arg === '--interrupt_time') options.interruptTimes = parseListArg(argv[++index]).map(parseDurationMs)
    else if (arg === '--interrupt_content') options.interruptContents = parseListArg(argv[++index])
    else if (arg === '--viewport-width') options.viewportWidth = Number(argv[++index])
    else if (arg === '--viewport-height') options.viewportHeight = Number(argv[++index])
  }

  return options
}

export function parseListArg(value) {
  const text = String(value || '').trim()
  if (!text) return []

  try {
    const parsed = JSON.parse(text.replace(/'/g, '"'))
    if (Array.isArray(parsed)) return parsed.map((item) => String(item))
  } catch {
    // Fall through to comma splitting for shell-friendly input.
  }

  return text
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

export function parseDurationMs(value) {
  const text = String(value || '').trim()
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s)?$/i)
  if (!match) throw new Error(`Invalid duration: ${value}`)
  const amount = Number(match[1])
  return match[2]?.toLowerCase() === 'ms' ? amount : amount * 1000
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
  interrupts = [],
}) {
  const successEndReasons = new Set([
    'completed_by_end_signal',
    'completed_by_console_idle_after_stream',
    'completed_by_console_idle',
  ])

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
    success: successEndReasons.has(endReason),
    lastEndState,
    interrupts,
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
  return Boolean(eventName)
}

export function isStreamFinishedLog(line) {
  return /\[(sendGeometryChat|sendGeometryVoiceFollowup)\] 流结束/.test(String(line || ''))
}

export function isAudioStartLog(line) {
  return String(line || '').includes('[RI] playAudio: start')
}

export function isAudioEndedLog(line) {
  return String(line || '').includes('[RI] playAudio: ended')
}

export function isTerminalProcessEndLog(line) {
  const endLog = parseProcessEndLog(line)
  return Boolean(endLog && endLog.index === endLog.total && endLog.total > 10)
}

export function decideRunEnd({
  streamFinished,
  terminalProcessEnded,
  pendingInterruptCount,
  audioPlaying,
  hasSeenConsoleEvent,
  hasCapturedScreenshot,
  now,
  lastConsoleActivityAt,
  idleTimeoutMs,
  deadlineAt,
  stableAfterEndMs = 2500,
}) {
  if (streamFinished && terminalProcessEnded && pendingInterruptCount === 0 && !audioPlaying) {
    if (!hasCapturedScreenshot) return 'no_matching_iframe_events'
    if (now - lastConsoleActivityAt >= stableAfterEndMs) return 'completed_by_end_signal'
    return null
  }

  if (hasCapturedScreenshot && pendingInterruptCount === 0 && now - lastConsoleActivityAt >= idleTimeoutMs && !audioPlaying) {
    return streamFinished ? 'completed_by_console_idle_after_stream' : 'completed_by_console_idle'
  }

  if (now >= deadlineAt) {
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

function buildInterrupts(options) {
  if (!options.interrupt) return []
  const times = options.interruptTimes.length ? options.interruptTimes : [20000]
  const contents = options.interruptContents.length ? options.interruptContents : ['你讲一下第一步']
  return times.map((timeMs, index) => ({
    timeMs,
    content: contents[index] || contents[contents.length - 1],
    fired: false,
  }))
}

async function clickGeometryVoiceButton(page, labelPattern) {
  const button = page.locator('.geometry-voice-btn', { hasText: labelPattern }).last()
  await button.waitFor({ state: 'visible', timeout: 10000 })
  await button.click()
}

async function fireMockInterrupt(page) {
  await clickGeometryVoiceButton(page, /语音提问/)
  await page.waitForTimeout(800)
  await clickGeometryVoiceButton(page, /停止录音/)
}

export async function runGeometryScreenshotCli(options) {
  const startedAt = new Date().toISOString()
  const interrupts = buildInterrupts(options)
  const browser = await chromium.launch({
    headless: options.headless,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  })
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
  let streamFinished = false
  let terminalProcessEnded = false
  let endReason = 'failed_before_capture'
  let fallbackCount = 0
  let totalScreenshots = 0
  let lastConsoleActivityAt = Date.now()
  let hasSeenConsoleEvent = false
  let lastEndState = null
  let firstPlaybackStartedAt = null
  let audioPlaying = false
  let pendingInterruptTask = null
  let sequence = 0
  const pendingConsoleTasks = createPendingConsoleTaskTracker()

  try {
    await page.route('**/api/geometry/asr', async (route) => {
      const next = interrupts.find((item) => item.fired && !item.asrUsed)
      if (next) next.asrUsed = true
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: next?.content || options.interruptContents[0] || '你讲一下第一步' }),
      })
    })

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
        const text = message.text()

        if (isAudioStartLog(text)) {
          audioPlaying = true
          firstPlaybackStartedAt = firstPlaybackStartedAt || Date.now()
        } else if (isAudioEndedLog(text)) {
          audioPlaying = false
        }

        const endLog = parseProcessEndLog(text)
        if (endLog) {
          lastEndState = endLog
          terminalProcessEnded = isTerminalProcessEndLog(text)
        }

        if (isStreamFinishedLog(text)) {
          streamFinished = true
          receivedEndSignal = true
          return
        }

        const parsed = parseSendToIframeLog(text)
        if (!parsed) return

        hasSeenConsoleEvent = true

        if (!shouldCaptureScreenshotEvent(parsed.eventName)) {
          return
        }

        const payload = await resolveConsolePayload(message, parsed)
        if (!payload) return

        const frame = page.locator('iframe.response-iframe').first().contentFrame()
        if (!frame) return

        const captureSequence = sequence + 1
        sequence = captureSequence
        const target = await resolveCaptureLocator(frame)
        const entry = buildIndexEntry({
          sequence: captureSequence,
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

      if (firstPlaybackStartedAt && !pendingInterruptTask) {
        const nextInterrupt = interrupts.find((item) => !item.fired && now - firstPlaybackStartedAt >= item.timeMs)
        if (nextInterrupt) {
          nextInterrupt.fired = true
          streamFinished = false
          terminalProcessEnded = false
          pendingInterruptTask = fireMockInterrupt(page)
            .catch((error) => {
              nextInterrupt.error = String(error?.message || error)
            })
            .finally(() => {
              pendingInterruptTask = null
            })
        }
      }

      const decidedEnd = decideRunEnd({
        streamFinished,
        terminalProcessEnded,
        pendingInterruptCount: interrupts.filter((item) => !item.fired).length + (pendingInterruptTask ? 1 : 0),
        audioPlaying,
        hasSeenConsoleEvent,
        hasCapturedScreenshot: totalScreenshots > 0,
        now,
        lastConsoleActivityAt,
        idleTimeoutMs: options.idleTimeoutMs,
        deadlineAt,
        stableAfterEndMs: options.stableAfterEndMs,
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
      interrupts: interrupts.map((item) => ({
        timeMs: item.timeMs,
        content: item.content,
        fired: item.fired,
        asrUsed: Boolean(item.asrUsed),
        error: item.error || '',
      })),
    })
    writeSummary(paths.summaryPath, summary)
    return summary
  } finally {
    await browser.close()
  }
}
