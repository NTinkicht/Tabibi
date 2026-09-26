import { z } from 'zod';

/**
 * Canonical positive decimal query integer. Signs, exponent notation,
 * fractions, whitespace padding and leading zeroes are deliberately rejected.
 */
export const strictLimit100Schema = z
  .string()
  .regex(/^(?:[1-9]\d?|100)$/)
  .transform((value) => Number(value));
