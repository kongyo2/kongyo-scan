type Env = Readonly<Record<string, string | undefined>>;

export interface StreamLike {
  isTTY?: boolean | undefined;
  columns?: number | undefined;
  write(chunk: string): boolean;
}

export interface TerminalFlags {
  json?: boolean | undefined;
  nonInteractive?: boolean | undefined;
  noColor?: boolean | undefined;
  debug?: boolean | undefined;
}

export interface Terminal {
  stdout: StreamLike;
  stderr: StreamLike;
  interactive: boolean;
  nonInteractiveReason: string | undefined;
  json: boolean;
  stdoutRich: boolean;
  stderrRich: boolean;
  stdoutColor: boolean;
  stderrColor: boolean;
  stdoutColumns: number;
  stderrColumns: number;
  debug: boolean;
  agent: boolean;
  ci: boolean;
}

const AGENT_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CODEX_SANDBOX",
  "CODEX_THREAD_ID",
  "CURSOR_AGENT",
  "GEMINI_CLI",
  "OPENCODE",
  "AIDER",
  "AI_AGENT",
] as const;

export function detectAgent(env: Env): boolean {
  return AGENT_VARIABLES.some((name) => {
    const value = env[name];
    return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
  });
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function colorFor(stream: StreamLike, flags: TerminalFlags, env: Env): boolean {
  if (flags.noColor) return false;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  const forced = env["FORCE_COLOR"];
  if (forced !== undefined && forced !== "")
    return forced !== "0" && forced.toLowerCase() !== "false";
  return stream.isTTY === true && env["TERM"] !== "dumb";
}

export function resolveTerminal(
  flags: TerminalFlags,
  env: Env = process.env,
  streams: {
    stdin: { isTTY?: boolean | undefined };
    stdout: StreamLike;
    stderr: StreamLike;
  } = process,
): Terminal {
  const ci = truthy(env["CI"]);
  const agent = detectAgent(env);
  const stdinTty = streams.stdin.isTTY === true;
  const stderrTty = streams.stderr.isTTY === true;
  const json = flags.json === true;

  let reason: string | undefined;
  if (json) reason = "--json";
  else if (flags.nonInteractive === true) reason = "--non-interactive";
  else if (ci) reason = "CI";
  else if (!stdinTty || !stderrTty) reason = "no terminal";
  else if (agent && flags.nonInteractive !== false) reason = "a coding agent";

  const dumb = env["TERM"] === "dumb";
  return {
    stdout: streams.stdout,
    stderr: streams.stderr,
    interactive: reason === undefined,
    nonInteractiveReason: reason,
    json,
    stdoutRich: streams.stdout.isTTY === true && !dumb,
    stderrRich: stderrTty && !dumb,
    stdoutColor: !json && colorFor(streams.stdout, flags, env),
    stderrColor: !json && colorFor(streams.stderr, flags, env),
    stdoutColumns:
      streams.stdout.columns && streams.stdout.columns > 0 ? streams.stdout.columns : 80,
    stderrColumns:
      streams.stderr.columns && streams.stderr.columns > 0 ? streams.stderr.columns : 80,
    debug: flags.debug === true || truthy(env["KONGYO_SCAN_DEBUG"]),
    agent,
    ci,
  };
}
