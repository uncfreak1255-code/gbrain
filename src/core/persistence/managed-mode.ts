import type { SqlEngine } from './model.ts';

export async function managedPersistenceEnabled(engine: SqlEngine): Promise<boolean> {
  const [row] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  return row?.enabled === true;
}
