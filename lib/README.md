# solari-crew-core

Reusable, LLM-independent CrewOS domain logic. This package has no runtime dependencies and makes no database or network requests.

```js
import {
  buildEmployeeSpec,
  evaluatePolicy,
  compileSimulationPassIf,
  validateMcpArguments,
} from 'solari-crew-core';
```

The package exports EmployeeSpec construction and parsing, provenance checks, policy evaluation and the tool catalog, simulation scoring and simulated-refund verification, meeting context/memory formatting, media type/evidence helpers, memory chunking and ranking, MCP/browser input validation, and workflow progress helpers.

Build from the repository root with `npm --workspace solari-crew-core run build`. Publish from the repository root with `npm publish --workspace solari-crew-core`; `prepack` builds the compiled ESM and TypeScript declarations from `build/` automatically. Consumers install it with `npm install solari-crew-core`.
