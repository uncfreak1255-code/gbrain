import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  gbrainPath,
  loadConfigFileOnly,
  saveConfig,
  type GBrainConfig,
} from '../config.ts';

function durableChoiceFromConfig(parsed: unknown, configFile: string, action: string): boolean {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `refusing to ${action}: ${configFile} is not a config object, ` +
      'so the zero-paid-spend setting is unknown. Repair or remove the file.',
    );
  }
  const autopilot = (parsed as { autopilot?: unknown }).autopilot;
  if (autopilot === undefined) return false;
  if (autopilot === null || typeof autopilot !== 'object' || Array.isArray(autopilot)) {
    throw new Error(
      `refusing to ${action}: ${configFile} has an invalid autopilot section, ` +
      'so the zero-paid-spend setting is unknown. Repair or remove the file.',
    );
  }
  if (!Object.prototype.hasOwnProperty.call(autopilot, 'zero_paid_spend')) return false;
  const value = (autopilot as { zero_paid_spend?: unknown }).zero_paid_spend;
  if (typeof value !== 'boolean') {
    throw new Error(
      `refusing to ${action}: ${configFile} has a non-boolean ` +
      'autopilot.zero_paid_spend value. Repair or remove the setting.',
    );
  }
  return value;
}

/**
 * Resolve the durable spend choice without ever guessing that malformed state
 * means paid spend is allowed.
 */
export function readDurableZeroPaidSpend(): boolean {
  const configFile = join(gbrainPath(), 'config.json');
  if (!existsSync(configFile)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configFile, 'utf-8'));
  } catch (e) {
    throw new Error(
      `refusing to write the autopilot wrapper: ${configFile} exists but could not be read ` +
      `(${e instanceof Error ? e.message : String(e)}), so the zero-paid-spend setting is ` +
      'unknown. Repair or remove the file.',
    );
  }
  return durableChoiceFromConfig(parsed, configFile, 'write the autopilot wrapper');
}

/** Persist an explicit choice without overwriting an unreadable config. */
export function persistDurableZeroPaidSpend(choice: boolean): void {
  const configFile = join(gbrainPath(), 'config.json');
  const cfg = loadConfigFileOnly();
  if (cfg === null && existsSync(configFile)) {
    throw new Error(
      `refusing to persist zero-paid-spend: ${configFile} exists but could not be read, ` +
      'so overwriting it would destroy the rest of the config. Repair or remove the file.',
    );
  }
  if (cfg !== null) durableChoiceFromConfig(cfg, configFile, 'persist zero-paid-spend');
  saveConfig({
    ...(cfg ?? {} as GBrainConfig),
    autopilot: { ...cfg?.autopilot, zero_paid_spend: choice },
  });
}
