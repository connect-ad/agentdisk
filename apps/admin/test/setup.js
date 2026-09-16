/**
 * Adds the DOM matchers (`toBeDisabled`, `toHaveValue`, `toHaveFocus`…).
 *
 * They read as the assertion rather than as its mechanism: `toBeDisabled()`
 * says what the test is about, where `.disabled === true` says how it was
 * checked and leaves the reader to work out why that mattered.
 */
import '@testing-library/jest-dom/vitest';
