import path from 'node:path';

export function pathIsWithinRoot(root, candidate, pathApi = path) {
  const relative = pathApi.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !relative.startsWith('../') && !pathApi.isAbsolute(relative));
}

export function selectAccessRoot(candidate, persistentRoots, temporaryGrants, requiredAccess = 'read', now = Date.now(), pathApi = path) {
  const roots = [
    ...persistentRoots.map((entry) => typeof entry === 'string'
      ? { root: entry, access: 'read_write', expiresAt: Infinity, source: 'persistent' }
      : { ...entry, expiresAt: Infinity, source: 'persistent' }),
    ...temporaryGrants
      .filter((grant) => grant.expiresAt > now)
      .map((grant) => ({ ...grant, source: 'temporary' })),
  ];
  return roots
    .filter((grant) => (requiredAccess !== 'write' || grant.access === 'read_write') && pathIsWithinRoot(grant.root, candidate, pathApi))
    .sort((left, right) => right.root.length - left.root.length)[0] || null;
}

export function isDriveRoot(candidate, pathApi = path) {
  const root = pathApi.normalize(pathApi.parse(candidate).root);
  const normalized = pathApi.normalize(candidate);
  if (pathApi.sep === '\\') return root.toLowerCase() === normalized.toLowerCase();
  return root === normalized;
}

export function assertRootGrantable(candidate, allowDriveRoot = false, pathApi = path) {
  if (isDriveRoot(candidate, pathApi) && !allowDriveRoot) {
    throw new Error('Drive roots require an explicit owner approval through ForgeLink.');
  }
  return candidate;
}

export function requiresExtraConfirmation(candidate, pathApi = path) {
  if (isDriveRoot(candidate, pathApi)) return true;
  const driveRoot = pathApi.parse(candidate).root;
  const relative = pathApi.relative(driveRoot, candidate).split(pathApi.sep).filter(Boolean);
  const first = (relative[0] || '').toLowerCase();
  const systemRoots = new Set(['windows', 'program files', 'program files (x86)', 'programdata', 'system', 'library', 'applications', 'volumes', 'etc', 'usr', 'bin', 'sbin', 'var', 'opt', 'private']);
  if (systemRoots.has(first)) return true;
  return first === 'users' && relative.length <= 2;
}
