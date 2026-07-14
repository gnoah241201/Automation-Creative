import path from 'node:path';

export const composerRoot = path.resolve(
  process.cwd(),
  'temp_superpowers',
  'native-renders',
  'composer',
);

export const resolveComposerChild = (root: string, id: string): string => {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) {
    throw new Error('Invalid managed asset identifier');
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, id);
  if (path.dirname(resolved) !== resolvedRoot) {
    throw new Error('Invalid managed asset identifier');
  }

  return resolved;
};
