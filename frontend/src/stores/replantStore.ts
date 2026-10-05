/**
 * 补植计划状态管理（Zustand）
 * 维护补植计划的行内草稿、复核状态与批量选中项；
 * 状态推进与「补植完成回写地块缺株数」也在这里统一收口。
 */
import { create } from 'zustand';
import type { Replant, ReplantDraft, ReplantState } from '../types/replant';
import {
  advanceReplantState,
  db,
  exportSnapshot,
  importSnapshot,
  initDatabase,
  putReplant,
  removeReplant,
  resetDatabase,
  type DatabaseSnapshot,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';
import { usePlotStore } from './plotStore';

/** 补植计划筛选条件 */
export interface ReplantFilters {
  plotId: string | 'all';
  state: ReplantState | 'all';
  keyword: string;
}

export interface ReplantStoreState {
  filters: ReplantFilters;
  /** 每行的行内编辑草稿，key = replant id */
  drafts: Record<string, Partial<ReplantDraft>>;
  /** 当前复核选中的状态（用于批量推进） */
  reviewState: ReplantState | 'all';
  selectedIds: string[];
  lastMessage: string;
  revision: number;
  init: () => Promise<void>;
  setFilters: (patch: Partial<ReplantFilters>) => void;
  resetFilters: () => void;
  setDraft: (replantId: string, patch: Partial<ReplantDraft>) => void;
  clearDraft: (replantId: string) => void;
  hasDraft: (replantId: string) => boolean;
  saveDraft: (replantId: string) => Promise<void>;
  createReplant: (draft: ReplantDraft) => Promise<Replant>;
  deleteReplant: (replantId: string) => Promise<void>;
  /**
   * 推进到下一状态。
   * 进入「部分补植 / 已补植」时需带上本次实际补植株数（默认计划数/剩余计划数），
   * 由回写逻辑扣减地块缺株数并重算成活率。
   */
  advance: (replantId: string, actualCount?: number) => Promise<ReplantState | null>;
  setState: (replantId: string, state: ReplantState, actualCount?: number) => Promise<void>;
  batchAdvance: () => Promise<number>;
  setSelectedIds: (ids: string[]) => void;
  setReviewState: (state: ReplantState | 'all') => void;
  exportAll: () => Promise<DatabaseSnapshot>;
  importAll: (snapshot: DatabaseSnapshot) => Promise<void>;
  resetAll: () => Promise<void>;
}

const EMPTY_FILTERS: ReplantFilters = { plotId: 'all', state: 'all', keyword: '' };

export const useReplantStore = create<ReplantStoreState>((set, get) => ({
  filters: { ...EMPTY_FILTERS },
  drafts: {},
  reviewState: 'all',
  selectedIds: [],
  lastMessage: '',
  revision: 0,

  async init() {
    await initDatabase();
    set({ revision: get().revision + 1 });
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: { ...EMPTY_FILTERS }, selectedIds: [] });
  },

  setDraft(replantId, patch) {
    set({ drafts: { ...get().drafts, [replantId]: { ...get().drafts[replantId], ...patch } } });
  },

  clearDraft(replantId) {
    const next = { ...get().drafts };
    delete next[replantId];
    set({ drafts: next });
  },

  hasDraft(replantId) {
    return get().drafts[replantId] !== undefined;
  },

  async saveDraft(replantId) {
    const draft = get().drafts[replantId];
    if (draft === undefined) return;
    const existing = await db.replants.get(replantId);
    if (!existing) return;
    await putReplant({ ...existing, ...draft } as Replant);
    get().clearDraft(replantId);
    set({ revision: get().revision + 1, lastMessage: '草稿已保存到补植计划' });
  },

  async createReplant(draft) {
    const stamp = nowIso();
    const row: Replant = {
      id: uuid('replant'),
      plotId: draft.plotId,
      missingCount: draft.missingCount,
      actualCount: draft.state === '待补植' ? null : draft.actualCount ?? draft.missingCount,
      baseAliveCount: null,
      planDate: draft.planDate,
      species: draft.species,
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 2,
    };
    await putReplant(row);
    set({ revision: get().revision + 1 });
    return row;
  },

  async deleteReplant(replantId) {
    await removeReplant(replantId);
    get().clearDraft(replantId);
    set({
      selectedIds: get().selectedIds.filter((id) => id !== replantId),
      revision: get().revision + 1,
    });
  },

  async advance(replantId, actualCount) {
    const existing = await db.replants.get(replantId);
    if (!existing) return null;
    if (existing.state === '已复核') return null;

    // 已补植 → 已复核，无需再登记实际数
    if (existing.state === '已补植') {
      const next: ReplantState = '已复核';
      await advanceReplantState(replantId, next);
      set({ revision: get().revision + 1, lastMessage: `状态已推进为「${next}」` });
      return next;
    }

    // 待补植 / 部分补植：登记本次实际补植株数。
    // 批量推进等未显式传入的场景，默认按剩余计划数（无剩余时按计划数）补齐。
    const done = existing.actualCount ?? 0;
    const remaining = Math.max(0, existing.missingCount - done);
    let registered = actualCount;
    if (registered === undefined) registered = remaining > 0 ? remaining : existing.missingCount;
    if (!(registered > 0)) {
      throw new Error('实际补植株数需大于 0；一株未补时无需推进，保持「待补植」即可');
    }

    // 累计实际数达到计划数才视为补植完成，否则（少补）标成部分补植并留在待办
    const accumulated = done + registered;
    const next: ReplantState = accumulated >= existing.missingCount ? '已补植' : '部分补植';

    await advanceReplantState(replantId, next, registered);
    await usePlotStore.getState().refreshCounts();
    set({
      revision: get().revision + 1,
      lastMessage:
        next === '部分补植'
          ? `已登记实际补植 ${registered} 株（计划 ${existing.missingCount} 株），标记为部分补植并留在待办`
          : `已登记累计实际补植 ${accumulated} 株，地块缺株数与成活率已回写`,
    });
    return next;
  },

  async setState(replantId, state, actualCount) {
    await advanceReplantState(replantId, state, actualCount);
    set({ revision: get().revision + 1 });
  },

  async batchAdvance() {
    const ids = get().selectedIds;
    let count = 0;
    // 逐条推进：未显式登记实际数时默认按（剩余）计划数补齐；单条失败不影响其余计划
    const failures: string[] = [];
    for (const id of ids) {
      try {
        const next = await get().advance(id);
        if (next !== null) count += 1;
      } catch {
        failures.push(id);
      }
    }
    set({
      selectedIds: [],
      lastMessage:
        failures.length === 0
          ? `已批量推进 ${count} 条补植计划（实际数默认取计划数）`
          : `已推进 ${count} 条，${failures.length} 条失败（实际补植株数需大于 0）`,
    });
    return count;
  },

  setSelectedIds(ids) {
    set({ selectedIds: [...ids] });
  },

  setReviewState(state) {
    set({ reviewState: state });
  },

  async exportAll() {
    return exportSnapshot();
  },

  async importAll(snapshot) {
    await importSnapshot(snapshot);
    set({ revision: get().revision + 1 });
  },

  async resetAll() {
    await resetDatabase();
    set({ drafts: {}, selectedIds: [], revision: get().revision + 1 });
  },
}));
