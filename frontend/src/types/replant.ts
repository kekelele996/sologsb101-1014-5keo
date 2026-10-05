/**
 * 补植计划（Replant）
 * 验收成活率偏低时生成的补植任务，完成后回写地块缺株数。
 */
import type { SeedlingSpecies } from './seedling';

/** 补植状态：待补植 / 部分补植 / 已补植 / 已复核 */
export type ReplantState = '待补植' | '部分补植' | '已补植' | '已复核';

/** 补植状态筛选项（含「全部」由页面自行兜底） */
export const REPLANT_STATE_OPTIONS: ReplantState[] = ['待补植', '部分补植', '已补植', '已复核'];

/**
 * 补植状态流转顺序，用于「推进状态」动作：
 * 实际补植少于计划数时落到「部分补植」并留在待办，可再次推进把剩余缺株补齐。
 */
export const REPLANT_STATE_FLOW: ReplantState[] = ['待补植', '部分补植', '已补植', '已复核'];

/** 仍需跟进的待办状态（待补植 + 部分补植） */
export function isReplantPending(state: ReplantState): boolean {
  return state === '待补植' || state === '部分补植';
}

/** 已登记实际补植株数的状态（部分补植 / 已补植 / 已复核） */
export function isReplantDone(state: ReplantState): boolean {
  return state !== '待补植';
}

export interface Replant {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 计划补植株数（缺株数，株） */
  missingCount: number;
  /**
   * 实际补植株数（株）：推进到「部分补植 / 已补植」时由班组登记，默认取计划数；
   * 待补植阶段为 null。
   */
  actualCount: number | null;
  /**
   * 首次回写时最新测次的原成活株数，作为多次推进（部分补植 → 补齐）的重算基准，
   * 避免「原成活株数 + 累计实际补植株数」重复叠加。
   */
  baseAliveCount: number | null;
  /** 计划补植日期 YYYY-MM-DD */
  planDate: string;
  /** 补植树种 */
  species: SeedlingSpecies;
  /** 补植状态 */
  state: ReplantState;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑补植计划的表单草稿 */
export interface ReplantDraft {
  plotId: string;
  missingCount: number;
  actualCount?: number | null;
  planDate: string;
  species: SeedlingSpecies;
  state: ReplantState;
}

/** 计划数与实际补植株数的差额（计划 − 实际）；待补植阶段返回 null */
export function replantGap(row: Pick<Replant, 'missingCount' | 'actualCount'>): number | null {
  return row.actualCount === null ? null : row.missingCount - row.actualCount;
}

/** 状态徽标配色（与页面 Tag 保持一致） */
export function replantStateColor(state: ReplantState): string {
  switch (state) {
    case '待补植':
      return 'orange';
    case '部分补植':
      return 'volcano';
    case '已补植':
      return 'blue';
    case '已复核':
      return 'green';
  }
}
