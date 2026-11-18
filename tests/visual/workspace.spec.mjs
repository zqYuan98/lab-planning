import { expect, test } from '@playwright/test'
import { instant, password } from './config-data.mjs'

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(instant)) })

test('登录页', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '登录工作空间' })).toBeVisible()
  await expect(page).toHaveScreenshot('login.png', { fullPage: true })
})

for (const [view, heading] of [
  ['overview', '部门概览'], ['monthly', '月度目标'], ['weekly', '每周执行'], ['work-register', '我的工作清单'],
]) {
  test(heading, async ({ page }) => {
    await page.goto('/')
    await page.getByLabel('邮箱').fill('manager@example.test')
    await page.getByLabel('密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '登录工作空间' }).click()
    await expect(page.locator('.workspace-shell')).toBeVisible()
    await page.goto(view === 'overview' ? '/' : '/work?view=' + view)
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page).toHaveScreenshot(view + '.png', { fullPage: true })
  })
}
