import * as React from "react";

/* 全局界面图标：统一自绘，替代原先的 pikaicons / lucide。
   规格跟预览播放 / 彩蛋图标一致 —— 16 网格、1.7 线宽、圆头圆角，转角在路径里带半径。
   默认 24px 与原图标库同尺寸；各处的实际大小仍由所在组件的 CSS 决定。 */

type IconProps = React.SVGProps<SVGSVGElement>;

function icon(displayName: string, body: React.ReactNode) {
  const Icon = ({ className = "", ...props }: IconProps) => (
    <svg
      className={`ui-icon ${className}`.trim()}
      width="24"
      height="24"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {body}
    </svg>
  );
  Icon.displayName = displayName;
  return Icon;
}

export const PlusIcon = icon("PlusIcon", <path d="M8 3.4V12.6M3.4 8H12.6" />);

export const MinusIcon = icon("MinusIcon", <path d="M3.4 8H12.6" />);

export const CheckIcon = icon("CheckIcon", <path d="M3.3 8.5L6.2 11.3Q6.6 11.7 7 11.3L12.7 5.2" />);

export const ChevronDownIcon = icon("ChevronDownIcon", <path d="M4.4 6.3L7.5 9.4Q8 9.9 8.5 9.4L11.6 6.3" />);

export const ChevronRightIcon = icon("ChevronRightIcon", <path d="M6.3 4.4L9.4 7.5Q9.9 8 9.4 8.5L6.3 11.6" />);

export const CrossIcon = icon("CrossIcon", <path d="M4.6 4.6L11.4 11.4M11.4 4.6L4.6 11.4" />);

export const CopyIcon = icon("CopyIcon", (
  <>
    <rect x="5.6" y="5.6" width="7.9" height="7.9" rx="2.2" />
    <path d="M10.4 5.6V4.7Q10.4 2.5 8.2 2.5H4.7Q2.5 2.5 2.5 4.7V8.2Q2.5 10.4 4.7 10.4H5.6" />
  </>
));

export const TrashIcon = icon("TrashIcon", (
  <>
    <path d="M2.8 4.5H13.2" />
    <path d="M6.3 2.4H9.7" />
    <path d="M4.1 4.5L4.7 12Q4.85 13.6 6.45 13.6H9.55Q11.15 13.6 11.3 12L11.9 4.5" />
  </>
));

export const DownloadIcon = icon("DownloadIcon", (
  <>
    <path d="M8 2.6V10" />
    <path d="M4.8 6.9L8 10.1L11.2 6.9" />
    <path d="M3.4 13.4H12.6" />
  </>
));

export const FileIcon = icon("FileIcon", (
  <>
    <path d="M8.6 2.5H5.3Q3.4 2.5 3.4 4.4V11.6Q3.4 13.5 5.3 13.5H10.7Q12.6 13.5 12.6 11.6V6.5L8.6 2.5Z" />
    <path d="M8.6 2.8V4.9Q8.6 6.5 10.2 6.5H12.3" />
  </>
));

/** ⌘：中间一个方框，四角各绕一个小圈。 */
export const CommandIcon = icon("CommandIcon", (
  <path d="M5.9 5.9V4.3A2 2 0 1 0 4.3 5.9H11.7A2 2 0 1 0 10.1 4.3V11.7A2 2 0 1 0 11.7 10.1H4.3A2 2 0 1 0 5.9 11.7Z" />
));

/** ⌫：朝左的键帽里一个叉。 */
export const DeleteKeyIcon = icon("DeleteKeyIcon", (
  <>
    <path d="M5.4 3.5H12.3Q14.1 3.5 14.1 5.3V10.7Q14.1 12.5 12.3 12.5H5.4Q4.7 12.5 4.25 11.95L1.9 8.8Q1.45 8 1.9 7.2L4.25 4.05Q4.7 3.5 5.4 3.5Z" />
    <path d="M7.4 6.55L10.3 9.45M10.3 6.55L7.4 9.45" />
  </>
));

export const MouseIcon = icon("MouseIcon", (
  <>
    <rect x="4" y="1.9" width="8" height="12.2" rx="4" />
    <path d="M8 4.6V6.6" />
  </>
));
