import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateAccess, withinAccess } from './access.js';
import { matches, newOwner, readOptional, readOwner } from './owner.js';
import { askCodex, buildPrompt, legacyWorkspace } from './runner.js';

export const worldId = 'qiqi-codex';
const panelId = 'control';
const finishedEvent = 'qiqi-codex.finished';
const historyLimit = 50;
const labels = {
  pending: '待审核', running: '运行中', stopping: '正在停止', succeeded: '已完成',
  failed: '失败', rejected: '已拒绝', cancelled: '已停止', interrupted: '重启中断',
  permission: '待权限审核',
};

function atomicallyWrite(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const isActive = (job) => ['permission', 'pending', 'running'].includes(job.status);
const validTimeout = (value) => Number.isInteger(value) && value >= 60 && value <= 3600;
const fail = (text) => ({ text, failed: true });

export class CodexWorld {
  id = worldId;
  #host;
  #context;
  #directory;
  #file;
  #owner;
  #hostProtected = false;
  #sessions = new Set();
  #state;
  #active;
  #toolDescriptions;

  constructor(context, tools) {
    const { botDir } = context;
    this.#context = context;
    this.#directory = join(botDir, 'worlds', worldId);
    this.#file = join(this.#directory, 'control-state.json');
    this.#toolDescriptions = tools;
  }

  async start(host) {
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    this.#owner = readOwner(this.#directory);
    const config = readOptional(join(this.#context.botDir, 'config.json'));
    this.#hostProtected = Boolean(this.#context.secret?.('CORTICO_WEB_PASSWORD') ||
      (config && JSON.parse(config.replace(/^\uFEFF/, '')).web?.password));
    const directory = this.#owner.digest && existsSync(legacyWorkspace)
      ? legacyWorkspace : join(this.#context.botDir, 'workspace', worldId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const access = validateAccess({ directory, mode: 'read' });
    let state = { approvalRequired: true, timeoutSeconds: 600, jobs: [] };
    try {
      state = JSON.parse(readFileSync(this.#file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (typeof state.approvalRequired !== 'boolean' || !validTimeout(state.timeoutSeconds) || !Array.isArray(state.jobs)) {
      throw new Error('Codex 控制记录无法读取，已暂停接单。');
    }
    const jobs = state.jobs.map((job) => job.status === 'running'
      ? { ...job, status: 'interrupted', finishedAt: Date.now(), result: '服务重启中断了这次任务。' }
      : job);
    this.#commit({ access, botMayDecide: false, botMaySelectAccess: false, ...state, jobs });
    this.#host = host;
  }

  async stop() {
    this.#host = undefined;
    const active = this.#active;
    active?.controller.abort();
    await active?.done;
    this.#sessions.clear();
  }

  envPromptVars() {
    return null;
  }

  tools() {
    const handlers = {
      qiqi_codex_ask: async (args, ctx) => this.#submit(args, ctx?.signal),
      qiqi_codex_result: async (args) => this.#result(args?.id),
      qiqi_codex_request_permission: async (args, ctx) => this.#submit(args, ctx?.signal, true),
      qiqi_codex_decide_permission: async (args, ctx) => {
        if (!this.#host || ctx?.signal?.aborted) return fail('本次调用已取消。');
        try {
          this.#decidePermission(args?.id, args?.approve, 'bot');
          return args.approve ? '已同意这一次权限请求，任务仍按发送审核设置处理。' : '已拒绝该权限请求。';
        } catch (error) { return fail(error.message); }
      },
    };
    return this.#toolDescriptions.map(({ summary, ...tool }) => ({ ...tool, handler: handlers[tool.name] }));
  }

  webUi() {
    return {
      label: '鳍鳍的 Codex',
      panels: [{ id: panelId, title: '任务' }, { id: 'settings', title: '设置' }],
      invoke: async (panel, method, args) => {
        if (![panelId, 'settings'].includes(panel) || !this.#host) return { error: '请先启用「鳍鳍的 Codex」。' };
        const [key, value] = args;
        if (!this.#owner.digest) {
          if (method !== 'setup') return { locked: true, setup: true };
          try {
            const digest = readOptional(join(this.#directory, 'setup.sha256'));
            if (!/^[a-f0-9]{64}$/.test(digest ?? '') || !matches(value?.setupCode, digest)) {
              throw new Error('初始化码无效。请使用本机安装命令生成的初始化码。');
            }
            this.#saveOwner(newOwner(value.passcode));
            rmSync(join(this.#directory, 'setup.sha256'), { force: true });
            return { ...this.#view(), token: this.#session() };
          } catch (error) { return { locked: true, setup: true, error: error.message }; }
        }
        const required = this.#owner.enabled;
        const session = typeof key === 'string' && this.#sessions.has(key);
        const validCode = !session && matches(key, this.#owner.digest, this.#owner.salt);
        if (required && !session && !validCode) return { locked: true };
        try {
          if (method === 'detail') {
            const job = this.#get(value);
            return job ? { prompt: job.prompt, result: job.result,
              activity: this.#active?.id === job.id ? this.#active.activity : job.activity ?? [] } : { error: '找不到此任务。' };
          }
          if (method === 'activity') return { activity: this.#active?.id === value ? this.#active.activity : [] };
          if (method === 'lock') {
            this.#sessions.delete(key);
            return { locked: required };
          }
          if (method === 'passcode') {
            this.#saveOwner(newOwner(value.next, this.#owner.enabled));
            return { ...this.#view(), token: this.#session() };
          }
          if (method === 'accessCode') {
            if (typeof value !== 'boolean') throw new Error('无效的访问码设置。');
            // Migrate a legacy hash only when the operator rotates their code.
            this.#saveOwner({ ...this.#owner, enabled: value });
            return { ...this.#view(), token: this.#session() };
          }
          if (method !== 'state') this.#apply(method, value);
          return { ...this.#view(), ...(validCode ? { token: this.#session() } : {}) };
        } catch (error) {
          if (error.code) this.#host.log.warn('Codex 面板保存失败', { method, code: error.code });
          return { ...this.#view(), error: error.code ? '保存失败，请检查本机存储。' : error.message };
        }
      },
    };
  }

  #session() {
    const token = randomUUID();
    this.#sessions.add(token);
    if (this.#sessions.size > 32) this.#sessions.delete(this.#sessions.values().next().value);
    return token;
  }

  #saveOwner(record) {
    atomicallyWrite(join(this.#directory, 'owner.json'), record);
    this.#owner = record;
    this.#sessions.clear();
  }

  #commit(state) {
    atomicallyWrite(this.#file, state);
    this.#state = state;
  }

  #update(job, changes) {
    const next = { ...job, ...changes };
    this.#commit({ ...this.#state, jobs: this.#state.jobs.map((row) => row.id === job.id ? next : row) });
    return next;
  }

  #get(id) {
    return this.#state?.jobs.find((job) => job.id === id);
  }

  #view() {
    const { approvalRequired, timeoutSeconds, access, botMayDecide, botMaySelectAccess, jobs } = this.#state;
    return {
      approvalRequired, timeoutSeconds, access, botMayDecide, botMaySelectAccess, hostProtected: this.#hostProtected,
      accessCodeRequired: this.#owner.enabled,
      jobs: jobs.map(({ prompt, result, activity, ...job }) => this.#active?.id === job.id
        ? { ...job, status: this.#active.controller.signal.aborted ? 'stopping' : job.status,
          activityVersion: this.#active.activityVersion }
        : job),
    };
  }

  #submit(args, signal, request = false) {
    if (!this.#host || signal?.aborted) return fail('Codex 扩展未运行或本轮已取消。');
    if (!this.#owner.digest) return fail('请主人先在 Codex World 面板完成初始化。');
    const task = typeof args?.task === 'string' ? args.task.trim() : '';
    if (!task || task.length > 3000) return fail('请输入 1 至 3000 字符的自然语言任务。');
    const existing = this.#state.jobs.find(isActive);
    if (existing) return fail(`已有任务 ${existing.id}（${labels[existing.status]}），请勿重复提交。`);
    let access;
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    if (request && (!reason || reason.length > 1000)) return fail('请填写 1 至 1000 字的权限申请理由。');
    const base = this.#state.access;
    const selected = args.directory !== undefined || args.mode !== undefined || args.readPaths !== undefined;
    if (selected && !request && !this.#state.botMaySelectAccess) {
      return fail('基础权限由主人设定。需要读取外部文件时，以额外只读路径发起一次权限申请。');
    }
    try {
      if (!selected && request) throw new Error('请指定需要的文件权限或额外只读路径。');
      access = validateAccess({
        directory: args.directory ?? base.directory,
        mode: args.mode ?? (request ? 'read' : base.mode),
        readPaths: args.readPaths ?? (request ? [] : base.readPaths),
      });
      if (!request && selected && !withinAccess(access, base)) {
        throw new Error('超出主人的基础授权，请发起一次权限申请。');
      }
    }
    catch (error) { return fail(error.message); }
    const job = {
      id: randomUUID(), task, access, prompt: buildPrompt(task, access), createdAt: Date.now(),
      status: request ? 'permission' : 'pending', forceReview: this.#state.approvalRequired,
      ...(request ? { permission: { reason } } : {}),
    };
    this.#commit({ ...this.#state, jobs: [job, ...this.#state.jobs].slice(0, historyLimit) });
    if (request) return `权限申请 ${job.id} 已记录，等候权限审核。任务尚未发送。`;
    if (this.#state.approvalRequired) {
      return `任务 ${job.id} 已在本机等待主人审核，尚未提交给 Codex。`;
    }
    this.#launch(job);
    return `任务 ${job.id} 已开始在后台运行。`;
  }

  #result(id) {
    const job = this.#get(id);
    if (!job) return fail('找不到此 Codex 任务。');
    const status = this.#active?.id === id && this.#active.controller.signal.aborted ? 'stopping' : job.status;
    const result = job.result ?? '';
    const preview = result.length > 6000 ? result.slice(0, 6000) + '\n〔完整回复见 World 面板〕' : result;
    return [`Codex 任务 ${job.id}：${labels[status]}`,
      job.permission?.actor && `权限决定：${job.permission.actor === 'bot' ? '鳍鳍' : '主人'}`, preview].filter(Boolean).join('\n');
  }

  #apply(method, value) {
    if (method === 'approval' && typeof value === 'boolean') {
      this.#commit({ ...this.#state, approvalRequired: value });
      return;
    }
    if (method === 'timeout' && validTimeout(value)) {
      this.#commit({ ...this.#state, timeoutSeconds: value });
      return;
    }
    if (method === 'permissions') {
      this.#commit({ ...this.#state, access: validateAccess(value) });
      return;
    }
    if (method === 'delegate' && typeof value === 'boolean') {
      this.#commit({ ...this.#state, botMayDecide: value });
      return;
    }
    if (method === 'delegateAccess' && typeof value === 'boolean') {
      this.#commit({ ...this.#state, botMaySelectAccess: value });
      return;
    }
    if (method === 'allowPermission' || method === 'denyPermission') {
      this.#decidePermission(value, method === 'allowPermission', 'owner');
      return;
    }
    const job = this.#get(value);
    if (method === 'approve' && job?.status === 'pending') {
      this.#launch(job);
      return;
    }
    if (method === 'reject' && job?.status === 'pending') {
      this.#finish(job, 'rejected', '主人拒绝了该请求。');
      return;
    }
    if (method === 'stop' && job?.status === 'running' && this.#active?.id === job.id) {
      this.#active.controller.abort();
      return;
    }
    throw new Error('任务状态已改变，或设置值超出范围。');
  }

  #decidePermission(id, approve, actor) {
    if (actor === 'bot' && !this.#state.botMayDecide) throw new Error('权限审核目前仅由主人处理。');
    const job = this.#get(id);
    if (job?.status !== 'permission' || typeof approve !== 'boolean') throw new Error('该权限申请已处理或不存在。');
    if (approve) {
      const requested = validateAccess(job.access);
      this.#assertUnchangedAccess(requested, job.access);
      if (actor === 'bot' && !withinAccess(requested, this.#state.access)) {
        throw new Error('超出主人预授权的目录或权限，仅主人可以同意。');
      }
    }
    const reviewed = { ...job, permission: { ...job.permission, actor, approved: approve, at: Date.now() } };
    if (!approve) {
      this.#finish(reviewed, 'rejected', '权限申请已被拒绝。');
      return;
    }
    const pending = this.#update(reviewed, { status: 'pending' });
    if (!job.forceReview && !this.#state.approvalRequired) this.#launch(pending);
  }

  #assertUnchangedAccess(access, previous) {
    if (access.directory !== previous.directory || JSON.stringify(access.readPaths) !== JSON.stringify(previous.readPaths ?? [])) {
      throw new Error('授权的路径指向发生变化，请重新提交任务。');
    }
  }

  #launch(job) {
    if (this.#active) throw new Error('另一个 Codex 任务仍在运行。');
    const access = validateAccess(job.access ?? this.#state.access);
    if (job.access) this.#assertUnchangedAccess(access, job.access);
    const running = this.#update(job, {
      status: 'running', startedAt: Date.now(), timeoutSeconds: this.#state.timeoutSeconds, access,
    });
    const controller = new AbortController();
    const active = { id: job.id, controller, activity: [], activityVersion: 0 };
    this.#active = active;
    active.done = askCodex(running.prompt, running.timeoutSeconds, controller.signal, access, (entry) => {
      active.activity.push(entry);
      if (active.activity.length > 60) active.activity.shift();
      active.activityVersion++;
    }).then(
      (result) => this.#finish(running, controller.signal.aborted ? 'cancelled' : 'succeeded',
        controller.signal.aborted ? '主人或宿主停止了调用。' : result),
      (error) => this.#finish(running, controller.signal.aborted ? 'cancelled' : 'failed', error.message),
    ).catch((error) => {
      this.#host?.log.error('Codex 任务记录保存失败', { id: running.id, code: error.code });
    }).finally(() => { this.#active = undefined; });
  }

  #finish(job, status, result) {
    this.#update(job, { status, result, finishedAt: Date.now(),
      ...(this.#active?.id === job.id ? { activity: this.#active.activity } : {}) });
    const host = this.#host;
    if (!host) return;
    void host.pushEvent({
      type: finishedEvent,
      source: worldId,
      origin: 'internal',
      ts: new Date().toISOString(),
      tags: ['snapshot'],
      text: `Codex 任务 ${job.id}：${labels[status]}。需要结果时用 qiqi_codex_result 查询。`,
    }, { trigger: 'flush' }).catch(() => host.log.warn('无法投递 Codex 任务完成通知', { id: job.id }));
  }
}
