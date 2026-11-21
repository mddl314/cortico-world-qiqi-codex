const labels = {
  pending: '待审核', running: '运行中', stopping: '正在停止', succeeded: '已完成',
  failed: '失败', rejected: '已拒绝', cancelled: '已停止', interrupted: '重启中断',
  permission: '待权限审核',
};
const timeLabel = (value) => new Date(value).toLocaleString();
const activeStatus = new Set(['permission', 'pending', 'running', 'stopping']);
const modeLabel = (access) => access?.mode === 'write' ? '目录内读写' : '只读';
let ownerKey = '';

function duration(seconds) {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes === 60) return '1 小时';
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
}

function mount(ctx, isSettings) {
  const { root, ui, signal } = ctx;
  const h = (tag, cls, value) => ui.h(tag, cls, value);
  const signIn = h('form', 'sheet');
  const work = h('div');
  const notice = ui.msgline();
  notice.setAttribute('role', 'status');
  const key = h('input', 'field');
  key.type = 'password';
  key.autocomplete = 'current-password';
  key.required = true;
  const setupCode = h('input', 'field');
  setupCode.type = 'password';
  setupCode.autocomplete = 'off';
  const setupField = ui.field('一次性初始化码', setupCode);
  setupField.hidden = true;
  const setupHelp = h('p', 'muted', '请先在 Cortico 主机运行扩展目录中的 setup.mjs，获取一次性初始化码。');
  setupHelp.hidden = true;
  const unlock = ui.button('解锁', { variant: 'primary' });
  unlock.type = 'submit';
  const signInActions = ui.actions();
  signInActions.append(unlock);
  signIn.append(h('h3', null, '主人审核'), setupHelp, setupField, ui.field('面板访问码', key), signInActions);
  root.append(notice, signIn, work);

  const settings = h('section', 'sheet');
  const approval = h('input');
  approval.type = 'checkbox';
  const time = h('input', 'field');
  time.type = 'range';
  time.min = '60';
  time.max = '3600';
  time.step = '1';
  time.value = '600';
  time.style.width = '100%';
  const timeValue = h('output');
  const numericTime = h('input', 'field');
  numericTime.type = 'number';
  numericTime.min = time.min;
  numericTime.max = time.max;
  numericTime.step = '1';
  numericTime.value = time.value;
  const save = ui.button('保存等待时间', { variant: 'primary' });
  const lock = ui.button('锁定面板');
  const settingsActions = ui.actions();
  settingsActions.append(save, lock);
  const timeScale = ui.rowbar();
  timeScale.style.justifyContent = 'space-between';
  timeScale.append(h('span', null, '60 秒'), timeValue, h('span', null, '1 小时'));
  settings.append(
    h('h3', null, '发送设置'), ui.field('发送前由主人审核', approval),
    ui.field('Codex 最长运行时间', time), timeScale,
    ui.field('精确时间（秒）', numericTime), settingsActions,
    h('p', 'muted', '从任务发给 Codex 时起计时。修改设置适用于之后开始运行的任务。已待审的任务仍需手动批准或拒绝。'),
  );

  const activity = h('section', 'sheet');
  const detail = h('div');
  activity.append(h('h3', null, '当前任务'), detail);
  const history = h('section', 'sheet');
  const records = h('div');
  history.append(h('h3', null, '最近 50 条任务'), records);
  const permissions = h('section', 'sheet');
  const directory = h('input', 'field');
  directory.type = 'text';
  directory.spellcheck = false;
  const mode = h('select', 'field');
  for (const [value, name] of [['read', '只读'], ['write', '目录内读写']]) {
    const option = h('option', null, name);
    option.value = value;
    mode.append(option);
  }
  const delegate = h('input');
  delegate.type = 'checkbox';
  const delegateAccess = h('input');
  delegateAccess.type = 'checkbox';
  const readPaths = h('textarea', 'field');
  readPaths.rows = 3;
  readPaths.spellcheck = false;
  const savePermissions = ui.button('保存权限', { variant: 'primary' });
  const chooseFolder = ui.button('选择文件夹');
  const permissionNotice = ui.msgline();
  permissionNotice.setAttribute('role', 'status');
  const permissionActions = ui.actions();
  permissionActions.append(savePermissions, chooseFolder);
  permissions.append(
    h('h3', null, 'Codex 权限'), ui.field('工作文件夹（绝对路径）', directory),
    ui.field('工作文件夹权限', mode), ui.field('额外只读路径（每行一个文件或文件夹）', readPaths),
    permissionActions, permissionNotice, ui.field('允许鳍鳍为任务选择基础权限', delegateAccess),
    ui.field('允许鳍鳍同意或拒绝权限申请', delegate),
    h('p', 'muted', '默认由主人设定基础权限并审批。允许鳍鳍决定后，她可在已授权范围内为任务选用权限，或审批单次申请。'),
  );
  const credentials = h('section', 'sheet');
  const codeEnabled = h('input');
  codeEnabled.type = 'checkbox';
  const codeNote = h('p', 'muted');
  const nextCode = h('input', 'field');
  nextCode.type = 'password';
  nextCode.autocomplete = 'new-password';
  const rotate = ui.button('更改访问码', { variant: 'primary' });
  const credentialActions = ui.actions();
  credentialActions.append(rotate);
  credentials.append(
    h('h3', null, '面板访问'), ui.field('要求插件访问码', codeEnabled), codeNote,
    ui.field('新访问码', nextCode), credentialActions,
  );
  work.append(...(isSettings ? [permissions, settings, credentials] : [activity, history]));
  work.hidden = true;

  let busy = false;
  let mutations = Promise.resolve();
  let polling = false;
  let generation = 0;
  let dirtyTime = false;
  let dirtyAccess = false;
  let setupMode = false;
  let runningLog;
  let logRevision;
  let activeRevision;
  let historyRevision = '';
  let openRecord;

  function tell(text, bad = false) {
    notice.textContent = text;
    notice.classList.toggle('bad', bad);
  }

  function displayDuration() {
    timeValue.textContent = duration(Number(time.value));
    time.setAttribute('aria-valuetext', timeValue.textContent);
  }

  function sealed() {
    ownerKey = '';
    generation++;
    work.hidden = true;
    signIn.hidden = false;
    key.value = '';
    nextCode.value = setupCode.value = '';
    detail.replaceChildren();
    records.replaceChildren();
    activeRevision = undefined;
    historyRevision = '';
    openRecord = undefined;
    dirtyTime = false;
    dirtyAccess = false;
    permissionNotice.textContent = '';
    runningLog = undefined;
    logRevision = undefined;
  }

  function showSetup(value) {
    setupMode = value;
    setupHelp.hidden = setupField.hidden = !value;
    setupCode.required = value;
    key.autocomplete = value ? 'new-password' : 'current-password';
    unlock.textContent = value ? '设置访问码' : '解锁';
  }

  function textBlock(title, text) {
    const block = h('div');
    const content = h('pre', null, text);
    content.style.whiteSpace = 'pre-wrap';
    content.style.overflowWrap = 'anywhere';
    content.style.maxHeight = '28em';
    content.style.overflow = 'auto';
    block.append(h('h4', null, title), content);
    return block;
  }

  async function readDetail(job, container, onReady) {
    const credential = ownerKey;
    try {
      const data = await ctx.invoke('detail', [credential, job.id]);
      if (signal.aborted || !container.isConnected || (data.locked && credential !== ownerKey)) return;
      if (data.locked) {
        sealed();
        return;
      }
      if (data.error) throw new Error(data.error);
      const outbound = h('details');
      outbound.open = job.status === 'pending';
      outbound.append(h('summary', null, '实际发送给 Codex 的全文'), textBlock('请求正文', data.prompt));
      const content = [outbound];
      if (data.result !== undefined) {
        content.push(textBlock(job.status === 'succeeded' ? 'Codex 回复' : '任务结果', data.result));
      }
      if (!activeStatus.has(job.status) && data.activity?.length) {
        const transcript = h('details');
        const log = h('div');
        showActivity(log, data.activity);
        transcript.append(h('summary', null, '运行记录'), log);
        content.push(transcript);
      }
      container.replaceChildren(...content);
      onReady?.();
    } catch (error) {
      if (!signal.aborted && container.isConnected) {
        container.replaceChildren(ui.msgline(error.message, true));
        if (onReady) container.append(ui.button('重读任务正文', {
          onClick: () => void readDetail(job, container, onReady),
        }));
      }
    }
  }

  function showActivity(element, entries) {
    if (!entries.length) {
      element.replaceChildren(ui.placeholder('等待 Codex 返回运行事件…'));
      return;
    }
    const list = h('ol');
    for (const entry of entries) {
      const row = h('li', null, `${new Date(entry.at).toLocaleTimeString()} · ${entry.stage} · ${entry.label}`);
      if (entry.text) {
        const content = h('pre', null, entry.text);
        content.style.whiteSpace = 'pre-wrap';
        content.style.overflowWrap = 'anywhere';
        row.append(content);
      }
      list.append(row);
    }
    const follow = element.scrollHeight - element.scrollTop - element.clientHeight < 50;
    element.replaceChildren(list);
    if (follow) element.scrollTop = element.scrollHeight;
  }

  async function updateActivity(job) {
    if (!runningLog || job?.activityVersion === undefined) return;
    const log = runningLog;
    const revision = `${job.id}/${job.activityVersion}`;
    if (revision === logRevision) return;
    logRevision = revision;
    const credential = ownerKey;
    try {
      const data = await ctx.invoke('activity', [credential, job.id]);
      if (signal.aborted || !log.isConnected || log !== runningLog || revision !== logRevision) return;
      if (data.locked) {
        if (credential !== ownerKey) { logRevision = undefined; return; }
        sealed();
        return;
      }
      showActivity(log, data.activity ?? []);
    } catch {
      if (revision === logRevision) logRevision = undefined;
    }
  }

  function renderActive(job) {
    const revision = job ? `${job.id}/${job.status}` : '';
    if (revision === activeRevision) return;
    activeRevision = revision;
    runningLog = undefined;
    logRevision = undefined;
    if (!job) {
      detail.replaceChildren(ui.placeholder('当前没有待审核或运行中的任务。'));
      return;
    }
    const meta = job.startedAt
      ? `开始于 ${timeLabel(job.startedAt)} · 最长 ${duration(job.timeoutSeconds)}`
      : `提交于 ${timeLabel(job.createdAt)}`;
    const body = h('div');
    const actions = ui.actions();
    let enableApproval;
    if (job.status === 'permission') {
      actions.append(
        ui.button('同意本次权限', { variant: 'primary',
          onClick: () => void request('allowPermission', job.id, '已同意本次权限申请。') }),
        ui.button('拒绝权限', { variant: 'danger',
          onClick: () => void request('denyPermission', job.id, '已拒绝本次权限申请。') }),
      );
    }
    if (job.status === 'pending') {
      const approve = ui.button('批准并发送', { variant: 'primary',
        onClick: () => void request('approve', job.id, '任务已批准。') });
      approve.disabled = true;
      enableApproval = () => { approve.disabled = false; };
      actions.append(
        approve,
        ui.button('拒绝', { variant: 'danger', onClick: () => void request('reject', job.id, '任务已拒绝。') }),
      );
    }
    if (job.status === 'running') {
      actions.append(ui.button('停止 Codex', { variant: 'danger',
        onClick: () => void request('stop', job.id, '已请求停止 Codex。') }));
    }
    const permission = job.access ? accessText(job.access) : '';
    detail.replaceChildren(ui.pill(labels[job.status], job.status === 'pending' || job.status === 'permission' ? 'plain' : 'on'),
      h('p', 'muted', meta), textBlock('鳍鳍提交的任务', job.task), body, actions);
    if (permission) detail.insertBefore(textBlock('本次文件权限', permission), body);
    if (job.permission?.reason) detail.insertBefore(textBlock('申请理由', job.permission.reason), body);
    if (job.permission?.actor) detail.insertBefore(h('p', null, decisionText(job.permission)), body);
    if (job.status === 'running' || job.status === 'stopping') {
      runningLog = h('div');
      runningLog.style.maxHeight = '25em';
      runningLog.style.overflow = 'auto';
      runningLog.setAttribute('aria-label', 'Codex 实时事件');
      detail.append(h('h4', null, '实时运行记录'), runningLog);
    }
    void readDetail(job, body, enableApproval);
  }

  function accessText(access) {
    const extra = access.readPaths?.length ? ['额外只读路径', ...access.readPaths] : [];
    return [`${modeLabel(access)} · ${access.directory}`, ...extra].join('\n');
  }

  function decisionText(permission) {
    return `${permission.actor === 'bot' ? '鳍鳍' : '主人'}已${permission.approved ? '同意' : '拒绝'}本次权限申请。`;
  }

  function renderHistory(jobs) {
    const revision = JSON.stringify(jobs);
    if (historyRevision === revision) return;
    historyRevision = revision;
    records.replaceChildren();
    if (!jobs.length) records.append(ui.placeholder('还没有已结束的任务。'));
    for (const job of jobs) {
      const entry = h('details', 'sheet');
      const summary = h('summary', null, `${labels[job.status]} · ${timeLabel(job.finishedAt)} · ${job.task.slice(0, 90)}`);
      const body = h('div');
      entry.append(summary, textBlock('鳍鳍提交的任务', job.task));
      if (job.access) entry.append(textBlock('本次文件权限', accessText(job.access)));
      if (job.permission?.reason) entry.append(textBlock('申请理由', job.permission.reason));
      if (job.permission?.actor) entry.append(h('p', null, decisionText(job.permission)));
      entry.append(body);
      records.append(entry);
      let loaded = false;
      entry.addEventListener('toggle', () => {
        if (entry.open) {
          openRecord = job.id;
          if (!loaded) {
            loaded = true;
            void readDetail(job, body);
          }
        } else if (openRecord === job.id) openRecord = undefined;
      }, { signal });
      if (openRecord === job.id) entry.open = true;
    }
  }

  function draw(data) {
    signIn.hidden = true;
    work.hidden = false;
    approval.checked = data.approvalRequired;
    delegate.checked = data.botMayDecide;
    delegateAccess.checked = data.botMaySelectAccess;
    codeEnabled.checked = data.accessCodeRequired;
    lock.hidden = !data.accessCodeRequired;
    codeNote.textContent = data.hostProtected
      ? '关闭后由 Cortico WebUI 登录保护此面板。'
      : '关闭后，能打开 Cortico 面板的人都可以查看任务、审核和更改设置。';
    if (!dirtyAccess && data.access) {
      directory.value = data.access.directory;
      mode.value = data.access.mode;
      readPaths.value = (data.access.readPaths ?? []).join('\n');
    }
    if (!dirtyTime) {
      numericTime.value = time.value = String(data.timeoutSeconds);
      displayDuration();
    }
    const active = data.jobs.find((job) => activeStatus.has(job.status));
    if (!isSettings) {
      renderActive(active);
      void updateActivity(active);
      renderHistory(data.jobs.filter((job) => !activeStatus.has(job.status)));
    }
  }

  function request(method, value, confirmation, credential) {
    if (method === 'state' && !confirmation) return send(method, value, confirmation, credential);
    const queued = mutations.then(() => send(method, value, confirmation, credential));
    mutations = queued.catch(() => {});
    return queued;
  }

  async function send(method, value, confirmation, credential = ownerKey) {
    if (busy || signal.aborted) return;
    const mutation = method !== 'state' || Boolean(confirmation);
    const permissionChange = ['permissions', 'delegate', 'delegateAccess'].includes(method);
    const announce = permissionChange ? (message, bad = false) => {
      permissionNotice.textContent = message;
      permissionNotice.classList.toggle('bad', bad);
    } : tell;
    if (mutation) {
      busy = true;
      generation++;
      announce('');
      if (method === 'permissions') savePermissions.disabled = true;
    } else {
      if (polling) return;
      polling = true;
    }
    const version = generation;
    try {
      const data = await ctx.invoke(method, [credential, value]);
      if (signal.aborted || generation !== version) return;
      if (data.locked) {
        sealed();
        showSetup(Boolean(data.setup));
        if (data.error || credential) tell(data.error ?? '面板访问码不正确或会话已失效。', true);
      } else if (!Array.isArray(data.jobs)) {
        announce(data.error ?? '无法读取控制面板。', true);
      } else {
        ownerKey = data.token ?? (data.accessCodeRequired ? credential : '');
        key.value = setupCode.value = '';
        if (method === 'timeout' && !data.error) dirtyTime = false;
        if (method === 'permissions' && !data.error) dirtyAccess = false;
        if (method === 'passcode' && !data.error) nextCode.value = '';
        draw(data);
        if (data.error || confirmation) announce(data.error ?? confirmation, Boolean(data.error));
      }
    } catch (error) {
      if (!signal.aborted && generation === version) {
        announce(error.message, true);
        if (mutation && ownerKey) {
          busy = false;
          void request('state');
        }
      }
    } finally {
      if (method === 'permissions') savePermissions.disabled = false;
      if (mutation) busy = false;
      else polling = false;
    }
  }

  signIn.addEventListener('submit', (event) => {
    event.preventDefault();
    if (setupMode) void request('setup', { setupCode: setupCode.value.trim(), passcode: key.value }, '访问码已设置。', '');
    else void request('state', undefined, '面板已解锁。', key.value);
  }, { signal });
  lock.addEventListener('click', () => {
    void ctx.invoke('lock', [ownerKey]).catch(() => {});
    sealed();
    tell('面板已锁定。');
  }, { signal });
  approval.addEventListener('change', async () => {
    const next = approval.checked;
    approval.checked = !next;
    if (!next && !await ui.confirm({
      title: '关闭发送前审核？',
      danger: true,
      body: '关闭后，鳍鳍新提交的任务会直接发给 Codex。已经待审的任务仍需单独处理。',
    })) return;
    await request('approval', next, next ? '已开启发送前审核。' : '已关闭发送前审核。');
  }, { signal });
  time.addEventListener('input', () => {
    dirtyTime = true;
    numericTime.value = time.value;
    displayDuration();
  }, { signal });
  numericTime.addEventListener('input', () => {
    dirtyTime = true;
    if (numericTime.validity.valid && numericTime.value) time.value = numericTime.value;
    displayDuration();
  }, { signal });
  save.addEventListener('click', () => {
    if (!numericTime.value || !numericTime.reportValidity()) return;
    void request('timeout', Number(numericTime.value), '等待时间已保存。');
  }, { signal });
  directory.addEventListener('input', () => { dirtyAccess = true; }, { signal });
  mode.addEventListener('change', () => { dirtyAccess = true; }, { signal });
  readPaths.addEventListener('input', () => { dirtyAccess = true; }, { signal });
  chooseFolder.addEventListener('click', async () => {
    try {
      const selected = await ctx.pickPath({ kind: 'directory', ...(directory.value ? { currentPath: directory.value } : {}) });
      if (selected && !signal.aborted) {
        directory.value = selected;
        dirtyAccess = true;
      }
    } catch (error) { tell(error.message, true); }
  }, { signal });
  savePermissions.addEventListener('click', async () => {
    await request('permissions', {
      directory: directory.value, mode: mode.value, readPaths: readPaths.value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean),
    }, '基础权限已保存。');
  }, { signal });
  delegateAccess.addEventListener('change', () => {
    const next = delegateAccess.checked;
    delegateAccess.checked = !next;
    void request('delegateAccess', next, next ? '鳍鳍可以在授权范围内选择本次权限。' : '已恢复为仅主人设定基础权限。');
  }, { signal });
  delegate.addEventListener('change', async () => {
    const next = delegate.checked;
    delegate.checked = !next;
    if (next && !await ui.confirm({
      title: '允许鳍鳍审批权限申请？', body: '鳍鳍可以拒绝申请，只能同意你已预授权范围内的申请。',
    })) return;
    await request('delegate', next, next ? '已允许鳍鳍审批。' : '已恢复为仅主人审批。');
  }, { signal });
  codeEnabled.addEventListener('change', async () => {
    const next = codeEnabled.checked;
    codeEnabled.checked = !next;
    if (!next && !await ui.confirm({
      title: '关闭插件访问码？', body: codeNote.textContent, danger: true,
    })) return;
    await request('accessCode', next, next ? '访问码保护已开启。' : '插件访问码已关闭。');
  }, { signal });
  rotate.addEventListener('click', () => {
    if (!nextCode.value) return;
    void request('passcode', { next: nextCode.value }, '已更改访问码，其他面板会话已锁定。');
  }, { signal });
  ctx.interval(() => { if (!work.hidden) void request('state'); }, 850);
  void request('state');
}

export default { panels: {
  control: { mount: (ctx) => mount(ctx, false) },
  settings: { mount: (ctx) => mount(ctx, true) },
} };
