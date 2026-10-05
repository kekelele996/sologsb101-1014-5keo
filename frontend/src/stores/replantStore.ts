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
  normalizeReplant,
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
   * 「待补植 / 部分补植 → 已补植 / 部分补植」需登记本次实际补植株数（默认填计划数 / 差额），
   * 回写地块缺株数并重算成活率；「已补植 → 已复核」无需登记实际数。
   */
  advance: (replantId: string, actualCount?: number) => Promise<ReplantState | null>;
  setState: (replantId: string, state: ReplantState) => Promise<void>;
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
      actualCount: 0,
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
    const normalized = normalizeReplant(existing);

    // 已复核为终态，不可继续推进
    if (normalized.state === '已复核') return null;

    // 已补植 → 已复核：复核动作，无需登记实际补植株数
    if (normalized.state === '已补植') {
      await advanceReplantState(replantId, '已复核');
      await usePlotStore.getState().refreshCounts();
      set({ revision: get().revision + 1, lastMessage: '状态已推进为「已复核」' });
      return '已复核';
    }

    // 待补植 / 部分补植 → 需登记本次实际补植株数（默认填计划数 / 差额）
    const remaining = Math.max(0, normalized.missingCount - normalized.actualCount);
    const thisActual = Math.max(0, Math.round(actualCount ?? remaining));
    const newActual = normalized.actualCount + thisActual;
    const next: ReplantState = newActual >= normalized.missingCount ? '已补植' : '部分补植';

    await advanceReplantState(replantId, next, thisActual);
    await usePlotStore.getState().refreshCounts();
    set({
      revision: get().revision + 1,
      lastMessage:
        next === '已补植'
          ? `已按实际 ${thisActual} 株补植完成，地块缺株数与成活率已回写`
          : `本次补植 ${thisActual} 株，仍差 ${normalized.missingCount - newActual} 株，已标记为部分补植并留在待办`,
    });
    return next;
  },

  async setState(replantId, state) {
    const existing = await db.replants.get(replantId);
    if (existing !== undefined && (state === '已补植' || state === '部分补植')) {
      // 直接改状态时，按「差额」作为本次实际补植株数回写
      const normalized = normalizeReplant(existing);
      const remaining = Math.max(0, normalized.missingCount - normalized.actualCount);
      await advanceReplantState(replantId, state, remaining);
    } else {
      await advanceReplantState(replantId, state);
    }
    set({ revision: get().revision + 1 });
  },

  async batchAdvance() {
    const ids = get().selectedIds;
    let count = 0;
    for (const id of ids) {
      const next = await get().advance(id);
      if (next !== null) count += 1;
    }
    set({ selectedIds: [], lastMessage: `已批量推进 ${count} 条补植计划` });
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
