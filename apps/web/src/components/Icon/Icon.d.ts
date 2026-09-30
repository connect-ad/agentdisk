import type { SVGProps } from 'react';
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  /** Glyph name from the AgentDisk set. */
  name?: 'dashboard'|'folder'|'file'|'filePlus'|'upload'|'download'|'key'|'agent'|'activity'|'chart'|'clock'|'gear'|'search'|'plus'|'minus'|'chevronDown'|'chevronRight'|'chevronLeft'|'chevronUpDown'|'copy'|'trash'|'check'|'x'|'alert'|'info'|'lock'|'unlock'|'more'|'link'|'refresh'|'shield'|'book'|'terminal'|'eye'|'eyeOff'|'menu'|'external'|'users'|'database'|'billing'|'logout'|'drag'|'pin'|'bolt'|'archive';
  /** Pixel box. Use 14 in dense rows, 16 default, 20 in headers. */
  size?: number;
  strokeWidth?: number;
  /** Supplying a title makes the icon exposed to screen readers. */
  title?: string;
}
export declare function Icon(props: IconProps): JSX.Element;
export declare const iconNames: string[];
