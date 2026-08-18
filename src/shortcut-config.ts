import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { KeyId } from "@earendil-works/pi-tui";

export const DEFAULT_SHORTCUTS = {
  openStatus: "ctrl+\\",
  quickCommit: "alt+g",
} as const;
export const DEFAULT_CUSTOM_FOOTER = false;

export type ShortcutAction = keyof typeof DEFAULT_SHORTCUTS;
export type ShortcutValue = KeyId | undefined;

export interface ShortcutConfig {
  readonly version: 1;
  readonly shortcuts: Readonly<Record<ShortcutAction, ShortcutValue>>;
  readonly customFooter: boolean;
}

export interface ShortcutDiagnostics {
  readonly warnings: string[];
  readonly errors: string[];
  readonly duplicates: ReadonlyArray<Readonly<{ key: KeyId; actions: ShortcutAction[] }>>;
}

export interface LoadedShortcutConfig extends ShortcutDiagnostics {
  readonly config: ShortcutConfig;
  readonly path: string;
  readonly sourcePath?: string;
}

export type ShortcutParseResult =
  | { readonly ok: true; readonly value: ShortcutValue; readonly canonical: string }
  | { readonly ok: false; readonly error: string };

const MODIFIERS = ["ctrl", "shift", "alt", "super"] as const;
const SPECIAL_KEYS = new Map<string, string>([
  ["esc", "escape"],
  ["escape", "escape"],
  ["return", "enter"],
  ["enter", "enter"],
  ["pageup", "pageUp"],
  ["pagedown", "pageDown"],
  ["backspace", "backspace"],
  ["delete", "delete"],
  ["insert", "insert"],
  ["clear", "clear"],
  ["home", "home"],
  ["end", "end"],
  ["up", "up"],
  ["down", "down"],
  ["left", "left"],
  ["right", "right"],
  ...Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, `f${index + 1}`] as const),
]);
const SYMBOL_KEYS = new Set(["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?"]);
const COMMON_PI_BINDINGS = new Set([
  "escape",
  "ctrl+c",
  "ctrl+d",
  "ctrl+g",
  "ctrl+l",
  "ctrl+p",
  "ctrl+shift+p",
  "ctrl+o",
  "ctrl+t",
  "shift+tab",
  "alt+enter",
]);

export function parseShortcut(value: unknown): ShortcutParseResult {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined, canonical: "none" };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "Shortcut must be a string, empty, or none." };
  }

  const input = value.trim().toLowerCase();
  if (input === "" || input === "none") {
    return { ok: true, value: undefined, canonical: "none" };
  }

  const modifiers: string[] = [];
  let remaining = input;
  while (true) {
    const match = remaining.match(/^(ctrl|shift|alt|super)\+/);
    if (!match) break;
    const modifier = match[1];
    if (!modifier || modifiers.includes(modifier)) {
      return { ok: false, error: `Shortcut has a duplicate modifier: ${modifier ?? "unknown"}.` };
    }
    modifiers.push(modifier);
    remaining = remaining.slice(match[0].length);
  }

  if (!remaining) return { ok: false, error: "Shortcut is missing its key." };
  const special = SPECIAL_KEYS.get(remaining);
  const isLetterOrDigit = /^[a-z0-9]$/.test(remaining);
  if (!special && !isLetterOrDigit && !SYMBOL_KEYS.has(remaining)) {
    return { ok: false, error: `Unsupported key: ${remaining}.` };
  }

  const orderedModifiers = MODIFIERS.filter((modifier) => modifiers.includes(modifier));
  const key = special ?? remaining;
  const canonical = [...orderedModifiers, key].join("+");
  return { ok: true, value: canonical as KeyId, canonical };
}

export function parseShortcutConfig(raw: unknown): {
  readonly config: ShortcutConfig;
  readonly diagnostics: ShortcutDiagnostics;
} {
  const warnings: string[] = [];
  const errors: string[] = [];
  const value = isRecord(raw) ? raw : {};
  if (raw !== undefined && !isRecord(raw)) {
    errors.push("Configuration must be a JSON object.");
  }
  if (value.version !== undefined && value.version !== 1) {
    errors.push("Only shortcut configuration version 1 is supported.");
  }

  const rawShortcuts = isRecord(value.shortcuts) ? value.shortcuts : {};
  if (value.shortcuts !== undefined && !isRecord(value.shortcuts)) {
    errors.push("The shortcuts field must be an object.");
  }
  const customFooter = value.customFooter === undefined ? DEFAULT_CUSTOM_FOOTER : value.customFooter;
  if (typeof customFooter !== "boolean") {
    errors.push("The customFooter field must be a boolean.");
  }

  const shortcuts: Record<ShortcutAction, ShortcutValue> = {
    openStatus: undefined,
    quickCommit: undefined,
  };
  for (const action of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
    const candidate = rawShortcuts[action];
    const parsed = parseShortcut(candidate === undefined ? DEFAULT_SHORTCUTS[action] : candidate);
    if (!parsed.ok) {
      errors.push(`${action}: ${parsed.error}`);
      shortcuts[action] = defaultShortcutValue(action);
    } else {
      shortcuts[action] = parsed.value;
    }
  }

  const byKey = new Map<KeyId, ShortcutAction[]>();
  for (const action of Object.keys(shortcuts) as ShortcutAction[]) {
    const key = shortcuts[action];
    if (!key) continue;
    const actions = byKey.get(key) ?? [];
    actions.push(action);
    byKey.set(key, actions);
    if (COMMON_PI_BINDINGS.has(key)) {
      warnings.push(`${action} uses ${key}, which may collide with a pi built-in shortcut.`);
    }
  }

  const duplicates: Array<{ key: KeyId; actions: ShortcutAction[] }> = [];
  for (const [key, actions] of byKey) {
    if (actions.length > 1) {
      duplicates.push({ key, actions });
      errors.push(`The pi-git shortcuts ${actions.join(" and ")} use the same key: ${key}.`);
    }
  }

  return {
    config: {
      version: 1,
      shortcuts,
      customFooter: typeof customFooter === "boolean" ? customFooter : DEFAULT_CUSTOM_FOOTER,
    },
    diagnostics: { warnings, errors, duplicates },
  };
}

export function loadShortcutConfig(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): LoadedShortcutConfig {
  const configuredDir = env.PI_CODING_AGENT_DIR?.trim();
  const fallbackPath = path.join(homeDirectory, ".pi", "agent", "pi-git.json");
  const primaryPath = path.join(configuredDir || path.join(homeDirectory, ".pi", "agent"), "pi-git.json");
  const candidates = primaryPath === fallbackPath ? [primaryPath] : [primaryPath, fallbackPath];

  const warnings: string[] = [];
  const errors: string[] = [];
  let sourcePath: string | undefined;
  let raw: unknown;
  for (const candidate of candidates) {
    try {
      raw = JSON.parse(fs.readFileSync(candidate, "utf8")) as unknown;
      sourcePath = candidate;
      break;
    } catch (error: unknown) {
      if (isFileNotFound(error)) continue;
      warnings.push(`Could not read ${candidate}; using default pi-git settings.`);
      break;
    }
  }

  const parsed = parseShortcutConfig(raw);
  warnings.push(...parsed.diagnostics.warnings);
  errors.push(...parsed.diagnostics.errors);
  if (errors.length > 0) {
    warnings.push(...errors.map((error) => `Invalid pi-git configuration: ${error}`));
  }

  return {
    config: parsed.config,
    warnings,
    errors,
    duplicates: parsed.diagnostics.duplicates,
    path: primaryPath,
    ...(sourcePath ? { sourcePath } : {}),
  };
}

export function validateShortcutConfig(config: ShortcutConfig): ShortcutDiagnostics {
  return parseShortcutConfig({
    version: config.version,
    shortcuts: {
      openStatus: config.shortcuts.openStatus ?? "none",
      quickCommit: config.shortcuts.quickCommit ?? "none",
    },
    customFooter: config.customFooter,
  }).diagnostics;
}

export function writeShortcutConfig(
  config: ShortcutConfig,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const diagnostics = validateShortcutConfig(config);
  if (diagnostics.errors.length > 0) {
    throw new Error(diagnostics.errors.join(" "));
  }

  const directory = env.PI_CODING_AGENT_DIR?.trim() || path.join(homeDirectory, ".pi", "agent");
  const target = path.join(directory, "pi-git.json");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.pi-git.${process.pid}.${Date.now()}.tmp`);
  const serializable = {
    version: 1,
    shortcuts: {
      openStatus: config.shortcuts.openStatus ?? "none",
      quickCommit: config.shortcuts.quickCommit ?? "none",
    },
    customFooter: config.customFooter,
  };

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "w", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(serializable, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // The atomic rename already completed. Permissions are best effort on platforms that ignore chmod.
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
  return target;
}

export function resetShortcut(config: ShortcutConfig, action: ShortcutAction): ShortcutConfig {
  return {
    version: 1,
    shortcuts: {
      ...config.shortcuts,
      [action]: defaultShortcutValue(action),
    },
    customFooter: config.customFooter,
  };
}

export function resetAllShortcuts(): ShortcutConfig {
  return {
    version: 1,
    shortcuts: {
      openStatus: defaultShortcutValue("openStatus"),
      quickCommit: defaultShortcutValue("quickCommit"),
    },
    customFooter: DEFAULT_CUSTOM_FOOTER,
  };
}

export function shortcutHelp(config: ShortcutConfig): string[] {
  const format = (value: ShortcutValue) => value ?? "disabled";
  return [
    `Open Git status: ${format(config.shortcuts.openStatus)}`,
    `Quick commit: ${format(config.shortcuts.quickCommit)}`,
    `Custom footer: ${config.customFooter ? "enabled" : "disabled"}`,
  ];
}

function defaultShortcutValue(action: ShortcutAction): ShortcutValue {
  const parsed = parseShortcut(DEFAULT_SHORTCUTS[action]);
  return parsed.ok ? parsed.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
