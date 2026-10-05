'use strict';
const path = require('node:path');

function groupProjects(threads, roots = [], additional = [], { platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const normalize = value => {
    let result = paths.resolve(value).replace(/[\\/]+$/, '') || paths.parse(paths.resolve(value)).root;
    if (platform === 'win32') result = result.toLowerCase();
    return result;
  };
  const within = (value, root) => value === root || value.startsWith(root.endsWith(paths.sep) ? root : root + paths.sep);
  const projects = new Map(); const matches = [];
  const add = (source, current, aliases = [], priority = 1) => {
    if (!source || typeof source.path !== 'string' || !source.path) return;
    const id = normalize(source.path);
    let project = projects.get(id);
    if (!project) { project = { id, path: source.path, name: source.name || paths.basename(source.path) || source.path, current, threads: [] }; projects.set(id, project); }
    else project.current ||= current;
    matches.push({ path: id, project, priority: 0 });
    for (const folder of aliases) {
      const value = typeof folder === 'string' ? folder : folder?.path;
      if (typeof value === 'string' && value) matches.push({ path: normalize(value), project, priority });
    }
  };
  for (const project of additional) add(project, false, project.folders || [], 2);
  for (const root of roots) {
    if (!root?.path) continue;
    const alias = matches.filter(m => m.priority === 2 && within(normalize(root.workspacePath || root.path), m.path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (alias) alias.project.current = true;
    else add(root, true, root.workspacePath ? [root.workspacePath] : []);
  }
  // Explicit worktree mappings beat ordinary ancestry; nested paths use the longest match.
  matches.sort((a, b) => b.priority - a.priority || b.path.length - a.path.length);
  const seen = new Set();
  for (const thread of threads) {
    if (!thread?.id || seen.has(thread.id)) continue; seen.add(thread.id);
    const cwd = typeof thread.cwd === 'string' && thread.cwd ? thread.cwd : null;
    const canonical = cwd ? normalize(cwd) : null;
    let project = canonical && matches.find(m => within(canonical, m.path))?.project;
    if (!project) {
      const id = canonical || 'unassigned'; project = projects.get(id);
      if (!project) { project = { id, path: cwd, name: cwd ? paths.basename(cwd) || cwd : '未关联项目', current: false, threads: [] }; projects.set(id, project); }
    }
    const title = thread.name || thread.title || thread.preview?.slice(0, 60) || '未命名聊天';
    project.threads.push({ ...thread, name: title, title });
  }
  return [...projects.values()].sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
}
module.exports = { groupProjects };
