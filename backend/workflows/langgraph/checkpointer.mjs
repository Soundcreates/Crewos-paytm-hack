import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { databaseDialect, databaseFile, postgresPool } from '../../lib/db.mjs';
import { setupPostgresCheckpointer } from './postgres-checkpoint-setup.mjs';

let saverPromise;

export async function getWorkflowCheckpointer() {
  if (!saverPromise) {
    saverPromise = (async () => {
      if (databaseDialect === 'postgres') {
        const { PostgresSaver } = await import('@langchain/langgraph-checkpoint-postgres');
        const saver = new PostgresSaver(postgresPool);
        await setupPostgresCheckpointer(postgresPool, (setupPool) => new PostgresSaver(setupPool).setup());
        return saver;
      }
      const { SqliteSaver } = await import('@langchain/langgraph-checkpoint-sqlite');
      const filename = resolve(process.env.LANGGRAPH_CHECKPOINT_FILE || `${databaseFile}.langgraph.sqlite`);
      mkdirSync(dirname(filename), { recursive: true });
      return SqliteSaver.fromConnString(filename);
    })().catch(error => { saverPromise = undefined; throw error; });
  }
  return saverPromise;
}

