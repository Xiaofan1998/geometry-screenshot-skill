import { parseArgs, runGeometryScreenshotCli } from '../src/geometryWebScreenshotRunner.js'

const options = parseArgs(process.argv.slice(2))

runGeometryScreenshotCli(options)
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2))
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
