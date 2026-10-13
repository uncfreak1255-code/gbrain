/** Narrow source-owner setting for correction-preserving fact writes. */
import type { BrainEngine } from '../core/engine.ts';
import { sourceCorrectionMode } from '../core/facts/supersession-policy.ts';

export async function runSetCorrectionMode(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0];
  const mode = args[1];
  if (!id || !mode) {
    console.error('Usage: gbrain sources set-correction-mode <id> <semantic|explicit>');
    process.exit(2);
  }
  if (mode !== 'semantic' && mode !== 'explicit') {
    console.error(`Error: invalid correction mode "${mode}". Valid options: semantic | explicit`);
    process.exit(2);
  }
  const exists = await engine.updateSourceConfig(id, { correction_mode: mode });
  if (!exists) {
    console.error(`Error: source "${id}" not found.`);
    console.error(`  Run 'gbrain sources list' to see registered sources.`);
    process.exit(4);
  }
  const effective = await sourceCorrectionMode(engine, id);
  console.log(`Source ${id} correction mode: ${effective}`);
}
