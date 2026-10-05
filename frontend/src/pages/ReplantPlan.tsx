/**
 * /replants 补植计划与结构版本
 * 补植计划增删改、状态流转（待补植 → 部分补植 → 已补植 → 已复核）、实际补植株数登记、
 * 草稿行内编辑、JSON 导入导出。推进时由班组登记实际数（默认计划数），少补自动标「部分补植」并留在待办。
 * 消费模型：Replant、Survey、全部模型；复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ClearOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  SaveOutlined,
  SyncOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { useReplantStore } from '../stores/replantStore';
import { DB_NAME, DB_SCHEMA_VERSION, db } from '../utils/db';
import {
  isReplantPending,
  replantGap,
  replantStateColor,
  REPLANT_STATE_OPTIONS,
  type Replant,
  type ReplantDraft,
  type ReplantState,
} from '../types/replant';
import { SEEDLING_SPECIES_OPTIONS, type SeedlingSpecies } from '../types/seedling';
import { exportSnapshotJson, exportSummaryCsvFile, parseSnapshot } from '../utils/export';
import { percentText } from '../utils/rate';

interface ReplantFormValues {
  plotId: string;
  missingCount: number;
  actualCount: number | null;
  planDate: Dayjs;
  species: SeedlingSpecies;
  state: ReplantState;
}

/** 推进状态时的实际补植株数登记弹窗 */
interface ActualModalState {
  row: Replant;
  /** 本次需要登记的株数（部分补植再次推进时为追加株数） */
  value: number;
}

export default function ReplantPlan() {
  const { message, modal } = App.useApp();
  const plots = usePlotStore((state) => state.plots);
  const seedlings = usePlotStore((state) => state.seedlings);
  const plantings = usePlotStore((state) => state.plantings);
  const surveys = usePlotStore((state) => state.surveys);
  const statOf = usePlotStore((state) => state.statOf);
  const ready = usePlotStore((state) => state.ready);

  const filters = useReplantStore((state) => state.filters);
  const setFilters = useReplantStore((state) => state.setFilters);
  const resetFilters = useReplantStore((state) => state.resetFilters);
  const drafts = useReplantStore((state) => state.drafts);
  const hasDraft = useReplantStore((state) => state.hasDraft);
  const setDraft = useReplantStore((state) => state.setDraft);
  const clearDraft = useReplantStore((state) => state.clearDraft);
  const saveDraft = useReplantStore((state) => state.saveDraft);
  const createReplant = useReplantStore((state) => state.createReplant);
  const deleteReplant = useReplantStore((state) => state.deleteReplant);
  const advance = useReplantStore((state) => state.advance);
  const batchAdvance = useReplantStore((state) => state.batchAdvance);
  const selectedIds = useReplantStore((state) => state.selectedIds);
  const setSelectedIds = useReplantStore((state) => state.setSelectedIds);
  const exportAll = useReplantStore((state) => state.exportAll);
  const importAll = useReplantStore((state) => state.importAll);
  const resetAll = useReplantStore((state) => state.resetAll);
  const lastMessage = useReplantStore((state) => state.lastMessage);

  const { rows, loading, update } = useIdbTable<Replant>(db.replants, { sortByUpdatedAt: false });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Replant | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actualModal, setActualModal] = useState<ActualModalState | null>(null);
  const [actualSaving, setActualSaving] = useState(false);
  const [actualForm] = Form.useForm<{ actualCount: number }>();
  const [form] = Form.useForm<ReplantFormValues>();
  const formState = Form.useWatch('state', form) as ReplantState | undefined;

  const plotName = (plotId: string): string => plots.find((item) => item.id === plotId)?.name ?? '（地块已删除）';

  const filtered = useMemo(() => {
    const key = filters.keyword.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (filters.plotId !== 'all' && row.plotId !== filters.plotId) return false;
        if (filters.state !== 'all' && row.state !== filters.state) return false;
        if (key === '') return true;
        return plotName(row.plotId).toLowerCase().includes(key) || row.species.toLowerCase().includes(key);
      })
      .sort((a, b) => a.planDate.localeCompare(b.planDate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters, plots]);

  const stats = useMemo(() => {
    const missing = rows.reduce((acc, row) => acc + row.missingCount, 0);
    const actual = rows.reduce((acc, row) => acc + (row.actualCount ?? 0), 0);
    const shortfall = rows
      .filter((row) => isReplantPending(row.state))
      .reduce((acc, row) => acc + Math.max(0, replantGap(row) ?? row.missingCount), 0);
    const reviewed = rows.filter((row) => row.state === '已复核').length;
    const pending = rows.filter((row) => isReplantPending(row.state)).length;
    return {
      missing,
      actual,
      shortfall,
      pending,
      reviewed,
      reviewPct: rows.length === 0 ? 0 : Math.round((reviewed / rows.length) * 1000) / 10,
    };
  }, [rows]);

  const openCreate = (): void => {
    setEditing(null);
    const plotId = filters.plotId !== 'all' ? filters.plotId : plots.length > 0 ? plots[0].id : '';
    const stat = statOf(plotId);
    form.setFieldsValue({
      plotId,
      missingCount: stat.suggestReplant > 0 ? stat.suggestReplant : 100,
      actualCount: null,
      planDate: dayjs().add(15, 'day'),
      species: seedlings.find((row) => row.plotId === plotId)?.species ?? '秋茄',
      state: '待补植',
    });
    setOpen(true);
  };

  const openEdit = (row: Replant): void => {
    setEditing(row);
    form.setFieldsValue({
      plotId: row.plotId,
      missingCount: row.missingCount,
      actualCount: row.actualCount,
      planDate: dayjs(row.planDate),
      species: row.species,
      state: row.state,
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload: ReplantDraft = {
        plotId: values.plotId,
        missingCount: values.missingCount,
        actualCount: values.state === '待补植' ? null : values.actualCount ?? values.missingCount,
        planDate: values.planDate.format('YYYY-MM-DD'),
        species: values.species,
        state: values.state,
      };
      if (editing === null) {
        await createReplant(payload);
        message.success(`已创建补植计划：缺株 ${payload.missingCount} 株`);
      } else {
        await update(editing.id, payload);
        message.success('补植计划已更新');
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAdvance = (row: Replant): void => {
    if (row.state === '已复核') {
      message.info('该计划已处于最终状态（已复核）');
      return;
    }
    // 已补植 → 已复核无需再登记实际数
    if (row.state === '已补植') {
      void (async () => {
        const next = await advance(row.id);
        if (next !== null) message.success(`状态已推进为「${next}」`);
      })();
      return;
    }
    // 待补植默认计划数；部分补植再推进时默认补齐剩余计划数
    const done = row.actualCount ?? 0;
    const remaining = Math.max(0, row.missingCount - done);
    const defaultValue = remaining > 0 ? remaining : row.missingCount;
    actualForm.resetFields();
    actualForm.setFieldsValue({ actualCount: defaultValue });
    setActualModal({ row, value: defaultValue });
  };

  const handleConfirmActual = async (): Promise<void> => {
    if (actualModal === null) return;
    try {
      const values = await actualForm.validateFields();
      setActualSaving(true);
      const next = await advance(actualModal.row.id, values.actualCount);
      if (next === null) {
        message.info('该计划已处于最终状态（已复核）');
      } else if (next === '部分补植') {
        message.success(`实际补植 ${values.actualCount} 株，少于计划数，已标记为部分补植并留在待办`);
      } else if (next === '已补植') {
        message.success(
          actualModal.row.state === '部分补植'
            ? `本次补植 ${values.actualCount} 株，已补齐剩余缺株，缺株数与成活率已回写`
            : `已按实际补植 ${values.actualCount} 株回写缺株数并重算成活率`,
        );
      } else {
        message.success(`状态已推进为「${next}」`);
      }
      setActualModal(null);
    } catch (error) {
      if (error instanceof Error && error.message !== 'validation') message.error(error.message);
    } finally {
      setActualSaving(false);
    }
  };

  const handleExport = async (): Promise<void> => {
    const snapshot = await exportAll();
    const filename = exportSnapshotJson(snapshot);
    message.success(`已导出整库存档 ${filename}`);
  };

  const handleExportCsv = (): void => {
    const filename = exportSummaryCsvFile(plots, seedlings, plantings, surveys, rows);
    message.success(`已导出成活率汇总 ${filename}`);
  };

  const handleImportFile = async (file: File): Promise<void> => {
    const text = await file.text();
    const result = parseSnapshot(text);
    if (!result.ok || result.snapshot === null) {
      message.error(result.message);
      return;
    }
    await importAll(result.snapshot);
    await usePlotStore.getState().refreshCounts();
    message.success(`导入成功：${result.message}`);
  };

  const handleReset = (): void => {
    modal.confirm({
      title: '确认重置本地数据？',
      content: '全部地块、苗木批次、栽植记录、验收记录与补植计划都会被清空，并重新灌入演示数据。',
      okText: '确认重置',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await resetAll();
        await usePlotStore.getState().refreshCounts();
        message.success('已重置为演示数据');
      },
    });
  };

  const columns: ColumnsType<Replant> = [
    {
      title: '地块',
      key: 'plot',
      width: 200,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{plotName(record.plotId)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            最新成活率{' '}
            {statOf(record.plotId).surveyCount > 0 ? percentText(statOf(record.plotId).latestRate) : '未验收'} ·
            栽植 {statOf(record.plotId).plantTotal.toLocaleString('zh-CN')} 株
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '计划数（株）',
      key: 'missingCount',
      width: 150,
      align: 'right',
      render: (_value, record) => {
        const draft = drafts[record.id];
        if (draft === undefined) return record.missingCount.toLocaleString('zh-CN');
        return (
          <InputNumber
            min={0}
            max={200000}
            step={10}
            size="small"
            style={{ width: 120 }}
            value={draft.missingCount ?? record.missingCount}
            onChange={(value) => setDraft(record.id, { missingCount: value ?? 0 })}
          />
        );
      },
    },
    {
      title: '实际补植（株）',
      key: 'actualCount',
      width: 140,
      align: 'right',
      render: (_value, record) =>
        record.actualCount === null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          record.actualCount.toLocaleString('zh-CN')
        ),
    },
    {
      title: '差额（计划−实际）',
      key: 'gap',
      width: 150,
      align: 'right',
      render: (_value, record) => {
        const gap = replantGap(record);
        if (gap === null) return <Typography.Text type="secondary">—</Typography.Text>;
        if (gap === 0) return <Tag color="green">已补齐</Tag>;
        return (
          <Tooltip title={gap > 0 ? '实际少补，仍缺对应株数，计划留在待办' : '实际多补，已按栽植总株数封顶，缺株数记 0'}>
            <Tag color={gap > 0 ? 'volcano' : 'gold'} style={{ marginInlineEnd: 0 }}>
              {gap > 0 ? '少补' : '多补'} {Math.abs(gap).toLocaleString('zh-CN')}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '计划日期',
      key: 'planDate',
      width: 180,
      render: (_value, record) => {
        const draft = drafts[record.id];
        if (draft === undefined) return record.planDate;
        return (
          <DatePicker
            size="small"
            value={dayjs(draft.planDate ?? record.planDate)}
            onChange={(value) => {
              if (value !== null) setDraft(record.id, { planDate: value.format('YYYY-MM-DD') });
            }}
          />
        );
      },
    },
    {
      title: '补植树种',
      key: 'species',
      width: 150,
      render: (_value, record) => {
        const draft = drafts[record.id];
        if (draft === undefined) return <Tag color="green">{record.species}</Tag>;
        return (
          <Select
            size="small"
            style={{ width: 120 }}
            value={draft.species ?? record.species}
            onChange={(value: SeedlingSpecies) => setDraft(record.id, { species: value })}
            options={SEEDLING_SPECIES_OPTIONS.map((value) => ({ value, label: value }))}
          />
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      width: 120,
      render: (value: ReplantState) => (
        <Tooltip title={value === '部分补植' ? '实际少补，计划留在待办，可继续推进补齐剩余缺株' : undefined}>
          <Tag color={replantStateColor(value)} style={{ marginInlineEnd: 0 }}>
            {value}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: '草稿',
      key: 'draft',
      width: 150,
      render: (_value, record) =>
        hasDraft(record.id) ? (
          <Space size={4}>
            <Button
              size="small"
              type="primary"
              icon={<SaveOutlined />}
              onClick={() => void saveDraft(record.id)}
            >
              保存
            </Button>
            <Button size="small" onClick={() => clearDraft(record.id)}>
              放弃
            </Button>
          </Space>
        ) : (
          <Button
            size="small"
            onClick={() =>
              setDraft(record.id, {
                missingCount: record.missingCount,
                planDate: record.planDate,
                species: record.species,
                state: record.state,
              })
            }          >
            改草稿
          </Button>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 250,
      fixed: 'right',
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button
            size="small"
            type="link"
            icon={<SyncOutlined />}
            disabled={record.state === '已复核'}
            onClick={() => handleAdvance(record)}
          >
            {record.state === '部分补植' ? '继续补植' : '推进状态'}
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该补植计划？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await deleteReplant(record.id);
              message.success('补植计划已删除');
            }}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="补植计划" value={rows.length} suffix="条" tone="primary" />
        <StatBadge
          label="待办补植"
          value={stats.pending}
          suffix="条"
          tone={stats.pending > 0 ? 'warning' : 'default'}
          hint="状态为「待补植」或「部分补植」的计划，少补的计划会留在待办继续跟进"
        />
        <StatBadge label="计划补植合计" value={stats.missing.toLocaleString('zh-CN')} suffix="株" tone="danger" />
        <StatBadge label="实际补植合计" value={stats.actual.toLocaleString('zh-CN')} suffix="株" tone="info" />
        <StatBadge
          label="待补缺口"
          value={stats.shortfall.toLocaleString('zh-CN')}
          suffix="株"
          tone={stats.shortfall > 0 ? 'warning' : 'default'}
          size="small"
          hint="待办计划中计划数减实际数的尚缺株数合计"
        />
        <StatBadge
          label="复核完成率"
          value={percentText(stats.reviewPct)}
          percent={stats.reviewPct}
          tone="success"
          hint="状态为「已复核」的计划占比"
        />
        <StatBadge
          label="数据结构版本"
          value={`v${DB_SCHEMA_VERSION}`}
          suffix={`· ${DB_NAME}`}
          tone="info"
          hint="IndexedDB 库名与结构版本号；升级时会按 version().stores() 自动迁移"
        />
      </div>

      {lastMessage !== '' ? (
        <Alert type="info" showIcon style={{ marginBottom: 14 }} message={lastMessage} />
      ) : null}

      <Card
        title="补植计划与结构版本"
        extra={
          <Space wrap>
            <Button icon={<DownloadOutlined />} onClick={() => void handleExport()}>
              导出 JSON 存档
            </Button>
            <Button icon={<DownloadOutlined />} onClick={handleExportCsv}>
              导出 CSV 汇总
            </Button>
            <Upload
              accept=".json"
              showUploadList={false}
              beforeUpload={(file) => {
                void handleImportFile(file as unknown as File);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />}>导入 JSON 存档</Button>
            </Upload>
            <Button danger icon={<ClearOutlined />} onClick={handleReset}>
              重置演示数据
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={plots.length === 0}>
              新建补植计划
            </Button>
          </Space>
        }
      >
        <FilterBar
          keyword={filters.keyword}
          onKeywordChange={(value: string) => setFilters({ keyword: value })}
          fields={[
            { key: 'plotId', label: '地块', options: plots.map((plot) => plot.id), optionLabels: Object.fromEntries(plots.map((plot) => [plot.id, plot.name])) },
            { key: 'state', label: '状态', options: [...REPLANT_STATE_OPTIONS] },
          ]}
          values={{ plotId: filters.plotId, state: filters.state }}
          onChange={(key: string, value: string) => {
            if (key === 'plotId') setFilters({ plotId: value });
            if (key === 'state') setFilters({ state: value as ReplantState | 'all' });
          }}
          onReset={resetFilters}
          resultText={`命中 ${filtered.length} / ${rows.length} 条`}
          extra={
            <>
              <Tag color={selectedIds.length > 0 ? 'purple' : 'default'}>已选 {selectedIds.length} 条</Tag>
              <Button
                icon={<SyncOutlined />}
                disabled={selectedIds.length === 0}
                onClick={async () => {
                  const count = await batchAdvance();
                  message.success(`已批量推进 ${count} 条补植计划`);
                }}
              >
                批量推进状态
              </Button>
            </>
          }
        />

        {rows.length === 0 && !loading ? (
          <EmptyPanel
            title="还没有补植计划"
            description="验收成活率偏低时可一键生成补植计划；也可以在这里手动新建，并按「待补植 → 部分补植 → 已补植 → 已复核」推进，推进时登记班组实际补植株数（默认计划数），少补会标成部分补植并留在待办。"
            actionText="新建补植计划"
            onAction={openCreate}
          />
        ) : (
          <Table<Replant>
            rowKey="id"
            size="middle"
            loading={loading || !ready}
            columns={columns}
            dataSource={filtered}
            scroll={{ x: 1620 }}
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
            }}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{
              emptyText: <EmptyPanel title="没有符合筛选条件的补植计划" actionText="重置筛选" onAction={resetFilters} />,
            }}
          />
        )}
      </Card>

      <Modal
        title={editing === null ? '新建补植计划' : '编辑补植计划'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="plotId" label="地块" rules={[{ required: true, message: '请选择地块' }]}>
            <Select options={plots.map((plot) => ({ value: plot.id, label: plot.name }))} />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="missingCount"
              label="计划补植（株）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写计划补植株数' }]}
            >
              <InputNumber min={1} max={200000} step={10} style={{ width: '100%' }} />
            </Form.Item>
            {formState !== undefined && formState !== '待补植' ? (
              <Form.Item
                name="actualCount"
                label="实际补植（株）"
                style={{ flex: 1 }}
                rules={[{ required: true, message: '请填写实际补植株数' }]}
                extra="留档补录用，不在此处触发回写"
              >
                <InputNumber min={0} max={200000} step={10} style={{ width: '100%' }} placeholder="默认同计划数" />
              </Form.Item>
            ) : null}
            <Form.Item name="planDate" label="计划日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="species" label="补植树种" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={SEEDLING_SPECIES_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item name="state" label="状态" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={REPLANT_STATE_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            班组在列表中「推进状态」时登记实际补植株数（默认填计划数）：实际少于计划数会标成「部分补植」并留在待办；
            地块缺株数按计划数减实际数回写（减到零为止），并按原成活株数加实际补植株数重算最新测次成活率。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        title="登记实际补植株数"
        open={actualModal !== null}
        onCancel={() => setActualModal(null)}
        onOk={() => void handleConfirmActual()}
        confirmLoading={actualSaving}
        okText="确认推进"
        cancelText="取消"
        destroyOnClose
      >
        {actualModal !== null ? (
          <Form form={actualForm} layout="vertical">
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              {plotName(actualModal.row.plotId)} · {actualModal.row.species} · 计划补植{' '}
              {actualModal.row.missingCount.toLocaleString('zh-CN')} 株
              {actualModal.row.state === '部分补植' && actualModal.row.actualCount !== null ? (
                <>
                  ，已补 {actualModal.row.actualCount.toLocaleString('zh-CN')} 株，尚缺{' '}
                  {Math.max(0, actualModal.row.missingCount - actualModal.row.actualCount).toLocaleString('zh-CN')} 株
                </>
              ) : null}
            </Typography.Paragraph>
            <Form.Item
              name="actualCount"
              label={actualModal.row.state === '部分补植' ? '本次追加补植株数（株）' : '本次实际补植株数（株）'}
              rules={[
                { required: true, message: '请填写实际补植株数' },
                {
                  validator: (_rule, value: number | null | undefined) =>
                    typeof value === 'number' && value > 0
                      ? Promise.resolve()
                      : Promise.reject(new Error('实际补植株数需大于 0；一株未补时请保持待办')),
                },
              ]}
              extra="默认填计划数，可按现场实际少补或多补修改。少于计划数将标记为「部分补植」并留在待办。"
            >
              <InputNumber min={1} max={200000} step={10} style={{ width: '100%' }} autoFocus />
            </Form.Item>
          </Form>
        ) : null}
      </Modal>
    </div>
  );
}
