/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbmangrove
 * - 含数据结构版本号与 v1 → v2 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { Seedling } from '../types/seedling';
import type { Planting } from '../types/planting';
import type { Survey } from '../types/survey';
import type { Replant, ReplantState } from '../types/replant';
import { calcSurvivalRate, rateLevel } from './rate';
import { nowIso, today } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbmangrove';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class MangroveDatabase extends Dexie {
  plots!: Table<Plot, string>;
  seedlings!: Table<Seedling, string>;
  plantings!: Table<Planting, string>;
  surveys!: Table<Survey, string>;
  replants!: Table<Replant, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt',
      seedlings: 'id, plotId, species, source, arrivalDate',
      plantings: 'id, plotId, seedlingId, plantDate',
      surveys: 'id, plotId, round, date',
      replants: 'id, plotId, planDate, state',
    });

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        // 复合索引 [plotId+round]：按地块 + 测次快速取验收记录
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('plots'),
          tx.table('seedlings'),
          tx.table('plantings'),
          tx.table('surveys'),
          tx.table('replants'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：地块补齐「缺株数 / 最近补植日期」回写字段
        await tx.table('plots').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.missingCount !== 'number') row.missingCount = 0;
          if (typeof row.lastReplantDate !== 'string') row.lastReplantDate = '';
        });
        // 迁移 3：验收记录补齐成活率等级字段
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          const rate = typeof row.survivalRate === 'number' ? row.survivalRate : 0;
          if (typeof row.grade !== 'string') row.grade = rateLevel(rate);
          if (typeof row.gradeManual !== 'boolean') row.gradeManual = false;
        });
      });

    // ---------- v3：补植计划登记「实际补植株数」，新增「部分补植」状态 ----------
    // 索引结构与 v2 一致，仅补齐行字段（Dexie 非索引字段无需在 stores() 中声明）。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        plots: 'id, name, tideZone, substrate, restoreMode, state, createdAt, updatedAt',
        seedlings: 'id, plotId, species, source, arrivalDate, quantity',
        plantings: 'id, plotId, seedlingId, plantDate, spacingM',
        surveys: 'id, plotId, [plotId+round], date, grade',
        replants: 'id, plotId, planDate, state, species',
      })
      .upgrade(async (tx) => {
        await tx.table('replants').toCollection().modify((row: Record<string, unknown>) => {
          // 历史数据：待补植尚无实际数；其余状态按「默认填计划数」回填
          if (typeof row.actualCount !== 'number') {
            row.actualCount = row.state === '待补植' ? null : typeof row.missingCount === 'number' ? row.missingCount : 0;
          }
          if (typeof row.baseAliveCount !== 'number') row.baseAliveCount = null;
        });
      });
  }
}

export const db = new MangroveDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.plots.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 地块 -------------------------------- */

export async function listPlots(): Promise<Plot[]> {
  const rows = await db.plots.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getPlot(id: string): Promise<Plot | undefined> {
  return db.plots.get(id);
}

export async function putPlot(row: Plot): Promise<void> {
  await db.plots.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function patchPlot(id: string, patch: Partial<Plot>): Promise<void> {
  await db.plots.update(id, { ...patch, updatedAt: nowIso() });
}

/** 删除地块并级联清理其下苗木批次、栽植、验收与补植计划 */
export async function removePlot(id: string): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await db.seedlings.where('plotId').equals(id).delete();
    await db.plantings.where('plotId').equals(id).delete();
    await db.surveys.where('plotId').equals(id).delete();
    await db.replants.where('plotId').equals(id).delete();
    await db.plots.delete(id);
  });
}

/* ------------------------------ 苗木批次 ------------------------------ */

export async function listSeedlings(): Promise<Seedling[]> {
  const rows = await db.seedlings.toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function listSeedlingsByPlot(plotId: string): Promise<Seedling[]> {
  const rows = await db.seedlings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate));
}

export async function putSeedling(row: Seedling): Promise<void> {
  await db.seedlings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSeedling(id: string): Promise<void> {
  await db.transaction('rw', db.seedlings, db.plantings, async () => {
    // 该批次已被栽植记录引用时一并清理，避免出现悬空引用
    await db.plantings.where('seedlingId').equals(id).delete();
    await db.seedlings.delete(id);
  });
}

/* ------------------------------- 栽植 ------------------------------- */

export async function listPlantings(): Promise<Planting[]> {
  const rows = await db.plantings.toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function listPlantingsByPlot(plotId: string): Promise<Planting[]> {
  const rows = await db.plantings.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => b.plantDate.localeCompare(a.plantDate));
}

export async function putPlanting(row: Planting): Promise<void> {
  await db.plantings.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removePlanting(id: string): Promise<void> {
  await db.plantings.delete(id);
}

/* ------------------------------- 验收 ------------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray();
  return rows.sort((a, b) => a.plotId.localeCompare(b.plotId) || a.round - b.round);
}

export async function listSurveysByPlot(plotId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.round - b.round);
}

export async function putSurvey(row: Survey): Promise<void> {
  const grade = row.gradeManual ? row.grade : rateLevel(row.survivalRate);
  await db.surveys.put({ ...row, grade, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 批量调整成活率等级（人工复核覆盖） */
export async function patchSurveyGrades(ids: string[], grade: Survey['grade']): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.surveys.bulkGet(ids);
  const stamp = nowIso();
  const next = rows
    .filter((row): row is Survey => row !== undefined)
    .map((row) => ({ ...row, grade, gradeManual: true, updatedAt: stamp }));
  if (next.length > 0) await db.surveys.bulkPut(next);
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id);
}

/* ------------------------------ 补植计划 ------------------------------ */

export async function listReplants(): Promise<Replant[]> {
  const rows = await db.replants.toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function listReplantsByPlot(plotId: string): Promise<Replant[]> {
  const rows = await db.replants.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.planDate.localeCompare(b.planDate));
}

export async function putReplant(row: Replant): Promise<void> {
  await db.replants.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeReplant(id: string): Promise<void> {
  await db.replants.delete(id);
}

/**
 * 补植完成回写（登记实际补植株数时触发）：
 * 1）缺株数按「计划数 − 实际数」回写，减到零为止（多补也不会写成负数）；
 * 2）写入最近补植日期；
 * 3）最新测次按「原成活株数 + 累计实际补植株数」重算成活率，成活株数以栽植总株数封顶。
 *
 * 实际数少于计划数时落到「部分补植」：只回写差额，且该计划留在待办，
 * 可再次推进（第二次的 actualCount 为追加补植株数）。
 */
export async function applyReplantCompletion(
  replantId: string,
  next: ReplantState,
  actualCount: number,
): Promise<void> {
  await db.transaction('rw', db.plots, db.replants, db.surveys, db.plantings, async () => {
    const replant = await db.replants.get(replantId);
    if (!replant) return;
    const plot = await db.plots.get(replant.plotId);
    if (!plot) return;

    // 部分补植 → 补齐时，入参为本次追加株数，累计到已登记的实际数上
    const previouslyApplied = replant.actualCount ?? 0;
    const accumulated = Math.max(0, previouslyApplied + Math.max(0, actualCount));
    // 缺株数：首次推进即「计划数 − 实际数」，减到零为止；
    // 部分补植二次推进 / 多条计划并存时，按本次新增实际数增量扣减，避免冲掉其它缺口
    const nextMissing = Math.max(0, plot.missingCount - (accumulated - previouslyApplied));

    await db.replants.update(replant.id, {
      state: next,
      actualCount: accumulated,
      updatedAt: nowIso(),
    });

    await db.plots.update(plot.id, {
      missingCount: nextMissing,
      lastReplantDate: today(),
      updatedAt: nowIso(),
    });

    const plantings = await db.plantings.where('plotId').equals(plot.id).toArray();
    const total = plantings.reduce((acc, item) => acc + item.count, 0);
    const surveys = await db.surveys.where('plotId').equals(plot.id).toArray();
    if (surveys.length === 0) return;
    const latest = surveys.reduce((acc, item) => (item.round > acc.round ? item : acc));
    // 以首次回写时的原成活株数为基准（快照），后续追加补植只加一次，避免重复叠加
    const baseAlive = replant.baseAliveCount ?? latest.aliveCount;
    const aliveAfter = total > 0 ? Math.min(total, baseAlive + accumulated) : baseAlive + accumulated;
    const rate = total > 0 ? calcSurvivalRate(aliveAfter, total) : latest.survivalRate;
    await Promise.all([
      db.replants.update(replant.id, { baseAliveCount: baseAlive }),
      db.surveys.update(latest.id, {
        aliveCount: aliveAfter,
        survivalRate: rate,
        grade: latest.gradeManual ? latest.grade : rateLevel(rate),
        updatedAt: nowIso(),
      }),
    ]);
  });
}

/**
 * 推进补植状态（待补植 → 部分补植 → 已补植 → 已复核）：
 * 进入「部分补植 / 已补植」时必须带上本次登记的实际补植株数并触发回写。
 */
export async function advanceReplantState(
  replantId: string,
  next: ReplantState,
  actualCount?: number,
): Promise<void> {
  if (next === '部分补植' || next === '已补植') {
    await applyReplantCompletion(replantId, next, Math.max(0, Math.floor(actualCount ?? 0)));
    return;
  }
  await db.replants.update(replantId, { state: next, updatedAt: nowIso() });
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plots: Plot[];
  seedlings: Seedling[];
  plantings: Planting[];
  surveys: Survey[];
  replants: Replant[];
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plots, seedlings, plantings, surveys, replants] = await Promise.all([
    db.plots.toArray(),
    db.seedlings.toArray(),
    db.plantings.toArray(),
    db.surveys.toArray(),
    db.replants.toArray(),
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plots,
    seedlings,
    plantings,
    surveys,
    replants,
  };
}

/** 用快照覆盖整库（导入存档）；兼容缺少 v3 字段的旧版存档 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
    ]);
    await db.plots.bulkPut(snapshot.plots.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.seedlings.bulkPut(snapshot.seedlings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.plantings.bulkPut(snapshot.plantings.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })));
    // 旧版存档无实际补植株数：按「默认填计划数」回填（待补植仍为 null）
    await db.replants.bulkPut(
      snapshot.replants.map((row) => ({
        ...row,
        actualCount:
          typeof row.actualCount === 'number' ? row.actualCount : row.state === '待补植' ? null : row.missingCount,
        baseAliveCount: typeof row.baseAliveCount === 'number' ? row.baseAliveCount : null,
        revision: ROW_REVISION,
      })),
    );
  });
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', db.plots, db.seedlings, db.plantings, db.surveys, db.replants, async () => {
    await Promise.all([
      db.plots.clear(),
      db.seedlings.clear(),
      db.plantings.clear(),
      db.surveys.clear(),
      db.replants.clear(),
    ]);
  });
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [plots, seedlings, plantings, surveys, replants] = await Promise.all([
    db.plots.count(),
    db.seedlings.count(),
    db.plantings.count(),
    db.surveys.count(),
    db.replants.count(),
  ]);
  return { plots, seedlings, plantings, surveys, replants };
}
