import { Box, Text, useAnimation, useInput, usePaste, useWindowSize } from "ink";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

import { displayWidth, padEnd } from "../cli/theme.js";

const ColorContext = createContext(true);

export function ColorProvider(props: { color: boolean; children: ReactNode }): ReactNode {
  return <ColorContext.Provider value={props.color}>{props.children}</ColorContext.Provider>;
}

export type Tone = "success" | "warning" | "danger" | "accent" | "command";

const TONE_COLORS: Record<Tone, string> = {
  success: "green",
  warning: "yellow",
  danger: "red",
  accent: "magenta",
  command: "cyan",
};

export function Tint(props: { tone: Tone; bold?: boolean; children: ReactNode }): ReactNode {
  const color = useContext(ColorContext);
  if (!color) return <Text bold={props.bold === true}>{props.children}</Text>;
  return (
    <Text color={TONE_COLORS[props.tone]} bold={props.bold === true}>
      {props.children}
    </Text>
  );
}

export function Faint(props: { children: ReactNode }): ReactNode {
  const color = useContext(ColorContext);
  return <Text dimColor={color}>{props.children}</Text>;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner(): ReactNode {
  const { frame } = useAnimation({ interval: 90 });
  return <Tint tone="accent">{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</Tint>;
}

export function useListRows(maximum: number, reserved: number): number {
  const { rows } = useWindowSize();
  const height = Number.isFinite(rows) && rows > 0 ? rows : 24;
  return Math.max(4, Math.min(maximum, height - reserved));
}

export interface KeyHint {
  keys: string;
  label: string;
}

export function KeyHints(props: { hints: readonly KeyHint[] }): ReactNode {
  return (
    <Box flexWrap="wrap" columnGap={2}>
      {props.hints.map((hint) => (
        <Text key={`${hint.keys}:${hint.label}`}>
          <Text bold>{hint.keys}</Text>
          <Faint> {hint.label}</Faint>
        </Text>
      ))}
    </Box>
  );
}

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface SelectListProps<T> {
  choices: readonly Choice<T>[];
  onSelect: (value: T) => void;
  onCancel?: (() => void) | undefined;
  limit?: number;
  searchable?: boolean;
  initialIndex?: number;
  isActive?: boolean;
  onHighlight?: (value: T) => void;
}

export function SelectList<T>(props: SelectListProps<T>): ReactNode {
  const limit = props.limit ?? 10;
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(props.initialIndex ?? 0);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!props.searchable || needle === "") return props.choices;
    return props.choices.filter((choice) =>
      `${choice.label} ${choice.hint ?? ""}`.toLowerCase().includes(needle),
    );
  }, [props.choices, props.searchable, query]);
  const focused = Math.min(index, Math.max(0, filtered.length - 1));

  const move = (delta: number): void => {
    if (filtered.length === 0) return;
    let next = focused;
    for (let step = 0; step < filtered.length; step++) {
      next = (next + delta + filtered.length) % filtered.length;
      if (!filtered[next]?.disabled) break;
    }
    setIndex(next);
    const choice = filtered[next];
    if (choice) props.onHighlight?.(choice.value);
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        props.onCancel?.();
        return;
      }
      if (key.return) {
        const choice = filtered[focused];
        if (choice && !choice.disabled) props.onSelect(choice.value);
        return;
      }
      if (key.upArrow || (!props.searchable && input === "k")) move(-1);
      else if (key.downArrow || (!props.searchable && input === "j")) move(1);
      else if (key.pageUp) move(-limit);
      else if (key.pageDown) move(limit);
      else if (props.searchable) {
        if (key.backspace || key.delete) {
          setQuery((current) => current.slice(0, -1));
          setIndex(0);
        } else if (input !== "" && !key.ctrl && !key.meta && !key.tab) {
          setQuery((current) => current + input);
          setIndex(0);
        }
      }
    },
    { isActive: props.isActive !== false },
  );
  usePaste(
    (text) => {
      setQuery((current) => current + text.replaceAll(/[\r\n]/gu, ""));
      setIndex(0);
    },
    { isActive: props.isActive !== false && props.searchable === true },
  );

  const start = Math.max(
    0,
    Math.min(focused - Math.floor(limit / 2), Math.max(0, filtered.length - limit)),
  );
  const visible = filtered.slice(start, start + limit);
  const labelWidth = filtered.some((choice) => choice.hint)
    ? Math.min(40, Math.max(0, ...filtered.map((choice) => displayWidth(choice.label))))
    : 0;
  return (
    <Box flexDirection="column">
      {props.searchable ? (
        <Text>
          <Faint>Filter: </Faint>
          {query}
          <Text inverse> </Text>
        </Text>
      ) : null}
      {start > 0 ? <Faint> ↑ {start} more</Faint> : null}
      {visible.length === 0 ? <Faint> No choices match this filter.</Faint> : null}
      {visible.map((choice, offset) => {
        const active = start + offset === focused;
        return (
          <Text key={`${start + offset}:${choice.label}`} wrap="truncate-end">
            {active ? <Tint tone="accent">› </Tint> : "  "}
            <Text bold={active} dimColor={choice.disabled === true}>
              {choice.hint ? padEnd(choice.label, labelWidth) : choice.label}
            </Text>
            {choice.hint ? <Faint>{`  ${choice.hint}`}</Faint> : null}
          </Text>
        );
      })}
      {start + limit < filtered.length ? (
        <Faint> ↓ {filtered.length - start - limit} more</Faint>
      ) : null}
    </Box>
  );
}

export interface TextFieldProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel?: (() => void) | undefined;
  placeholder?: string;
  mask?: boolean;
  isActive?: boolean;
}

export function TextField(props: TextFieldProps): ReactNode {
  const active = props.isActive !== false;
  useInput(
    (input, key) => {
      if (key.return) props.onSubmit(props.value);
      else if (key.escape) props.onCancel?.();
      else if (key.backspace || key.delete) props.onChange(props.value.slice(0, -1));
      else if (key.ctrl && input === "u") props.onChange("");
      else if (
        input !== "" &&
        !key.ctrl &&
        !key.meta &&
        !key.tab &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow
      ) {
        props.onChange(props.value + input.replaceAll(/[\r\n]/gu, ""));
      }
    },
    { isActive: active },
  );
  usePaste((text) => props.onChange(props.value + text.replaceAll(/[\r\n]/gu, "").trim()), {
    isActive: active,
  });
  const shown = props.mask ? "•".repeat(props.value.length) : props.value;
  return (
    <Text>
      {shown === "" && props.placeholder ? <Faint>{props.placeholder}</Faint> : shown}
      {active ? <Text inverse> </Text> : null}
    </Text>
  );
}

export function Row(props: { label: string; children: ReactNode; width?: number }): ReactNode {
  return (
    <Box>
      <Box width={props.width ?? 14} flexShrink={0}>
        <Faint>{props.label}</Faint>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="truncate-end">{props.children}</Text>
      </Box>
    </Box>
  );
}
