'use client';

import { useEffect, useState } from 'react';
import {
  formatUpdatedAgo,
  startUpdatedAgoTicker,
  updatedAgo,
  type UpdatedAgoLocale,
} from './updated-ago';

/** Ticking relative age of the snapshot; the 5 s tick avoids per-second re-render churn. */
export function UpdatedAgoText({
  generatedAt,
  locale,
}: {
  generatedAt: string;
  locale: UpdatedAgoLocale;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => startUpdatedAgoTicker(setNowMs), [generatedAt]);
  const age = updatedAgo(generatedAt, nowMs);
  if (!age) return null;
  return <>{formatUpdatedAgo(age, locale)}</>;
}
