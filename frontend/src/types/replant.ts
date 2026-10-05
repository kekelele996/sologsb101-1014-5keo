/**
 * 补植计划（Replant）
 * 验收成活率偏低时生成的补植任务，完成后按实际补植株数回写地块缺株数并重算成活率。
 */
import type { SeedlingSpecies } from './seedling';

/** 补植状态：待补植 / 部分补植 / 已补植 / 已复核 */
export type ReplantState = '待补植' | '部分补植' | '已补植' | '已复核';

export const REPLANT_STATE_OPTIONS: ReplantState[] = ['待补植', '部分补植', '已补植', '已复核'];

/** 补植状态流转顺序，用于展示排序；实际推进时「待补植 / 部分补植」需登记实际补植株数 */
export const REPLANT_STATE_FLOW: ReplantState[] = ['待补植', '部分补植', '已补植', '已复核'];

export interface Replant {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 计划缺株数（株）——建计划时的计划补植株数 */
  missingCount: number;
  /** 实际补植株数（株）——班组推进时登记，多补不少补均如实记录；累计已回写 */
  actualCount: number;
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
  planDate: string;
  species: SeedlingSpecies;
  state: ReplantState;
}
