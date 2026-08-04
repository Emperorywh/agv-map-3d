/**
 * 帧时间/耗时样本统计（SPEC §10.2：以 p95/p99 百分位断言，不以平均 FPS 替代）。
 * tests 页侧（PerformanceHarness）与 Node 侧（性能规格）共用的同一实现。
 * 百分位采用 nearest-rank：sort 后取第 ceil(p/100·n) 个（1 基）。
 */

export interface SampleStats {
  readonly count: number
  readonly min: number
  readonly max: number
  readonly mean: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
}

/** nearest-rank 百分位；空样本返回 0 */
export function percentileNearestRank(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

export function summarizeSamples(values: readonly number[]): SampleStats {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 }
  }
  let sum = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const value of values) {
    sum += value
    if (value < min) min = value
    if (value > max) max = value
  }
  return {
    count: values.length,
    min,
    max,
    mean: sum / values.length,
    p50: percentileNearestRank(values, 50),
    p95: percentileNearestRank(values, 95),
    p99: percentileNearestRank(values, 99),
  }
}
