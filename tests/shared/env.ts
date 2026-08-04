/**
 * 验收报告环境采集（SPEC §10.2/§1.3，Node 侧）。
 *
 * 报告必须记录：硬件（CPU/核数/内存/平台）、浏览器完整版本、commit、
 * Playwright/Node 版本；WebGL renderer 字符串与数据文件 SHA-256 由页侧
 * 桥采集（实际渲染上下文与实际消费字节），不在本模块。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'

export interface AcceptanceEnvironment {
  /** ISO 时间戳（报告采集时刻） */
  readonly collectedAt: string
  /** git commit（HEAD；非 git 环境记录原因而非伪造） */
  readonly commit: string
  readonly cpu: string
  readonly cpuCores: number
  readonly memoryGB: number
  readonly platform: string
  readonly osRelease: string
  readonly arch: string
  readonly nodeVersion: string
  readonly playwrightVersion: string
  readonly browserName: string
  /** Playwright 冻结的 Chromium 完整版本（§1.3 验收浏览器） */
  readonly browserVersion: string
}

function resolveGitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch (cause) {
    return `未知（git 不可用：${cause instanceof Error ? cause.message : String(cause)}）`
  }
}

function resolvePlaywrightVersion(): string {
  const packageJsonPath = fileURLToPath(
    new URL('../../node_modules/@playwright/test/package.json', import.meta.url),
  )
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
    return String(parsed.version)
  }
  return '未知（package.json 缺少 version 字段）'
}

export function collectAcceptanceEnvironment(browserVersion: string): AcceptanceEnvironment {
  const cpuList = cpus()
  return {
    collectedAt: new Date().toISOString(),
    commit: resolveGitCommit(),
    cpu: cpuList[0]?.model ?? '未知',
    cpuCores: cpuList.length,
    memoryGB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    platform: platform(),
    osRelease: release(),
    arch: arch(),
    nodeVersion: process.version,
    playwrightVersion: resolvePlaywrightVersion(),
    browserName: 'chromium',
    browserVersion,
  }
}
