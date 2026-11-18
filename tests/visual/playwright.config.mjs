import { defineConfig } from '@playwright/test'
import { origin } from './config-data.mjs'

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  workers: 1,
  retries: 0,
  snapshotPathTemplate: '{testDir}/baselines/{projectName}/{arg}{ext}',
  outputDir: '../../output/visual-regression',
  expect: { toHaveScreenshot: { animations: 'disabled', caret: 'hide', threshold: 0, maxDiffPixels: 0 } },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 375, height: 812 }, hasTouch: true } },
  ],
  use: { baseURL: origin, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', deviceScaleFactor: 1 },
  webServer: {
    command: 'node --import tsx tests/visual/fixture.mjs',
    cwd: '../..',
    url: origin + '/api/auth/status',
    reuseExistingServer: false,
  },
})
