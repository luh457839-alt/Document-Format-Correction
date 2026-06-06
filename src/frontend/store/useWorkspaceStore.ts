import { create } from 'zustand';
import {
  fetchFormattingHistory,
  fetchFormattingRun,
  fetchTemplateConfigs,
  fetchWorkspaceDefaultConfig,
  getFormattingRunDownloadUrl,
  startFormattingRun,
  uploadWorkspaceDocument,
} from '../services/backendApiClient';
import {
  ConfigValue,
  FormattingConfig,
  FormattingJobSnapshot,
  FormattingRunSummary,
  HeadingConfig,
  TemplateMetaSummary,
  WorkspaceDocument,
} from '../types/apiContracts';

type HeadingKey = keyof FormattingConfig['headings'];
type GlobalTypographyKey = keyof FormattingConfig['globalTypography'];
type HeadingConfigKey = keyof HeadingConfig;

interface WorkspaceState {
  document: WorkspaceDocument | null;
  defaultConfig: FormattingConfig | null;
  config: FormattingConfig | null;
  templates: TemplateMetaSummary[];
  selectedTemplateId: string;
  commandText: string;
  customRequirement: string;
  job: FormattingJobSnapshot | null;
  history: FormattingRunSummary[];
  isLoadingDefaults: boolean;
  isUploading: boolean;
  isRunning: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  uploadDocument: (file: File) => Promise<void>;
  replaceDocument: (file: File) => Promise<void>;
  resetToDefault: () => void;
  clearConfig: () => void;
  setCommandText: (value: string) => void;
  setCustomRequirement: (value: string) => void;
  setSelectedTemplateId: (value: string) => void;
  updateGlobalField: <K extends GlobalTypographyKey>(key: K, value: FormattingConfig['globalTypography'][K]) => void;
  updateHeadingField: <K extends HeadingConfigKey>(heading: HeadingKey, key: K, value: HeadingConfig[K]) => void;
  startRun: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  resetTask: () => void;
  clearError: () => void;
}

function noChangeValue<T>(): ConfigValue<T> {
  return { mode: 'no_change' };
}

function buildNoChangeConfig(): FormattingConfig {
  const headingKeys: HeadingKey[] = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  return {
    globalTypography: {
      fontFamily: noChangeValue<string>(),
      fontSizePt: noChangeValue<number>(),
      lineSpacing: noChangeValue<number>(),
      paragraphBeforePt: noChangeValue<number>(),
      paragraphAfterPt: noChangeValue<number>(),
    },
    headings: Object.fromEntries(
      headingKeys.map((heading) => [
        heading,
        {
          fontFamily: noChangeValue<string>(),
          fontSizePt: noChangeValue<number>(),
          bold: noChangeValue<boolean>(),
          numbering: noChangeValue<string>(),
          paragraphBeforePt: noChangeValue<number>(),
          paragraphAfterPt: noChangeValue<number>(),
        },
      ])
    ) as FormattingConfig['headings'],
  };
}

function cloneConfig(config: FormattingConfig): FormattingConfig {
  return JSON.parse(JSON.stringify(config)) as FormattingConfig;
}

function isActiveJob(job: FormattingJobSnapshot | null): boolean {
  return job?.status === 'queued' || job?.status === 'running';
}

async function pollFormattingJob(jobId: string, updateJob: (job: FormattingJobSnapshot) => void): Promise<FormattingJobSnapshot> {
  let current = await fetchFormattingRun(jobId).then((result) => result.job);
  updateJob(current);
  while (isActiveJob(current)) {
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    current = await fetchFormattingRun(jobId).then((result) => result.job);
    updateJob(current);
  }
  return current;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  document: null,
  defaultConfig: null,
  config: null,
  templates: [],
  selectedTemplateId: '',
  commandText: '',
  customRequirement: '',
  job: null,
  history: [],
  isLoadingDefaults: false,
  isUploading: false,
  isRunning: false,
  error: null,

  initialize: async () => {
    if (get().isLoadingDefaults) return;
    set({ isLoadingDefaults: true, error: null });
    try {
      const [defaults, history] = await Promise.all([
        fetchWorkspaceDefaultConfig(),
        fetchFormattingHistory().catch(() => []),
      ]);
      set({
        defaultConfig: defaults.config,
        config: cloneConfig(defaults.config),
        templates: defaults.templates,
        selectedTemplateId: defaults.templates[0]?.id || '',
        history,
      });
    } catch (exc) {
      set({ error: exc instanceof Error ? exc.message : '加载工作台配置失败' });
    } finally {
      set({ isLoadingDefaults: false });
    }
  },

  uploadDocument: async (file: File) => {
    set({ isUploading: true, error: null });
    try {
      const document = await uploadWorkspaceDocument(file);
      set({ document, job: null });
      if (!get().config) {
        await get().initialize();
      }
    } catch (exc) {
      set({ error: exc instanceof Error ? exc.message : 'DOCX 上传失败' });
    } finally {
      set({ isUploading: false });
    }
  },

  replaceDocument: async (file: File) => {
    await get().uploadDocument(file);
  },

  resetToDefault: () => {
    const defaultConfig = get().defaultConfig;
    set({
      config: defaultConfig ? cloneConfig(defaultConfig) : null,
      commandText: '',
      customRequirement: '',
      error: null,
    });
  },

  clearConfig: () => {
    set({
      config: buildNoChangeConfig(),
      commandText: '',
      customRequirement: '',
      selectedTemplateId: '',
      error: null,
    });
  },

  setCommandText: (value) => set({ commandText: value }),
  setCustomRequirement: (value) => set({ customRequirement: value }),
  setSelectedTemplateId: (value) => set({ selectedTemplateId: value }),

  updateGlobalField: (key, value) => {
    const config = get().config;
    if (!config) return;
    set({
      config: {
        ...config,
        globalTypography: {
          ...config.globalTypography,
          [key]: value,
        },
      },
    });
  },

  updateHeadingField: (heading, key, value) => {
    const config = get().config;
    if (!config) return;
    set({
      config: {
        ...config,
        headings: {
          ...config.headings,
          [heading]: {
            ...config.headings[heading],
            [key]: value,
          },
        },
      },
    });
  },

  startRun: async () => {
    const { document, config, commandText, customRequirement, selectedTemplateId } = get();
    if (!document || !config || get().isRunning) return;
    set({ isRunning: true, error: null });
    try {
      const created = await startFormattingRun({
        documentId: document.documentId,
        config,
        commandText,
        customRequirement,
        templateId: selectedTemplateId || undefined,
      });
      set({ job: created.job });
      const completed = await pollFormattingJob(created.job.jobId, (job) => set({ job }));
      set({ job: completed });
      await get().refreshHistory();
      if (completed.status === 'completed') {
        const url = completed.downloadUrl || getFormattingRunDownloadUrl(completed.jobId);
        set({ job: { ...completed, downloadUrl: url } });
      }
    } catch (exc) {
      set({ error: exc instanceof Error ? exc.message : '格式修改任务失败' });
    } finally {
      set({ isRunning: false });
    }
  },

  refreshHistory: async () => {
    try {
      const history = await fetchFormattingHistory();
      set({ history });
    } catch (exc) {
      set({ error: exc instanceof Error ? exc.message : '加载历史记录失败' });
    }
  },

  resetTask: () => {
    set({
      document: null,
      job: null,
      commandText: '',
      customRequirement: '',
      error: null,
      config: get().defaultConfig ? cloneConfig(get().defaultConfig as FormattingConfig) : null,
    });
  },

  clearError: () => set({ error: null }),
}));

export { buildNoChangeConfig };
