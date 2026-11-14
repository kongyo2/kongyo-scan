import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AppContext } from "../app/context.js";
import { loadKeys } from "../app/context.js";
import { booleanOption, type CommandSpec, type ParsedArgs, requireArgument } from "../cli/args.js";
import { deleteProviderKey, setProviderKey } from "../config/credentials.js";
import { CONFIG_SCHEMA_URL } from "../config/json-schema.js";
import {
  flattenConfig,
  getValue,
  isSecretKey,
  maskSecret,
  settingDocs,
  setValue,
  splitKey,
  unsetValue,
} from "../config/keys.js";
import type { Config } from "../config/schema.js";
import { loadConfigFile, saveConfigFile } from "../config/store.js";
import { CliError, isNodeError, usageError } from "../core/errors.js";
import { displayPath } from "../core/paths.js";
import { BIN } from "../version.js";

const JSON_OPTION = {
  name: "json",
  type: "boolean",
  description: "Output the result as JSON",
} as const;

function display(value: unknown, secret: boolean): string {
  if (secret && typeof value === "string") return maskSecret(value);
  if (typeof value === "string") return value;
  return JSON.stringify(masked(value));
}

/** Replace every credential in a value with its mask, for output. */
function masked(value: unknown, segments: string[] = []): unknown {
  if (Array.isArray(value))
    return value.map((item, index) => masked(item, [...segments, String(index)]));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        masked(child, [...segments, key]),
      ]),
    );
  }
  return typeof value === "string" && isSecretKey(segments) ? maskSecret(value) : value;
}

/** The provider whose API key a setting name addresses, when it addresses one. */
function storedKeyTarget(config: Config, key: string): string | undefined {
  const segments = splitKey(key, config);
  if (segments.length !== 3 || segments[0] !== "providers" || segments[2] !== "api_key")
    return undefined;
  const name = segments[1]!;
  const match = (config.providers ?? []).find(
    (provider) => provider.name.toLowerCase() === name.toLowerCase(),
  );
  if (!match) {
    throw new CliError("not_found", `Couldn't find provider ${JSON.stringify(name)}.`, {
      reason: "provider_not_found",
      next: [{ label: "List configured providers", argv: [BIN, "providers", "list"] }],
    });
  }
  return match.name;
}

async function listConfig(context: AppContext): Promise<number> {
  const { output, terminal } = context;
  const { config, exists } = await loadConfigFile(context.paths.configFile);
  if (terminal.json) {
    output.json({
      config: masked(config) as Record<string, unknown>,
      path: context.paths.configFile,
      exists,
    });
    return 0;
  }
  const keys = await loadKeys(context);
  const rows = flattenConfig(config);
  for (const provider of config.providers ?? []) {
    const stored = keys[provider.name.toLowerCase()];
    if (stored === undefined) continue;
    const key = `providers.${provider.name}.api_key`;
    const existing = rows.find((row) => row.key === key);
    if (existing) {
      existing.value = stored;
      continue;
    }
    // Show the stored key with the provider's other fields, not at the end of the list.
    const last = rows.findLastIndex(
      (row) => splitKey(row.key, config)[1] === provider.name && row.key.startsWith("providers."),
    );
    rows.splice(last < 0 ? rows.length : last + 1, 0, { key, value: stored, secret: true });
  }
  rows.sort(
    (a, b) => Number(a.key.startsWith("providers.")) - Number(b.key.startsWith("providers.")),
  );
  if (rows.length === 0) {
    output.info(`  No settings in ${displayPath(context.paths.configFile, context.env)}.`);
    output.next([{ label: "Add a provider to get started", argv: [BIN, "providers", "add"] }]);
    return 0;
  }
  if (output.out.rich) {
    output.table(
      [{ header: "Setting" }, { header: "Value", shrink: true }],
      rows.map((row) => [row.key, display(row.value, row.secret)]),
    );
  } else {
    for (const row of rows) output.line(`${row.key}\t${display(row.value, row.secret)}`);
  }
  return 0;
}

async function getConfig(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal } = context;
  const key = requireArgument(args, 0, "key", `${BIN} config get`);
  const { config } = await loadConfigFile(context.paths.configFile);
  const stored = storedKeyTarget(config, key);
  const value =
    stored === undefined
      ? getValue(config, key)
      : ((await loadKeys(context))[stored.toLowerCase()] ?? getValue(config, key));
  if (value === undefined) {
    throw new CliError("not_found", `${key} is not set.`, {
      reason: "not_found",
      next: [{ label: "List the settings that are set", argv: [BIN, "config", "list"] }],
    });
  }
  const secret = isSecretKey(splitKey(key, config));
  if (terminal.json) {
    output.json({
      setting: {
        key,
        value:
          secret && typeof value === "string"
            ? maskSecret(value)
            : masked(value, splitKey(key, config)),
        secret,
      },
    });
    return 0;
  }
  output.line(display(value, secret));
  return 0;
}

async function setConfig(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal } = context;
  const key = requireArgument(args, 0, "key", `${BIN} config set`);
  const raw = requireArgument(args, 1, "value", `${BIN} config set`);
  const { config } = await loadConfigFile(context.paths.configFile);
  const provider = storedKeyTarget(config, key);
  if (provider !== undefined) {
    // Keys never go into the settings file, which scans can read; they go to protected storage.
    if (raw.trim() === "") throw usageError(`Can't set ${key} to an empty value.`);
    await setProviderKey(context.paths.credentialsFile, provider, raw.trim());
    if (getValue(config, key) !== undefined) {
      await saveConfigFile(
        context.paths.configFile,
        unsetValue(config, key, context.paths.configFile).config,
      );
    }
    if (terminal.json)
      output.json({
        setting: { key, value: maskSecret(raw.trim()), secret: true },
        outcome: "set",
      });
    else {
      output.success("Set", key);
      output.row("Value", maskSecret(raw.trim()));
      output.row("Stored", "outside the settings file, where scans cannot read it");
      if (!terminal.stdout.isTTY) output.line(key);
    }
    return 0;
  }
  const next: Config = setValue(config, key, raw, context.paths.configFile);
  await saveConfigFile(context.paths.configFile, next);
  const segments = splitKey(key, next);
  const value = getValue(next, key);
  const secret = isSecretKey(segments);
  if (terminal.json) {
    output.json({
      setting: {
        key,
        value: secret && typeof value === "string" ? maskSecret(value) : masked(value, segments),
        secret,
      },
      outcome: "set",
    });
    return 0;
  }
  output.success("Set", key);
  output.row("Value", display(value, secret));
  if (!terminal.stdout.isTTY) output.line(key);
  return 0;
}

async function unsetConfig(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal } = context;
  const key = requireArgument(args, 0, "key", `${BIN} config unset`);
  const { config } = await loadConfigFile(context.paths.configFile);
  const provider = storedKeyTarget(config, key);
  const result = unsetValue(config, key, context.paths.configFile);
  if (result.changed) await saveConfigFile(context.paths.configFile, result.config);
  if (provider !== undefined && (await deleteProviderKey(context.paths.credentialsFile, provider)))
    result.changed = true;
  if (terminal.json) {
    output.json({ setting: { key }, outcome: result.changed ? "unset" : "unchanged" });
    return 0;
  }
  if (result.changed) output.success("Unset", key);
  else output.info(`  ${key} is not set.`);
  if (!terminal.stdout.isTTY) output.line(key);
  return 0;
}

async function configKeys(context: AppContext): Promise<number> {
  const { output, terminal } = context;
  const docs = settingDocs();
  if (terminal.json) {
    output.json({ settings: docs, pagination: { next: null } });
    return 0;
  }
  output.table(
    [{ header: "Setting" }, { header: "Type" }, { header: "Description", shrink: true }],
    docs.map((doc) => [doc.key, doc.type, doc.description]),
  );
  return 0;
}

async function configPath(context: AppContext): Promise<number> {
  const { output, terminal } = context;
  if (terminal.json) output.json({ path: context.paths.configFile, home: context.paths.home });
  else output.line(context.paths.configFile);
  return 0;
}

export const configCommand: CommandSpec<AppContext> = {
  name: "config",
  group: "Configure",
  summary: "Read and change settings",
  defaultSubcommand: "list",
  subcommands: [
    {
      name: "list",
      aliases: ["ls"],
      summary: "List the settings that are set",
      options: [JSON_OPTION],
      run: listConfig,
    },
    {
      name: "get",
      summary: "Print one setting",
      arguments: [
        { name: "key", description: "Dotted setting name, such as scan.mode", required: true },
      ],
      options: [JSON_OPTION],
      notes: ["API keys are always shown masked."],
      run: getConfig,
    },
    {
      name: "set",
      summary: "Set one setting",
      arguments: [
        {
          name: "key",
          description: "Dotted setting name, such as policy.fail_on_severity",
          required: true,
        },
        { name: "value", description: "New value; JSON for lists and objects", required: true },
      ],
      options: [JSON_OPTION],
      examples: [
        {
          label: "Use the highest reasoning effort for scans",
          argv: [BIN, "config", "set", "reasoning_effort", "max"],
        },
        {
          label: "Fail CI on high or critical findings",
          argv: [BIN, "config", "set", "policy.fail_on_severity", "high"],
        },
        {
          label: "Change one provider's model",
          argv: [BIN, "config", "set", "providers.<PROVIDER>.model", "<NAME>"],
        },
        {
          label: "Pass a native Codex setting",
          argv: [BIN, "config", "set", "codex.analytics.enabled", "false"],
        },
      ],
      notes: [
        "An API key set here is stored outside the settings file, where scans cannot read it.",
        "Use providers add or providers update --api-key-stdin to keep a key off the command line.",
      ],
      run: setConfig,
    },
    {
      name: "unset",
      summary: "Remove one setting",
      arguments: [{ name: "key", description: "Dotted setting name", required: true }],
      options: [JSON_OPTION],
      run: unsetConfig,
    },
    {
      name: "keys",
      summary: "List every setting with its type and meaning",
      options: [JSON_OPTION],
      run: configKeys,
    },
    {
      name: "path",
      summary: "Print the path of the settings file",
      options: [JSON_OPTION],
      run: configPath,
    },
  ],
};

const STARTER = {
  $schema: CONFIG_SCHEMA_URL,
  scan: { mode: "standard" },
  policy: { fail_on_severity: "high" },
};

async function initProject(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal } = context;
  const file = resolve(context.cwd, args.positionals[0] ?? "kongyo-scan.json");
  const force = booleanOption(args, "force") === true;
  try {
    // "wx" refuses to follow through to an existing file, so nothing is overwritten by accident.
    await writeFile(file, `${JSON.stringify(STARTER, null, 2)}\n`, {
      encoding: "utf8",
      flag: force ? "w" : "wx",
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new CliError("conflict", `Can't create ${file}. The file already exists.`, {
        reason: "file_exists",
        next: [
          {
            label: "Replace it",
            argv: [BIN, "init", args.positionals[0] ?? "kongyo-scan.json", "--force"],
          },
        ],
      });
    }
    throw new CliError(
      "platform",
      `Failed to create ${file}. ${isNodeError(error) ? error.message : String(error)}`,
      {
        reason: "internal_error",
        cause: error,
      },
    );
  }
  const next = [
    {
      label: "Preview a scan with these settings",
      argv: [BIN, "scan", "--config", file, "--dry-run"],
    },
  ];
  if (terminal.json) {
    output.json({ file: { path: file }, outcome: force ? "replaced" : "created" }, next);
    return 0;
  }
  output.success("Created", file);
  output.info("  Edit it to set the scope, mode, and failure policy for this repository.");
  if (!terminal.stdout.isTTY) output.line(file);
  output.next(next);
  return 0;
}

export const initCommand: CommandSpec<AppContext> = {
  name: "init",
  group: "Configure",
  summary: "Create a starter settings file for a repository",
  arguments: [{ name: "file", description: "File to create (default: kongyo-scan.json)" }],
  options: [
    { name: "force", type: "boolean", description: "Replace the file if it exists" },
    JSON_OPTION,
  ],
  notes: [
    "The file is used only when you pass it with --config or KONGYO_SCAN_CONFIG; it is never picked up on its own.",
    "It may hold any setting, but keep API keys in your own settings with providers add.",
  ],
  run: initProject,
};
