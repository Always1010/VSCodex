'use strict';
function parts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('本地更新版本必须是 major.minor.patch 格式。');
  const values = version.split('.').map(Number);
  if (values.some(value => !Number.isSafeInteger(value))) throw new Error('本地更新版本超出范围。');
  return values;
}
function compareVersions(a, b) {
  const left = parts(a); const right = parts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
function nextVersion(version) {
  const values = parts(version); values[2]++;
  const next = values.join('.'); parts(next); return next;
}
module.exports = { compareVersions, nextVersion };
