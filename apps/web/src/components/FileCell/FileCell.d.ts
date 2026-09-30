import type { ReactNode } from 'react';
export interface FileCellProps {
  name: string;
  kind?: 'file'|'folder';
  /** Secondary line: path, version count, MIME type. */
  meta?: ReactNode;
  /** Override the extension chip, e.g. for files with no suffix. */
  ext?: string;
  /** Marks objects an agent created — the core AgentDisk provenance signal. */
  agentWritten?: boolean;
}
export declare function FileCell(props: FileCellProps): JSX.Element;
