import type { ButtonHTMLAttributes, ReactNode } from 'react';

// TAB-UI-01: shared presentational components (docs/design/foundations.md).
// Copy is supplied by callers from src/modules/localization; no literal UI text here.

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'soft';

export function Button({
  variant = 'primary',
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const classes = ['tb-button', `tb-button--${variant}`, className]
    .filter(Boolean)
    .join(' ');
  return <button type={type} className={classes} {...rest} />;
}

export type ChipTone =
  | 'neutral'
  | 'called'
  | 'arrived'
  | 'active'
  | 'warning'
  | 'priority'
  | 'danger';

export function Chip({
  tone = 'neutral',
  children,
}: {
  tone?: ChipTone;
  children: ReactNode;
}) {
  return <span className={`tb-chip tb-chip--${tone}`}>{children}</span>;
}

export type SegmentedOption = { value: string; label: ReactNode };

export function SegmentedControl({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly SegmentedOption[];
  value: string;
  onChange?: (value: string) => void;
  label?: string;
}) {
  return (
    <div className="tb-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={onChange ? () => onChange(option.value) : undefined}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function StatusBar({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="tb-status-bar" role="status">
      <span>{children}</span>
      {action}
    </div>
  );
}
