import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EXCLUDED_TIDS,
  normalizeTid,
  buildExcludedTidSet,
  filterAllowedTids,
  pickTid,
  parseSendToIframeLog,
  parseProcessEndLog,
  buildScreenshotFileName,
} from './geometryScreenshotCore.js'

test('normalizeTid strips whitespace and trailing json suffix', () => {
  assert.equal(normalizeTid(' circle_arc_grounded.json '), 'circle_arc_grounded')
  assert.equal(normalizeTid('semantic_visual_smoke'), 'semantic_visual_smoke')
})

test('buildExcludedTidSet matches the approved blacklist', () => {
  const excluded = buildExcludedTidSet()
  assert.equal(excluded.has('491790740_grounded'), true)
  assert.equal(excluded.has('similar_ratio_grounded'), true)
  assert.equal(excluded.has('not-blocked'), false)
  assert.deepEqual(EXCLUDED_TIDS, [
    '491790740_grounded',
    'semantic_arc_smoke',
    '9471047bdededfa535720c24e2e85d82',
    'semantic_visual_smoke',
    'circle_arc_grounded',
    'similar_ratio_grounded',
  ])
})

test('filterAllowedTids normalizes, de-duplicates, and removes excluded tids', () => {
  const result = filterAllowedTids([
    '491790740_grounded.json',
    'circle_arc_grounded',
    'custom_case.json',
    'custom_case',
    'fresh_tid',
  ])

  assert.deepEqual(result, ['custom_case', 'fresh_tid'])
})

test('pickTid chooses a deterministic item from the filtered list', () => {
  assert.equal(pickTid(['first', 'second', 'third'], 0.0), 'first')
  assert.equal(pickTid(['first', 'second', 'third'], 0.51), 'second')
  assert.equal(pickTid(['first', 'second', 'third'], 0.99), 'third')
  assert.throws(() => pickTid([], 0.5), /No allowed tid candidates remain/)
})

test('parseSendToIframeLog reads the console prefix and event name', () => {
  assert.deepEqual(
    parseSendToIframeLog('[ResponseItem] sendToIframe -> init {"foo":1}'),
    { eventName: 'init', rawParams: '{"foo":1}' },
  )
  assert.deepEqual(
    parseSendToIframeLog('[ResponseItem] sendToIframe -> addAnnotation { section_id: "seg_1" }'),
    { eventName: 'addAnnotation', rawParams: '{ section_id: "seg_1" }' },
  )
  assert.equal(parseSendToIframeLog('[RI] processEvents: END index=4 total=4'), null)
})

test('parseProcessEndLog extracts index and total from end logs', () => {
  assert.deepEqual(
    parseProcessEndLog('[RI] processEvents: END index=12 total=12'),
    { index: 12, total: 12 },
  )
  assert.equal(parseProcessEndLog('[ResponseItem] sendToIframe -> init {}'), null)
})

test('buildScreenshotFileName pads sequence and sanitizes event names', () => {
  assert.equal(buildScreenshotFileName(1, 'init'), '001-init.png')
  assert.equal(buildScreenshotFileName(12, 'renderProblem'), '012-renderProblem.png')
  assert.equal(buildScreenshotFileName(3, 'addAnnotation/seg-1'), '003-addAnnotation-seg-1.png')
})
