# Project Rules & Guidelines for AI Agent

Before starting any implementation, feature development, or bug fix, always read and follow the strict rules defined in this document.

## Mandatory Rules (Non-Negotiable)

1. **No `any` Types Allowed**
   - Prohibit the use of `any` typing across the entire application codebase (TypeScript frontend, backend, workers, python etc.).
   - Always use explicit types, custom interfaces/types, or `unknown` with proper type guards where appropriate.
