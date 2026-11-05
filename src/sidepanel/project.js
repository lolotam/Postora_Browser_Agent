export function createProjectUi({ getSessionId, send, request, input, isRunning, t, resize }) {
  const el = (id) => document.getElementById(id);
  let project = null, directory = '.', revision = 0, owner = null;
  const showError = (error) => { el('projectError').textContent = error?.message || String(error || ''); };
  const render = () => {
    const chip = el('projectChip');
    chip.hidden = !project;
    chip.replaceChildren();
    if (!project) return;
    const label = document.createElement('button'); label.type = 'button'; label.className = 'ghost';
    label.textContent = `▱ ${project.name}`; label.title = project.root;
    label.onclick = () => openFiles('.');
    chip.append(label);
    const hint = document.createElement('small'); hint.textContent = t('project.mentionHint'); chip.append(hint);
  };
  const set = (value) => { project = value; revision += 1; render(); };
  const open = () => {
    owner = getSessionId(); showError('');
    el('projectRoot').value = project?.root || '';
    el('projectDialog').showModal();
  };
  el('projectBtn').onclick = open;
  el('projectBrowse').onclick = async () => {
    showError('');
    try {
      const root = await request('project-pick');
      if (owner === getSessionId() && root) el('projectRoot').value = root;
    } catch (error) { showError(error); }
  };
  const bind = (root) => {
    if (owner !== getSessionId()) { el('projectDialog').close(); return; }
    if (isRunning()) return showError(t('project.stopFirst'));
    send({ type: 'project-set', sessionId: owner, root }, { expectedSessionId: owner }).catch(showError);
  };
  el('projectSave').onclick = () => bind(el('projectRoot').value.trim());
  el('projectUnlink').onclick = () => bind(null);
  async function openFiles(next) {
    if (!project) return open();
    directory = next;
    const mine = ++revision, sessionId = getSessionId();
    el('projectFiles').textContent = t('project.loading');
    el('projectDirectory').textContent = directory;
    if (!el('projectFilesDialog').open) el('projectFilesDialog').showModal();
    try {
      const data = await request('project-list-ui', { sessionId, path: directory });
      if (mine !== revision || sessionId !== getSessionId()) return;
      el('projectFiles').replaceChildren(...data.entries.map((entry) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'menu-row';
        button.textContent = `${entry.directory ? '▱' : '@'} ${entry.name}`;
        button.onclick = () => {
          const path = directory === '.' ? entry.name : `${directory}/${entry.name}`;
          if (entry.directory) return openFiles(path);
          input.value = input.value.replace(/@$/, '') + `@${JSON.stringify(path)} `;
          resize(); el('projectFilesDialog').close(); input.focus();
        };
        return button;
      }));
    } catch (error) { if (mine === revision) el('projectFiles').textContent = error.message; }
  }
  el('projectParent').onclick = () => openFiles(directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/')) : '.');
  input.addEventListener('input', () => { if (project && /@$/.test(input.value)) void openFiles('.'); });
  return {
    apply(value, error) {
      if (error) { showError(error); return; }
      set(value);
      el('projectDialog').close();
    },
    reset() { set(null); el('projectDialog').close(); el('projectFilesDialog').close(); },
    render,
  };
}
