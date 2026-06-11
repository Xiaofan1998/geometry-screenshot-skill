import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSendToIframeLog, parseProcessEndLog } from './geometryScreenshotCore.js'
import {
  parseArgs,
  parseListArg,
  parseDurationMs,
  buildExcludedTidsSummary,
  buildSuccessSummary,
  createPendingConsoleTaskTracker,
  shouldCaptureScreenshotEvent,
  isStreamFinishedLog,
  isTerminalProcessEndLog,
  getCaptureSelectorCandidates,
  decideRunEnd,
} from './geometryWebScreenshotRunner.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

test('parseArgs reads fixed tid and output overrides', () => {
  const options = parseArgs([
    '--tid', 'circle_arc_grounded.json',
    '--output-dir', '/tmp/output',
    '--headless', 'false',
    '--idle-timeout-ms', '5000',
    '--stable-after-end-ms', '1500',
    '--interrupt', 'true',
    '--interrupt_time', '[20s, 60s]',
    '--interrupt_content', "['给我讲一下勾股定理','你讲一下第一步']",
  ])

  assert.deepEqual(options, {
    url: 'http://localhost:5173',
    tid: 'circle_arc_grounded',
    outputDir: '/tmp/output',
    headless: false,
    idleTimeoutMs: 5000,
    endSignalTimeoutMs: 30000,
    stableAfterEndMs: 1500,
    interrupt: true,
    interruptTimes: [20000, 60000],
    interruptContents: ['给我讲一下勾股定理', '你讲一下第一步'],
    viewportWidth: 1920,
    viewportHeight: 1400,
  })
})

test('parseListArg and parseDurationMs accept shell-friendly arrays', () => {
  assert.deepEqual(parseListArg("['20s', '60s']"), ['20s', '60s'])
  assert.deepEqual(parseListArg('20s,60s'), ['20s', '60s'])
  assert.equal(parseDurationMs('20s'), 20000)
  assert.equal(parseDurationMs('1500ms'), 1500)
  assert.equal(parseDurationMs('2'), 2000)
})

test('buildExcludedTidsSummary returns the approved blacklist without json suffixes', () => {
  assert.deepEqual(buildExcludedTidsSummary(), [
    '491790740_grounded',
    'semantic_arc_smoke',
    '9471047bdededfa535720c24e2e85d82',
    'semantic_visual_smoke',
    'circle_arc_grounded',
    'similar_ratio_grounded',
  ])
})

test('buildSuccessSummary includes output metadata for completed runs', () => {
  const summary = buildSuccessSummary({
    selectedTid: 'fresh_tid',
    sourceMode: 'auto_selected',
    totalScreenshots: 3,
    endReason: 'completed_by_end_signal',
    receivedEndSignal: true,
    fallbackCount: 1,
    allowedTidCount: 12,
    startedAt: '2026-06-10T09:00:00.000Z',
    endedAt: '2026-06-10T09:00:10.000Z',
    outputDir: '/tmp/session',
    lastEndState: { index: 12, total: 12 },
    interrupts: [{ timeMs: 20000, content: '你讲一下第一步', fired: true, asrUsed: true, error: '' }],
  })

  assert.deepEqual(summary, {
    selectedTid: 'fresh_tid',
    sourceMode: 'auto_selected',
    excludedTids: [
      '491790740_grounded',
      'semantic_arc_smoke',
      '9471047bdededfa535720c24e2e85d82',
      'semantic_visual_smoke',
      'circle_arc_grounded',
      'similar_ratio_grounded',
    ],
    allowedTidCount: 12,
    totalScreenshots: 3,
    endReason: 'completed_by_end_signal',
    receivedEndSignal: true,
    fallbackCount: 1,
    startedAt: '2026-06-10T09:00:00.000Z',
    endedAt: '2026-06-10T09:00:10.000Z',
    outputDir: '/tmp/session',
    success: true,
    lastEndState: { index: 12, total: 12 },
    interrupts: [{ timeMs: 20000, content: '你讲一下第一步', fired: true, asrUsed: true, error: '' }],
  })
})

test('createPendingConsoleTaskTracker waits for in-flight screenshot tasks', async () => {
  const tracker = createPendingConsoleTaskTracker()
  let finished = false

  tracker.track(new Promise((resolve) => {
    setTimeout(() => {
      finished = true
      resolve()
    }, 10)
  }))

  assert.equal(finished, false)
  assert.equal(tracker.size(), 1)

  await tracker.waitForIdle()

  assert.equal(finished, true)
  assert.equal(tracker.size(), 0)
})

test('shouldCaptureScreenshotEvent accepts every iframe command', () => {
  assert.equal(shouldCaptureScreenshotEvent('showLecture'), true)
  assert.equal(shouldCaptureScreenshotEvent('renderProblem'), true)
  assert.equal(shouldCaptureScreenshotEvent('showSummary'), true)
  assert.equal(shouldCaptureScreenshotEvent(''), false)
})

test('stream and process-end detectors track separate phases', () => {
  assert.equal(isStreamFinishedLog('[sendGeometryChat] 流结束'), true)
  assert.equal(isStreamFinishedLog('[sendGeometryVoiceFollowup] 流结束'), true)
  assert.equal(isStreamFinishedLog('[RI] processEvents: END index=12 total=12'), false)
  assert.equal(isTerminalProcessEndLog('[RI] processEvents: END index=10 total=10'), false)
  assert.equal(isTerminalProcessEndLog('[RI] processEvents: END index=11 total=12'), false)
  assert.equal(isTerminalProcessEndLog('[RI] processEvents: END index=12 total=12'), true)
})

test('getCaptureSelectorCandidates prefers the full lecture container', () => {
  assert.deepEqual(getCaptureSelectorCandidates(), ['#app', 'body'])
})

test('decideRunEnd waits for RI process END and avoids mid-stream timeout while screenshots continue', () => {
  const deadlineAt = 30000
  const idleTimeoutMs = 10000

  assert.equal(decideRunEnd({
    streamFinished: false,
    terminalProcessEnded: false,
    pendingInterruptCount: 0,
    audioPlaying: false,
    hasSeenConsoleEvent: true,
    hasCapturedScreenshot: true,
    now: 12000,
    lastConsoleActivityAt: 9000,
    idleTimeoutMs,
    deadlineAt,
  }), null)

  assert.equal(decideRunEnd({
    streamFinished: true,
    terminalProcessEnded: true,
    pendingInterruptCount: 0,
    audioPlaying: false,
    hasSeenConsoleEvent: true,
    hasCapturedScreenshot: true,
    now: 15000,
    lastConsoleActivityAt: 12000,
    idleTimeoutMs,
    deadlineAt,
  }), 'completed_by_end_signal')

  assert.equal(decideRunEnd({
    streamFinished: true,
    terminalProcessEnded: true,
    pendingInterruptCount: 1,
    audioPlaying: false,
    hasSeenConsoleEvent: true,
    hasCapturedScreenshot: true,
    now: 20050,
    lastConsoleActivityAt: 9000,
    idleTimeoutMs,
    deadlineAt,
  }), null)

  assert.equal(decideRunEnd({
    streamFinished: false,
    terminalProcessEnded: false,
    pendingInterruptCount: 0,
    audioPlaying: false,
    hasSeenConsoleEvent: true,
    hasCapturedScreenshot: true,
    now: 40001,
    lastConsoleActivityAt: 29000,
    idleTimeoutMs,
    deadlineAt,
  }), 'completed_by_console_idle')

  assert.equal(decideRunEnd({
    streamFinished: false,
    terminalProcessEnded: false,
    pendingInterruptCount: 0,
    audioPlaying: false,
    hasSeenConsoleEvent: true,
    hasCapturedScreenshot: false,
    now: 30001,
    lastConsoleActivityAt: 15000,
    idleTimeoutMs,
    deadlineAt,
  }), 'timeout_waiting_for_end_signal')

  assert.equal(decideRunEnd({
    streamFinished: true,
    terminalProcessEnded: false,
    pendingInterruptCount: 0,
    audioPlaying: false,
    hasSeenConsoleEvent: true,
    hasCapturedScreenshot: true,
    now: 25000,
    lastConsoleActivityAt: 9000,
    idleTimeoutMs,
    deadlineAt,
  }), 'completed_by_console_idle_after_stream')

  assert.equal(decideRunEnd({
    streamFinished: true,
    terminalProcessEnded: true,
    pendingInterruptCount: 0,
    audioPlaying: true,
    hasSeenConsoleEvent: true,
    hasCapturedScreenshot: true,
    now: 45000,
    lastConsoleActivityAt: 9000,
    idleTimeoutMs,
    deadlineAt: 60000,
  }), null)
})
