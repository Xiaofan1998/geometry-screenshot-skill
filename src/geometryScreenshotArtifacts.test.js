import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createSessionPaths,
  buildIndexEntry,
  appendIndexEntry,
  writeSummary,
} from './geometryScreenshotArtifacts.js'

test('createSessionPaths creates the session folder and screenshot folder', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geometry-skill-'))
  const paths = createSessionPaths({
    outputDir,
    selectedTid: 'semantic_demo',
    now: new Date('2026-06-10T08:09:10.111Z'),
  })

  assert.equal(fs.existsSync(paths.sessionDir), true)
  assert.equal(fs.existsSync(paths.screenshotsDir), true)
  assert.equal(paths.sessionId.includes('semantic_demo'), true)
  assert.equal(paths.indexPath.endsWith('index.jsonl'), true)
  assert.equal(paths.summaryPath.endsWith('summary.json'), true)
})

test('buildIndexEntry returns the padded screenshot path and metadata', () => {
  const entry = buildIndexEntry({
    sequence: 4,
    eventName: 'addAnnotation',
    params: { section_id: 'seg_1' },
    rawParams: '{ section_id: "seg_1" }',
    screenshotsDir: '/tmp/screenshots',
    fallbackUsed: true,
    timestamp: '2026-06-10T08:09:10.111Z',
  })

  assert.deepEqual(entry, {
    sequence: 4,
    eventName: 'addAnnotation',
    params: { section_id: 'seg_1' },
    rawParams: '{ section_id: "seg_1" }',
    screenshotPath: path.join('/tmp/screenshots', '004-addAnnotation.png'),
    timestamp: '2026-06-10T08:09:10.111Z',
    fallbackUsed: true,
  })
})

test('appendIndexEntry and writeSummary persist JSON artifacts', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geometry-skill-'))
  const indexPath = path.join(outputDir, 'index.jsonl')
  const summaryPath = path.join(outputDir, 'summary.json')

  appendIndexEntry(indexPath, { sequence: 1, eventName: 'init' })
  appendIndexEntry(indexPath, { sequence: 2, eventName: 'renderProblem' })
  writeSummary(summaryPath, {
    selectedTid: 'fresh_tid',
    totalScreenshots: 2,
    endReason: 'completed_by_end_signal',
    success: true,
  })

  const indexLines = fs.readFileSync(indexPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))

  assert.deepEqual(indexLines, [
    { sequence: 1, eventName: 'init' },
    { sequence: 2, eventName: 'renderProblem' },
  ])
  assert.deepEqual(summary, {
    selectedTid: 'fresh_tid',
    totalScreenshots: 2,
    endReason: 'completed_by_end_signal',
    success: true,
  })
})
