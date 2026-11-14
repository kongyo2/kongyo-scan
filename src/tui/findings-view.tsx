import { Box, Text, useInput } from "ink";
import { type ReactNode, useState } from "react";

import { wrapText } from "../cli/theme.js";
import {
  type FindingSummary,
  formatCounts,
  formatLocation,
  countSeverities,
  type Severity,
} from "../scan/results.js";
import { Faint, KeyHints, Row, Tint, type Tone } from "./components.js";

const SEVERITY_TONE: Record<Severity, Tone | undefined> = {
  critical: "danger",
  high: "danger",
  medium: "warning",
  low: undefined,
  informational: undefined,
};

export function SeverityLabel(props: { severity: Severity; width?: number }): ReactNode {
  const text = props.severity.padEnd(props.width ?? 0);
  const tone = SEVERITY_TONE[props.severity];
  return tone ? <Tint tone={tone}>{text}</Tint> : <Text>{text}</Text>;
}

export interface FindingsViewProps {
  /** Headline row, such as the scan outcome. */
  heading: ReactNode;
  /** Label/value rows shown under the heading. */
  facts: readonly (readonly [string, string])[];
  findings: readonly FindingSummary[];
  columns: number;
  rows: number;
  onBack: () => void;
  isActive?: boolean;
}

/** Browse a scan's findings: a list, and a scrollable detail view for the focused one. */
export function FindingsView(props: FindingsViewProps): ReactNode {
  const [index, setIndex] = useState(0);
  const [detail, setDetail] = useState(false);
  const [scroll, setScroll] = useState(0);
  const width = Math.max(40, Math.min(props.columns, 110));
  const finding = props.findings[Math.min(index, props.findings.length - 1)];

  const detailLines = (): string[] => {
    if (!finding) return [];
    const lines: string[] = [];
    const section = (label: string, text: string | undefined): void => {
      if (!text) return;
      if (lines.length > 0) lines.push("");
      lines.push(`# ${label}`);
      lines.push(...wrapText(text, width - 2));
    };
    section("Summary", finding.summary);
    section("Root cause", finding.rootCause);
    section("Fix", finding.remediation);
    section("How it was validated", finding.validation);
    if (finding.evidence.length > 0) {
      lines.push("", "# Evidence");
      for (const evidence of finding.evidence) {
        lines.push(
          `${evidence.path}${evidence.startLine === undefined ? "" : `:${evidence.startLine}`}${evidence.label ? `  ${evidence.label}` : ""}`,
        );
        for (const codeLine of (evidence.code ?? "").split("\n").slice(0, 8))
          lines.push(`  ${codeLine}`);
      }
    }
    return lines;
  };
  const lines = detail ? detailLines() : [];
  const viewport = Math.max(5, props.rows - 10);
  const maxScroll = Math.max(0, lines.length - viewport);

  useInput(
    (input, key) => {
      if (detail) {
        if (key.escape || input === "b" || key.leftArrow || key.return) {
          setDetail(false);
          setScroll(0);
        } else if (key.upArrow || input === "k") setScroll((current) => Math.max(0, current - 1));
        else if (key.downArrow || input === "j")
          setScroll((current) => Math.min(maxScroll, current + 1));
        else if (key.pageUp) setScroll((current) => Math.max(0, current - viewport));
        else if (key.pageDown || input === " ")
          setScroll((current) => Math.min(maxScroll, current + viewport));
        return;
      }
      if (key.escape || input === "b" || key.leftArrow) props.onBack();
      else if (key.upArrow || input === "k") setIndex((current) => Math.max(0, current - 1));
      else if (key.downArrow || input === "j")
        setIndex((current) => Math.min(props.findings.length - 1, current + 1));
      else if ((key.return || key.rightArrow) && finding) setDetail(true);
    },
    { isActive: props.isActive !== false },
  );

  if (detail && finding) {
    return (
      <Box flexDirection="column" width={width}>
        <Text bold wrap="truncate-end">
          {finding.title}
        </Text>
        <Text>
          <SeverityLabel severity={finding.severity} />
          <Faint>{`${finding.confidence ? `  ·  ${finding.confidence} confidence` : ""}${formatLocation(finding) ? `  ·  ${formatLocation(finding)}` : ""}${finding.cwe.length > 0 ? `  ·  ${finding.cwe.join(", ")}` : ""}`}</Faint>
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {lines.slice(scroll, scroll + viewport).map((line, offset) =>
            line.startsWith("# ") ? (
              <Text key={`${scroll + offset}`} bold>
                {line.slice(2)}
              </Text>
            ) : (
              <Text key={`${scroll + offset}`} wrap="truncate-end">
                {line === "" ? " " : line}
              </Text>
            ),
          )}
        </Box>
        <Box marginTop={1}>
          <KeyHints
            hints={[
              ...(maxScroll > 0
                ? [
                    {
                      keys: "↑↓",
                      label: `scroll (${Math.min(lines.length, scroll + viewport)}/${lines.length})`,
                    },
                  ]
                : []),
              { keys: "Enter", label: "back to the list" },
            ]}
          />
        </Box>
      </Box>
    );
  }

  const listRows = Math.max(3, props.rows - 12 - props.facts.length);
  const start = Math.max(
    0,
    Math.min(index - Math.floor(listRows / 2), Math.max(0, props.findings.length - listRows)),
  );
  const locationWidth = Math.min(
    34,
    Math.max(8, ...props.findings.map((item) => formatLocation(item).length)),
  );
  return (
    <Box flexDirection="column" width={width}>
      {props.heading}
      <Box flexDirection="column" marginTop={1}>
        {props.facts.map(([label, value]) => (
          <Row key={label} label={label}>
            {value}
          </Row>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {props.findings.length === 0 ? (
          <Faint>No findings were reported for this scope.</Faint>
        ) : (
          <>
            <Faint>{`Findings: ${formatCounts(countSeverities(props.findings))}`}</Faint>
            {start > 0 ? <Faint> ↑ {start} more</Faint> : null}
            {props.findings.slice(start, start + listRows).map((item, offset) => {
              const active = start + offset === index;
              return (
                <Text key={item.id} wrap="truncate-end">
                  {active ? <Tint tone="accent">› </Tint> : "  "}
                  <SeverityLabel severity={item.severity} width={9} />
                  <Faint>{formatLocation(item).padEnd(locationWidth)} </Faint>
                  <Text bold={active}>{item.title}</Text>
                </Text>
              );
            })}
            {start + listRows < props.findings.length ? (
              <Faint> ↓ {props.findings.length - start - listRows} more</Faint>
            ) : null}
          </>
        )}
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            ...(props.findings.length > 0
              ? [
                  { keys: "↑↓", label: "move" },
                  { keys: "Enter", label: "read the finding" },
                ]
              : []),
            { keys: "b", label: "back" },
          ]}
        />
      </Box>
    </Box>
  );
}
