import type { ReactNode } from 'react';
export interface InputProps {
  label?: string;
  /** Shown below when there is no error. Explain the constraint, not the obvious. */
  hint?: string;
  /** Replaces the hint. Sets aria-invalid and the red border. */
  error?: string;
  optional?: boolean;
  required?: boolean;
  /** Static text glued to the left, e.g. "agentdisk.io/". */
  prefix?: ReactNode;
  suffix?: ReactNode;
  leadingIcon?: ReactNode;
  /** Use for keys, paths, IDs, endpoints — anything a machine reads. */
  mono?: boolean;
  size?: 'md'|'lg';
  multiline?: boolean;
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  type?: string;
  id?: string;
  className?: string;
  onChange?: (e: any) => void;
}
export declare function Input(props: InputProps): JSX.Element;
